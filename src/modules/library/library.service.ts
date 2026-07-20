import { prisma } from "../../db/client";
import type { Manga, ReadingEvent } from "../../generated/prisma/client";
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
  readCount: number;
  sourceDomains: string[];
}

export interface UpdateMangaInput {
  canonicalName?: string;
  status?: string;
  tags?: string[];
  // string = manual cover; null = clear (the next reading may refill it)
  coverUrl?: string | null;
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
 */
export async function getLibrary(
  filters: LibraryFilters,
): Promise<LibraryProjection[]> {
  const conditions = [];
  if (filters.domain) {
    conditions.push({ events: { some: { sourceDomain: filters.domain } } });
  }
  if (filters.since) {
    conditions.push({ events: { some: { readAt: { gte: filters.since } } } });
  }

  const mangas = await prisma.manga.findMany({
    where: conditions.length > 0 ? { AND: conditions } : undefined,
    include: { events: { orderBy: { readAt: "desc" } } },
    orderBy: { createdAt: "asc" },
  });

  return mangas
    .map(project)
    .sort(
      (a, b) =>
        (b.lastActivity?.readAt.getTime() ?? 0) -
        (a.lastActivity?.readAt.getTime() ?? 0),
    );
}

export async function getMangaHistory(
  id: string,
): Promise<{ manga: Manga; events: ReadingEvent[] } | null> {
  const manga = await prisma.manga.findUnique({
    where: { id },
    include: { events: { orderBy: { readAt: "desc" } } },
  });
  if (!manga) {
    return null;
  }
  const { events, ...rest } = manga;
  return { manga: rest, events };
}

/**
 * Manual corrections from the dashboard: display name, reading status and
 * tags. normalizedSlug is deliberately untouched: it is the dedup key, and
 * changing it would either break future matching or collide with another
 * manga.
 */
export async function updateManga(
  id: string,
  input: UpdateMangaInput,
): Promise<Manga | null> {
  const existing = await prisma.manga.findUnique({ where: { id } });
  if (!existing) {
    return null;
  }
  const manga = await prisma.manga.update({
    where: { id },
    data: {
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
  const existing = await prisma.manga.findUnique({ where: { id } });
  if (!existing) {
    return null;
  }
  const manga = await prisma.manga.update({
    where: { id },
    data: {
      coverImage: new Uint8Array(bytes),
      coverImageType: contentType,
      coverVersion: { increment: 1 },
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
  const manga = await prisma.manga.findUnique({
    where: { id },
    include: { events: { orderBy: { readAt: "desc" } } },
  });
  if (!manga) {
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
  const body = await response.arrayBuffer();
  // First successful proxy fetch becomes permanent local bytes: the cover
  // survives referer changes, CDN policy changes and the site dying.
  await prisma.manga.update({
    where: { id },
    data: {
      coverImage: new Uint8Array(body),
      coverImageType: contentType,
      coverVersion: { increment: 1 },
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
 * Explicit user deletion from the dashboard; events fall with the manga via
 * onDelete: Cascade. This is the one sanctioned way data leaves the log.
 */
export async function deleteManga(id: string): Promise<boolean> {
  const existing = await prisma.manga.findUnique({ where: { id } });
  if (!existing) {
    return false;
  }
  await prisma.manga.delete({ where: { id } });
  publishLibraryChanged();
  return true;
}

function project(manga: Manga & { events: ReadingEvent[] }): LibraryProjection {
  // events arrive desc by readAt; strict > keeps the most recent among ties
  let reachedChapter: { number: number; label: string } | null = null;
  for (const event of manga.events) {
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

  const latest = manga.events[0] ?? null;

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
    readCount: manga.events.length,
    sourceDomains: [
      ...new Set(manga.events.map((event) => event.sourceDomain)),
    ],
  };
}
