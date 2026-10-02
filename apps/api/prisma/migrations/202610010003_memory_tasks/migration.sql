CREATE TABLE "MemoryExtraction" (
 "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "sourceType" TEXT NOT NULL, "sourceId" TEXT NOT NULL,
 "observedAt" TIMESTAMP(3) NOT NULL, "text" TEXT NOT NULL, "status" "ProcessingStatus" NOT NULL DEFAULT 'PENDING',
 "errorMessage" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "MemoryExtraction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MemoryExtraction_userId_sourceType_sourceId_observedAt_key" ON "MemoryExtraction"("userId", "sourceType", "sourceId", "observedAt");
CREATE INDEX "MemoryExtraction_userId_status_idx" ON "MemoryExtraction"("userId", "status");
