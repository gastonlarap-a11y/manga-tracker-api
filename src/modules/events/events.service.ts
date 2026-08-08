import { prisma } from "../../db/client";
import type { Manga, ReadingEvent } from "../../generated/prisma/client";
import { resolveMangaGroups } from "../../lib/manga-groups";
import {
  normalizeSlug,
  parseChapterNumber,
  seriesKeyFromUrl,
} from "../../lib/normalize";
import { isConfidentMatch, titleSimilarity } from "../../lib/similarity";
import { publishLibraryChanged } from "./events.bus";

export interface RecordReadingEventInput {
  mangaName: string;
  chapterLabel: string;
  sourceUrl: string;
  coverUrl?: string;
  /** The series page this chapter belongs to, when the site exposes one. */
  seriesUrl?: string;
}

/** Identity columns only: enough to resolve groups, cheap enough to load always. */
interface MangaIdentity {
  id: string;
  normalizedSlug: string;
  mergedIntoSlug: string | null;
  deletedAt: Date | null;
}

/** The card a reading belongs to, plus every row whose events count as its history. */
interface EventTarget {
  canonicalId: string;
  memberIds: string[];
}

/**
 * Records one reading. The server derives slug, domain and chapter number —
 * clients are never trusted with them. Events are append-only: nothing is
 * ever updated or deleted, and a LOWER but unseen chapter still inserts
 * (that is exactly the "site changed servers" case; the library projection
 * takes MAX(chapterNumber) over the whole history). The one report that does
 * not append: a chapter already present anywhere in the manga's history —
 * re-reading or reloading an existing chapter returns its stored event
 * (created: false). The optional coverUrl (og:image captured by the
 * extension) is persisted only while the manga has none (first cover wins;
 * manual covers set from the dashboard are never clobbered), even on
 * deduplicated reports.
 *
 * Everything here works on the manga's GROUP rather than on the slug's row, so
 * a series read on two sites under two titles lands on one card: see
 * resolveTarget for how a new title is matched against the library.
 */
export async function recordReadingEvent(
  input: RecordReadingEventInput,
): Promise<{ manga: Manga; event: ReadingEvent; created: boolean }> {
  const normalizedSlug = normalizeSlug(input.mangaName);
  const sourceDomain = new URL(input.sourceUrl).hostname;
  const chapterNumber = parseChapterNumber(input.chapterLabel);
  const seriesKey =
    input.seriesUrl === undefined ? null : seriesKeyFromUrl(input.seriesUrl);

  const target = await resolveTarget(
    normalizedSlug,
    input.mangaName,
    seriesKey,
  );
  let manga = await prisma.manga.findUniqueOrThrow({
    where: { id: target.canonicalId },
  });

  // Reading a deleted manga again brings it back — the deletion was a
  // statement about the library, and picking the series up again reverses it.
  // Its history is still there because the delete was soft. Only the canonical
  // needs reviving: it is the row that owns the card.
  let resurrected = false;
  if (manga.deletedAt !== null) {
    manga = await prisma.manga.update({
      where: { id: manga.id },
      data: { deletedAt: null, updatedAt: new Date() },
    });
    resurrected = true;
  }

  // First cover wins: an already-stored cover (automatic or user-set) is
  // never overwritten by later readings — clearing it from the dashboard is
  // the way to let a new one in.
  let coverChanged = false;
  if (input.coverUrl && manga.coverUrl === null) {
    manga = await prisma.manga.update({
      where: { id: manga.id },
      data: {
        coverUrl: input.coverUrl,
        coverVersion: { increment: 1 },
        updatedAt: new Date(),
      },
    });
    coverChanged = true;
  }

  // Chapter identity: the parsed number when it exists ("Cap. 49" and
  // "Chapter 49" are the same chapter); the exact label otherwise. Searched
  // across the whole group: a chapter read on the other site before the merge
  // still lives under that row's mangaId, and re-appending it here would show
  // the chapter twice on the card.
  const existing = await prisma.readingEvent.findFirst({
    where:
      chapterNumber !== null
        ? { mangaId: { in: target.memberIds }, chapterNumber }
        : {
            mangaId: { in: target.memberIds },
            chapterNumber: null,
            chapterLabel: input.chapterLabel,
          },
    orderBy: { readAt: "desc" },
  });
  if (existing) {
    if (coverChanged || resurrected) {
      publishLibraryChanged();
    }
    return { manga, event: existing, created: false };
  }

  const event = await prisma.readingEvent.create({
    data: {
      // Written against the canonical, so the card is complete without any
      // later reconciliation. Provenance is not lost: sourceDomain and
      // sourceUrl still say which site this reading came from.
      mangaId: manga.id,
      chapterLabel: input.chapterLabel,
      chapterNumber,
      sourceUrl: input.sourceUrl,
      sourceDomain,
      seriesKey,
    },
  });

  publishLibraryChanged();
  return { manga, event, created: true };
}

/**
 * Finds the card this title belongs to, creating a manga when it is genuinely
 * new.
 *
 * The series key wins over everything when the page gave one: within a site,
 * the series path is stable identity, so a site that reformats its <title>
 * cannot split a series it already tracks into a second manga.
 *
 * A slug that already exists resolves through its group, so reading on a site
 * whose manga was merged away lands on the surviving card instead of reviving
 * the duplicate.
 *
 * A slug that does NOT exist is first compared against the library: two sites
 * translating one Japanese title differently produce different slugs, and
 * letting that create a second card is the bug this whole feature exists for.
 * Above AUTO_MERGE_SCORE, and with no sequel marker in the leftover words, the
 * new row is born already merged — the duplicate card never appears. Anything
 * below is created standalone and shows up as a suggestion in /duplicates,
 * because a wrong automatic merge is worse than a duplicate the user can join
 * with one click.
 */
async function resolveTarget(
  normalizedSlug: string,
  mangaName: string,
  seriesKey: string | null,
): Promise<EventTarget> {
  let identities = await loadIdentities();

  const bySeries = await findBySeriesKey(seriesKey, identities);
  if (bySeries !== null) {
    return bySeries;
  }

  if (!identities.some((row) => row.normalizedSlug === normalizedSlug)) {
    await prisma.manga.upsert({
      // upsert, not create: two tabs reporting the same new manga at once would
      // otherwise race into a unique-constraint violation on normalizedSlug.
      where: { normalizedSlug },
      create: {
        canonicalName: mangaName,
        normalizedSlug,
        mergedIntoSlug: findConfidentCanonical(normalizedSlug, identities),
      },
      update: {},
    });
    // Re-read rather than patching the in-memory list: this reflects whatever
    // won the race, and group resolution below then holds for either outcome.
    identities = await loadIdentities();
  }

  const group = resolveMangaGroups(identities).find((candidate) =>
    [candidate.canonical, ...candidate.aliases].some(
      (member) => member.normalizedSlug === normalizedSlug,
    ),
  );
  if (group === undefined) {
    // Unreachable: the slug was just guaranteed to exist in identities.
    throw new Error(`No manga group resolved for slug ${normalizedSlug}`);
  }
  return { canonicalId: group.canonical.id, memberIds: group.memberIds };
}

/**
 * The card that already owns this series page, or null when the page carried no
 * series link or the series is new here. One indexed lookup, so the common case
 * (a series read before on the same site) costs a single row read.
 */
async function findBySeriesKey(
  seriesKey: string | null,
  identities: MangaIdentity[],
): Promise<EventTarget | null> {
  if (seriesKey === null) {
    return null;
  }
  const previous = await prisma.readingEvent.findFirst({
    where: { seriesKey },
    select: { mangaId: true },
    orderBy: { readAt: "desc" },
  });
  if (previous === null) {
    return null;
  }
  const group = resolveMangaGroups(identities).find((candidate) =>
    candidate.memberIds.includes(previous.mangaId),
  );
  // The event's manga was deleted outright (only possible through a restore):
  // fall through to title matching rather than pointing at nothing.
  if (group === undefined) {
    return null;
  }
  return { canonicalId: group.canonical.id, memberIds: group.memberIds };
}

function loadIdentities(): Promise<MangaIdentity[]> {
  return prisma.manga.findMany({
    select: {
      id: true,
      normalizedSlug: true,
      mergedIntoSlug: true,
      deletedAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * The canonical slug this new title should be merged into, or null to stand on
 * its own. Every member of a group is compared, not just its canonical: the new
 * title may read closer to an alias, and the card is the same either way.
 */
function findConfidentCanonical(
  normalizedSlug: string,
  identities: MangaIdentity[],
): string | null {
  let best: { slug: string; score: number } | null = null;

  for (const group of resolveMangaGroups(identities)) {
    // A deleted card is not a merge target; reading its title again is meant to
    // revive that card, not to fold a new series into a deleted one.
    if (group.canonical.deletedAt !== null) {
      continue;
    }
    for (const member of [group.canonical, ...group.aliases]) {
      const match = titleSimilarity(normalizedSlug, member.normalizedSlug);
      if (
        isConfidentMatch(match) &&
        (best === null || match.score > best.score)
      ) {
        best = { slug: group.canonical.normalizedSlug, score: match.score };
      }
    }
  }

  return best?.slug ?? null;
}
