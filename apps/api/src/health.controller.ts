import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "./infra/prisma.service.js";
import { RedisService } from "./infra/redis.service.js";
import { SearchService } from "./modules/search/search.service.js";
import { MailService } from "./modules/mail/mail.service.js";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  @Get("live")
  live() { return { status: "ok", time: new Date().toISOString() }; }

  @Get("ready")
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      await this.redis.ping();
      const heartbeat = await this.redis.client.get("nbboss:worker:heartbeat");
      return { status: "ready", database: "ok", redis: "ok", worker: heartbeat ? "online" : "offline", workerHeartbeat: heartbeat };
    } catch { throw new ServiceUnavailableException("数据库或队列服务未就绪"); }
  }

  @Get("system")
  async system() {
    const state = await this.ready();
    if (!state.workerHeartbeat || Date.now() - Date.parse(state.workerHeartbeat) > 30_000 || !Number.isFinite(Date.parse(state.workerHeartbeat))) throw new ServiceUnavailableException("后台任务服务未就绪");
    return state;
  }

  @Get("capabilities")
  capabilities() {
    return {
      model: process.env.LLM_ENABLED !== "false" && Boolean(process.env.LLM_API_KEY),
      search: new SearchService().available(),
      smtp: new MailService(this.prisma).available(),
      searchMode: new SearchService().available() ? (process.env.SEARCH_PROVIDER === "mock" ? "mock" : "live") : "disabled",
      mailMode: new MailService(this.prisma).available() ? (process.env.SMTP_PROVIDER === "mock" ? "mock" : "live") : "disabled",
      ocr: process.env.OCR_ENABLED !== "false",
      reasons: { search: new SearchService().available() ? null : "请配置并启用 Tavily 搜索服务", smtp: new MailService(this.prisma).available() ? null : "请配置 SMTP 发件服务与收件人" },
      embedding: Boolean(process.env.EMBEDDING_BASE_URL && process.env.EMBEDDING_API_KEY && process.env.EMBEDDING_MODEL),
      vision: process.env.VISION_ENABLED === "true" && Boolean(process.env.VISION_BASE_URL && process.env.VISION_API_KEY && process.env.VISION_MODEL),
    };
  }
}
