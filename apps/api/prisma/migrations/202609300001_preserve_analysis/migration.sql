ALTER TABLE "Meeting" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Risk" ADD COLUMN "fingerprint" TEXT, ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
CREATE UNIQUE INDEX "Risk_meetingId_fingerprint_key" ON "Risk"("meetingId", "fingerprint");
ALTER TABLE "EmailDelivery" ADD COLUMN "idempotencyKey" TEXT, ADD COLUMN "payload" JSONB;
CREATE UNIQUE INDEX "EmailDelivery_idempotencyKey_key" ON "EmailDelivery"("idempotencyKey");
ALTER TABLE "DocumentPage" ADD COLUMN "extractionMethod" TEXT NOT NULL DEFAULT 'TEXT';
ALTER TYPE "DeliveryStatus" ADD VALUE IF NOT EXISTS 'SENDING';
ALTER TABLE "EmailDelivery" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
