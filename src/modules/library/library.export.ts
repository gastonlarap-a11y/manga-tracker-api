// The library as a file someone keeps: a backup that owes nothing to this
// machine's SQLite or to a sync store, and a spreadsheet other trackers import.
//
// Streamed, never built in memory: a library at the scale the bench measures
// (10,000 series, 1,000,000 readings) is hundreds of MB of JSON. Cards are read
// a batch at a time in title order, through the same keyset paging the
// dashboard uses, and each batch is written before the next one is read.
//
// Not a snapshot: a reading recorded while the export runs may or may not be in
// it, depending on whether its card's batch had already been read.
import { z } from "@hono/zod-openapi";
import { prisma } from "../../db/client";
import { inChunks, refreshProjection } from "../../db/library-projection";
import { calendarDayIn } from "../../lib/calendar-day";
import { CSV_BOM, csvRecord } from "../../lib/csv";
import {
  mangaStatusSchema,
  statusFromDb,
  tagsFromJson,
} from "../../lib/schemas";
import { getLibraryPage, type LibraryProjection } from "./library.service";

export const exportFormatSchema = z.enum(["json", "csv"]);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

/** What a reader of the JSON checks before trusting its shape. */
export const EXPORT_FORMAT = "manga-tracker-library";
/** Bumped by any change a reader of version 1 would misread. */
export const EXPORT_VERSION = 1;

/** Cards per round trip: a handful of queries each, whatever the library. */
const BATCH = 100;

// Natural keys only, as in the sync documents: a local uuid means nothing on
// another machine, a slug and an event's id mean the same thing everywhere.
const exportedMangaSchema = z.object({
  canonicalName: z.string(),
  normalizedSlug: z.string(),
  createdAt: z.iso.datetime(),
  coverUrl: z.string().nullable(),
});

const exportedEventSchema = z.object({
  /** The event's id, the same one on every machine it synced to. */
  id: z.string(),
  /** The slug of the manga it was recorded on: the card's, or an alias's. */
  mangaSlug: z.string(),
  chapterLabel: z.string(),
  chapterNumber: z.number().nullable(),
  sourceUrl: z.string(),
  sourceDomain: z.string(),
  readAt: z.iso.datetime(),
  seriesKey: z.string().nullable(),
});

export const exportedSeriesSchema = exportedMangaSchema
  .extend({
    status: mangaStatusSchema,
    tags: z.array(z.string()),
    /** The mangas merged into this card. */
    aliases: z.array(exportedMangaSchema),
    /** Every reading of the card, aliases included, oldest first. */
    events: z.array(exportedEventSchema),
  })
  .openapi("ExportedSeries");
export type ExportedSeries = z.infer<typeof exportedSeriesSchema>;

export const libraryExportSchema = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    version: z.literal(EXPORT_VERSION),
    exportedAt: z.iso.datetime(),
    /** One per card, A–Z. Deleted cards and cover bytes are left out. */
    series: z.array(exportedSeriesSchema),
  })
  .openapi("LibraryExport");

/**
 * The CSV's columns. Snake_case and these names because that is how trackers
 * that import by title tend to read them; status is the API's own value.
 */
export const CSV_HEADER = [
  "title",
  "status",
  "last_chapter_read",
  "last_read_at",
  "last_source_url",
  "sites",
  "tags",
] as const;

/** How sites and tags are joined inside one cell. */
const LIST_SEPARATOR = "; ";

/** Every card, a batch at a time, A–Z. */
async function* cardBatches(): AsyncGenerator<LibraryProjection[]> {
  let cursor: string | undefined;
  do {
    const page = await getLibraryPage({ sort: "title", limit: BATCH, cursor });
    if (page.items.length > 0) {
      yield page.items;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
}

/** A batch of cards with their members and readings, in the batch's order. */
async function seriesOf(
  cards: readonly LibraryProjection[],
): Promise<ExportedSeries[]> {
  const members = await inChunks(
    cards.map((card) => card.id),
    (chunk) =>
      prisma.libraryMember.findMany({ where: { canonicalId: { in: chunk } } }),
  );
  const memberIds = members.map((member) => member.memberId);
  const [mangas, events] = await Promise.all([
    inChunks(memberIds, (chunk) =>
      prisma.manga.findMany({
        where: { id: { in: chunk } },
        omit: { coverImage: true },
      }),
    ),
    inChunks(memberIds, (chunk) =>
      prisma.readingEvent.findMany({ where: { mangaId: { in: chunk } } }),
    ),
  ]);

  const mangaById = new Map(mangas.map((manga) => [manga.id, manga]));
  const canonicalOf = new Map(
    members.map((member) => [member.memberId, member.canonicalId]),
  );
  const eventsOf = new Map<string, ExportedSeries["events"]>();
  for (const event of events) {
    const canonical = canonicalOf.get(event.mangaId);
    const slug = mangaById.get(event.mangaId)?.normalizedSlug;
    if (canonical === undefined || slug === undefined) {
      continue;
    }
    const list = eventsOf.get(canonical) ?? [];
    list.push({
      id: event.id,
      mangaSlug: slug,
      chapterLabel: event.chapterLabel,
      chapterNumber: event.chapterNumber,
      sourceUrl: event.sourceUrl,
      sourceDomain: event.sourceDomain,
      readAt: event.readAt.toISOString(),
      seriesKey: event.seriesKey,
    });
    eventsOf.set(canonical, list);
  }

  const series: ExportedSeries[] = [];
  for (const card of cards) {
    const canonical = mangaById.get(card.id);
    if (canonical === undefined) {
      // Deleted between the page and this read: it is not in the library.
      continue;
    }
    const aliases = members
      .filter(
        (member) =>
          member.canonicalId === card.id && member.memberId !== card.id,
      )
      .flatMap((member) => mangaById.get(member.memberId) ?? [])
      .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    series.push({
      canonicalName: canonical.canonicalName,
      normalizedSlug: canonical.normalizedSlug,
      createdAt: canonical.createdAt.toISOString(),
      coverUrl: canonical.coverUrl,
      status: statusFromDb(canonical.status),
      tags: tagsFromJson(canonical.tags),
      aliases: aliases.map((alias) => ({
        canonicalName: alias.canonicalName,
        normalizedSlug: alias.normalizedSlug,
        createdAt: alias.createdAt.toISOString(),
        coverUrl: alias.coverUrl,
      })),
      events: (eventsOf.get(card.id) ?? []).toSorted(
        (a, b) => a.readAt.localeCompare(b.readAt) || a.id.localeCompare(b.id),
      ),
    });
  }
  return series;
}

/**
 * The JSON backup, one series per line so a reader can stream it too, and a
 * diff of two exports stays readable.
 */
export async function* exportJson(now: Date): AsyncGenerator<string> {
  yield `{"format":${JSON.stringify(EXPORT_FORMAT)},"version":${EXPORT_VERSION},"exportedAt":${JSON.stringify(now.toISOString())},"series":[`;
  let separator = "\n";
  for await (const cards of cardBatches()) {
    for (const series of await seriesOf(cards)) {
      yield `${separator}${JSON.stringify(series)}`;
      separator = ",\n";
    }
  }
  yield "\n]}\n";
}

function csvRow(card: LibraryProjection): string {
  return csvRecord([
    card.canonicalName,
    statusFromDb(card.status),
    card.reachedChapter === null ? "" : String(card.reachedChapter.number),
    card.lastActivity?.readAt.toISOString() ?? "",
    card.lastSourceUrl ?? "",
    card.sourceDomains.join(LIST_SEPARATOR),
    tagsFromJson(card.tags).join(LIST_SEPARATOR),
  ]);
}

/** The spreadsheet: one row per card, from the read model alone. */
export async function* exportCsv(): AsyncGenerator<string> {
  yield CSV_BOM + csvRecord(CSV_HEADER);
  for await (const cards of cardBatches()) {
    yield cards.map(csvRow).join("");
  }
}

/** `manga-tracker-2026-10-13.json`, the day being the reader's. */
export function exportFileName(
  format: ExportFormat,
  now: Date,
  timeZone: string,
): string {
  return `manga-tracker-${calendarDayIn(timeZone)(now)}.${format}`;
}

/**
 * Bytes pulled from the generator only as fast as the client reads them, and
 * the reads stopped when it goes away. A failure halfway errors the stream —
 * the client sees a broken transfer, never a file that merely looks complete.
 */
export function streamOf(
  chunks: AsyncGenerator<string>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(encoder.encode(next.value));
        }
      } catch (cause) {
        console.error("[export] stopped halfway:", cause);
        controller.error(cause);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

export interface LibraryExport {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  fileName: string;
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8; header=present",
};

/**
 * The export, ready to send. The read model is brought current first, before
 * the first byte: a failure there is still a proper error response, where one
 * once the body has started can only cut the transfer.
 */
export async function openLibraryExport(
  format: ExportFormat,
  now: Date = new Date(),
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Promise<LibraryExport> {
  await refreshProjection();
  return {
    body: streamOf(format === "json" ? exportJson(now) : exportCsv()),
    contentType: CONTENT_TYPES[format],
    fileName: exportFileName(format, now, timeZone),
  };
}
