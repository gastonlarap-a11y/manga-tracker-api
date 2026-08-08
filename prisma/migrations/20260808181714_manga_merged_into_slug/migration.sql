-- AlterTable
-- A nullable column, so SQLite takes the cheap ALTER path and existing rows keep
-- their meaning: NULL = canonical, which is what every manga is before any merge.
ALTER TABLE "Manga" ADD COLUMN "mergedIntoSlug" TEXT;

-- CreateIndex
CREATE INDEX "Manga_mergedIntoSlug_idx" ON "Manga"("mergedIntoSlug");

-- CreateTable
CREATE TABLE "DuplicateDismissal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slugA" TEXT NOT NULL,
    "slugB" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateDismissal_slugA_slugB_key" ON "DuplicateDismissal"("slugA", "slugB");
