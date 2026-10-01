import { prisma } from "../../db/client";
import {
  inChunks,
  NEVER_READ,
  refreshProjection,
  storedCoverIds,
} from "../../db/library-projection";
import type {
  LibraryEntry,
  Manga,
  Prisma,
  ReadingEvent,
} from "../../generated/prisma/client";
import { calendarDayIn, daysEndingOn } from "../../lib/calendar-day";
import { chapterKey } from "../../lib/normalize";
import { searchKeyOf } from "../../lib/search-key";
import { publishLibraryChanged } from "../events/events.bus";

export interface LibraryFilters {
  domain?: string;
  since?: Date;
}

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

/** A card as the routes render it, from its row in the read model. */
function toProjection(entry: LibraryEntry): LibraryProjection {
  return {
    id: entry.mangaId,
    canonicalName: entry.canonicalName,
    normalizedSlug: entry.normalizedSlug,
    coverUrl: entry.coverUrl,
    coverVersion: entry.coverVersion,
    hasStoredCover: entry.hasStoredCover,
    status: entry.status,
    tags: entry.tags,
    reachedChapter:
      entry.reachedNumber !== null && entry.reachedLabel !== null
        ? { number: entry.reachedNumber, label: entry.reachedLabel }
        : null,
    lastActivity:
      entry.lastReadAt.getTime() > NEVER_READ.getTime() &&
      entry.lastChapterLabel !== null
        ? { readAt: entry.lastReadAt, chapterLabel: entry.lastChapterLabel }
        : null,
    lastSourceUrl: entry.lastSourceUrl,
    readCount: entry.readCount,
    // Cast justified: written by projectEntry as a JSON array of strings.
    sourceDomains: JSON.parse(entry.sourceDomains) as string[],
    aliasCount: entry.aliasCount,
  };
}

export type LibrarySort = "recent" | "title" | "chapters";

export interface LibraryQuery extends LibraryFilters {
  /** One status, or every card when absent. */
  status?: string;
  /** Matched against the title, accents and case ignored. */
  q?: string;
  /** Every one of these, not any. */
  tags?: string[];
}

function whereFor(query: LibraryQuery): Prisma.LibraryEntryWhereInput {
  const and: Prisma.LibraryEntryWhereInput[] = [];
  if (query.domain !== undefined) {
    and.push({ domains: { some: { domain: query.domain } } });
  }
  // A card read since then is one whose newest event is since then — which
  // is what "has any event since" meant over the whole group.
  if (query.since !== undefined) {
    and.push({ lastReadAt: { gte: query.since } });
  }
  if (query.status !== undefined) {
    and.push({ status: query.status });
  }
  const needle = query.q === undefined ? "" : searchKeyOf(query.q);
  if (needle !== "") {
    and.push({ searchKey: { contains: needle } });
  }
  for (const tag of query.tags ?? []) {
    // Tags are stored as a JSON array; the quotes make "accion" match the tag
    // and never a longer one that contains it.
    and.push({ tags: { contains: JSON.stringify(tag) } });
  }
  return { AND: and };
}

const RECENT: Prisma.LibraryEntryOrderByWithRelationInput[] = [
  { lastReadAt: "desc" },
  { mangaId: "asc" },
];

/**
 * Every card, most recently read first (never-read ones last).
 *
 * The whole library in one answer: what the browser extension asks for, and
 * what it will go on asking for in the version already in people's browsers.
 * The dashboard reads it a page at a time instead (getLibraryPage).
 */
export async function getLibrary(
  filters: LibraryFilters,
): Promise<LibraryProjection[]> {
  await refreshProjection();
  const entries = await prisma.libraryEntry.findMany({
    where: whereFor(filters),
    orderBy: RECENT,
  });
  return entries.map(toProjection);
}

export interface LibraryPageQuery extends LibraryQuery {
  sort: LibrarySort;
  limit: number;
  /** From the previous page's nextCursor; absent for the first page. */
  cursor?: string;
}

export interface LibraryPage {
  items: LibraryProjection[];
  /** Null on the last page. */
  nextCursor: string | null;
}

/**
 * Where a page ended, by value rather than by row: a keyset cursor still
 * points somewhere sensible after the card it was taken from changed or went
 * away, which a cursor naming a row does not.
 */
interface PageCursor {
  /** The sort key of the last card shown: ms for recent, text, or a count. */
  k: number | string;
  id: string;
}

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** The cursor, or null for one this server did not write. */
export function decodeCursor(raw: string): PageCursor | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      "k" in value &&
      typeof value.id === "string" &&
      (typeof value.k === "number" || typeof value.k === "string")
    ) {
      return { k: value.k, id: value.id };
    }
    return null;
  } catch {
    return null;
  }
}

function afterCursor(
  sort: LibrarySort,
  cursor: PageCursor,
): Prisma.LibraryEntryWhereInput {
  const tie = { mangaId: { gt: cursor.id } };
  switch (sort) {
    case "recent": {
      const at = new Date(Number(cursor.k));
      return { OR: [{ lastReadAt: { lt: at } }, { lastReadAt: at, ...tie }] };
    }
    case "title": {
      const key = String(cursor.k);
      return { OR: [{ sortKey: { gt: key } }, { sortKey: key, ...tie }] };
    }
    case "chapters": {
      const count = Number(cursor.k);
      return {
        OR: [{ readCount: { lt: count } }, { readCount: count, ...tie }],
      };
    }
  }
}

const ORDER: Record<
  LibrarySort,
  Prisma.LibraryEntryOrderByWithRelationInput[]
> = {
  recent: RECENT,
  title: [{ sortKey: "asc" }, { mangaId: "asc" }],
  chapters: [{ readCount: "desc" }, { mangaId: "asc" }],
};

function cursorOf(sort: LibrarySort, entry: LibraryEntry): PageCursor {
  switch (sort) {
    case "recent":
      return { k: entry.lastReadAt.getTime(), id: entry.mangaId };
    case "title":
      return { k: entry.sortKey, id: entry.mangaId };
    case "chapters":
      return { k: entry.readCount, id: entry.mangaId };
  }
}

/**
 * One page of cards, filtered, searched and ordered by the database: the cost
 * is the page, whatever the size of the library behind it.
 */
export async function getLibraryPage(
  query: LibraryPageQuery,
): Promise<LibraryPage> {
  await refreshProjection();
  const where = whereFor(query);
  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (cursor !== null) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      afterCursor(query.sort, cursor),
    ];
  }
  // One more than asked: whether it comes back says if there is a next page.
  const rows = await prisma.libraryEntry.findMany({
    where,
    orderBy: ORDER[query.sort],
    take: query.limit + 1,
  });
  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items: items.map(toProjection),
    nextCursor:
      rows.length > query.limit && last !== undefined
        ? encodeCursor(cursorOf(query.sort, last))
        : null,
  };
}

export interface LibrarySummary {
  counts: { reading: number; completed: number; dropped: number; all: number };
  chapters: number;
  sites: number;
  activeThisWeek: number;
  /** Every site any card was read on, for the filter. */
  domains: string[];
  /** Every tag in use, for the filter. */
  tags: string[];
}

const WEEK_MS = 7 * 86_400_000;

/**
 * The library's totals — the stats tiles, the counts on the status tabs and
 * the options of the filters — computed by the database over the read model,
 * so the dashboard never needs every card to show them.
 */
export async function getLibrarySummary(
  now: Date = new Date(),
): Promise<LibrarySummary> {
  await refreshProjection();
  const [byStatus, sums, domains, activeThisWeek, tagged] = await Promise.all([
    prisma.libraryEntry.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.libraryEntry.aggregate({ _sum: { readCount: true } }),
    // groupBy, not findMany's `distinct`: Prisma applies that one in memory,
    // after reading a row per card and site — tens of thousands at scale —
    // where GROUP BY is answered from the domain index.
    prisma.libraryEntryDomain.groupBy({
      by: ["domain"],
      orderBy: { domain: "asc" },
    }),
    prisma.libraryEntry.count({
      where: { lastReadAt: { gte: new Date(now.getTime() - WEEK_MS) } },
    }),
    prisma.libraryEntry.findMany({
      where: { tags: { not: "[]" } },
      select: { tags: true },
    }),
  ]);

  const counts = { reading: 0, completed: 0, dropped: 0, all: 0 };
  for (const row of byStatus) {
    if (row.status === "completed" || row.status === "dropped") {
      counts[row.status] += row._count._all;
    } else {
      // Anything unrecognised is shown as reading, as statusFromDb reads it.
      counts.reading += row._count._all;
    }
    counts.all += row._count._all;
  }
  const tags = new Set<string>();
  for (const row of tagged) {
    // Cast justified: written by updateManga as JSON.stringify(string[]).
    for (const tag of JSON.parse(row.tags) as string[]) {
      tags.add(tag);
    }
  }

  return {
    counts,
    chapters: sums._sum.readCount ?? 0,
    sites: domains.length,
    activeThisWeek,
    domains: domains.map((row) => row.domain),
    tags: [...tags].toSorted(),
  };
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
 *
 * Reads the window and nothing else (the readAt index), so it costs the days
 * asked for, not the years of history behind them.
 */
export async function getActivity({
  days,
  timeZone,
  now = new Date(),
}: ActivityQuery): Promise<ActivityDay[]> {
  await refreshProjection();
  const dayOf = calendarDayIn(timeZone);
  const window = daysEndingOn(dayOf(now), days);
  const read = new Map(window.map((day) => [day, new Set<string>()]));
  // Every instant before this falls before the window's first day, whatever the
  // zone and however long a DST day is. Anything after it is placed by its
  // day, and dropped if outside.
  const earliest = new Date(now.getTime() - (days + 1) * 86_400_000);

  const events = await prisma.readingEvent.findMany({
    where: { readAt: { gte: earliest } },
    select: {
      mangaId: true,
      chapterNumber: true,
      chapterLabel: true,
      readAt: true,
    },
  });
  if (events.length > 0) {
    // Twelve weeks of a heavy reader touch thousands of series: more ids than
    // one IN may carry.
    const members = await inChunks(
      [...new Set(events.map((e) => e.mangaId))],
      (chunk) =>
        prisma.libraryMember.findMany({ where: { memberId: { in: chunk } } }),
    );
    const canonicalOf = new Map(
      members.map((member) => [member.memberId, member.canonicalId]),
    );
    const alive = new Set(
      (
        await inChunks([...new Set(canonicalOf.values())], (chunk) =>
          prisma.libraryEntry.findMany({
            where: { mangaId: { in: chunk } },
            select: { mangaId: true },
          }),
        )
      ).map((entry) => entry.mangaId),
    );
    for (const event of events) {
      const canonical = canonicalOf.get(event.mangaId);
      if (canonical === undefined || !alive.has(canonical)) {
        continue;
      }
      read.get(dayOf(event.readAt))?.add(`${canonical}:${chapterKey(event)}`);
    }
  }

  return window.map((date) => ({
    date,
    chapters: read.get(date)?.size ?? 0,
  }));
}

interface GroupRef {
  canonicalId: string;
  memberIds: string[];
}

/**
 * The card an id belongs to — the canonical's or any alias's, so a link saved
 * before a merge keeps working — with every member of it. Two indexed lookups
 * in the read model, where it used to load the whole library to find one.
 */
async function loadGroupOf(id: string): Promise<GroupRef | null> {
  await refreshProjection();
  const member = await prisma.libraryMember.findUnique({
    where: { memberId: id },
  });
  if (member === null) {
    return null;
  }
  const members = await prisma.libraryMember.findMany({
    where: { canonicalId: member.canonicalId },
    select: { memberId: true },
  });
  return {
    canonicalId: member.canonicalId,
    memberIds: members.map((row) => row.memberId),
  };
}

/** Whether the card is shown: its canonical is alive. */
async function hasCard(canonicalId: string): Promise<boolean> {
  const entry = await prisma.libraryEntry.findUnique({
    where: { mangaId: canonicalId },
    select: { mangaId: true },
  });
  return entry !== null;
}

/**
 * The row that owns the card this id belongs to. Every write below goes through
 * it, so editing, deleting or re-covering a series does the same thing whether
 * the caller holds the canonical's id or an alias's — a card is one entity, and
 * a link saved before a merge must not act on an invisible row.
 */
async function loadCanonical(id: string): Promise<Manga | null> {
  const group = await loadGroupOf(id);
  return prisma.manga.findUnique({ where: { id: group?.canonicalId ?? id } });
}

export interface HistoryEvent extends ReadingEvent {
  /** Other domains where this same chapter was read, after a merge. */
  alsoReadOn: string[];
}

/** A manga row without its cover bytes, told whether it has any. */
export type MangaRow = Omit<Manga, "coverImage"> & { hasStoredCover: boolean };

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
  manga: MangaRow;
  /** The mangas merged into this one; the dashboard lists them to undo a merge. */
  aliases: MangaRow[];
  events: HistoryEvent[];
} | null> {
  const group = await loadGroupOf(id);
  if (group === null || !(await hasCard(group.canonicalId))) {
    return null;
  }
  const [rows, stored, events] = await Promise.all([
    prisma.manga.findMany({
      where: { id: { in: group.memberIds } },
      omit: { coverImage: true },
      orderBy: { createdAt: "asc" },
    }),
    storedCoverIds(group.memberIds),
    prisma.readingEvent.findMany({
      where: { mangaId: { in: group.memberIds } },
      orderBy: { readAt: "desc" },
    }),
  ]);
  const withFlag = rows.map((row) => ({
    ...row,
    hasStoredCover: stored.has(row.id),
  }));
  const manga = withFlag.find((row) => row.id === group.canonicalId);
  if (manga === undefined) {
    return null;
  }
  return {
    manga,
    aliases: withFlag.filter((row) => row.id !== group.canonicalId),
    events: dedupeChapters(events),
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
 *
 * Reads one row and the card's domains — it used to load the whole library,
 * once per cover the grid asked for.
 */
export async function fetchMangaCover(
  id: string,
  fetchFn: FetchLike = fetch,
): Promise<CoverImage | null> {
  const group = await loadGroupOf(id);
  if (group === null) {
    return null;
  }
  const manga = await prisma.manga.findUnique({
    where: { id: group.canonicalId },
    select: {
      id: true,
      coverUrl: true,
      coverImage: true,
      coverImageType: true,
    },
  });
  if (manga === null) {
    return null;
  }
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

  // Referers come from the whole group: after a merge the cover often belongs
  // to a CDN of the OTHER site of the pair, which only accepts its own referer.
  const domains = (await groupDomains(group)).slice(0, MAX_REFERER_ATTEMPTS);
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

/**
 * The sites a card was read on, most recent first: from the read model while
 * the card is shown, from its events when it is not (a deleted card still has
 * a cover to serve to a link that points at it).
 */
async function groupDomains(group: GroupRef): Promise<string[]> {
  const entry = await prisma.libraryEntry.findUnique({
    where: { mangaId: group.canonicalId },
    select: { sourceDomains: true },
  });
  if (entry !== null) {
    // Cast justified: written by projectEntry as a JSON array of strings.
    return JSON.parse(entry.sourceDomains) as string[];
  }
  const events = await prisma.readingEvent.findMany({
    where: { mangaId: { in: group.memberIds } },
    select: { sourceDomain: true },
    orderBy: { readAt: "desc" },
  });
  return [...new Set(events.map((event) => event.sourceDomain))];
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
  const group = await loadGroupOf(id);
  if (group === null || !(await hasCard(group.canonicalId))) {
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
