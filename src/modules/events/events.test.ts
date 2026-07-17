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

  it("inserts unseen chapters even when the number regresses (server change)", async () => {
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

  it("returns the existing event for a repeated report of a chapter", async () => {
    const first = createEventResponseSchema.parse(
      await (
        await postEvent({
          mangaName: "Nano Machine",
          chapterLabel: "Cap. 49",
          sourceUrl: "https://olympusxyz.com/capitulo/900001/",
        })
      ).json(),
    );

    const res = await postEvent({
      mangaName: "Nano Machine",
      chapterLabel: "Cap. 49",
      sourceUrl: "https://olympusxyz.com/capitulo/900001/",
    });

    expect(res.status).toBe(200);
    const second = createEventResponseSchema.parse(await res.json());
    expect(second.event.id).toBe(first.event.id);
    expect(await prisma.readingEvent.count()).toBe(1);
  });

  it("deduplicates by parsed chapter number, not by the raw label", async () => {
    await postEvent({
      mangaName: "Nano Machine",
      chapterLabel: "Chapter 49",
      sourceUrl: "https://siteone.com/nano-machine/49",
    });

    const res = await postEvent({
      mangaName: "Nano Machine",
      chapterLabel: "Cap. 49",
      sourceUrl: "https://sitetwo.net/nano-machine/cap-49",
    });

    expect(res.status).toBe(200);
    expect(await prisma.readingEvent.count()).toBe(1);
  });

  it("does not re-insert an old chapter after newer ones were read", async () => {
    for (const label of ["Cap. 49", "Cap. 50"]) {
      await postEvent({
        mangaName: "Nano Machine",
        chapterLabel: label,
        sourceUrl: "https://olympusxyz.com/nano-machine",
      });
    }

    const res = await postEvent({
      mangaName: "Nano Machine",
      chapterLabel: "Cap. 49",
      sourceUrl: "https://olympusxyz.com/nano-machine",
    });

    expect(res.status).toBe(200);
    expect(await prisma.readingEvent.count()).toBe(2);
  });

  it("does not re-insert a chapter no matter how old its event is", async () => {
    const first = createEventResponseSchema.parse(
      await (
        await postEvent({
          mangaName: "Nano Machine",
          chapterLabel: "Cap. 49",
          sourceUrl: "https://olympusxyz.com/nano-machine",
        })
      ).json(),
    );
    // Test-only state crafting: the app itself never updates events.
    await prisma.readingEvent.update({
      where: { id: first.event.id },
      data: { readAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
    });

    const res = await postEvent({
      mangaName: "Nano Machine",
      chapterLabel: "Cap. 49",
      sourceUrl: "https://olympusxyz.com/nano-machine",
    });

    expect(res.status).toBe(200);
    expect(await prisma.readingEvent.count()).toBe(1);
  });

  it("deduplicates unparseable labels by their exact text", async () => {
    await postEvent({
      mangaName: "Berserk",
      chapterLabel: "Extra Omake",
      sourceUrl: "https://olympusxyz.com/berserk/extra",
    });

    const repeated = await postEvent({
      mangaName: "Berserk",
      chapterLabel: "Extra Omake",
      sourceUrl: "https://olympusxyz.com/berserk/extra",
    });
    expect(repeated.status).toBe(200);

    const different = await postEvent({
      mangaName: "Berserk",
      chapterLabel: "Otro Extra",
      sourceUrl: "https://olympusxyz.com/berserk/otro-extra",
    });
    expect(different.status).toBe(201);
    expect(await prisma.readingEvent.count()).toBe(2);
  });

  it("persists the reported cover on the manga, even on deduped reports", async () => {
    await postEvent({
      mangaName: "Nano Machine",
      chapterLabel: "Cap. 49",
      sourceUrl: "https://olympusxyz.com/nano-machine",
    });

    const res = await postEvent({
      mangaName: "Nano Machine",
      chapterLabel: "Cap. 49",
      sourceUrl: "https://olympusxyz.com/nano-machine",
      coverUrl: "https://olympusxyz.com/covers/nano-machine.jpg",
    });

    expect(res.status).toBe(200);
    const manga = await prisma.manga.findUniqueOrThrow({
      where: { normalizedSlug: "nano-machine" },
    });
    expect(manga.coverUrl).toBe(
      "https://olympusxyz.com/covers/nano-machine.jpg",
    );
    expect(await prisma.readingEvent.count()).toBe(1);
  });

  it("never overwrites an existing cover (first cover wins)", async () => {
    await postEvent({
      mangaName: "Nano Machine",
      chapterLabel: "Cap. 49",
      sourceUrl: "https://olympusxyz.com/nano-machine",
      coverUrl: "https://cdn.example.com/real-cover.jpg",
    });

    await postEvent({
      mangaName: "Nano Machine",
      chapterLabel: "Cap. 50",
      sourceUrl: "https://olympusxyz.com/nano-machine",
      coverUrl: "https://olympusxyz.com/other-image.webp",
    });

    const manga = await prisma.manga.findUniqueOrThrow({
      where: { normalizedSlug: "nano-machine" },
    });
    expect(manga.coverUrl).toBe("https://cdn.example.com/real-cover.jpg");
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
