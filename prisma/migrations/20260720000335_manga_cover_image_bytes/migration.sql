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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Manga" ("canonicalName", "coverUrl", "createdAt", "id", "normalizedSlug", "status", "tags") SELECT "canonicalName", "coverUrl", "createdAt", "id", "normalizedSlug", "status", "tags" FROM "Manga";
DROP TABLE "Manga";
ALTER TABLE "new_Manga" RENAME TO "Manga";
CREATE UNIQUE INDEX "Manga_normalizedSlug_key" ON "Manga"("normalizedSlug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
