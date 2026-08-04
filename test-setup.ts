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

// The suite must never reach the cluster, and it has to be hermetic by
// construction rather than because a developer's .env happens to be incomplete.
// Once `env:pull` started writing a working MONGODB_URL, the sync tests began
// hitting Azure for real — a POST /sync/now from a test run is a write into the
// shared store, and events there can never be removed.
delete Bun.env.MONGODB_URL;
delete Bun.env.MONGODB_DB;

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
