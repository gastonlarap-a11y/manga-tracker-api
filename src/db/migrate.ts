// Applies the committed migrations with bun:sqlite, so a machine that runs this
// server needs neither the Prisma CLI nor a manual step.
//
// Why this exists: until now migrations were applied out of band — by hand on
// macOS, by `deploy.ts`/`bootstrap-windows.ts` elsewhere. Anyone who just
// started the server without migrating first got a process that answered
// /health and then failed on the first query against a table that did not
// exist. That is fine for a developer and unacceptable for a packaged app
// someone installs by double-clicking.
//
// The records are written in the exact shape Prisma's own `migrate deploy`
// uses (`_prisma_migrations`, checksum included), so both paths can be used on
// the same database: this one recognises what the CLI applied, and the CLI
// recognises what this one applied.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface MigrationResult {
  /** Names applied by this call, oldest first. Empty when already up to date. */
  applied: string[];
  /** Names that were already recorded in the database. */
  alreadyApplied: string[];
}

/**
 * `file:/path/to.db` and `file:./rel.db` are what the app passes around;
 * bun:sqlite wants the plain path. Anything else (a libSQL URL over the
 * network) is not a local file and cannot be migrated here.
 */
export function databaseFileFromUrl(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith("file:")) {
    return null;
  }
  return databaseUrl.slice("file:".length);
}

/**
 * Brings the database at `databaseUrl` up to date. Idempotent: a database that
 * is already current is opened, read and closed without a single write.
 *
 * A URL that is not a local file is left alone — that is a remote libSQL
 * server, whose schema is not this process's business.
 */
export function applyMigrations(
  databaseUrl: string,
  migrationsDir: string = defaultMigrationsDir(),
): MigrationResult {
  const file = databaseFileFromUrl(databaseUrl);
  if (file === null) {
    return { applied: [], alreadyApplied: [] };
  }

  const db = new Database(file, { create: true });
  try {
    // Foreign keys off during a migration: SQLite table rebuilds (the
    // RedefineTables pattern Prisma emits) drop and recreate tables, which
    // would trip referential checks halfway through.
    db.run("PRAGMA foreign_keys=OFF");
    ensureMigrationsTable(db);

    const recorded = new Set(
      db
        .query<{ migration_name: string }, []>(
          "SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL",
        )
        .all()
        .map((row) => row.migration_name),
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const name of migrationNames(migrationsDir)) {
      if (recorded.has(name)) {
        alreadyApplied.push(name);
        continue;
      }
      const sql = readFileSync(
        join(migrationsDir, name, "migration.sql"),
        "utf8",
      );
      // One transaction per migration: a failure leaves the database on the
      // last complete migration instead of halfway through a schema change.
      db.run("BEGIN");
      try {
        for (const statement of sql.split(";")) {
          if (statement.trim()) {
            db.run(statement);
          }
        }
        recordMigration(db, name, sql);
        db.run("COMMIT");
      } catch (cause) {
        db.run("ROLLBACK");
        throw new Error(`Migration ${name} failed: ${describe(cause)}`, {
          cause,
        });
      }
      applied.push(name);
    }

    db.run("PRAGMA foreign_keys=ON");
    return { applied, alreadyApplied };
  } finally {
    db.close();
  }
}

/** Migration directory names, oldest first — they are timestamp-prefixed. */
function migrationNames(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((entry) => statSync(join(migrationsDir, entry)).isDirectory())
    .sort();
}

function ensureMigrationsTable(db: Database): void {
  // Same DDL Prisma creates, so a database bootstrapped here stays usable by
  // `prisma migrate` and the other way round.
  db.run(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "checksum" TEXT NOT NULL,
    "finished_at" DATETIME,
    "migration_name" TEXT NOT NULL,
    "logs" TEXT,
    "rolled_back_at" DATETIME,
    "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
  )`);
}

function recordMigration(db: Database, name: string, sql: string): void {
  // Prisma's checksum is the SHA-256 of the migration file, hex encoded;
  // writing the same value keeps `prisma migrate status` happy.
  const checksum = new Bun.CryptoHasher("sha256").update(sql).digest("hex");
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO "_prisma_migrations"
       ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
     VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)`,
    [crypto.randomUUID(), checksum, now, name, now],
  );
}

function defaultMigrationsDir(): string {
  // Resolved from this file rather than from the working directory: the
  // packaged app starts the server from wherever it happens to be.
  return join(import.meta.dir, "..", "..", "prisma", "migrations");
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
