import { beforeEach, describe, expect, it } from "bun:test";
import { prisma } from "../../db/client";
import { refreshProjection } from "../../db/library-projection";
import { resolveMangaGroups } from "../../lib/manga-groups";
import { chapterKey } from "../../lib/normalize";
import { getLibrary } from "./library.service";

/**
 * The library as it was computed before the read model existed — every
 * manga, every event, grouped and projected in memory on each request. Kept
 * here as the oracle the projection must always agree with.
 */
async function computedLibrary() {
  const mangas = await prisma.manga.findMany({
    include: { events: { orderBy: { readAt: "desc" } } },
    orderBy: { createdAt: "asc" },
  });
  return resolveMangaGroups(mangas)
    .filter((group) => group.canonical.deletedAt === null)
    .map((group) => {
      const events = [group.canonical, ...group.aliases]
        .flatMap((manga) => manga.events)
        .sort((a, b) => b.readAt.getTime() - a.readAt.getTime());
      let reached: { number: number; label: string } | null = null;
      for (const event of events) {
        if (
          event.chapterNumber !== null &&
          (reached === null || event.chapterNumber > reached.number)
        ) {
          reached = { number: event.chapterNumber, label: event.chapterLabel };
        }
      }
      const latest = events[0] ?? null;
      const manga = group.canonical;
      return {
        id: manga.id,
        canonicalName: manga.canonicalName,
        coverUrl: manga.coverUrl,
        coverVersion: manga.coverVersion,
        hasStoredCover: manga.coverImage !== null,
        status: manga.status,
        tags: manga.tags,
        reachedChapter: reached,
        lastActivity: latest
          ? { readAt: latest.readAt, chapterLabel: latest.chapterLabel }
          : null,
        lastSourceUrl: latest?.sourceUrl ?? null,
        readCount: new Set(events.map(chapterKey)).size,
        sourceDomains: [...new Set(events.map((event) => event.sourceDomain))],
        aliasCount: group.aliases.length,
      };
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

async function projectedLibrary() {
  return (await getLibrary({}))
    .map(({ normalizedSlug: _slug, ...entry }) => entry)
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOMAINS = ["a.com", "b.com", "c.com"];

beforeEach(async () => {
  await prisma.manga.deleteMany();
  await refreshProjection();
});

describe("the library projection", () => {
  it("agrees with computing the library from scratch, through every kind of write", async () => {
    const random = mulberry32(42);
    const pick = <T>(items: readonly T[]) =>
      items[Math.floor(random() * items.length)] as T;
    // A minute per write, so no two events tie on readAt and "the latest" is
    // never a matter of row order.
    let clock = Date.UTC(2026, 0, 1);
    const tick = () => {
      clock += 60_000;
      return new Date(clock);
    };
    const slugs: string[] = [];

    for (let step = 0; step < 300; step++) {
      const mangas = await prisma.manga.findMany({
        select: {
          id: true,
          normalizedSlug: true,
          mergedIntoSlug: true,
          deletedAt: true,
        },
      });
      const roll = random();
      if (mangas.length < 4 || roll < 0.2) {
        const slug = `serie-${slugs.length}`;
        slugs.push(slug);
        await prisma.manga.create({
          data: {
            canonicalName: `Serie ${slugs.length}`,
            normalizedSlug: slug,
            events: {
              create: {
                chapterLabel: "Cap. 1",
                chapterNumber: 1,
                sourceUrl: `https://${pick(DOMAINS)}/${slug}/1`,
                sourceDomain: pick(DOMAINS),
                readAt: tick(),
              },
            },
          },
        });
      } else if (roll < 0.5) {
        // A reading — sometimes a chapter already read, on another site.
        const manga = pick(mangas);
        const number = 1 + Math.floor(random() * 30);
        await prisma.readingEvent.create({
          data: {
            mangaId: manga.id,
            chapterLabel: random() < 0.1 ? "Extra" : `Cap. ${number}`,
            chapterNumber: random() < 0.1 ? null : number,
            sourceUrl: `https://x/${number}`,
            sourceDomain: pick(DOMAINS),
            readAt: tick(),
          },
        });
      } else if (roll < 0.6) {
        const manga = pick(mangas);
        await prisma.manga.update({
          where: { id: manga.id },
          data: {
            canonicalName: `Renombrada ${step}`,
            status: pick(["reading", "completed", "dropped"]),
            tags: JSON.stringify(random() < 0.5 ? [] : ["accion"]),
          },
        });
      } else if (roll < 0.7) {
        // Merge, unmerge or chain: any pointer, as two machines can leave it.
        const alias = pick(mangas);
        const target = pick(mangas);
        await prisma.manga.update({
          where: { id: alias.id },
          data: {
            mergedIntoSlug:
              alias.id === target.id || random() < 0.3
                ? null
                : target.normalizedSlug,
          },
        });
      } else if (roll < 0.78) {
        const manga = pick(mangas);
        await prisma.manga.update({
          where: { id: manga.id },
          data: { deletedAt: manga.deletedAt === null ? tick() : null },
        });
      } else if (roll < 0.86) {
        const manga = pick(mangas);
        await prisma.manga.update({
          where: { id: manga.id },
          data: {
            coverUrl: `https://cdn/${step}.webp`,
            coverImage: random() < 0.5 ? new Uint8Array([1, 2, 3]) : null,
            coverVersion: { increment: 1 },
          },
        });
      } else if (roll < 0.9) {
        // A row gone for good, its events with it (the cascade).
        await prisma.manga.delete({ where: { id: pick(mangas).id } });
      } else {
        // What a sync pull does: many events in one statement.
        const manga = pick(mangas);
        await prisma.readingEvent.createMany({
          data: Array.from({ length: 5 }, (_, index) => ({
            mangaId: manga.id,
            chapterLabel: `Cap. ${100 + index}`,
            chapterNumber: 100 + index,
            sourceUrl: `https://sync/${index}`,
            sourceDomain: pick(DOMAINS),
            readAt: tick(),
          })),
        });
      }

      if (step % 10 === 9) {
        expect(await projectedLibrary()).toEqual(await computedLibrary());
      }
    }
  }, 60_000);

  it("rebuilds everything when most of the library changed at once", async () => {
    // Past the threshold the refresh rebuilds rather than walks groups: the
    // first read after the migration is this case.
    await prisma.manga.createMany({
      data: Array.from({ length: 260 }, (_, index) => ({
        canonicalName: `Masiva ${index}`,
        normalizedSlug: `masiva-${index}`,
      })),
    });

    expect(await projectedLibrary()).toEqual(await computedLibrary());
    expect(await prisma.libraryDirty.count()).toBe(0);
  });

  it("keeps a mark set while a refresh was already running", async () => {
    const manga = await prisma.manga.create({
      data: { canonicalName: "Primera", normalizedSlug: "primera" },
    });
    const running = refreshProjection();
    await prisma.manga.update({
      where: { id: manga.id },
      data: { canonicalName: "Segunda" },
    });
    await running;

    const [entry] = await getLibrary({});
    expect(entry?.canonicalName).toBe("Segunda");
  });
});

describe("the triggers behind the projection", () => {
  it("are all in place after every migration", async () => {
    // Prisma alters a SQLite column by rebuilding the table, which drops its
    // triggers without a word — and then the library silently stops following
    // what is written. A migration that rebuilds one of these tables has to
    // create its triggers again; this is what notices when it did not.
    const rows = await prisma.$queryRaw<{ name: string }[]>`
      SELECT "name" FROM "sqlite_master" WHERE "type" = 'trigger' ORDER BY "name"`;

    expect(rows.map((row) => row.name)).toEqual([
      "DuplicateDismissal_titles_delete",
      "DuplicateDismissal_titles_insert",
      "DuplicateDismissal_titles_update",
      "Manga_projection_delete",
      "Manga_projection_insert",
      "Manga_projection_update",
      "Manga_titles_update",
      "ReadingEvent_projection_delete",
      "ReadingEvent_projection_insert",
      "ReadingEvent_projection_update",
    ]);
  });

  it("move the duplicates revision on a title, never on a reading or a status", async () => {
    const revision = async () =>
      (await prisma.libraryRevision.findUnique({ where: { id: 1 } }))?.titles;
    const manga = await prisma.manga.create({
      data: { canonicalName: "Uno", normalizedSlug: "uno" },
    });
    const afterCreate = await revision();

    await prisma.readingEvent.create({
      data: {
        mangaId: manga.id,
        chapterLabel: "Cap. 1",
        chapterNumber: 1,
        sourceUrl: "https://a.com/1",
        sourceDomain: "a.com",
      },
    });
    await prisma.manga.update({
      where: { id: manga.id },
      data: { status: "completed", tags: '["accion"]' },
    });
    expect(await revision()).toBe(afterCreate);

    await prisma.manga.update({
      where: { id: manga.id },
      data: { canonicalName: "Uno (renombrado)" },
    });
    expect(await revision()).toBe((afterCreate ?? 0) + 1);
  });
});
