import { CanActivate, ExecutionContext, HttpException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { RedisService } from "../infra/redis.service.js";
import { resourceLimit } from "./resource-limits.js";

@Injectable()
export class RequestLimits {
  constructor(private readonly redis: RedisService) {}
  async consume(key: string, limit: number, seconds: number, response: Response, message: string) {
    let result: number[];
    try {
      await this.redis.connect();
      const digest = createHash("sha256").update(key).digest("hex");
      result = await this.redis.client.eval("local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]) end; return {n,redis.call('ttl',KEYS[1])}", 1, `limit:${digest}`, seconds) as number[];
    } catch { throw new ServiceUnavailableException("请求保护服务暂不可用，请稍后重试"); }
    if (result[0] > limit) {
      response.setHeader("Retry-After", String(Math.max(1, result[1])));
      throw new HttpException(message, 429);
    }
  }
}

@Injectable()
export class AuthRateGuard implements CanActivate {
  constructor(private readonly limits: RequestLimits) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const action = req.path.split("/").at(-1);
    if (!["login", "register", "password"].includes(action ?? "")) return true;
    await this.limits.consume(`auth-ip:${req.ip}`, resourceLimit("AUTH_RATE_LIMIT", 100), 900, res, "操作过于频繁，请稍后再试");
    const account = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : undefined;
    if (account) await this.limits.consume(`auth-account:${action}:${account}`, 20, 900, res, "该账号尝试次数过多，请 15 分钟后再试");
    return true;
  }
}

@Injectable()
export class AiQuotaGuard implements CanActivate {
  constructor(private readonly limits: RequestLimits) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request & { user: { id: string } }>();
    if (req.method !== "POST") return true;
    // Editing, stopping, and email retries must remain available at the quota limit.
    if (!/(?:\/messages|\/files(?:\/batch)?|\/files\/[^/]+\/retry|\/reanalyze|\/presentations|\/presentations\/[^/]+\/retry|\/memories\/tasks\/[^/]+\/retry)$/.test(req.path)) return true;
    const res = context.switchToHttp().getResponse<Response>();
    await this.limits.consume(`ai-burst:${req.user.id}`, 20, 60, res, "处理请求过于频繁，请稍后重试");
    const now = new Date();
    const ttl = Math.ceil((Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)-now.valueOf())/1000);
    await this.limits.consume(`ai-daily:${req.user.id}:${now.toISOString().slice(0,10)}`, resourceLimit("AI_DAILY_REQUEST_LIMIT", 200), ttl, res, "今日 AI 处理请求额度已用完，请明日再试或联系维护人员");
    return true;
  }
}
