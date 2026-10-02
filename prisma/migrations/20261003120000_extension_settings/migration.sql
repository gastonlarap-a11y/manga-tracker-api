-- When the extension counts a chapter as read. No row is inserted: an absent
-- row means the defaults, so a machine that never opens the setting has none.

-- CreateTable
CREATE TABLE "ExtensionSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "readingRequired" BOOLEAN NOT NULL DEFAULT false,
    "readMinSeconds" INTEGER NOT NULL DEFAULT 30,
    "readMinScrollPercent" INTEGER NOT NULL DEFAULT 80,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
