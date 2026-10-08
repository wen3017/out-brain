import { Redis } from "ioredis";
const redis = new Redis(process.env.REDIS_URL!, { connectTimeout: 2000, maxRetriesPerRequest: 1, retryStrategy: () => null });
redis.on("error", () => {});
try {
  const heartbeat = await redis.get("nbboss:worker:heartbeat");
  const age = heartbeat ? Date.now() - Date.parse(heartbeat) : Number.NaN;
  if (!Number.isFinite(age) || age < 0 || age > 30_000) process.exitCode = 1;
} catch { process.exitCode = 1; }
finally { redis.disconnect(); }
