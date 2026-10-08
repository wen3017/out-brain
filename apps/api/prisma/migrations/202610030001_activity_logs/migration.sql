CREATE TABLE "ActivityLog" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId" TEXT,
  "level" VARCHAR(8) NOT NULL,
  "service" VARCHAR(16) NOT NULL,
  "category" VARCHAR(16) NOT NULL,
  "operation" VARCHAR(120) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "traceId" VARCHAR(160) NOT NULL,
  "resourceId" VARCHAR(160),
  "errorCode" VARCHAR(64),
  "durationMs" INTEGER,
  "attempt" INTEGER,
  "httpStatus" INTEGER,
  CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ActivityLog_userId_createdAt_id_idx" ON "ActivityLog"("userId", "createdAt", "id");
CREATE INDEX "ActivityLog_userId_level_createdAt_idx" ON "ActivityLog"("userId", "level", "createdAt");
CREATE INDEX "ActivityLog_userId_traceId_idx" ON "ActivityLog"("userId", "traceId");
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");
