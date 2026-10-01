import { prisma } from "../../db/client";
import type { Manga, ReadingEvent } from "../../generated/prisma/client";
import { calendarDayIn, daysEndingOn } from "../../lib/calendar-day";
import {
  type MangaGroup,
  resolveCanonical,
  resolveMangaGroups,
} from "../../lib/manga-groups";
import { chapterKey } from "../../lib/normalize";
import { publishLibraryChanged } from "../events/events.bus";

export interface LibraryFilters {
  domain?: string;
  since?: Date;
}

type MangaWithEvents = Manga & { events: ReadingEvent[] };

export interface LibraryProjection {
  id: string;
  canonicalName: string;
  normalizedSlug: string;
  coverUrl: string | null;
  coverVersion: number;
  // True once cover bytes are stored locally — the extension uses it to know
  // which covers still need a byte backfill.
  hasStoredCover: boolean;
  status: string;
  tags: string;
  reachedChapter: { number: number; label: string } | null;
  lastActivity: { readAt: Date; chapterLabel: string } | null;
  lastSourceUrl: string | null;
  /** Distinct chapters read, NOT event rows: a chapter read on two merged sites counts once. */
  readCount: number;
  sourceDomains: string[];
  /** How many other mangas were merged into this card. 0 for an untouched entry. */
  aliasCount: number;
}

export interface UpdateMangaInput {
  canonicalName?: string;
  status?: string;
  tags?: string[];
  // string = manual cover; null = clear (the next reading may refill it)
  coverUrl?: string | null;
}

/**
 * Loads every manga with its events and collapses merged ones into groups.
 *
 * Soft-deleted rows are NOT filtered in SQL: an alias the user had deleted
 * before merging still contributes its readings to the series, and deciding
 * visibility is the canonical's job (a card exists iff its canonical is alive).
 * Filtering by deletedAt in the query would silently drop those events.
 */
async function loadGroups(): Promise<MangaGroup<MangaWithEvents>[]> {
  const mangas = await prisma.manga.findMany({
    include: { events: { orderBy: { readAt: "desc" } } },
    orderBy: { createdAt: "asc" },
  });
  return resolveMangaGroups(mangas);
}

/** Every event of the group, most recent first. Nothing is deduplicated here. */
function groupEvents(group: MangaGroup<MangaWithEvents>): ReadingEvent[] {
  return [group.canonical, ...group.aliases]
    .flatMap((manga) => manga.events)
    .sort((a, b) => b.readAt.getTime() - a.readAt.getTime());
}

/**
 * The library is a projection over the append-only event log:
 * - reachedChapter = the highest parsed chapter across the WHOLE history
 *   (real progress; a low-chapter event after a server change never lowers it)
 * - lastActivity = the most recent event, regardless of its chapter
 * Entries come back most-recently-read first (mangas without events last).
 * Volume is tiny (tens of events/day), so loading events per manga and
 * projecting in memory is simpler and strictly more correct than groupBy
 * (which cannot return the label of the max row).
 *
 * One card per GROUP: a series read on two sites under two different titles is
 * one entry, whose history is the union of both. The filters are applied to the
 * group's events rather than pushed into SQL — a `where` on the manga row would
 * miss a canonical whose only matching reading belongs to one of its aliases.
 */
export async function getLibrary(
  filters: LibraryFilters,
): Promise<LibraryProjection[]> {
  const groups = await loadGroups();

  return groups
    .filter((group) => group.canonical.deletedAt === null)
    .map((group) => ({ group, events: groupEvents(group) }))
    .filter(({ events }) => matchesFilters(events, filters))
    .map(({ group, events }) => project(group, events))
    .sort(
      (a, b) =>
        (b.lastActivity?.readAt.getTime() ?? 0) -
        (a.lastActivity?.readAt.getTime() ?? 0),
    );
}

function matchesFilters(
  events: ReadingEvent[],
  filters: LibraryFilters,
): boolean {
  if (
    filters.domain !== undefined &&
    !events.some((event) => event.sourceDomain === filters.domain)
  ) {
    return false;
  }
  const since = filters.since;
  if (since !== undefined && !events.some((event) => event.readAt >= since)) {
    return false;
  }
  return true;
}

export interface ActivityQuery {
  days: number;
  timeZone: string;
  now?: Date;
}

export interface ActivityDay {
  /** Calendar day in the query's time zone, `YYYY-MM-DD`. */
  date: string;
  chapters: number;
}

/**
 * Chapters read per calendar day over the last `days` days, oldest first, with
 * every day present — a day nothing was read on is a zero, not a gap, so the
 * dashboard draws the series without having to know the calendar.
 *
 * Counted the way `readCount` counts: distinct chapters per card. A chapter
 * read that day on two sites merged into one card is one chapter, not two.
 * Readings of a deleted card are not counted, as the card is not shown.
 */
export async function getActivity({
  days,
  timeZone,
  now = new Date(),
}: ActivityQuery): Promise<ActivityDay[]> {
  const dayOf = calendarDayIn(timeZone);
  const window = daysEndingOn(dayOf(now), days);
  const read = new Map(window.map((day) => [day, new Set<string>()]));
  // Every instant before this falls before the window's first day, whatever the
  // zone and however long a DST day is, so the newest-first scan can stop
  // there. Anything after it is placed by its day, and dropped if outside.
  const earliest = now.getTime() - (days + 1) * 86_400_000;

  for (const group of await loadGroups()) {
    if (group.canonical.deletedAt !== null) {
      continue;
    }
    for (const event of groupEvents(group)) {
      if (event.readAt.getTime() < earliest) {
        break; // groupEvents is newest first: the rest are older still.
      }
      read
        .get(dayOf(event.readAt))
        ?.add(`${group.canonical.id}:${chapterKey(event)}`);
    }
  }

  return window.map((date) => ({
    date,
    chapters: read.get(date)?.size ?? 0,
  }));
}

/**
 * The row that owns the card this id belongs to. Every write below goes through
 * it, so editing, deleting or re-covering a series does the same thing whether
 * the caller holds the canonical's id or an alias's — a card is one entity, and
 * a link saved before a merge must not act on an invisible row.
 *
 * The fast path (nothing merged) costs exactly the same single query it did
 * before this feature existed.
 */
async function loadCanonical(id: string): Promise<Manga | null> {
  const manga = await prisma.manga.findUnique({ where: { id } });
  if (manga === null || manga.mergedIntoSlug === null) {
    return manga;
  }
  const identities = await prisma.manga.findMany({
    select: { id: true, normalizedSlug: true, mergedIntoSlug: true },
  });
  const canonical = resolveCanonical(
    {
      id: manga.id,
      normalizedSlug: manga.normalizedSlug,
      mergedIntoSlug: manga.mergedIntoSlug,
    },
    new Map(identities.map((row) => [row.normalizedSlug, row])),
  );
  return canonical.id === manga.id
    ? manga
    : prisma.manga.findUnique({ where: { id: canonical.id } });
}

export interface HistoryEvent extends ReadingEvent {
  /** Other domains where this same chapter was read, after a merge. */
  alsoReadOn: string[];
}

/**
 * The history behind one card. Accepts the id of the canonical or of any alias
 * merged into it, so a link saved before a merge keeps working.
 *
 * Chapters are deduplicated across the group with the same identity the
 * ingestion uses (chapterKey): re-reading chapter 12 on the second site is the
 * same chapter, and showing it twice was the whole complaint about duplicated
 * cards, one level down. The earliest event of each chapter is the one kept —
 * it is the day the chapter was actually read for the first time.
 */
export async function getMangaHistory(id: string): Promise<{
  manga: Manga;
  /** The mangas merged into this one; the dashboard lists them to undo a merge. */
  aliases: Manga[];
  events: HistoryEvent[];
} | null> {
  const groups = await loadGroups();
  const group = groups.find((candidate) => candidate.memberIds.includes(id));
  if (group === undefined || group.canonical.deletedAt !== null) {
    return null;
  }

  const { events: _events, ...manga } = group.canonical;
  return {
    manga,
    aliases: group.aliases.map(({ events: _aliasEvents, ...alias }) => alias),
    events: dedupeChapters(groupEvents(group)),
  };
}

/** Input must be sorted most-recent-first; output keeps that order. */
function dedupeChapters(events: ReadingEvent[]): HistoryEvent[] {
  const byChapter = new Map<string, HistoryEvent>();
  // Walked oldest-first so the surviving row is the first reading; the extra
  // domains are collected onto it as later readings show up.
  for (const event of events.toReversed()) {
    const key = chapterKey(event);
    const kept = byChapter.get(key);
    if (kept === undefined) {
      byChapter.set(key, { ...event, alsoReadOn: [] });
      continue;
    }
    if (
      event.sourceDomain !== kept.sourceDomain &&
      !kept.alsoReadOn.includes(event.sourceDomain)
    ) {
      kept.alsoReadOn.push(event.sourceDomain);
    }
  }
  return [...byChapter.values()].toSorted(
    (a, b) => b.readAt.getTime() - a.readAt.getTime(),
  );
}

/**
 * Manual corrections from the dashboard: display name, reading status and
 * tags. normalizedSlug is deliberately untouched: it is the dedup key, and
 * changing it would either break future matching or collide with another
 * manga. (Renaming was also the only "fix" offered for a duplicate before
 * merging existed, and it never actually joined anything — that is what
 * POST /duplicates/merge is for.)
 */
export async function updateManga(
  id: string,
  input: UpdateMangaInput,
): Promise<Manga | null> {
  const existing = await loadCanonical(id);
  if (!existing || existing.deletedAt !== null) {
    return null;
  }
  const manga = await prisma.manga.update({
    where: { id: existing.id },
    data: {
      // Every writer stamps updatedAt by hand — see the schema comment on why
      // @updatedAt would break convergence between machines.
      updatedAt: new Date(),
      ...(input.canonicalName !== undefined
        ? { canonicalName: input.canonicalName }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.tags !== undefined ? { tags: JSON.stringify(input.tags) } : {}),
      // A new (or cleared) coverUrl invalidates bytes captured for the old
      // one; the version bump tells clients the cover identity changed.
      ...(input.coverUrl !== undefined
        ? {
            coverUrl: input.coverUrl,
            coverImage: null,
            coverImageType: null,
            coverVersion: { increment: 1 },
          }
        : {}),
    },
  });
  publishLibraryChanged();
  return manga;
}

/**
 * Cover bytes captured by the extension inside the real browser — the only
 * client that hotlink-protected/Cloudflare-walled CDNs admit. Stored in the
 * DB so covers keep working even after the source site dies.
 */
export async function storeMangaCoverImage(
  id: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<Manga | null> {
  const existing = await loadCanonical(id);
  if (!existing || existing.deletedAt !== null) {
    return null;
  }
  const manga = await prisma.manga.update({
    where: { id: existing.id },
    data: {
      coverImage: new Uint8Array(bytes),
      coverImageType: contentType,
      coverVersion: { increment: 1 },
      updatedAt: new Date(),
    },
  });
  publishLibraryChanged();
  return manga;
}

export interface CoverImage {
  body: ArrayBuffer;
  contentType: string;
}

// Prisma returns Bytes columns as views whose raw .buffer may be a shared
// pool with unrelated bytes — copying is the only safe way to an ArrayBuffer.
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

// Some cover CDNs enforce hotlink protection (img2mw.xyz serves manhwaweb
// covers only with Referer https://manhwaweb.com/), so the browser can never
// load them directly from the dashboard. Impersonating the reading site's
// referer is something only this local server can do.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const COVER_FETCH_TIMEOUT_MS = 10_000;

/**
 * A real cover is a few hundred KB; anything bigger is a wrong pick, not a
 * cover. The same cap for bytes the extension uploads and bytes this server
 * fetches itself — the proxy used to read whatever a coverUrl served, of any
 * size, straight into memory and then into the database.
 */
export const MAX_COVER_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The body of a response, or null once it grows past `max` bytes — read as a
 * stream and stopped there, because a Content-Length can be missing or wrong.
 */
export async function readBounded(
  response: Response,
  max: number,
): Promise<ArrayBuffer | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    return null;
  }
  if (response.body === null) {
    return new ArrayBuffer(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

// Only the call shape matters (Bun's `typeof fetch` also carries preconnect,
// which would force every test mock to fake it).
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// Enough for any realistic site-migration trail; the no-referer retry always
// runs after these.
const MAX_REFERER_ATTEMPTS = 4;

/**
 * Serves the manga's cover: locally stored bytes first (captured by the
 * extension in the real browser; immune to CDN blocking and site death).
 * Otherwise proxies the stored coverUrl, trying the Referer of EVERY site
 * the manga has been read on, most recent first — after a site migration the
 * cover often belongs to a previous site's CDN, which only accepts its own
 * referer (img2mw.xyz wants manhwaweb even when the latest reads happen on
 * lectorxd). A successful proxy fetch persists the bytes, so each cover is
 * fetched from its CDN at most once. fetchFn is injectable for tests.
 */
export async function fetchMangaCover(
  id: string,
  fetchFn: FetchLike = fetch,
): Promise<CoverImage | null> {
  const groups = await loadGroups();
  const group = groups.find((candidate) => candidate.memberIds.includes(id));
  if (group === undefined) {
    return null;
  }
  // Referers come from the whole group: after a merge the cover often belongs
  // to a CDN of the OTHER site of the pair, which only accepts its own referer.
  const manga = { ...group.canonical, events: groupEvents(group) };
  if (manga.coverImage !== null && manga.coverImageType !== null) {
    return {
      body: toArrayBuffer(manga.coverImage),
      contentType: manga.coverImageType,
    };
  }
  if (!manga.coverUrl) {
    return null;
  }

  let coverUrl: URL;
  try {
    coverUrl = new URL(manga.coverUrl);
  } catch {
    return null;
  }
  if (coverUrl.protocol !== "http:" && coverUrl.protocol !== "https:") {
    return null;
  }

  const domains = [
    ...new Set(manga.events.map((event) => event.sourceDomain)),
  ].slice(0, MAX_REFERER_ATTEMPTS);
  const referers = domains.length
    ? domains.map((domain) => `https://${domain}/`)
    : [`${coverUrl.origin}/`];

  let response: Response | null = null;
  for (const referer of referers) {
    response = await fetchCover(fetchFn, coverUrl.href, referer);
    if (response) {
      break;
    }
  }
  response ??= await fetchCover(fetchFn, coverUrl.href, null);
  if (!response) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return null;
  }
  const body = await readBounded(response, MAX_COVER_IMAGE_BYTES);
  if (body === null) {
    return null;
  }
  // First successful proxy fetch becomes permanent local bytes: the cover
  // survives referer changes, CDN policy changes and the site dying.
  await prisma.manga.update({
    where: { id: manga.id },
    data: {
      coverImage: new Uint8Array(body),
      coverImageType: contentType,
      coverVersion: { increment: 1 },
      updatedAt: new Date(),
    },
  });
  publishLibraryChanged();
  return { body, contentType };
}

async function fetchCover(
  fetchFn: FetchLike,
  url: string,
  referer: string | null,
): Promise<Response | null> {
  try {
    const response = await fetchFn(url, {
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        ...(referer !== null ? { Referer: referer } : {}),
      },
      signal: AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS),
    });
    return response.ok ? response : null;
  } catch {
    // Upstream unreachable or timed out — the route maps null to 404.
    return null;
  }
}

/**
 * Explicit user deletion from the dashboard. Soft: the manga disappears
 * everywhere it used to, but the row stays so the deletion can travel to the
 * other machines as a fact. Absence cannot carry that meaning — a manga missing
 * from one machine usually just means it has not synced yet.
 *
 * Events are left alone, which also keeps the append-only log intact: reading
 * the manga again resurrects it with its history (see recordReadingEvent).
 *
 * Deletes the whole group, not one row: the user deleted a card, and leaving an
 * alias alive would bring the series straight back on the next reading from the
 * other site.
 */
export async function deleteManga(id: string): Promise<boolean> {
  const groups = await loadGroups();
  const group = groups.find((candidate) => candidate.memberIds.includes(id));
  if (group === undefined || group.canonical.deletedAt !== null) {
    return false;
  }
  const now = new Date();
  await prisma.manga.updateMany({
    where: { id: { in: group.memberIds } },
    data: { deletedAt: now, updatedAt: now },
  });
  publishLibraryChanged();
  return true;
}

function project(
  group: MangaGroup<MangaWithEvents>,
  events: ReadingEvent[],
): LibraryProjection {
  const manga = group.canonical;
  // events arrive desc by readAt; strict > keeps the most recent among ties
  let reachedChapter: { number: number; label: string } | null = null;
  for (const event of events) {
    if (
      event.chapterNumber !== null &&
      (reachedChapter === null || event.chapterNumber > reachedChapter.number)
    ) {
      reachedChapter = {
        number: event.chapterNumber,
        label: event.chapterLabel,
      };
    }
  }

  // "Last activity" is the newest event, deduplicated or not — re-reading a
  // chapter on the other site IS activity, and it is where to keep reading.
  const latest = events[0] ?? null;

  return {
    id: manga.id,
    canonicalName: manga.canonicalName,
    normalizedSlug: manga.normalizedSlug,
    coverUrl: manga.coverUrl,
    coverVersion: manga.coverVersion,
    hasStoredCover: manga.coverImage !== null,
    status: manga.status,
    tags: manga.tags,
    reachedChapter,
    lastActivity: latest
      ? { readAt: latest.readAt, chapterLabel: latest.chapterLabel }
      : null,
    lastSourceUrl: latest?.sourceUrl ?? null,
    // Distinct chapters, not rows: after a merge the same chapter usually has
    // one event per site, and counting rows would double the progress shown.
    readCount: new Set(events.map(chapterKey)).size,
    sourceDomains: [...new Set(events.map((event) => event.sourceDomain))],
    aliasCount: group.aliases.length,
  };
}
