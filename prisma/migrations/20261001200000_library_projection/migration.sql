-- The library's read model (see the comment above LibraryEntry in
-- schema.prisma). The tables are Prisma's own DDL; the triggers below are what
-- keep them honest, and are written by hand because Prisma does not model them.

-- CreateTable
CREATE TABLE "LibraryEntry" (
    "mangaId" TEXT NOT NULL PRIMARY KEY,
    "canonicalName" TEXT NOT NULL,
    "normalizedSlug" TEXT NOT NULL,
    "searchKey" TEXT NOT NULL,
    "sortKey" TEXT NOT NULL,
    "coverUrl" TEXT,
    "coverVersion" INTEGER NOT NULL,
    "hasStoredCover" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "tags" TEXT NOT NULL,
    "reachedNumber" REAL,
    "reachedLabel" TEXT,
    "lastReadAt" DATETIME NOT NULL,
    "lastChapterLabel" TEXT,
    "lastSourceUrl" TEXT,
    "readCount" INTEGER NOT NULL,
    "sourceDomains" TEXT NOT NULL,
    "aliasCount" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "LibraryEntryDomain" (
    "mangaId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,

    PRIMARY KEY ("mangaId", "domain"),
    CONSTRAINT "LibraryEntryDomain_mangaId_fkey" FOREIGN KEY ("mangaId") REFERENCES "LibraryEntry" ("mangaId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LibraryMember" (
    "memberId" TEXT NOT NULL PRIMARY KEY,
    "canonicalId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "LibraryDirty" (
    "mangaId" TEXT NOT NULL PRIMARY KEY,
    "seq" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "LibraryRevision" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "titles" INTEGER NOT NULL
);

-- CreateIndex
CREATE INDEX "LibraryEntry_lastReadAt_mangaId_idx" ON "LibraryEntry"("lastReadAt" DESC, "mangaId");

-- CreateIndex
CREATE INDEX "LibraryEntry_status_lastReadAt_mangaId_idx" ON "LibraryEntry"("status", "lastReadAt" DESC, "mangaId");

-- CreateIndex
CREATE INDEX "LibraryEntry_sortKey_mangaId_idx" ON "LibraryEntry"("sortKey", "mangaId");

-- CreateIndex
CREATE INDEX "LibraryEntry_readCount_mangaId_idx" ON "LibraryEntry"("readCount" DESC, "mangaId");

-- CreateIndex
CREATE INDEX "LibraryEntryDomain_domain_idx" ON "LibraryEntryDomain"("domain");

-- CreateIndex
CREATE INDEX "LibraryMember_canonicalId_idx" ON "LibraryMember"("canonicalId");

-- CreateIndex
CREATE INDEX "LibraryDirty_seq_idx" ON "LibraryDirty"("seq");

-- CreateIndex
CREATE INDEX "ReadingEvent_readAt_idx" ON "ReadingEvent"("readAt");

-- The one row the duplicates counter lives in.
INSERT INTO "LibraryRevision" ("id", "titles") VALUES (1, 0);

-- Every manga starts dirty, so the first read after this migration builds the
-- whole projection from the rows already on disk.
INSERT INTO "LibraryDirty" ("mangaId", "seq") SELECT "id", 1 FROM "Manga";

-- ---------------------------------------------------------------------------
-- Dirty marking. Each marks the manga row whose card may have changed; the
-- refresh (src/db/library-projection.ts) resolves which card that is. `seq`
-- grows on every mark, so a refresh deletes only the marks it read.
--
-- Prisma alters a SQLite column by rebuilding the table, which drops these
-- triggers: a later migration that rebuilds Manga, ReadingEvent or
-- DuplicateDismissal must create its triggers again (a test lists them all).
-- ---------------------------------------------------------------------------

CREATE TRIGGER "ReadingEvent_projection_insert" AFTER INSERT ON "ReadingEvent" BEGIN
    INSERT OR REPLACE INTO "LibraryDirty" ("mangaId", "seq")
    VALUES (NEW."mangaId", (SELECT COALESCE(MAX("seq"), 0) + 1 FROM "LibraryDirty"));
END;

CREATE TRIGGER "ReadingEvent_projection_update" AFTER UPDATE ON "ReadingEvent" BEGIN
    INSERT OR REPLACE INTO "LibraryDirty" ("mangaId", "seq")
    VALUES (OLD."mangaId", (SELECT COALESCE(MAX("seq"), 0) + 1 FROM "LibraryDirty"));
    INSERT OR REPLACE INTO "LibraryDirty" ("mangaId", "seq")
    VALUES (NEW."mangaId", (SELECT COALESCE(MAX("seq"), 0) + 1 FROM "LibraryDirty"));
END;

CREATE TRIGGER "ReadingEvent_projection_delete" AFTER DELETE ON "ReadingEvent" BEGIN
    INSERT OR REPLACE INTO "LibraryDirty" ("mangaId", "seq")
    VALUES (OLD."mangaId", (SELECT COALESCE(MAX("seq"), 0) + 1 FROM "LibraryDirty"));
END;

CREATE TRIGGER "Manga_projection_insert" AFTER INSERT ON "Manga" BEGIN
    INSERT OR REPLACE INTO "LibraryDirty" ("mangaId", "seq")
    VALUES (NEW."id", (SELECT COALESCE(MAX("seq"), 0) + 1 FROM "LibraryDirty"));
    UPDATE "LibraryRevision" SET "titles" = "titles" + 1 WHERE "id" = 1;
END;

-- Any column can change what a card shows, so every update marks the row.
-- A merge or an unmerge also changes another card: the target before and after
-- is marked too, and so is every alias of a slug that is no longer this one.
CREATE TRIGGER "Manga_projection_update" AFTER UPDATE ON "Manga" BEGIN
    INSERT OR REPLACE INTO "LibraryDirty" ("mangaId", "seq")
    VALUES (NEW."id", (SELECT COALESCE(MAX("seq"), 0) + 1 FROM "LibraryDirty"));
    INSERT OR REPLACE INTO "LibraryDirty" ("mangaId", "seq")
    SELECT "id", (SELECT COALESCE(MAX("seq"), 0) + 1 FROM "LibraryDirty")
    FROM "Manga"
    WHERE OLD."mergedIntoSlug" IS NOT NEW."mergedIntoSlug"
      AND "normalizedSlug" IN (OLD."mergedIntoSlug", NEW."mergedIntoSlug");
    INSERT OR REPLACE INTO "LibraryDirty" ("mangaId", "seq")
    SELECT "id", (SELECT COALESCE(MAX("seq"), 0) + 1 FROM "LibraryDirty")
    FROM "Manga"
    WHERE OLD."normalizedSlug" IS NOT NEW."normalizedSlug"
      AND "mergedIntoSlug" = OLD."normalizedSlug";
END;

-- Only what /duplicates reads: a status or a tag does not change a suggestion.
CREATE TRIGGER "Manga_titles_update" AFTER UPDATE ON "Manga"
WHEN OLD."canonicalName" IS NOT NEW."canonicalName"
  OR OLD."normalizedSlug" IS NOT NEW."normalizedSlug"
  OR OLD."coverUrl" IS NOT NEW."coverUrl"
  OR OLD."mergedIntoSlug" IS NOT NEW."mergedIntoSlug"
  OR OLD."deletedAt" IS NOT NEW."deletedAt"
BEGIN
    UPDATE "LibraryRevision" SET "titles" = "titles" + 1 WHERE "id" = 1;
END;

CREATE TRIGGER "Manga_projection_delete" AFTER DELETE ON "Manga" BEGIN
    INSERT OR REPLACE INTO "LibraryDirty" ("mangaId", "seq")
    VALUES (OLD."id", (SELECT COALESCE(MAX("seq"), 0) + 1 FROM "LibraryDirty"));
    INSERT OR REPLACE INTO "LibraryDirty" ("mangaId", "seq")
    SELECT "id", (SELECT COALESCE(MAX("seq"), 0) + 1 FROM "LibraryDirty")
    FROM "Manga"
    WHERE "mergedIntoSlug" = OLD."normalizedSlug";
    UPDATE "LibraryRevision" SET "titles" = "titles" + 1 WHERE "id" = 1;
END;

CREATE TRIGGER "DuplicateDismissal_titles_insert" AFTER INSERT ON "DuplicateDismissal" BEGIN
    UPDATE "LibraryRevision" SET "titles" = "titles" + 1 WHERE "id" = 1;
END;

CREATE TRIGGER "DuplicateDismissal_titles_update" AFTER UPDATE ON "DuplicateDismissal" BEGIN
    UPDATE "LibraryRevision" SET "titles" = "titles" + 1 WHERE "id" = 1;
END;

CREATE TRIGGER "DuplicateDismissal_titles_delete" AFTER DELETE ON "DuplicateDismissal" BEGIN
    UPDATE "LibraryRevision" SET "titles" = "titles" + 1 WHERE "id" = 1;
END;
