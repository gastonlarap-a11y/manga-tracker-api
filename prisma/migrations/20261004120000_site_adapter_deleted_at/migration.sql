-- A calibration can be removed. A tombstone rather than a deleted row, so the
-- removal travels through the sync instead of being undone by the next pull.

-- AlterTable
ALTER TABLE "SiteAdapter" ADD COLUMN "deletedAt" DATETIME;
