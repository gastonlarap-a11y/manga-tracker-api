import { beforeEach, describe, expect, it } from "bun:test";
import { prisma } from "../../db/client";
import { errorSchema } from "../../lib/http";
import {
  CSV_HEADER,
  exportFileName,
  libraryExportSchema,
  streamOf,
} from "./library.export";
import { libraryRoutes } from "./library.routes";

function seedManga(
  slug: string,
  name: string,
  reads: { label: string; number: number | null; readAt: string }[],
  domain = "a.com",
) {
  return prisma.manga.create({
    data: {
      canonicalName: name,
      normalizedSlug: slug,
      events: {
        create: reads.map((read) => ({
          chapterLabel: read.label,
          chapterNumber: read.number,
          sourceUrl: `https://${domain}/${slug}/${read.number ?? "x"}`,
          sourceDomain: domain,
          readAt: new Date(read.readAt),
        })),
      },
    },
  });
}

async function exportOf(format: "json" | "csv") {
  const res = await libraryRoutes.request(`/library/export?format=${format}`);
  expect(res.status).toBe(200);
  return res;
}

beforeEach(async () => {
  await prisma.manga.deleteMany();
});

describe("GET /library/export?format=json", () => {
  it("exports every card A–Z with its aliases and their readings, deleted cards left out", async () => {
    const zetman = await seedManga("zetman", "Zetman", [
      { label: "Cap. 2", number: 2, readAt: "2026-07-03T10:00:00.000Z" },
      { label: "Cap. 1", number: 1, readAt: "2026-07-01T10:00:00.000Z" },
    ]);
    await prisma.manga.update({
      where: { id: zetman.id },
      data: {
        status: "on_hold",
        tags: JSON.stringify(["seinen"]),
        coverUrl: "https://cdn.example.com/zetman.jpg",
        coverImage: new Uint8Array([1, 2, 3]),
        coverImageType: "image/jpeg",
      },
    });
    // An alias read on another site: its readings belong to Zetman's card.
    await seedManga(
      "zetman-raw",
      "Zetman (raw)",
      [{ label: "Cap. 3", number: 3, readAt: "2026-07-05T10:00:00.000Z" }],
      "b.com",
    );
    await prisma.manga.update({
      where: { normalizedSlug: "zetman-raw" },
      data: { mergedIntoSlug: "zetman" },
    });
    await seedManga("asura", "Ásura", [
      { label: "Cap. 9", number: 9, readAt: "2026-07-02T10:00:00.000Z" },
    ]);
    const gone = await seedManga("borrada", "Borrada", [
      { label: "Cap. 1", number: 1, readAt: "2026-07-02T10:00:00.000Z" },
    ]);
    await prisma.manga.update({
      where: { id: gone.id },
      data: { deletedAt: new Date() },
    });

    const raw = await (await exportOf("json")).json();
    const backup = libraryExportSchema.parse(raw);

    expect(backup.format).toBe("manga-tracker-library");
    expect(backup.version).toBe(1);
    expect(backup.series.map((series) => series.canonicalName)).toEqual([
      "Ásura",
      "Zetman",
    ]);
    const zetmanSeries = backup.series[1];
    expect(zetmanSeries?.status).toBe("on_hold");
    expect(zetmanSeries?.tags).toEqual(["seinen"]);
    expect(zetmanSeries?.coverUrl).toBe("https://cdn.example.com/zetman.jpg");
    expect(zetmanSeries?.aliases.map((alias) => alias.normalizedSlug)).toEqual([
      "zetman-raw",
    ]);
    expect(
      zetmanSeries?.events.map((event) => [
        event.mangaSlug,
        event.chapterLabel,
      ]),
    ).toEqual([
      ["zetman", "Cap. 1"],
      ["zetman", "Cap. 2"],
      ["zetman-raw", "Cap. 3"],
    ]);
    // Natural keys only: no local uuid, and never the cover's bytes.
    const text = JSON.stringify(raw);
    expect(text).not.toContain(zetman.id);
    expect(text).not.toContain("coverImage");
  });

  it("sends it as a download named after today", async () => {
    const res = await exportOf("json");

    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="manga-tracker-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(libraryExportSchema.parse(await res.json()).series).toEqual([]);
  });

  it("walks past one batch", async () => {
    await prisma.manga.createMany({
      data: Array.from({ length: 205 }, (_, index) => ({
        canonicalName: `Serie ${String(index).padStart(3, "0")}`,
        normalizedSlug: `serie-${index}`,
      })),
    });

    const backup = libraryExportSchema.parse(
      await (await exportOf("json")).json(),
    );

    expect(backup.series).toHaveLength(205);
    expect(new Set(backup.series.map((s) => s.normalizedSlug)).size).toBe(205);
  });

  it("exports a status this build does not know as reading", async () => {
    const manga = await seedManga("futura", "Futura", []);
    await prisma.manga.update({
      where: { id: manga.id },
      data: { status: "plan_to_read" },
    });

    const backup = libraryExportSchema.parse(
      await (await exportOf("json")).json(),
    );

    expect(backup.series[0]?.status).toBe("reading");
  });
});

describe("GET /library/export?format=csv", () => {
  it("writes one row per card the way spreadsheets and trackers read it", async () => {
    const manga = await seedManga("zetman", "Zetman", [
      { label: "Cap. 1", number: 1, readAt: "2026-07-01T10:00:00.000Z" },
      { label: "Cap. 12.5", number: 12.5, readAt: "2026-07-03T10:00:00.000Z" },
    ]);
    await prisma.manga.update({
      where: { id: manga.id },
      data: { status: "on_hold", tags: JSON.stringify(["seinen", "accion"]) },
    });
    await seedManga("nunca", "Nunca", []);

    const res = await exportOf("csv");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

    expect(res.headers.get("content-type")).toBe(
      "text/csv; charset=utf-8; header=present",
    );
    expect(res.headers.get("content-disposition")).toMatch(/\.csv"$/);
    expect(text.startsWith("﻿")).toBe(true);
    expect(text.slice(1).split("\r\n")).toEqual([
      CSV_HEADER.join(","),
      "Nunca,reading,,,,,",
      "Zetman,on_hold,12.5,2026-07-03T10:00:00.000Z,https://a.com/zetman/12.5,a.com,seinen; accion",
      "",
    ]);
  });

  it("quotes a title with a comma, a quote or a line break", async () => {
    await seedManga("coma", 'Hola, "mundo"', []);

    const text = await (await exportOf("csv")).text();

    expect(text).toContain('"Hola, ""mundo""",reading');
  });

  it("neutralises a title a spreadsheet would run as a formula", async () => {
    await seedManga("formula", '=HYPERLINK("https://evil.example")', []);

    const text = await (await exportOf("csv")).text();

    expect(text).toContain(`"'=HYPERLINK(""https://evil.example"")",reading`);
  });
});

describe("export edges", () => {
  it("refuses a format it does not serve", async () => {
    const res = await libraryRoutes.request("/library/export?format=xml");

    expect(res.status).toBe(400);
    expect(errorSchema.safeParse(await res.json()).success).toBe(true);
  });

  it("names the file after the reader's day, not the UTC one", () => {
    const lateEvening = new Date("2026-10-14T02:30:00.000Z");

    expect(exportFileName("csv", lateEvening, "America/Santiago")).toBe(
      "manga-tracker-2026-10-13.csv",
    );
  });

  it("errors the stream instead of ending it when a batch fails", async () => {
    async function* failing(): AsyncGenerator<string> {
      yield '{"series":[';
      throw new Error("database went away");
    }
    const original = console.error;
    console.error = () => {};
    try {
      const reader = streamOf(failing()).getReader();
      expect((await reader.read()).done).toBe(false);
      await expect(reader.read()).rejects.toThrow("database went away");
    } finally {
      console.error = original;
    }
  });

  it("stops reading when the client goes away", async () => {
    let finished = false;
    async function* endless(): AsyncGenerator<string> {
      try {
        for (;;) {
          yield "x";
        }
      } finally {
        finished = true;
      }
    }
    const reader = streamOf(endless()).getReader();
    await reader.read();

    await reader.cancel();

    expect(finished).toBe(true);
  });
});
