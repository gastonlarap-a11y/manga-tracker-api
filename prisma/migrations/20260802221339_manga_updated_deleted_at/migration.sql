-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Manga" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "canonicalName" TEXT NOT NULL,
    "normalizedSlug" TEXT NOT NULL,
    "coverUrl" TEXT,
    "coverImage" BLOB,
    "coverImageType" TEXT,
    "coverVersion" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'reading',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME
);
-- updatedAt is backfilled from createdAt rather than left at CURRENT_TIMESTAMP:
-- the value has to be identical on every machine that migrates, or whichever
-- one ran the migration last would look newer and win every last-write-wins
-- comparison, silently overwriting the other's edits on the first sync.
INSERT INTO "new_Manga" ("canonicalName", "coverImage", "coverImageType", "coverUrl", "coverVersion", "createdAt", "id", "normalizedSlug", "status", "tags", "updatedAt") SELECT "canonicalName", "coverImage", "coverImageType", "coverUrl", "coverVersion", "createdAt", "id", "normalizedSlug", "status", "tags", "createdAt" FROM "Manga";
DROP TABLE "Manga";
ALTER TABLE "new_Manga" RENAME TO "Manga";
CREATE UNIQUE INDEX "Manga_normalizedSlug_key" ON "Manga"("normalizedSlug");
CREATE TABLE "new_SiteAdapter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domain" TEXT NOT NULL,
    "titleSelector" TEXT NOT NULL,
    "chapterSelector" TEXT,
    "chapterUrlRegex" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_SiteAdapter" ("chapterSelector", "chapterUrlRegex", "createdAt", "domain", "id", "titleSelector", "updatedAt") SELECT "chapterSelector", "chapterUrlRegex", "createdAt", "domain", "id", "titleSelector", "updatedAt" FROM "SiteAdapter";
DROP TABLE "SiteAdapter";
ALTER TABLE "new_SiteAdapter" RENAME TO "SiteAdapter";
CREATE UNIQUE INDEX "SiteAdapter_domain_key" ON "SiteAdapter"("domain");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
