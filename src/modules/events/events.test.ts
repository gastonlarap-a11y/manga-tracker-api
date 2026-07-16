import { beforeEach, describe, expect, it } from "bun:test";
import { z } from "@hono/zod-openapi";
import { prisma } from "../../db/client";
import { errorSchema } from "../../lib/http";
import { mangaSchema, readingEventSchema } from "../../lib/schemas";
import { eventsRoutes } from "./events.routes";

const createEventResponseSchema = z.object({
  manga: mangaSchema,
  event: readingEventSchema,
});

const postEvent = (body: unknown) =>
  eventsRoutes.request("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  await prisma.manga.deleteMany();
});

describe("POST /events", () => {
  it("records an event deriving slug, domain and chapter number", async () => {
    const res = await postEvent({
      mangaName: "Solo Leveling",
      chapterLabel: "Cap. 10.5",
      sourceUrl: "https://olympusxyz.com/solo-leveling/cap-10-5",
    });

    expect(res.status).toBe(201);
    const body = createEventResponseSchema.parse(await res.json());
    expect(body.manga.normalizedSlug).toBe("solo-leveling");
    expect(body.manga.canonicalName).toBe("Solo Leveling");
    expect(body.event.chapterNumber).toBe(10.5);
    expect(body.event.sourceDomain).toBe("olympusxyz.com");
    expect(body.event.mangaId).toBe(body.manga.id);
  });

  it("deduplicates mangas by normalized slug", async () => {
    const first = createEventResponseSchema.parse(
      await (
        await postEvent({
          mangaName: "One Piece",
          chapterLabel: "Chapter 100",
          sourceUrl: "https://siteone.com/one-piece/100",
        })
      ).json(),
    );
    const second = createEventResponseSchema.parse(
      await (
        await postEvent({
          mangaName: "One Piece Manga",
          chapterLabel: "Chapter 101",
          sourceUrl: "https://sitetwo.net/one-piece/101",
        })
      ).json(),
    );

    expect(second.manga.id).toBe(first.manga.id);
    expect(await prisma.manga.count()).toBe(1);
    expect(await prisma.readingEvent.count()).toBe(2);
  });

  it("always inserts, even when the chapter regresses (server change)", async () => {
    for (const label of ["Cap. 10", "Cap. 11", "Cap. 12", "Cap. 1"]) {
      const res = await postEvent({
        mangaName: "Solo Leveling",
        chapterLabel: label,
        sourceUrl: "https://newserver.net/solo-leveling",
      });
      expect(res.status).toBe(201);
    }

    expect(await prisma.readingEvent.count()).toBe(4);
  });

  it("stores a null chapter number for unparseable labels", async () => {
    const res = await postEvent({
      mangaName: "Berserk",
      chapterLabel: "Extra Omake",
      sourceUrl: "https://olympusxyz.com/berserk/extra",
    });

    expect(res.status).toBe(201);
    const body = createEventResponseSchema.parse(await res.json());
    expect(body.event.chapterNumber).toBeNull();
  });

  it("rejects a missing mangaName with a JSON 400", async () => {
    const res = await postEvent({
      chapterLabel: "Cap. 1",
      sourceUrl: "https://olympusxyz.com/x/1",
    });

    expect(res.status).toBe(400);
    expect(errorSchema.parse(await res.json()).error).toContain("mangaName");
  });

  it("rejects an invalid sourceUrl with a JSON 400", async () => {
    const res = await postEvent({
      mangaName: "Solo Leveling",
      chapterLabel: "Cap. 1",
      sourceUrl: "not-a-url",
    });

    expect(res.status).toBe(400);
    errorSchema.parse(await res.json());
    expect(await prisma.readingEvent.count()).toBe(0);
  });
});
