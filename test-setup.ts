import { Database } from "bun:sqlite";
import { afterAll } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One throwaway SQLite DB per test run: config.ts reads DATABASE_URL once at
// import time and db/client.ts holds a process-wide PrismaClient singleton, so
// the URL must be fixed before any test file imports them. Test files isolate
// themselves by wiping tables in beforeEach.
const dbPath = join(
  tmpdir(),
  `manga-tracker-test-${process.pid}-${Date.now()}.db`,
);
Bun.env.DATABASE_URL = `file:${dbPath}`;

// Apply the committed migrations synchronously (bun:sqlite, no Prisma CLI
// spawn) so tests run against the exact schema production gets.
const migrationsDir = join(import.meta.dir, "prisma", "migrations");
const db = new Database(dbPath, { create: true });
for (const dir of readdirSync(migrationsDir)
  .filter((entry) => statSync(join(migrationsDir, entry)).isDirectory())
  .sort()) {
  const sql = readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8");
  for (const statement of sql.split(";")) {
    if (statement.trim()) {
      db.run(statement);
    }
  }
}
db.close();

afterAll(() => {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(dbPath + suffix, { force: true });
  }
});
