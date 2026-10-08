import "reflect-metadata";
import { requestSecurity } from "./common/request-security.js";
import cookieParser from "cookie-parser";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { HttpExceptionFilter } from "./common/http-exception.filter.js";
import { requestLog } from "./common/request-log.js";

if (process.env.WORKER_MODE === "true") {
  const worker = await NestFactory.createApplicationContext(AppModule);
  worker.enableShutdownHooks();
} else {
  const app = await NestFactory.create(AppModule, { cors: false });
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.use(requestLog);
  app.use(requestSecurity);
  app.getHttpAdapter().getInstance().disable("x-powered-by");
  app.getHttpAdapter().getInstance().set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 0));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:3000", credentials: true });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT ?? 3001), "0.0.0.0");
}
