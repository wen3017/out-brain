import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { validateEnvironment } from "../src/common/environment.js";
import { requestSecurity } from "../src/common/request-security.js";
import { boundedUploadStorage } from "../src/modules/files/upload-storage.js";
import { UPLOAD_LIMITS } from "@nbboss/contracts";
import { RequestLimits, AuthRateGuard, AiQuotaGuard } from "../src/common/request-limits.js";
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });
const valid = () => ({ JWT_ACCESS_SECRET: "a".repeat(40), JWT_REFRESH_SECRET: "b".repeat(40), DATABASE_URL: "postgresql://localhost/db", REDIS_URL: "redis://localhost", WEB_ORIGIN: "http://localhost:3000", STORAGE_ROOT: resolve("uploads"), LLM_ENABLED: "false" });
describe("startup configuration", () => {
  it("supports infrastructure-only mode and rejects partial enabled providers", () => {
    expect(validateEnvironment(valid())).toBeTruthy();
    expect(() => validateEnvironment({ ...valid(), LLM_ENABLED: "true" })).toThrow("LLM_API_KEY");
    expect(() => validateEnvironment({ ...valid(), SEARCH_ENABLED: "true" })).toThrow("SEARCH_API_KEY");
    expect(() => validateEnvironment({ ...valid(), SMTP_ENABLED: "true" })).toThrow("SMTP_FROM");
    expect(() => validateEnvironment({ ...valid(), EMBEDDING_MODEL: "embed" })).toThrow("EMBEDDING_BASE_URL");
  });
  it("rejects fallback/equal secrets, insecure production and invalid quotas without leaking values", () => {
    expect(() => validateEnvironment({ ...valid(), JWT_ACCESS_SECRET: "replace-with-at-least-32-characters" })).toThrow("JWT_ACCESS_SECRET");
    expect(() => validateEnvironment({ ...valid(), JWT_REFRESH_SECRET: "a".repeat(40) })).toThrow("不能相同");
    expect(() => validateEnvironment({ ...valid(), NODE_ENV: "production" })).toThrow("HTTPS");
    expect(() => validateEnvironment({ ...valid(), AI_DAILY_REQUEST_LIMIT: "0" })).toThrow("AI_DAILY_REQUEST_LIMIT");
    expect(() => validateEnvironment({ ...valid(), STORAGE_ROOT: "./uploads" })).toThrow("STORAGE_ROOT");
    try { validateEnvironment({ ...valid(), DATABASE_URL: "secret-unparseable-value" }); } catch (e) { expect(String(e)).not.toContain("secret-unparseable-value"); }
  });
});
describe("browser request protection", () => {
  it.each(["https://attacker.test", "null"])("rejects a write from origin %s", origin => {
    process.env.WEB_ORIGIN = "https://workspace.test";
    const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() }; const next = vi.fn();
    requestSecurity({ method: "POST", get: (name: string) => name === "origin" ? origin : undefined } as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
  });
  it("allows the configured browser origin and non-browser clients", () => {
    process.env.WEB_ORIGIN = "https://workspace.test";
    for (const origin of [undefined, process.env.WEB_ORIGIN]) {
      const next = vi.fn(); requestSecurity({ method: "POST", get: (name: string) => name === "origin" ? origin : undefined } as any, { setHeader: vi.fn() } as any, next); expect(next).toHaveBeenCalledOnce();
    }
  });
});
describe("request and upload bounds", () => {
  it("returns a retry time when over quota and fails closed on Redis outage", async () => {
    const redis = { connect: vi.fn(), client: { eval: vi.fn().mockResolvedValue([3, 50]) } }; const res = { setHeader: vi.fn() };
    await expect(new RequestLimits(redis as any).consume("account", 2, 60, res as any, "limited")).rejects.toMatchObject({ status: 429 });
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "50");
    redis.connect.mockRejectedValue(new Error("private diagnostic"));
    await expect(new RequestLimits(redis as any).consume("account", 2, 60, res as any, "limited")).rejects.toMatchObject({ status: 503 });
  });
  it("counts AI entry points but permits edits and aborts after quota exhaustion", async () => {
    const limits = { consume: vi.fn() }; const guard = new AiQuotaGuard(limits as any);
    const context = (path: string) => ({ switchToHttp: () => ({ getRequest: () => ({ method: "POST", path, user: { id: "owner" } }), getResponse: () => ({}) }) }) as any;
    for (const path of ["/api/conversations/c/files/batch", "/api/conversations/c/messages", "/api/presentations/p/retry", "/api/memories/tasks/t/retry"]) await guard.canActivate(context(path));
    expect(limits.consume).toHaveBeenCalledTimes(8); limits.consume.mockClear();
    await guard.canActivate(context("/api/conversations/c/runs/r/abort")); expect(limits.consume).not.toHaveBeenCalled();
  });
  it("limits authentication by source and account", async () => {
    const limits = { consume: vi.fn() };
    await new AuthRateGuard(limits as any).canActivate({ switchToHttp: () => ({ getRequest: () => ({ path: "/api/auth/login", ip: "127.0.0.1", body: { username: "SomeUser" } }), getResponse: () => ({}) }) } as any);
    expect(limits.consume).toHaveBeenCalledTimes(2);
  });
  it("enforces a shared streamed byte budget across all files in one request", async () => {
    const req = {};
    const upload = (bytes: number) => new Promise((resolve, reject) => boundedUploadStorage._handleFile(req as any, { stream: Readable.from([Buffer.alloc(bytes)]) } as any, (err, file) => err ? reject(err) : resolve(file)));
    await upload(UPLOAD_LIMITS.pdfBytes); await upload(UPLOAD_LIMITS.pdfBytes);
    await expect(upload(UPLOAD_LIMITS.pdfBytes)).rejects.toMatchObject({ status: 413 });
  });
});
