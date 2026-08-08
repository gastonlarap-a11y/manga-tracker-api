import { prisma } from "../../db/client";
import type { Manga } from "../../generated/prisma/client";
import {
  dismissalKey,
  resolveCanonical,
  resolveMangaGroups,
} from "../../lib/manga-groups";
import { tagsFromJson } from "../../lib/schemas";
import {
  SUGGEST_SCORE,
  type TitleMatchReason,
  titleSimilarity,
} from "../../lib/similarity";
import { publishLibraryChanged } from "../events/events.bus";

export interface DuplicatePair {
  a: Manga;
  b: Manga;
  similarity: number;
  reasons: TitleMatchReason[] | ["cover"];
  sequelSuspicion: boolean;
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
 */
export async function findDuplicatePairs(): Promise<DuplicatePair[]> {
  const [mangas, dismissals] = await Promise.all([
    prisma.manga.findMany({
      // A deleted manga is not a duplicate candidate; its row only lingers so
      // the deletion can reach the other machines.
      where: { deletedAt: null },
      orderBy: { createdAt: "asc" },
    }),
    prisma.duplicateDismissal.findMany(),
  ]);

  const rejected = new Set(
    dismissals.map((row) => `${row.slugA}|${row.slugB}`),
  );
  const candidates = resolveMangaGroups(mangas).map((group) => group.canonical);

  // O(n²) over tens of mangas — sub-millisecond, not worth anything smarter.
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const [a, b] = [candidates[i], candidates[j]];
      const key = dismissalKey(a.normalizedSlug, b.normalizedSlug);
      if (rejected.has(`${key.slugA}|${key.slugB}`)) {
        continue;
      }

      if (a.coverUrl !== null && a.coverUrl === b.coverUrl) {
        pairs.push({
          a,
          b,
          similarity: 1,
          reasons: ["cover"],
          sequelSuspicion: false,
        });
        continue;
      }

      const match = titleSimilarity(a.normalizedSlug, b.normalizedSlug);
      if (match.score >= SUGGEST_SCORE) {
        pairs.push({
          a,
          b,
          similarity: match.score,
          reasons: match.reasons,
          sequelSuspicion: match.sequelSuspicion,
        });
      }
    }
  }

  return pairs.toSorted((x, y) => y.similarity - x.similarity);
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
