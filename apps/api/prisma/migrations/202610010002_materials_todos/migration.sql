ALTER TYPE "ProcessingStatus" ADD VALUE 'PARTIAL';
ALTER TYPE "DeliveryStatus" ADD VALUE 'CANCELLED';
ALTER TABLE "DocumentPage" ADD COLUMN "qualityStatus" TEXT NOT NULL DEFAULT 'OK', ADD COLUMN "qualityMessage" TEXT;
ALTER TABLE "Todo" ADD COLUMN "editedFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], ADD COLUMN "modelSuggestion" JSONB;
-- Existing rows predate field-level provenance. Preserve them conservatively.
UPDATE "Todo" SET "editedFields" = ARRAY['title','description','owner','dueAt'];
