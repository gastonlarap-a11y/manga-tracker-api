import { beforeEach, describe, expect, it } from "bun:test";
import { prisma } from "../../db/client";
import { SITE_RULES } from "../../lib/site-rules";
import { siteRulesRoutes } from "./site-rules.routes";

type Listed = {
  domain: string;
  series: { pattern: string; template: string; navigable: boolean } | null;
  titleSelector: string | null;
  chapterSelector: string | null;
  chapterUrlRegex: string | null;
};

const list = async (): Promise<Listed[]> => {
  const res = await siteRulesRoutes.request("/site-rules");
  expect(res.status).toBe(200);
  return (await res.json()) as Listed[];
};

beforeEach(async () => {
  await prisma.siteAdapter.deleteMany();
});

describe("GET /site-rules", () => {
  it("serves the curated catalogue on a machine that calibrated nothing", async () => {
    const rules = await list();

    expect(rules).toHaveLength(SITE_RULES.length);
    for (const curated of SITE_RULES) {
      const served = rules.find((rule) => rule.domain === curated.domain);
      expect(served?.series?.pattern).toBe(curated.series.pattern);
      expect(served?.titleSelector).toBeNull();
    }
  });

  it("adds this machine's calibrations to the list", async () => {
    await prisma.siteAdapter.create({
      data: { domain: "leercapitulo.com", titleSelector: "h1.title" },
    });

    const rules = await list();
    const calibrated = rules.find((rule) => rule.domain === "leercapitulo.com");

    expect(calibrated?.titleSelector).toBe("h1.title");
    // Nothing curated for that site, and a calibration says nothing about
    // series identity.
    expect(calibrated?.series).toBeNull();
  });

  it("keeps the curated series rule when the same site is calibrated", async () => {
    // The two halves answer different questions — which element holds the
    // title, and how the URL names the series — so one must not erase the other.
    await prisma.siteAdapter.create({
      data: { domain: "olympusxyz.com", titleSelector: "h1.series" },
    });

    const rules = await list();
    const olympus = rules.find((rule) => rule.domain === "olympusxyz.com");

    expect(olympus?.titleSelector).toBe("h1.series");
    expect(olympus?.series).not.toBeNull();
    expect(olympus?.series?.navigable).toBe(false);
  });

  it("lists every domain exactly once", async () => {
    await prisma.siteAdapter.create({
      data: { domain: "manhwaweb.com", titleSelector: "h1" },
    });

    const domains = (await list()).map((rule) => rule.domain);

    expect(new Set(domains).size).toBe(domains.length);
  });
});
