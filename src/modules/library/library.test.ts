import { beforeEach, describe, expect, it } from "bun:test";
import { z } from "@hono/zod-openapi";
import { prisma } from "../../db/client";
import { errorSchema } from "../../lib/http";
import { mangaSchema } from "../../lib/schemas";
import {
  libraryEntrySchema,
  libraryRoutes,
  mangaHistorySchema,
} from "./library.routes";
import { fetchMangaCover } from "./library.service";

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

  it("returns null without fetching when there is no manga or no cover", async () => {
    const uncovered = await seedManga("no-cover", "No Cover", []);
    const fetchFn = async (): Promise<Response> => {
      throw new Error("must not be called");
    };

    expect(await fetchMangaCover(uncovered.id, fetchFn)).toBeNull();
    expect(await fetchMangaCover("nope", fetchFn)).toBeNull();
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
  it("deletes the manga and its whole history", async () => {
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
    expect(await prisma.manga.count()).toBe(0);
    expect(await prisma.readingEvent.count()).toBe(0);
  });

  it("responds 404 for an unknown id", async () => {
    const res = await libraryRoutes.request("/mangas/nope", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
