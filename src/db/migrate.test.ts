import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, databaseFileFromUrl } from "./migrate";

// Each test gets its own database file; the suite-wide one from test-setup.ts
// is already migrated and must not be touched here.
const scratchDirs: string[] = [];

function freshDatabaseUrl(): string {
  const dir = mkdtempSync(join(tmpdir(), "migrate-test-"));
  scratchDirs.push(dir);
  return `file:${join(dir, "test.db")}`;
}

function tableNames(databaseUrl: string): string[] {
  const db = new Database(databaseUrl.slice("file:".length));
  try {
    return db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("databaseFileFromUrl", () => {
  it("unwraps the file: prefix the app passes around", () => {
    expect(databaseFileFromUrl("file:/tmp/a.db")).toBe("/tmp/a.db");
    expect(databaseFileFromUrl("file:./dev.db")).toBe("./dev.db");
  });

  it("returns null for anything that is not a local file", () => {
    // A remote libSQL server's schema is not this process's business.
    expect(databaseFileFromUrl("libsql://example.turso.io")).toBeNull();
    expect(databaseFileFromUrl("http://example.com")).toBeNull();
  });
});

describe("applyMigrations", () => {
  it("brings an empty database up to the full schema", () => {
    // The case that matters for a packaged app: a machine where nobody ever
    // ran the Prisma CLI.
    const url = freshDatabaseUrl();

    const result = applyMigrations(url);

    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.alreadyApplied).toEqual([]);
    const tables = tableNames(url);
    expect(tables).toContain("Manga");
    expect(tables).toContain("ReadingEvent");
    expect(tables).toContain("SiteAdapter");
    expect(tables).toContain("DuplicateDismissal");
    expect(tables).toContain("_prisma_migrations");
  });

  it("is idempotent: a second run applies nothing", () => {
    const url = freshDatabaseUrl();
    const first = applyMigrations(url);

    const second = applyMigrations(url);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(first.applied);
  });

  it("applies migrations in timestamp order", () => {
    const { applied } = applyMigrations(freshDatabaseUrl());
    expect(applied).toEqual([...applied].sort());
    // The very first migration has to come first, or later ALTERs hit tables
    // that do not exist yet.
    expect(applied[0]).toContain("_init");
  });

  it("applies only what is missing on a database from an older build", () => {
    // The upgrade path: a user's database is a few migrations behind because
    // it was created by a previous version of the app.
    const url = freshDatabaseUrl();
    const realDir = join(import.meta.dir, "..", "..", "prisma", "migrations");
    const all = readdirSync(realDir)
      .filter((entry) => statSync(join(realDir, entry)).isDirectory())
      .sort();

    // A migrations directory holding only the first two.
    const oldDir = mkdtempSync(join(tmpdir(), "migrate-old-"));
    scratchDirs.push(oldDir);
    for (const name of all.slice(0, 2)) {
      cpSync(join(realDir, name), join(oldDir, name), { recursive: true });
    }

    const first = applyMigrations(url, oldDir);
    expect(first.applied).toEqual(all.slice(0, 2));

    // Now the app ships with every migration: only the new ones run.
    const second = applyMigrations(url, realDir);
    expect(second.applied).toEqual(all.slice(2));
    expect(second.alreadyApplied).toEqual(all.slice(0, 2));
    expect(tableNames(url)).toContain("DuplicateDismissal");
  });

  it("records a Prisma-compatible checksum so the CLI still recognises it", () => {
    // Both paths have to work on the same database: this migrator on a user's
    // machine, `prisma migrate` on the developer's.
    const url = freshDatabaseUrl();
    applyMigrations(url);

    const db = new Database(url.slice("file:".length));
    const rows = db
      .query<{ migration_name: string; checksum: string }, []>(
        "SELECT migration_name, checksum FROM _prisma_migrations",
      )
      .all();
    db.close();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // SHA-256, hex encoded — exactly what Prisma writes.
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("leaves a non-file database alone", () => {
    const result = applyMigrations("libsql://example.turso.io");
    expect(result).toEqual({ applied: [], alreadyApplied: [] });
  });

  it("reports which migration failed instead of a bare SQL error", () => {
    const url = freshDatabaseUrl();
    const brokenDir = mkdtempSync(join(tmpdir(), "migrate-broken-"));
    scratchDirs.push(brokenDir);
    const migration = join(brokenDir, "20260101000000_broken");
    // node:fs, not `mkdir -p` through a shell: `-p` does not exist on Windows,
    // so spawning it left the directory absent and the test passed vacuously
    // everywhere except where it mattered. Writes are synchronous for the same
    // reason the rest of the migrator is — the file must be there on the next
    // line, not on the next tick.
    mkdirSync(migration, { recursive: true });
    writeFileSync(join(migration, "migration.sql"), "THIS IS NOT SQL;");

    expect(() => applyMigrations(url, brokenDir)).toThrow(
      /20260101000000_broken/,
    );
  });
});
