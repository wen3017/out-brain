import { isAbsolute } from "node:path";

/** Validate names only in errors: never echo credential values. */
export function validateEnvironment(env: Record<string, unknown>) {
  const errors: string[] = [];
  const value = (key: string) => String(env[key] ?? "").trim();
  const required = (key: string) => { if (!value(key)) errors.push(`${key} 未配置`); };
  const url = (key: string, protocols: string[], optional = false) => {
    if (optional && !value(key)) return;
    try { if (!protocols.includes(new URL(value(key)).protocol)) throw new Error(); }
    catch { errors.push(`${key} 地址无效`); }
  };
  for (const key of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"]) {
    if (value(key).length < 32 || /replace-with|local-dev|change-me/i.test(value(key))) errors.push(`${key} 必须为至少 32 字符的独立随机密钥`);
  }
  if (value("JWT_ACCESS_SECRET") === value("JWT_REFRESH_SECRET")) errors.push("两种 JWT 密钥不能相同");
  url("DATABASE_URL", ["postgres:", "postgresql:"]); url("REDIS_URL", ["redis:", "rediss:"]);
  url("WEB_ORIGIN", ["http:", "https:"]);
  try { if (new URL(value("WEB_ORIGIN")).origin !== value("WEB_ORIGIN")) errors.push("WEB_ORIGIN 不能包含路径或结尾斜杠"); } catch { /* Reported by the URL check. */ }
  required("STORAGE_ROOT");
  if (value("STORAGE_ROOT") && !isAbsolute(value("STORAGE_ROOT"))) errors.push("STORAGE_ROOT 必须是绝对路径，确保 API、Worker 和备份读取相同目录");
  if (value("LLM_ENABLED") !== "false") {
    required("LLM_API_KEY"); required("LLM_MODEL"); url("LLM_BASE_URL", ["http:", "https:"]);
  }
  if (value("SEARCH_ENABLED") === "true") {
    if (!["tavily", "mock", ""].includes(value("SEARCH_PROVIDER"))) errors.push("SEARCH_PROVIDER 不受支持");
    if (value("SEARCH_PROVIDER") !== "mock") required("SEARCH_API_KEY");
  }
  if (value("SMTP_ENABLED") === "true" && value("SMTP_PROVIDER") !== "mock") {
    required("SMTP_HOST");
    for (const key of ["SMTP_FROM", "SMTP_TO"]) if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value(key))) errors.push(`${key} 必须是单个有效邮箱`);
    if (value("SMTP_USER")) required("SMTP_PASSWORD");
  }
  for (const prefix of ["EMBEDDING", "VISION"]) {
    const keys = ["BASE_URL", "API_KEY", "MODEL"].map(suffix => `${prefix}_${suffix}`);
    if (keys.some(key => value(key)) || value(`${prefix}_ENABLED`) === "true") {
      keys.forEach(required); url(`${prefix}_BASE_URL`, ["http:", "https:"]);
    }
  }
  for (const key of ["API_PORT", "SMTP_PORT", "AUTH_RATE_LIMIT", "AI_DAILY_REQUEST_LIMIT", "USER_STORAGE_MB"]) {
    if (value(key) && (!/^\d+$/.test(value(key)) || Number(value(key)) < 1 || Number(value(key)) > (key.endsWith("PORT") ? 65535 : 1_000_000))) errors.push(`${key} 必须为有效正整数`);
  }
  if (value("TRUST_PROXY_HOPS") && !/^[0-3]$/.test(value("TRUST_PROXY_HOPS"))) errors.push("TRUST_PROXY_HOPS must be 0-3");
  for (const key of ["LLM_ENABLED", "SEARCH_ENABLED", "SMTP_ENABLED", "REGISTRATION_ENABLED", "COOKIE_SECURE"]) {
    if (value(key) && !["true", "false"].includes(value(key))) errors.push(`${key} 只能为 true 或 false`);
  }
  if (value("NODE_ENV") === "production") {
    if (!value("WEB_ORIGIN").startsWith("https://")) errors.push("生产环境 WEB_ORIGIN 必须使用 HTTPS");
    if (value("COOKIE_SECURE") === "false") errors.push("生产环境不能关闭 COOKIE_SECURE");
  }
  if (errors.length) throw new Error(`配置错误：${errors.join("；")}`);
  return env;
}
