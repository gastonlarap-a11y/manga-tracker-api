import { beforeEach, describe, expect, it } from "bun:test";
import { z } from "@hono/zod-openapi";
import { prisma } from "../../db/client";
import { errorSchema } from "../../lib/http";
import { mangaSchema } from "../../lib/schemas";
import {
  libraryActivitySchema,
  libraryEntrySchema,
  libraryRoutes,
  mangaHistorySchema,
} from "./library.routes";
import {
  fetchMangaCover,
  getActivity,
  MAX_COVER_IMAGE_BYTES,
  readBounded,
} from "./library.service";

const libraryResponseSchema = z.array(libraryEntrySchema);

interface SeedEvent {
  label: string;
  number: number | null;
  domain: string;
  readAt: string;
}

function seedManga(slug: string, name: string, events: SeedEvent[]) {
  return prisma.manga.create({
    data: {
      canonicalName: name,
      normalizedSlug: slug,
      events: {
        create: events.map((event) => ({
          chapterLabel: event.label,
          chapterNumber: event.number,
          sourceUrl: `https://${event.domain}/${slug}`,
          sourceDomain: event.domain,
          readAt: new Date(event.readAt),
        })),
      },
    },
  });
}

beforeEach(async () => {
  await prisma.manga.deleteMany();
});

describe("GET /library", () => {
  it("projects reached chapter (max, never regressing) and last activity", async () => {
    await seedManga("solo-leveling", "Solo Leveling", [
      {
        label: "Cap. 10",
        number: 10,
        domain: "olympusxyz.com",
        readAt: "2026-07-01T10:00:00.000Z",
      },
      {
        label: "Cap. 12",
        number: 12,
        domain: "olympusxyz.com",
        readAt: "2026-07-02T10:00:00.000Z",
      },
      // server change: the site shows chapter 1 again — recorded, but progress must stay 12
      {
        label: "Cap. 1",
        number: 1,
        domain: "newserver.net",
        readAt: "2026-07-03T10:00:00.000Z",
      },
    ]);

    const res = await libraryRoutes.request("/library");
    expect(res.status).toBe(200);
    const entries = libraryResponseSchema.parse(await res.json());
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.reachedChapter).toEqual({ number: 12, label: "Cap. 12" });
    expect(entry.lastActivity).toEqual({
      readAt: "2026-07-03T10:00:00.000Z",
      chapterLabel: "Cap. 1",
    });
    expect(entry.readCount).toBe(3);
    expect(entry.sourceDomains.toSorted()).toEqual([
      "newserver.net",
      "olympusxyz.com",
    ]);
  });

  it("returns a null reachedChapter when no event has a parsed number", async () => {
    await seedManga("berserk", "Berserk", [
      {
        label: "Extra Omake",
        number: null,
        domain: "olympusxyz.com",
        readAt: "2026-07-01T10:00:00.000Z",
      },
    ]);

    const entries = libraryResponseSchema.parse(
      await (await libraryRoutes.request("/library")).json(),
    );
    expect(entries[0]?.reachedChapter).toBeNull();
    expect(entries[0]?.lastActivity?.chapterLabel).toBe("Extra Omake");
  });

  it("orders entries by most recent activity first", async () => {
    await seedManga("older", "Older Manga", [
      {
        label: "Cap. 1",
        number: 1,
        domain: "olympusxyz.com",
        readAt: "2026-07-01T10:00:00.000Z",
      },
    ]);
    await seedManga("newer", "Newer Manga", [
      {
        label: "Cap. 2",
        number: 2,
        domain: "olympusxyz.com",
        readAt: "2026-07-05T10:00:00.000Z",
      },
    ]);
    await seedManga("no-events", "Empty Manga", []);

    const entries = libraryResponseSchema.parse(
      await (await libraryRoutes.request("/library")).json(),
    );

    expect(entries.map((entry) => entry.normalizedSlug)).toEqual([
      "newer",
      "older",
      "no-events",
    ]);
  });

  it("exposes the last source url for continue-reading", async () => {
    await seedManga("solo-leveling", "Solo Leveling", [
      {
        label: "Cap. 10",
        number: 10,
        domain: "olympusxyz.com",
        readAt: "2026-07-01T10:00:00.000Z",
      },
      {
        label: "Cap. 12",
        number: 12,
        domain: "newserver.net",
        readAt: "2026-07-02T10:00:00.000Z",
      },
    ]);

    const entries = libraryResponseSchema.parse(
      await (await libraryRoutes.request("/library")).json(),
    );

    expect(entries[0]?.lastSourceUrl).toBe(
      "https://newserver.net/solo-leveling",
    );
    expect(entries[0]?.status).toBe("reading");
    expect(entries[0]?.tags).toEqual([]);
  });

  it("filters by domain", async () => {
    await seedManga("solo-leveling", "Solo Leveling", [
      {
        label: "Cap. 1",
        number: 1,
        domain: "newserver.net",
        readAt: "2026-07-03T10:00:00.000Z",
      },
    ]);

    const match = libraryResponseSchema.parse(
      await (
        await libraryRoutes.request("/library?domain=newserver.net")
      ).json(),
    );
    expect(match).toHaveLength(1);

    const noMatch = libraryResponseSchema.parse(
      await (await libraryRoutes.request("/library?domain=other.com")).json(),
    );
    expect(noMatch).toEqual([]);
  });

  it("filters by since and rejects invalid dates", async () => {
    await seedManga("solo-leveling", "Solo Leveling", [
      {
        label: "Cap. 12",
        number: 12,
        domain: "olympusxyz.com",
        readAt: "2026-07-02T10:00:00.000Z",
      },
    ]);

    const recent = libraryResponseSchema.parse(
      await (
        await libraryRoutes.request("/library?since=2026-07-01T00:00:00.000Z")
      ).json(),
    );
    expect(recent).toHaveLength(1);

    const stale = libraryResponseSchema.parse(
      await (
        await libraryRoutes.request("/library?since=2026-07-10T00:00:00.000Z")
      ).json(),
    );
    expect(stale).toEqual([]);

    const invalid = await libraryRoutes.request("/library?since=garbage");
    expect(invalid.status).toBe(400);
    errorSchema.parse(await invalid.json());
  });
});

describe("GET /mangas/{id}/history", () => {
  it("returns all events, most recent first", async () => {
    const manga = await seedManga("solo-leveling", "Solo Leveling", [
      {
        label: "Cap. 10",
        number: 10,
        domain: "olympusxyz.com",
        readAt: "2026-07-01T10:00:00.000Z",
      },
      {
        label: "Cap. 12",
        number: 12,
        domain: "olympusxyz.com",
        readAt: "2026-07-02T10:00:00.000Z",
      },
      {
        label: "Cap. 1",
        number: 1,
        domain: "newserver.net",
        readAt: "2026-07-03T10:00:00.000Z",
      },
    ]);

    const res = await libraryRoutes.request(`/mangas/${manga.id}/history`);
    expect(res.status).toBe(200);
    const history = mangaHistorySchema.parse(await res.json());
    expect(history.manga.id).toBe(manga.id);
    expect(history.events.map((event) => event.chapterLabel)).toEqual([
      "Cap. 1",
      "Cap. 12",
      "Cap. 10",
    ]);
  });

  it("responds 404 for an unknown id", async () => {
    const res = await libraryRoutes.request("/mangas/nope/history");
    expect(res.status).toBe(404);
    errorSchema.parse(await res.json());
  });
});

describe("PUT /mangas/{id}", () => {
  it("updates only the canonical name, never the slug", async () => {
    const manga = await seedManga("solo-leveling", "solo leveling (raw)", []);

    const res = await libraryRoutes.request(`/mangas/${manga.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canonicalName: "Solo Leveling (KR)" }),
    });

    expect(res.status).toBe(200);
    const updated = mangaSchema.parse(await res.json());
    expect(updated.canonicalName).toBe("Solo Leveling (KR)");

    const stored = await prisma.manga.findUniqueOrThrow({
      where: { id: manga.id },
    });
    expect(stored.canonicalName).toBe("Solo Leveling (KR)");
    expect(stored.normalizedSlug).toBe("solo-leveling");
  });

  it("updates status and tags without touching the name", async () => {
    const manga = await seedManga("one-piece", "One Piece", []);

    const res = await libraryRoutes.request(`/mangas/${manga.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        tags: ["shonen", "piratas"],
      }),
    });

    expect(res.status).toBe(200);
    const updated = mangaSchema.parse(await res.json());
    expect(updated.status).toBe("completed");
    expect(updated.tags).toEqual(["shonen", "piratas"]);
    expect(updated.canonicalName).toBe("One Piece");

    const stored = await prisma.manga.findUniqueOrThrow({
      where: { id: manga.id },
    });
    expect(stored.status).toBe("completed");
    expect(stored.tags).toBe('["shonen","piratas"]');
  });

  it("sets and clears the manual cover", async () => {
    const manga = await seedManga("one-piece", "One Piece", []);

    const set = await libraryRoutes.request(`/mangas/${manga.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coverUrl: "https://cdn.example.com/cover.jpg" }),
    });
    expect(set.status).toBe(200);
    expect(mangaSchema.parse(await set.json()).coverUrl).toBe(
      "https://cdn.example.com/cover.jpg",
    );

    const clear = await libraryRoutes.request(`/mangas/${manga.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coverUrl: null }),
    });
    expect(clear.status).toBe(200);
    expect(mangaSchema.parse(await clear.json()).coverUrl).toBeNull();
  });

  it("invalidates stored cover bytes and bumps the version on a coverUrl change", async () => {
    const manga = await seedManga("one-piece", "One Piece", []);
    await prisma.manga.update({
      where: { id: manga.id },
      data: {
        coverUrl: "https://cdn.example.com/old.jpg",
        coverImage: new Uint8Array([1, 2, 3]),
        coverImageType: "image/jpeg",
        coverVersion: 3,
      },
    });

    const res = await libraryRoutes.request(`/mangas/${manga.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coverUrl: "https://cdn.example.com/new.jpg" }),
    });

    expect(res.status).toBe(200);
    expect(mangaSchema.parse(await res.json()).coverVersion).toBe(4);
    const stored = await prisma.manga.findUniqueOrThrow({
      where: { id: manga.id },
    });
    expect(stored.coverImage).toBeNull();
    expect(stored.coverImageType).toBeNull();
  });

  it("rejects an empty body, an invalid status and blank names", async () => {
    const manga = await seedManga("one-piece", "One Piece", []);

    const empty = await libraryRoutes.request(`/mangas/${manga.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);

    const badStatus = await libraryRoutes.request(`/mangas/${manga.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    expect(badStatus.status).toBe(400);

    const blank = await libraryRoutes.request(`/mangas/${manga.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canonicalName: "   " }),
    });
    expect(blank.status).toBe(400);

    const missing = await libraryRoutes.request("/mangas/nope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canonicalName: "Valid" }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("fetchMangaCover", () => {
  const COVER_URL = "https://img2mw.xyz/manhwas/carnicero/cover_123.webp";
  const COVER_BYTES = new Uint8Array([1, 2, 3, 4]);

  function seedCoveredManga() {
    return prisma.manga.create({
      data: {
        canonicalName: "Carnicero Marcial",
        normalizedSlug: "carnicero-marcial",
        coverUrl: COVER_URL,
        events: {
          create: [
            {
              chapterLabel: "Cap. 36",
              chapterNumber: 36,
              sourceUrl: "https://manhwaweb.com/leer/carnicero-36",
              sourceDomain: "manhwaweb.com",
              readAt: new Date("2026-07-16T10:00:00.000Z"),
            },
          ],
        },
      },
    });
  }

  function imageResponse(): Response {
    return new Response(COVER_BYTES, {
      status: 200,
      headers: { "content-type": "image/webp" },
    });
  }

  it("sends the Referer of the manga's reading site", async () => {
    const manga = await seedCoveredManga();
    const calls: { url: string; referer: string | undefined }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        referer: new Headers(init?.headers).get("referer") ?? undefined,
      });
      return imageResponse();
    };

    const cover = await fetchMangaCover(manga.id, fetchFn);

    expect(calls).toEqual([
      { url: COVER_URL, referer: "https://manhwaweb.com/" },
    ]);
    expect(cover?.contentType).toBe("image/webp");
    expect(new Uint8Array(cover?.body ?? new ArrayBuffer(0))).toEqual(
      COVER_BYTES,
    );
  });

  it("retries once without Referer when the upstream rejects it", async () => {
    const manga = await seedCoveredManga();
    const referers: (string | null)[] = [];
    const fetchFn = async (_url: string, init?: RequestInit) => {
      const referer = new Headers(init?.headers).get("referer");
      referers.push(referer);
      return referer !== null
        ? new Response("blocked", { status: 403 })
        : imageResponse();
    };

    const cover = await fetchMangaCover(manga.id, fetchFn);

    expect(referers).toEqual(["https://manhwaweb.com/", null]);
    expect(cover?.contentType).toBe("image/webp");
  });

  it("returns null when the upstream does not serve an image", async () => {
    const manga = await seedCoveredManga();
    const fetchFn = async () =>
      new Response("<html>Just a moment...</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });

    expect(await fetchMangaCover(manga.id, fetchFn)).toBeNull();
  });

  it("refuses an image too big to be a cover, and stores nothing", async () => {
    // A coverUrl can point anywhere; it used to be read whole into memory
    // and then into the database.
    const manga = await seedCoveredManga();
    const huge = new Uint8Array(MAX_COVER_IMAGE_BYTES + 1);
    const fetchFn = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(huge);
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "image/webp" } },
      );

    expect(await fetchMangaCover(manga.id, fetchFn)).toBeNull();
    const stored = await prisma.manga.findUniqueOrThrow({
      where: { id: manga.id },
    });
    expect(stored.coverImage).toBeNull();
  });

  it("returns null without fetching when there is no manga or no cover", async () => {
    const uncovered = await seedManga("no-cover", "No Cover", []);
    const fetchFn = async (): Promise<Response> => {
      throw new Error("must not be called");
    };

    expect(await fetchMangaCover(uncovered.id, fetchFn)).toBeNull();
    expect(await fetchMangaCover("nope", fetchFn)).toBeNull();
  });

  it("walks every reading site's referer after a site migration", async () => {
    const manga = await prisma.manga.create({
      data: {
        canonicalName: "Un Niño Criado",
        normalizedSlug: "un-nino-criado",
        coverUrl: COVER_URL,
        events: {
          create: [
            {
              chapterLabel: "Cap. 57",
              chapterNumber: 57,
              sourceUrl: "https://lectorxd.com/manhua/un-nio/leer/57",
              sourceDomain: "lectorxd.com",
              readAt: new Date("2026-07-19T10:00:00.000Z"),
            },
            {
              chapterLabel: "Cap. 55",
              chapterNumber: 55,
              sourceUrl: "https://manhwaweb.com/leer/un-nio_55",
              sourceDomain: "manhwaweb.com",
              readAt: new Date("2026-07-10T10:00:00.000Z"),
            },
          ],
        },
      },
    });
    const referers: (string | null)[] = [];
    const fetchFn = async (_url: string, init?: RequestInit) => {
      const referer = new Headers(init?.headers).get("referer");
      referers.push(referer);
      // The cover's own CDN (img2mw = manhwaweb) only accepts its referer.
      return referer === "https://manhwaweb.com/"
        ? imageResponse()
        : new Response("blocked", { status: 403 });
    };

    const cover = await fetchMangaCover(manga.id, fetchFn);

    expect(referers).toEqual([
      "https://lectorxd.com/",
      "https://manhwaweb.com/",
    ]);
    expect(cover?.contentType).toBe("image/webp");
  });

  it("persists the proxied bytes so the CDN is fetched at most once", async () => {
    const manga = await seedCoveredManga();

    const first = await fetchMangaCover(manga.id, async () => imageResponse());
    expect(first).not.toBeNull();

    const stored = await prisma.manga.findUniqueOrThrow({
      where: { id: manga.id },
    });
    expect(stored.coverImage).not.toBeNull();
    expect(stored.coverImageType).toBe("image/webp");
    expect(stored.coverVersion).toBe(1);

    const fetchFn = async (): Promise<Response> => {
      throw new Error("must not be called");
    };
    const second = await fetchMangaCover(manga.id, fetchFn);
    expect(second?.contentType).toBe("image/webp");
  });

  it("returns stored bytes without fetching when coverImage is present", async () => {
    const manga = await seedCoveredManga();
    await prisma.manga.update({
      where: { id: manga.id },
      data: { coverImage: COVER_BYTES, coverImageType: "image/png" },
    });
    const fetchFn = async (): Promise<Response> => {
      throw new Error("must not be called");
    };

    const cover = await fetchMangaCover(manga.id, fetchFn);

    expect(cover?.contentType).toBe("image/png");
    expect(new Uint8Array(cover?.body ?? new ArrayBuffer(0))).toEqual(
      COVER_BYTES,
    );
  });
});

describe("PUT /mangas/{id}/cover-image", () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  function putCoverImage(
    id: string,
    body: Uint8Array | string,
    contentType: string,
  ) {
    return libraryRoutes.request(`/mangas/${id}/cover-image`, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
    });
  }

  it("stores the bytes, bumps the version and serves them from /cover", async () => {
    const manga = await seedManga("solo-leveling", "Solo Leveling", []);

    const res = await putCoverImage(manga.id, PNG_BYTES, "image/png");

    expect(res.status).toBe(200);
    const dto = mangaSchema.parse(await res.json());
    expect(dto.coverVersion).toBe(1);

    const coverRes = await libraryRoutes.request(`/mangas/${manga.id}/cover`);
    expect(coverRes.status).toBe(200);
    expect(coverRes.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await coverRes.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("rejects a non-image content type", async () => {
    const manga = await seedManga("solo-leveling", "Solo Leveling", []);

    const res = await putCoverImage(manga.id, "not an image", "text/plain");

    expect(res.status).toBe(400);
    errorSchema.parse(await res.json());
  });

  it("rejects an empty body", async () => {
    const manga = await seedManga("solo-leveling", "Solo Leveling", []);

    const res = await putCoverImage(manga.id, new Uint8Array(0), "image/png");

    expect(res.status).toBe(400);
    errorSchema.parse(await res.json());
  });

  it("rejects an oversized body", async () => {
    const manga = await seedManga("solo-leveling", "Solo Leveling", []);

    const res = await putCoverImage(
      manga.id,
      new Uint8Array(5 * 1024 * 1024 + 1),
      "image/png",
    );

    expect(res.status).toBe(413);
    errorSchema.parse(await res.json());
  });

  it("responds 404 for an unknown manga", async () => {
    const res = await putCoverImage("nope", PNG_BYTES, "image/png");

    expect(res.status).toBe(404);
    errorSchema.parse(await res.json());
  });
});

describe("GET /mangas/{id}/cover", () => {
  it("responds 404 when the manga has no cover", async () => {
    const manga = await seedManga("no-cover", "No Cover", []);

    const res = await libraryRoutes.request(`/mangas/${manga.id}/cover`);

    expect(res.status).toBe(404);
    errorSchema.parse(await res.json());
  });
});

describe("DELETE /mangas/{id}", () => {
  it("makes the manga disappear from the library", async () => {
    const manga = await seedManga("junk", "Junk Manga", [
      {
        label: "Cap. 1",
        number: 1,
        domain: "olympusxyz.com",
        readAt: "2026-07-01T10:00:00.000Z",
      },
    ]);

    const res = await libraryRoutes.request(`/mangas/${manga.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(204);
    expect(await (await libraryRoutes.request("/library")).json()).toEqual([]);
    expect(await libraryRoutes.request(`/mangas/${manga.id}/history`)).toEqual(
      expect.objectContaining({ status: 404 }),
    );
  });

  it("keeps the row and its events so the deletion can reach other machines", async () => {
    const manga = await seedManga("junk", "Junk Manga", [
      {
        label: "Cap. 1",
        number: 1,
        domain: "olympusxyz.com",
        readAt: "2026-07-01T10:00:00.000Z",
      },
    ]);

    await libraryRoutes.request(`/mangas/${manga.id}`, { method: "DELETE" });

    // Soft: absence cannot carry "deleted" across machines, a timestamp can.
    const stored = await prisma.manga.findUniqueOrThrow({
      where: { id: manga.id },
    });
    expect(stored.deletedAt).not.toBe(null);
    expect(await prisma.readingEvent.count()).toBe(1);
  });

  it("responds 404 when deleting an already-deleted manga", async () => {
    const manga = await seedManga("junk", "Junk Manga", []);
    await libraryRoutes.request(`/mangas/${manga.id}`, { method: "DELETE" });

    const res = await libraryRoutes.request(`/mangas/${manga.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });

  it("responds 404 for an unknown id", async () => {
    const res = await libraryRoutes.request("/mangas/nope", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});

// The series that used to occupy two cards: same manga, two sites, two titles.
describe("merged mangas project as one card", () => {
  async function seedMergedPair() {
    const canonical = await seedManga(
      "callate-dragona-malvada-ya-no-quiero-criar-hijos-contigo",
      "Callate dragona malvada, ya no quiero criar hijos contigo",
      [
        {
          label: "Cap. 1",
          number: 1,
          domain: "sitio-a.com",
          readAt: "2026-07-01T10:00:00.000Z",
        },
        {
          label: "Cap. 2",
          number: 2,
          domain: "sitio-a.com",
          readAt: "2026-07-02T10:00:00.000Z",
        },
      ],
    );
    const alias = await seedManga(
      "callate-malvado-dragon-ya-no-quiero-criar-hijos-contigo",
      "Cállate, malvado dragón, ya no quiero criar hijos contigo",
      [
        // Chapter 2 again, on the other site: the same chapter, not a new one.
        {
          label: "Capítulo 2",
          number: 2,
          domain: "sitio-b.com",
          readAt: "2026-07-03T10:00:00.000Z",
        },
        {
          label: "Capítulo 3",
          number: 3,
          domain: "sitio-b.com",
          readAt: "2026-07-04T10:00:00.000Z",
        },
      ],
    );
    await prisma.manga.update({
      where: { id: alias.id },
      data: { mergedIntoSlug: canonical.normalizedSlug },
    });
    return { canonical, alias };
  }

  it("lists one entry that carries both sites and the combined progress", async () => {
    const { canonical } = await seedMergedPair();

    const entries = libraryResponseSchema.parse(
      await (await libraryRoutes.request("/library")).json(),
    );

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.id).toBe(canonical.id);
    expect(entry.aliasCount).toBe(1);
    expect(entry.reachedChapter).toEqual({ number: 3, label: "Capítulo 3" });
    expect(entry.sourceDomains.toSorted()).toEqual([
      "sitio-a.com",
      "sitio-b.com",
    ]);
    // Four events, three distinct chapters: chapter 2 was read on both sites.
    expect(entry.readCount).toBe(3);
    // Keep reading where the last reading happened, which is the other site.
    expect(entry.lastSourceUrl).toContain("sitio-b.com");
  });

  it("matches a domain filter against the alias's readings too", async () => {
    await seedMergedPair();

    const entries = libraryResponseSchema.parse(
      await (await libraryRoutes.request("/library?domain=sitio-b.com")).json(),
    );
    // A SQL `where` on the manga row would have returned nothing here: the
    // canonical has no event on sitio-b.com, its alias does.
    expect(entries).toHaveLength(1);
    expect(entries[0].normalizedSlug).toContain("dragona-malvada");
  });

  it("shows each chapter once in the history, saying where else it was read", async () => {
    const { canonical } = await seedMergedPair();

    const history = mangaHistorySchema.parse(
      await (
        await libraryRoutes.request(`/mangas/${canonical.id}/history`)
      ).json(),
    );

    expect(history.events.map((event) => event.chapterNumber)).toEqual([
      3, 2, 1,
    ]);
    const chapterTwo = history.events.find(
      (event) => event.chapterNumber === 2,
    );
    // The first reading is the one kept; the other site is recorded on it.
    expect(chapterTwo?.sourceDomain).toBe("sitio-a.com");
    expect(chapterTwo?.alsoReadOn).toEqual(["sitio-b.com"]);
  });

  it("serves the alias's id as the same card, so old links keep working", async () => {
    const { canonical, alias } = await seedMergedPair();

    const history = mangaHistorySchema.parse(
      await (await libraryRoutes.request(`/mangas/${alias.id}/history`)).json(),
    );
    expect(history.manga.id).toBe(canonical.id);
  });

  it("lists the merged-in mangas so the merge can be undone", async () => {
    const { canonical, alias } = await seedMergedPair();

    const history = mangaHistorySchema.parse(
      await (
        await libraryRoutes.request(`/mangas/${canonical.id}/history`)
      ).json(),
    );
    expect(history.aliases.map((entry) => entry.id)).toEqual([alias.id]);
  });

  it("edits the card even when the alias's id is used", async () => {
    const { canonical, alias } = await seedMergedPair();

    const res = await libraryRoutes.request(`/mangas/${alias.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });

    expect(mangaSchema.parse(await res.json()).id).toBe(canonical.id);
    expect(
      (await prisma.manga.findUniqueOrThrow({ where: { id: canonical.id } }))
        .status,
    ).toBe("completed");
  });

  it("deletes the whole group, so the other site cannot resurrect the card", async () => {
    const { canonical, alias } = await seedMergedPair();

    const res = await libraryRoutes.request(`/mangas/${canonical.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);

    const rows = await prisma.manga.findMany({
      where: { id: { in: [canonical.id, alias.id] } },
    });
    expect(rows.every((row) => row.deletedAt !== null)).toBe(true);
    expect(
      libraryResponseSchema.parse(
        await (await libraryRoutes.request("/library")).json(),
      ),
    ).toEqual([]);
    // Append-only: a delete never touches the log.
    expect(await prisma.readingEvent.count()).toBe(4);
  });

  it("keeps an alias's readings after the alias itself was deleted", async () => {
    const { canonical, alias } = await seedMergedPair();
    await prisma.manga.update({
      where: { id: alias.id },
      data: { deletedAt: new Date() },
    });

    const entries = libraryResponseSchema.parse(
      await (await libraryRoutes.request("/library")).json(),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(canonical.id);
    expect(entries[0].reachedChapter?.number).toBe(3);
  });
});

describe("readBounded", () => {
  const stream = (...chunks: Uint8Array[]) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
    );

  it("returns the whole body when it fits", async () => {
    const body = await readBounded(
      stream(new Uint8Array([1, 2]), new Uint8Array([3])),
      10,
    );

    expect(new Uint8Array(body ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("stops once the body grows past the limit, whatever the headers said", async () => {
    // Streamed with no Content-Length: the count has to happen while reading.
    expect(
      await readBounded(stream(new Uint8Array(6), new Uint8Array(6)), 10),
    ).toBeNull();
  });

  it("refuses up front a body that declares itself too big", async () => {
    const response = new Response("x", {
      headers: { "content-length": "999999999" },
    });

    expect(await readBounded(response, 10)).toBeNull();
  });
});

describe("getActivity", () => {
  // 09:00 in Santiago (UTC-3 in October).
  const now = new Date("2026-10-02T12:00:00.000Z");

  function chapter(number: number, readAt: string, domain = "sitio-a.com") {
    return { label: `Cap. ${number}`, number, domain, readAt };
  }

  it("counts a late-evening reading on the reader's day, not the UTC one", async () => {
    await seedManga("solo-leveling", "Solo Leveling", [
      chapter(10, "2026-10-02T02:30:00.000Z"), // Oct 1, 23:30 in Santiago
      chapter(11, "2026-10-02T04:00:00.000Z"), // Oct 2, 01:00 in Santiago
    ]);

    const santiago = await getActivity({
      days: 7,
      timeZone: "America/Santiago",
      now,
    });
    const utc = await getActivity({ days: 7, timeZone: "UTC", now });

    expect(santiago.slice(-2)).toEqual([
      { date: "2026-10-01", chapters: 1 },
      { date: "2026-10-02", chapters: 1 },
    ]);
    expect(utc.at(-1)).toEqual({ date: "2026-10-02", chapters: 2 });
  });

  it("returns every day of the window, zeros included, ending today", async () => {
    const days = await getActivity({ days: 7, timeZone: "UTC", now });

    expect(days.map((day) => day.date)).toEqual([
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
    expect(days.every((day) => day.chapters === 0)).toBe(true);
  });

  it("counts a chapter read on two merged sites the same day once", async () => {
    const canonical = await seedManga("dragona", "Dragona", [
      chapter(2, "2026-10-02T08:00:00.000Z"),
    ]);
    const alias = await seedManga("dragon", "Dragón", [
      chapter(2, "2026-10-02T09:00:00.000Z", "sitio-b.com"),
      chapter(3, "2026-10-02T10:00:00.000Z", "sitio-b.com"),
    ]);
    await prisma.manga.update({
      where: { id: alias.id },
      data: { mergedIntoSlug: canonical.normalizedSlug },
    });

    const days = await getActivity({ days: 7, timeZone: "UTC", now });

    expect(days.at(-1)).toEqual({ date: "2026-10-02", chapters: 2 });
  });

  it("leaves out a deleted card and readings older than the window", async () => {
    const deleted = await seedManga("borrado", "Borrado", [
      chapter(1, "2026-10-02T08:00:00.000Z"),
    ]);
    await prisma.manga.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });
    await seedManga("viejo", "Viejo", [chapter(1, "2026-09-01T08:00:00.000Z")]);

    const days = await getActivity({ days: 7, timeZone: "UTC", now });

    expect(days.reduce((sum, day) => sum + day.chapters, 0)).toBe(0);
  });
});

describe("GET /library/activity", () => {
  it("defaults to twelve weeks and says which zone it counted in", async () => {
    const res = await libraryRoutes.request(
      "/library/activity?tz=America/Santiago",
    );

    expect(res.status).toBe(200);
    const body = libraryActivitySchema.parse(await res.json());
    expect(body.timeZone).toBe("America/Santiago");
    expect(body.days).toHaveLength(84);
  });

  it("refuses a time zone it does not know", async () => {
    const res = await libraryRoutes.request("/library/activity?tz=Mars/Base");

    expect(res.status).toBe(400);
    expect(errorSchema.parse(await res.json()).error).toBeString();
  });

  it("refuses a window outside a week to a year and a week", async () => {
    for (const days of ["3", "400", "abc"]) {
      const res = await libraryRoutes.request(
        `/library/activity?days=${days}&tz=UTC`,
      );
      expect(res.status).toBe(400);
    }
  });
});
