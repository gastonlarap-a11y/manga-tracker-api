import { prisma } from "../../db/client";
import {
  inChunks,
  refreshProjection,
  storedCoverIds,
} from "../../db/library-projection";
import type { Manga } from "../../generated/prisma/client";
import { candidatePairs } from "../../lib/duplicate-candidates";
import {
  dismissalKey,
  resolveCanonical,
  resolveMangaGroups,
} from "../../lib/manga-groups";
import { tagsFromJson } from "../../lib/schemas";
import {
  SUGGEST_SCORE,
  type TitleMatchReason,
  titleSimilarityAtLeast,
} from "../../lib/similarity";
import { publishLibraryChanged } from "../events/events.bus";

/** A manga row without its cover bytes, told whether it has any. */
export type PairSide = Omit<Manga, "coverImage"> & { hasStoredCover: boolean };

export interface DuplicatePair {
  a: PairSide;
  b: PairSide;
  similarity: number;
  reasons: TitleMatchReason[] | ["cover"];
  sequelSuspicion: boolean;
}

interface ScoredPair {
  aId: string;
  bId: string;
  similarity: number;
  reasons: TitleMatchReason[] | ["cover"];
  sequelSuspicion: boolean;
}

/**
 * The last answer, and the revision it was computed at. LibraryRevision.titles
 * moves only when a title, a cover, a merge, a deletion or a dismissal does —
 * never on a reading — so a library read every day keeps its report until
 * something that could change it happens.
 *
 * A promise, so a second request arriving while the first is still scoring
 * waits for that work instead of starting the same work again.
 */
let cache: { revision: number; pairs: Promise<ScoredPair[]> } | null = null;

/** Pairs scored between two turns of the event loop. */
const SCORE_SLICE = 20_000;

/**
 * Scoring a large library takes about a second, and the server has one
 * thread: done in one go, an ingestion arriving meanwhile — a chapter being
 * read right now — would wait for all of it. Between slices it does not.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Suspected duplicates among the mangas that own a card — an already-merged
 * alias is not a suspect, it is a solved case.
 *
 * Two independent signals:
 * - the title score (see titleSimilarity: fuzzy token pairing, which is what
 *   catches two sites translating the same Japanese title differently)
 * - a shared coverUrl, which is proof regardless of how the titles read: the
 *   same image on the same CDN is the same series. Byte comparison is
 *   deliberately NOT done — two sites re-encode their covers, so identical
 *   bytes across domains essentially never happen and hashing every stored
 *   cover on each request would buy nothing.
 *
 * Pairs the user rejected (DuplicateDismissal) never come back.
 *
 * Scored only where a pair could match (lib/duplicate-candidates.ts) instead
 * of every title against every other, and remembered until the titles change.
 */
export async function findDuplicatePairs(): Promise<DuplicatePair[]> {
  await refreshProjection();
  const revision = (
    await prisma.libraryRevision.findUnique({ where: { id: 1 } })
  )?.titles;
  if (revision === undefined) {
    return withRows(await scorePairs());
  }
  if (cache === null || cache.revision !== revision) {
    const pairs = scorePairs();
    const entry = { revision, pairs };
    cache = entry;
    // A failed scoring is not an answer to remember; the next request retries.
    pairs.catch(() => {
      if (cache === entry) {
        cache = null;
      }
    });
  }
  return withRows(await cache.pairs);
}

async function scorePairs(): Promise<ScoredPair[]> {
  const [entries, rows, dismissals] = await Promise.all([
    prisma.libraryEntry.findMany({ select: { mangaId: true } }),
    // Ordered by age, as they always were: which side of a pair is `a` decides
    // the order of the merge buttons, and should not move between releases.
    // Every alive row, narrowed to the cards in memory below: an IN of every
    // card's id is past the driver's parameter limit in a large library.
    prisma.manga.findMany({
      where: { deletedAt: null },
      select: { id: true, normalizedSlug: true, coverUrl: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.duplicateDismissal.findMany({
      select: { slugA: true, slugB: true },
    }),
  ]);
  const cards = new Set(entries.map((entry) => entry.mangaId));
  const candidates = rows.filter((row) => cards.has(row.id));
  const rejected = new Set(
    dismissals.map((row) => `${row.slugA}|${row.slugB}`),
  );

  const isRejected = (slugA: string, slugB: string) => {
    const key = dismissalKey(slugA, slugB);
    return rejected.has(`${key.slugA}|${key.slugB}`);
  };

  const pairs: ScoredPair[] = [];
  const candidateIndexes = candidatePairs(
    candidates.map((manga) => ({
      slug: manga.normalizedSlug,
      coverUrl: manga.coverUrl,
    })),
  );
  for (let index = 0; index < candidateIndexes.length; index++) {
    if (index > 0 && index % SCORE_SLICE === 0) {
      await yieldToEventLoop();
    }
    const [i, j] = candidateIndexes[index] as [number, number];
    const [a, b] = [candidates[i], candidates[j]];
    if (a === undefined || b === undefined) {
      continue;
    }
    // Dismissals are checked on what matched, not on every candidate: the
    // key is a string built per pair, and almost no candidate matches.
    if (a.coverUrl !== null && a.coverUrl === b.coverUrl) {
      if (!isRejected(a.normalizedSlug, b.normalizedSlug)) {
        pairs.push({
          aId: a.id,
          bId: b.id,
          similarity: 1,
          reasons: ["cover"],
          sequelSuspicion: false,
        });
      }
      continue;
    }
    const match = titleSimilarityAtLeast(
      a.normalizedSlug,
      b.normalizedSlug,
      SUGGEST_SCORE,
    );
    if (match !== null && !isRejected(a.normalizedSlug, b.normalizedSlug)) {
      pairs.push({
        aId: a.id,
        bId: b.id,
        similarity: match.score,
        reasons: match.reasons,
        sequelSuspicion: match.sequelSuspicion,
      });
    }
  }
  // Stable, and the candidates came in (i, j) order: equal scores keep the
  // order a full double loop would have produced.
  return pairs.toSorted((x, y) => y.similarity - x.similarity);
}

/**
 * The cached pairs with their rows read fresh — a status or a tag changes
 * without moving the revision, and the report must show the current one.
 */
async function withRows(
  pairs: readonly ScoredPair[],
): Promise<DuplicatePair[]> {
  const ids = [...new Set(pairs.flatMap((pair) => [pair.aId, pair.bId]))];
  if (ids.length === 0) {
    return [];
  }
  const [rows, stored] = await Promise.all([
    inChunks(ids, (chunk) =>
      prisma.manga.findMany({
        where: { id: { in: chunk } },
        omit: { coverImage: true },
      }),
    ),
    storedCoverIds(ids),
  ]);
  const byId = new Map(
    rows.map((row) => [row.id, { ...row, hasStoredCover: stored.has(row.id) }]),
  );
  return pairs.flatMap((pair) => {
    const a = byId.get(pair.aId);
    const b = byId.get(pair.bId);
    return a !== undefined && b !== undefined
      ? [
          {
            a,
            b,
            similarity: pair.similarity,
            reasons: pair.reasons,
            sequelSuspicion: pair.sequelSuspicion,
          },
        ]
      : [];
  });
}

export type MergeOutcome =
  | { kind: "merged"; canonical: Manga; alias: Manga }
  | { kind: "already-merged"; canonical: Manga }
  | { kind: "not-found"; id: string };

/**
 * Declares two mangas to be the same series. GROUPS are merged, not rows: both
 * ids are first resolved to the canonical that owns their card, so the caller
 * can pass any member of either side and chains can never form — every alias of
 * the absorbed group is re-pointed at the surviving canonical in one go.
 *
 * No ReadingEvent is touched. The absorbed rows keep their events exactly where
 * they were written, and the library projection reads them through the group —
 * which is why unmerge can restore both histories intact, and why this does not
 * violate the append-only rule that kept merging out of the project until now.
 *
 * This is also the manual path from the dashboard: two titles with nothing in
 * common (a Spanish one and an English one) are merged here, since no local
 * heuristic can ever relate them.
 */
export async function mergeMangas(
  canonicalId: string,
  aliasId: string,
): Promise<MergeOutcome> {
  const mangas = await prisma.manga.findMany();
  const byId = new Map(mangas.map((manga) => [manga.id, manga]));
  const bySlug = new Map(mangas.map((manga) => [manga.normalizedSlug, manga]));

  const requestedCanonical = byId.get(canonicalId);
  if (requestedCanonical === undefined) {
    return { kind: "not-found", id: canonicalId };
  }
  const requestedAlias = byId.get(aliasId);
  if (requestedAlias === undefined) {
    return { kind: "not-found", id: aliasId };
  }

  const canonical = resolveCanonical(requestedCanonical, bySlug);
  const alias = resolveCanonical(requestedAlias, bySlug);
  if (canonical.id === alias.id) {
    return { kind: "already-merged", canonical };
  }

  // Everything in the absorbed group, including its own canonical, points at
  // the survivor. Flattening here is what keeps resolveCanonical's walk short
  // and makes an A->B->C chain unrepresentable.
  const absorbedIds = resolveMangaGroups(mangas)
    .filter((group) => group.canonical.id === alias.id)
    .flatMap((group) => group.memberIds);
  const now = new Date();

  const [updatedCanonical] = await prisma.$transaction([
    prisma.manga.update({
      where: { id: canonical.id },
      data: {
        // The survivor takes what the absorbed row had and it lacked: a cover
        // the user already saw, and the union of both tag sets. Its own status
        // and name win — that is what "canonical" means here.
        ...(canonical.coverUrl === null && alias.coverUrl !== null
          ? { coverUrl: alias.coverUrl, coverVersion: { increment: 1 } }
          : {}),
        tags: JSON.stringify(mergeTags(canonical.tags, alias.tags)),
        // Merging into a manga the user had deleted must not hide the series
        // that is demonstrably being read.
        ...(canonical.deletedAt !== null && alias.deletedAt === null
          ? { deletedAt: null }
          : {}),
        updatedAt: now,
      },
    }),
    prisma.manga.updateMany({
      where: { id: { in: absorbedIds } },
      data: { mergedIntoSlug: canonical.normalizedSlug, updatedAt: now },
    }),
  ]);

  publishLibraryChanged();
  return { kind: "merged", canonical: updatedCanonical, alias };
}

export type UnmergeOutcome =
  | { kind: "unmerged"; manga: Manga }
  | { kind: "not-merged"; manga: Manga }
  | { kind: "not-found"; id: string };

/**
 * Detaches one alias from its group. Free to do and free to undo, because the
 * merge never moved anything: the row gets its card back with the history it
 * always owned.
 */
export async function unmergeManga(id: string): Promise<UnmergeOutcome> {
  const manga = await prisma.manga.findUnique({ where: { id } });
  if (manga === null) {
    return { kind: "not-found", id };
  }
  if (manga.mergedIntoSlug === null) {
    return { kind: "not-merged", manga };
  }

  const updated = await prisma.manga.update({
    where: { id },
    data: { mergedIntoSlug: null, updatedAt: new Date() },
  });
  publishLibraryChanged();
  return { kind: "unmerged", manga: updated };
}

export type DismissOutcome =
  | { kind: "dismissed"; slugA: string; slugB: string }
  | { kind: "not-found"; id: string };

/**
 * "These two are NOT the same manga." Without it, lowering the suggestion
 * threshold would mean re-reading the same false positive forever.
 */
export async function dismissDuplicatePair(
  idA: string,
  idB: string,
): Promise<DismissOutcome> {
  const a = await prisma.manga.findUnique({ where: { id: idA } });
  if (a === null) {
    return { kind: "not-found", id: idA };
  }
  const b = await prisma.manga.findUnique({ where: { id: idB } });
  if (b === null) {
    return { kind: "not-found", id: idB };
  }

  const key = dismissalKey(a.normalizedSlug, b.normalizedSlug);
  const now = new Date();
  await prisma.duplicateDismissal.upsert({
    where: { slugA_slugB: key },
    create: { ...key, updatedAt: now },
    update: { updatedAt: now },
  });

  publishLibraryChanged();
  return { kind: "dismissed", ...key };
}

// Tags are a JSON string column; tagsFromJson degrades a corrupt value to [],
// so a manga with a broken tags column can still be merged.
function mergeTags(rawA: string, rawB: string): string[] {
  return [...new Set([...tagsFromJson(rawA), ...tagsFromJson(rawB)])];
}
