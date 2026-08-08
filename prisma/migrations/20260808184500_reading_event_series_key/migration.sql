-- AlterTable
-- Nullable, so existing events keep their meaning: NULL = the reporting page
-- exposed no series link, which is every event recorded before this column.
ALTER TABLE "ReadingEvent" ADD COLUMN "seriesKey" TEXT;

-- CreateIndex
CREATE INDEX "ReadingEvent_seriesKey_idx" ON "ReadingEvent"("seriesKey");
