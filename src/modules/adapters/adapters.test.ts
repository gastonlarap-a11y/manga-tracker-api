import { beforeEach, describe, expect, it } from "bun:test";
import { prisma } from "../../db/client";
import { errorSchema } from "../../lib/http";
import { adaptersRoutes, siteAdapterSchema } from "./adapters.routes";

const postAdapter = (body: unknown) =>
  adaptersRoutes.request("/adapters", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  await prisma.siteAdapter.deleteMany();
});

describe("POST /adapters + GET /adapters/{domain}", () => {
  it("stores a config and returns it unchanged on read", async () => {
    const created = await postAdapter({
      domain: "olympusxyz.com",
      titleSelector: "h1.title",
      chapterSelector: ".chapter",
    });
    expect(created.status).toBe(200);

    const res = await adaptersRoutes.request("/adapters/olympusxyz.com");
    expect(res.status).toBe(200);
    const adapter = siteAdapterSchema.parse(await res.json());
    expect(adapter.domain).toBe("olympusxyz.com");
    expect(adapter.titleSelector).toBe("h1.title");
    expect(adapter.chapterSelector).toBe(".chapter");
    expect(adapter.chapterUrlRegex).toBeNull();
  });

  it("replaces the whole config on recalibration (one row per domain)", async () => {
    await postAdapter({
      domain: "olympusxyz.com",
      titleSelector: "h1.title",
      chapterSelector: ".chapter",
      chapterUrlRegex: "/cap-(\\d+)",
    });
    await postAdapter({
      domain: "olympusxyz.com",
      titleSelector: "h2.new-title",
    });

    expect(await prisma.siteAdapter.count()).toBe(1);
    const adapter = siteAdapterSchema.parse(
      await (await adaptersRoutes.request("/adapters/olympusxyz.com")).json(),
    );
    expect(adapter.titleSelector).toBe("h2.new-title");
    expect(adapter.chapterSelector).toBeNull();
    expect(adapter.chapterUrlRegex).toBeNull();
  });

  it("treats domains case-insensitively", async () => {
    await postAdapter({ domain: "OlympusXYZ.com", titleSelector: "h1" });

    const res = await adaptersRoutes.request("/adapters/olympusxyz.com");
    expect(res.status).toBe(200);
  });

  it("responds 404 for a domain without adapter", async () => {
    const res = await adaptersRoutes.request("/adapters/unknown.com");
    expect(res.status).toBe(404);
    errorSchema.parse(await res.json());
  });

  it("rejects a body without titleSelector with a JSON 400", async () => {
    const res = await postAdapter({ domain: "olympusxyz.com" });
    expect(res.status).toBe(400);
    expect(errorSchema.parse(await res.json()).error).toContain(
      "titleSelector",
    );
  });
});

describe("DELETE /adapters/{domain}", () => {
  const remove = (domain: string) =>
    adaptersRoutes.request(`/adapters/${domain}`, { method: "DELETE" });

  it("removes a calibration: reads answer as if it never existed", async () => {
    await postAdapter({ domain: "lectorxd.com", titleSelector: "h1" });

    expect((await remove("lectorxd.com")).status).toBe(204);
    expect(
      (await adaptersRoutes.request("/adapters/lectorxd.com")).status,
    ).toBe(404);
  });

  it("keeps the row as a stamped tombstone, so the sync carries it", async () => {
    await postAdapter({ domain: "lectorxd.com", titleSelector: "h1" });
    const before = await prisma.siteAdapter.findUniqueOrThrow({
      where: { domain: "lectorxd.com" },
    });

    await remove("LectorXD.com");

    const after = await prisma.siteAdapter.findUniqueOrThrow({
      where: { domain: "lectorxd.com" },
    });
    expect(after.deletedAt).not.toBeNull();
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.updatedAt.getTime(),
    );
  });

  it("answers 404 for a site with nothing to remove, twice included", async () => {
    expect((await remove("nadie.com")).status).toBe(404);

    await postAdapter({ domain: "lectorxd.com", titleSelector: "h1" });
    await remove("lectorxd.com");
    expect((await remove("lectorxd.com")).status).toBe(404);
  });

  it("drops out of the list of calibrations", async () => {
    await postAdapter({ domain: "lectorxd.com", titleSelector: "h1" });
    await postAdapter({ domain: "leercapitulo.com", titleSelector: "h1" });
    await remove("lectorxd.com");

    const res = await adaptersRoutes.request("/adapters");
    const listed = (await res.json()) as { domain: string }[];

    expect(res.status).toBe(200);
    expect(listed.map((adapter) => adapter.domain)).toEqual([
      "leercapitulo.com",
    ]);
  });

  it("is undone by calibrating the site again", async () => {
    await postAdapter({ domain: "lectorxd.com", titleSelector: "h1" });
    await remove("lectorxd.com");

    await postAdapter({ domain: "lectorxd.com", titleSelector: "h1 > span" });

    const res = await adaptersRoutes.request("/adapters/lectorxd.com");
    expect(res.status).toBe(200);
    expect(siteAdapterSchema.parse(await res.json()).titleSelector).toBe(
      "h1 > span",
    );
  });
});
