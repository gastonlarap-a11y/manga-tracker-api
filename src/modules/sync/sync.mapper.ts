// Pure translation between SQLite rows and the replica's documents. No I/O and
// no mongodb import lives here, so every edge case is unit-testable: this is
// where tags stop being a JSON string, Bytes become BinData, and anything the
// replica hands back that looks corrupt degrades instead of breaking a restore
// (same defensive posture as src/lib/schemas.ts).
import {
  type MangaStatus,
  statusFromDb,
  tagsFromJson,
} from "../../lib/schemas";

export interface MangaDoc {
  _id: string;
  canonicalName: string;
  normalizedSlug: string;
  coverUrl: string | null;
  coverImageType: string | null;
  coverVersion: number;
  // Denormalized so the cover pass knows which mangas owe bytes without
  // touching the covers collection.
  hasStoredCover: boolean;
  status: MangaStatus;
  // A real array here; SQLite has no array columns, the replica does.
  tags: string[];
  createdAt: Date;
}

export interface ReadingEventDoc {
  _id: string;
  mangaId: string;
  chapterLabel: string;
  chapterNumber: number | null;
  sourceUrl: string;
  sourceDomain: string;
  readAt: Date;
}

export interface SiteAdapterDoc {
  // The domain is already unique in SQLite, so it doubles as the natural key.
  _id: string;
  id: string;
  titleSelector: string;
  chapterSelector: string | null;
  chapterUrlRegex: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CoverDoc {
  _id: string;
  data: Uint8Array;
  contentType: string | null;
  // Mirrors Manga.coverVersion so a push can diff without moving any bytes.
  coverVersion: number;
}

/**
 * Deliberately carries a flag instead of the bytes: a metadata push must never
 * pull every cover out of SQLite just to decide whether one exists.
 */
interface MangaRow {
  id: string;
  canonicalName: string;
  normalizedSlug: string;
  coverUrl: string | null;
  hasStoredCover: boolean;
  coverImageType: string | null;
  coverVersion: number;
  status: string;
  tags: string;
  createdAt: Date;
}

interface ReadingEventRow {
  id: string;
  mangaId: string;
  chapterLabel: string;
  chapterNumber: number | null;
  sourceUrl: string;
  sourceDomain: string;
  readAt: Date;
}

interface SiteAdapterRow {
  id: string;
  domain: string;
  titleSelector: string;
  chapterSelector: string | null;
  chapterUrlRegex: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ------------------------------------------------------
// SQLite -> replica
// ------------------------------------------------------

export function toMangaDoc(manga: MangaRow): MangaDoc {
  return {
    _id: manga.id,
    canonicalName: manga.canonicalName,
    normalizedSlug: manga.normalizedSlug,
    coverUrl: manga.coverUrl,
    coverImageType: manga.coverImageType,
    coverVersion: manga.coverVersion,
    hasStoredCover: manga.hasStoredCover,
    status: statusFromDb(manga.status),
    tags: tagsFromJson(manga.tags),
    createdAt: manga.createdAt,
  };
}

export function toEventDoc(event: ReadingEventRow): ReadingEventDoc {
  return {
    _id: event.id,
    mangaId: event.mangaId,
    chapterLabel: event.chapterLabel,
    chapterNumber: event.chapterNumber,
    sourceUrl: event.sourceUrl,
    sourceDomain: event.sourceDomain,
    readAt: event.readAt,
  };
}

export function toAdapterDoc(adapter: SiteAdapterRow): SiteAdapterDoc {
  return {
    _id: adapter.domain,
    id: adapter.id,
    titleSelector: adapter.titleSelector,
    chapterSelector: adapter.chapterSelector,
    chapterUrlRegex: adapter.chapterUrlRegex,
    createdAt: adapter.createdAt,
    updatedAt: adapter.updatedAt,
  };
}

export function toCoverDoc(manga: {
  id: string;
  coverImage: Uint8Array;
  coverImageType: string | null;
  coverVersion: number;
}): CoverDoc {
  return {
    _id: manga.id,
    data: manga.coverImage,
    contentType: manga.coverImageType,
    coverVersion: manga.coverVersion,
  };
}

// ------------------------------------------------------
// replica -> SQLite (restore)
// ------------------------------------------------------

// Documents come back from a remote store that nothing in this repo validates,
// so every reverse mapper coerces rather than trusts. A single unreadable field
// must not abort a restore of thousands of good rows.
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInt(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Epoch on unreadable input: a wrong timestamp beats losing the row. */
export function asDate(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date(0);
}

/**
 * The driver returns BinData as a Binary wrapper, but a fake target (or a
 * document written by another client) may hand back a raw Uint8Array. Accept
 * both structurally so this file stays free of any mongodb import.
 */
export function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "buffer" in value &&
    (value as { buffer: unknown }).buffer instanceof Uint8Array
  ) {
    return (value as { buffer: Uint8Array }).buffer;
  }
  return null;
}

export interface MangaRestoreInput {
  id: string;
  canonicalName: string;
  normalizedSlug: string;
  coverUrl: string | null;
  coverImageType: string | null;
  coverVersion: number;
  status: string;
  tags: string;
  createdAt: Date;
}

export function fromMangaDoc(doc: Record<string, unknown>): MangaRestoreInput {
  const tags = Array.isArray(doc.tags)
    ? doc.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  return {
    id: asString(doc._id),
    canonicalName: asString(doc.canonicalName),
    normalizedSlug: asString(doc.normalizedSlug),
    coverUrl: asNullableString(doc.coverUrl),
    coverImageType: asNullableString(doc.coverImageType),
    coverVersion: asInt(doc.coverVersion),
    status: statusFromDb(asString(doc.status, "reading")),
    // Back to the JSON string the SQLite column expects.
    tags: JSON.stringify(tags),
    createdAt: asDate(doc.createdAt),
  };
}

export interface EventRestoreInput {
  id: string;
  mangaId: string;
  chapterLabel: string;
  chapterNumber: number | null;
  sourceUrl: string;
  sourceDomain: string;
  readAt: Date;
}

export function fromEventDoc(doc: Record<string, unknown>): EventRestoreInput {
  return {
    id: asString(doc._id),
    mangaId: asString(doc.mangaId),
    chapterLabel: asString(doc.chapterLabel),
    chapterNumber: asNullableNumber(doc.chapterNumber),
    sourceUrl: asString(doc.sourceUrl),
    sourceDomain: asString(doc.sourceDomain),
    readAt: asDate(doc.readAt),
  };
}

export interface AdapterRestoreInput {
  id: string;
  domain: string;
  titleSelector: string;
  chapterSelector: string | null;
  chapterUrlRegex: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function fromAdapterDoc(
  doc: Record<string, unknown>,
): AdapterRestoreInput {
  const domain = asString(doc._id);
  return {
    // Pre-`id` documents fall back to the domain, which is unique anyway.
    id: asString(doc.id, domain),
    domain,
    titleSelector: asString(doc.titleSelector),
    chapterSelector: asNullableString(doc.chapterSelector),
    chapterUrlRegex: asNullableString(doc.chapterUrlRegex),
    createdAt: asDate(doc.createdAt),
    updatedAt: asDate(doc.updatedAt),
  };
}

export interface CoverRestoreInput {
  mangaId: string;
  coverImage: Uint8Array;
  coverImageType: string | null;
}

/** Null when the document carries no readable bytes — the cover is skipped. */
export function fromCoverDoc(
  doc: Record<string, unknown>,
): CoverRestoreInput | null {
  const bytes = asBytes(doc.data);
  if (bytes === null) {
    return null;
  }
  return {
    mangaId: asString(doc._id),
    coverImage: bytes,
    coverImageType: asNullableString(doc.contentType),
  };
}
