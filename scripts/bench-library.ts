/**
 * The library at the size it is designed for, measured.
 *
 *   bun run bench:library [series=10000] [events=1000000]
 *
 * Builds a throwaway database with that many series and readings — a few
 * series with thousands of chapters, most with tens, read across three years
 * on a couple of dozen sites — then times every read the dashboard makes, the
 * way the library used to be computed for comparison, and a reading arriving
 * while it is all in place. Nothing touches the real database or the network.
 */
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const series = Number(Bun.argv[2] ?? 10_000);
const totalEvents = Number(Bun.argv[3] ?? 1_000_000);

const dbPath = join(tmpdir(), `manga-tracker-bench-${process.pid}.db`);
// Before any module reads the configuration, as the test setup does.
Bun.env.DATABASE_URL = `file:${dbPath}`;
delete Bun.env.MONGODB_URL;

const { applyMigrations } = await import("../src/db/migrate");
applyMigrations(Bun.env.DATABASE_URL);

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(2026);

// ---- build ------------------------------------------------------------------

const syllables = [
  "ka",
  "ri",
  "to",
  "ma",
  "shi",
  "ne",
  "ra",
  "yu",
  "ko",
  "da",
  "mo",
  "ze",
  "fu",
  "re",
  "gi",
  "lo",
  "pe",
  "su",
  "ha",
  "ni",
];
const word = () =>
  Array.from(
    { length: 2 + Math.floor(random() * 3) },
    () => syllables[Math.floor(random() * syllables.length)],
  ).join("");
const domains = Array.from({ length: 24 }, (_, index) => `site${index}.com`);

// Pareto-like: a handful of series carry most of the chapters.
const weights = Array.from(
  { length: series },
  () => 1 / (random() ** 1.6 + 0.02),
);
const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

const db = new Database(dbPath);
const insertManga = db.prepare(
  `INSERT INTO "Manga" ("id","canonicalName","normalizedSlug","coverUrl","coverImage","coverImageType","status","tags","createdAt","updatedAt")
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
);
const insertEvent = db.prepare(
  `INSERT INTO "ReadingEvent" ("id","mangaId","chapterLabel","chapterNumber","sourceUrl","sourceDomain","readAt")
   VALUES (?,?,?,?,?,?,?)`,
);
const now = Date.now();
const threeYears = 3 * 365 * 86_400_000;
const ids: string[] = [];
// Written the way Prisma writes a DateTime here: ISO text with an explicit
// offset. A number would compare as smaller than every text value, and each
// date-bounded query would quietly find nothing — measuring nothing.
const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "+00:00");

const buildStart = performance.now();
db.run("BEGIN");
for (let index = 0; index < series; index++) {
  const id = crypto.randomUUID();
  ids.push(id);
  const name = Array.from({ length: 2 + Math.floor(random() * 5) }, word).join(
    " ",
  );
  insertManga.run(
    id,
    name,
    `${name.replaceAll(" ", "-")}-${index}`,
    `https://cdn.example/${index}.webp`,
    // One cover in five stored as bytes, as the extension leaves them.
    random() < 0.2 ? new Uint8Array(24_000) : null,
    random() < 0.2 ? "image/webp" : null,
    random() < 0.85 ? "reading" : random() < 0.5 ? "completed" : "dropped",
    random() < 0.1 ? '["accion"]' : "[]",
    iso(now - threeYears),
    iso(now - threeYears),
  );
}
let written = 0;
for (let index = 0; index < series; index++) {
  const count = Math.max(
    1,
    Math.round((weights[index] / weightSum) * totalEvents),
  );
  const id = ids[index] as string;
  for (let chapter = 1; chapter <= count && written < totalEvents; chapter++) {
    insertEvent.run(
      crypto.randomUUID(),
      id,
      `Cap. ${chapter}`,
      chapter,
      `https://x/${chapter}`,
      domains[Math.floor(random() * domains.length)] as string,
      iso(now - Math.floor(random() * threeYears)),
    );
    written++;
  }
}
db.run("COMMIT");
db.close();
const buildMs = performance.now() - buildStart;

// ---- measure ----------------------------------------------------------------

const { prisma } = await import("../src/db/client");
const { refreshProjection } = await import("../src/db/library-projection");
const library = await import("../src/modules/library/library.service");
const duplicates = await import("../src/modules/duplicates/duplicates.service");

const rows: [string, string][] = [];
async function time<T>(
  label: string,
  run: () => Promise<T>,
  repeat = 5,
): Promise<T> {
  let result: T | undefined;
  const samples: number[] = [];
  for (let attempt = 0; attempt < repeat; attempt++) {
    const start = performance.now();
    result = await run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] as number;
  rows.push([label, `${median.toFixed(1)} ms`]);
  return result as T;
}

await time("first refresh (whole projection)", () => refreshProjection(), 1);
const firstPage = await time("page: 60 most recent", () =>
  library.getLibraryPage({ sort: "recent", limit: 60 }),
);
await time("page: 60 most recent, reading only", () =>
  library.getLibraryPage({ sort: "recent", limit: 60, status: "reading" }),
);
await time("page: deep (cursor after 5 pages)", async () => {
  let cursor = firstPage.nextCursor ?? undefined;
  for (let page = 0; page < 4 && cursor !== undefined; page++) {
    cursor =
      (await library.getLibraryPage({ sort: "recent", limit: 60, cursor }))
        .nextCursor ?? undefined;
  }
  return library.getLibraryPage({ sort: "recent", limit: 60, cursor });
});
await time("page: A–Z", () =>
  library.getLibraryPage({ sort: "title", limit: 60 }),
);
await time("page: most chapters", () =>
  library.getLibraryPage({ sort: "chapters", limit: 60 }),
);
await time("page: search 'ka'", () =>
  library.getLibraryPage({ sort: "recent", limit: 60, q: "ka" }),
);
await time("page: one site", () =>
  library.getLibraryPage({ sort: "recent", limit: 60, domain: "site3.com" }),
);
await time("summary (stats, counts, filters)", () =>
  library.getLibrarySummary(),
);
const activity = await time("activity: 12 weeks", () =>
  library.getActivity({ days: 84, timeZone: "America/Santiago" }),
);
// A benchmark that reads nothing measures nothing: say what was counted.
const counted = activity.reduce((sum, day) => sum + day.chapters, 0);
rows.push(["  (chapters in that window)", counted.toLocaleString()]);
const biggest = (
  await prisma.libraryEntry.findFirst({ orderBy: { readCount: "desc" } })
)?.mangaId as string;
await time("history: the longest series", () =>
  library.getMangaHistory(biggest),
);
await time("cover: one lookup", () =>
  library.fetchMangaCover(ids[1] as string),
);
await time(
  "duplicates: cold",
  async () => {
    // A dismissal moves the revision, so this always recomputes.
    await prisma.duplicateDismissal.create({
      data: { slugA: `x${performance.now()}`, slugB: "y" },
    });
    return duplicates.findDuplicatePairs();
  },
  3,
);
await time("duplicates: warm (cached)", () => duplicates.findDuplicatePairs());
await time(
  "whole library, one list (the extension)",
  () => library.getLibrary({}),
  3,
);
await time("a reading arrives, then the first page", async () => {
  await prisma.readingEvent.create({
    data: {
      mangaId: ids[7] as string,
      chapterLabel: "Cap. 9999",
      chapterNumber: 9999,
      sourceUrl: "https://x/9999",
      sourceDomain: "site1.com",
    },
  });
  return library.getLibraryPage({ sort: "recent", limit: 60 });
});
await time(
  "before: the library as it used to be read",
  async () => {
    // What every request did: every manga with its cover bytes and every event.
    const mangas = await prisma.manga.findMany({ include: { events: true } });
    return mangas.length;
  },
  1,
);

console.log(
  `\n${series.toLocaleString()} series, ${written.toLocaleString()} readings — built (triggers firing) in ${(buildMs / 1000).toFixed(1)} s\n`,
);
const width = Math.max(...rows.map(([label]) => label.length));
for (const [label, value] of rows) {
  console.log(`${label.padEnd(width)}  ${value}`);
}

await prisma.$disconnect();
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  rmSync(dbPath + suffix, { force: true });
}
