// Pure translation between SQLite rows and the shared documents every machine
// converges on. No I/O and no mongodb import lives here, so every edge case is
// unit-testable: this is where tags stop being a JSON string, Bytes become
// BinData, and anything a peer wrote that looks corrupt degrades instead of
// breaking a sync (same defensive posture as src/lib/schemas.ts).
//
// Documents are keyed by natural keys, not by the local uuid: two machines that
// discover the same manga independently produce different uuids but the same
// normalizedSlug, and the slug is immutable (updateManga never recomputes it).
// Keying by uuid would make those two rows collide on the unique slug index
// instead of merging.
import {
  type MangaStatus,
  statusFromDb,
  tagsFromJson,
} from "../../lib/schemas";

export interface MangaDoc {
  /** normalizedSlug — the identity every machine agrees on. */
  _id: string;
  /** The originating machine's local uuid; informational only. */
  id: string;
  canonicalName: string;
  coverUrl: string | null;
  coverImageType: string | null;
  coverVersion: number;
  hasStoredCover: boolean;
  status: MangaStatus;
  tags: string[];
  createdAt: Date;
  /** Last-write-wins tiebreaker. */
  updatedAt: Date;
  /** Soft delete travels as a value; absence would be ambiguous. */
  deletedAt: Date | null;
  /**
   * The canonical this manga was merged into, as a slug — the same natural key
   * the documents are already addressed by, so the pointer means the same thing
   * on every machine (a local uuid would be meaningless to a peer).
   * Converges last-write-wins on updatedAt like any other field.
   */
  mergedIntoSlug: string | null;
}

/** "These two are not the same manga", keyed by the ordered slug pair. */
export interface DismissalDoc {
  /** `${slugA}|${slugB}`, both already in lexicographic order. */
  _id: string;
  slugA: string;
  slugB: string;
  createdAt: Date;
}

export interface ReadingEventDoc {
  _id: string;
  /** Denormalized so a peer can resolve the event against its own manga row. */
  mangaSlug: string;
  chapterLabel: string;
  chapterNumber: number | null;
  sourceUrl: string;
  sourceDomain: string;
  readAt: Date;
  /** Series-page identity within a site; null for events recorded without one. */
  seriesKey: string | null;
}

export interface SiteAdapterDoc {
  _id: string;
  id: string;
  titleSelector: string;
  chapterSelector: string | null;
  chapterUrlRegex: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CoverDoc {
  /** normalizedSlug, aligned with MangaDoc. */
  _id: string;
  data: Uint8Array;
  contentType: string | null;
  coverVersion: number;
}

interface MangaRow {
  id: string;
  canonicalName: string;
  normalizedSlug: string;
  coverUrl: string | null;
  /** A flag, never the bytes: a metadata sync must not read every cover. */
  hasStoredCover: boolean;
  coverImageType: string | null;
  coverVersion: number;
  status: string;
  tags: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  mergedIntoSlug: string | null;
}

interface DismissalRow {
  slugA: string;
  slugB: string;
  createdAt: Date;
}

interface ReadingEventRow {
  id: string;
  chapterLabel: string;
  chapterNumber: number | null;
  sourceUrl: string;
  sourceDomain: string;
  readAt: Date;
  seriesKey: string | null;
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
// SQLite -> shared documents
// ------------------------------------------------------

export function toMangaDoc(manga: MangaRow): MangaDoc {
  return {
    _id: manga.normalizedSlug,
    id: manga.id,
    canonicalName: manga.canonicalName,
    coverUrl: manga.coverUrl,
    coverImageType: manga.coverImageType,
    coverVersion: manga.coverVersion,
    hasStoredCover: manga.hasStoredCover,
    status: statusFromDb(manga.status),
    tags: tagsFromJson(manga.tags),
    createdAt: manga.createdAt,
    updatedAt: manga.updatedAt,
    deletedAt: manga.deletedAt,
    mergedIntoSlug: manga.mergedIntoSlug,
  };
}

export function toDismissalDoc(row: DismissalRow): DismissalDoc {
  return {
    _id: `${row.slugA}|${row.slugB}`,
    slugA: row.slugA,
    slugB: row.slugB,
    createdAt: row.createdAt,
  };
}

export function toEventDoc(
  event: ReadingEventRow,
  mangaSlug: string,
): ReadingEventDoc {
  return {
    _id: event.id,
    mangaSlug,
    chapterLabel: event.chapterLabel,
    chapterNumber: event.chapterNumber,
    sourceUrl: event.sourceUrl,
    sourceDomain: event.sourceDomain,
    readAt: event.readAt,
    seriesKey: event.seriesKey,
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
  normalizedSlug: string;
  coverImage: Uint8Array;
  coverImageType: string | null;
  coverVersion: number;
}): CoverDoc {
  return {
    _id: manga.normalizedSlug,
    data: manga.coverImage,
    contentType: manga.coverImageType,
    coverVersion: manga.coverVersion,
  };
}

// ------------------------------------------------------
// Shared documents -> SQLite
// ------------------------------------------------------

// Documents come from a store that nothing in this repo validates, written by
// another machine possibly running an older build, so every reverse mapper
// coerces rather than trusts. One unreadable field must not abort a sync.
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

export function asNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = asDate(value);
  // Epoch here means "unparseable", and treating that as a deletion would
  // silently hide a manga on every machine.
  return parsed.getTime() === 0 ? null : parsed;
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

export interface MangaMerge {
  normalizedSlug: string;
  canonicalName: string;
  coverUrl: string | null;
  coverImageType: string | null;
  coverVersion: number;
  status: string;
  tags: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  mergedIntoSlug: string | null;
}

export function fromMangaDoc(doc: Record<string, unknown>): MangaMerge {
  const tags = Array.isArray(doc.tags)
    ? doc.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  return {
    normalizedSlug: asString(doc._id),
    canonicalName: asString(doc.canonicalName),
    coverUrl: asNullableString(doc.coverUrl),
    coverImageType: asNullableString(doc.coverImageType),
    coverVersion: asInt(doc.coverVersion),
    status: statusFromDb(asString(doc.status, "reading")),
    // Back to the JSON string the SQLite column stores.
    tags: JSON.stringify(tags),
    createdAt: asDate(doc.createdAt),
    updatedAt: asDate(doc.updatedAt),
    deletedAt: asNullableDate(doc.deletedAt),
    // Kept exactly as written, even when the target slug is unknown here: the
    // peer's canonical may simply not have arrived yet, and resolveCanonical
    // already treats a dangling pointer as "canonical for now". Clearing it
    // would make the two machines strip each other's merge forever.
    mergedIntoSlug: asNullableString(doc.mergedIntoSlug),
  };
}

export interface DismissalMerge {
  slugA: string;
  slugB: string;
  createdAt: Date;
}

/** Null when the document carries no usable pair — it is skipped, not guessed. */
export function fromDismissalDoc(
  doc: Record<string, unknown>,
): DismissalMerge | null {
  const slugA = asString(doc.slugA);
  const slugB = asString(doc.slugB);
  if (slugA === "" || slugB === "" || slugA === slugB) {
    return null;
  }
  return { slugA, slugB, createdAt: asDate(doc.createdAt) };
}

export interface EventMerge {
  id: string;
  mangaSlug: string;
  chapterLabel: string;
  chapterNumber: number | null;
  sourceUrl: string;
  sourceDomain: string;
  readAt: Date;
  seriesKey: string | null;
}

export function fromEventDoc(doc: Record<string, unknown>): EventMerge {
  return {
    id: asString(doc._id),
    mangaSlug: asString(doc.mangaSlug),
    chapterLabel: asString(doc.chapterLabel),
    chapterNumber: asNullableNumber(doc.chapterNumber),
    sourceUrl: asString(doc.sourceUrl),
    sourceDomain: asString(doc.sourceDomain),
    readAt: asDate(doc.readAt),
    seriesKey: asNullableString(doc.seriesKey),
  };
}

export interface AdapterMerge {
  id: string;
  domain: string;
  titleSelector: string;
  chapterSelector: string | null;
  chapterUrlRegex: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function fromAdapterDoc(doc: Record<string, unknown>): AdapterMerge {
  const domain = asString(doc._id);
  return {
    id: asString(doc.id, domain),
    domain,
    titleSelector: asString(doc.titleSelector),
    chapterSelector: asNullableString(doc.chapterSelector),
    chapterUrlRegex: asNullableString(doc.chapterUrlRegex),
    createdAt: asDate(doc.createdAt),
    updatedAt: asDate(doc.updatedAt),
  };
}

export interface CoverMerge {
  normalizedSlug: string;
  coverImage: Uint8Array;
  coverImageType: string | null;
  coverVersion: number;
}

/** Null when the document carries no readable bytes — the cover is skipped. */
export function fromCoverDoc(doc: Record<string, unknown>): CoverMerge | null {
  const bytes = asBytes(doc.data);
  if (bytes === null) {
    return null;
  }
  return {
    normalizedSlug: asString(doc._id),
    coverImage: bytes,
    coverImageType: asNullableString(doc.contentType),
    coverVersion: asInt(doc.coverVersion),
  };
}
