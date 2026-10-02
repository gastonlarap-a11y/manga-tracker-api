import { beforeEach, describe, expect, it } from "bun:test";
import { prisma } from "../../db/client";
import { isParsableSelector } from "../../lib/css-selector";
import {
  EXTENSION_CATALOGUE,
  EXTENSION_CONFIG_SCHEMA_VERSION,
} from "../../lib/extension-config";
import { extensionRoutes } from "./extension.routes";
import { DEFAULT_EXTENSION_SETTINGS } from "./extension.service";

type Settings = {
  readingRequired: boolean;
  readMinSeconds: number;
  readMinScrollPercent: number;
};

type Config = {
  schemaVersion: number;
  minExtensionVersion: string;
  detection: Record<string, unknown>;
  themes: {
    name: string;
    readerMarker: string;
    headingSelector: string | null;
    seriesLinkSelector: string | null;
    nextSelector: string | null;
  }[];
  notices: { id: string; level: string; text: string }[];
  reading: Settings;
};

const put = (body: unknown) =>
  extensionRoutes.request("/extension-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const config = async (): Promise<Config> => {
  const res = await extensionRoutes.request("/extension-config");
  expect(res.status).toBe(200);
  return (await res.json()) as Config;
};

beforeEach(async () => {
  await prisma.extensionSettings.deleteMany();
});

describe("GET /extension-config", () => {
  it("serves the catalogue with the reading settings of this machine", async () => {
    const served = await config();

    expect(served.schemaVersion).toBe(EXTENSION_CONFIG_SCHEMA_VERSION);
    expect(served.minExtensionVersion).toBe(
      EXTENSION_CATALOGUE.minExtensionVersion,
    );
    expect(served.themes.map((theme) => theme.name)).toEqual(
      EXTENSION_CATALOGUE.themes.map((theme) => theme.name),
    );
    expect(served.reading).toEqual(DEFAULT_EXTENSION_SETTINGS);
  });

  it("sends an unset number as null, which the extension reads as its default", async () => {
    const { detection } = await config();

    // Absent in the catalogue today; an undefined would vanish from the JSON
    // and leave the extension unable to tell "no override" from "old server".
    expect(detection.confidenceThreshold).toBeNull();
    expect(detection.settleDelayMs).toBeNull();
    expect(Array.isArray(detection.chapterUrlPatterns)).toBe(true);
  });

  it("reflects a change made from the dashboard", async () => {
    await put({
      readingRequired: true,
      readMinSeconds: 45,
      readMinScrollPercent: 60,
    });

    expect((await config()).reading).toEqual({
      readingRequired: true,
      readMinSeconds: 45,
      readMinScrollPercent: 60,
    });
  });
});

describe("PUT /extension-settings", () => {
  it("replaces the settings and answers with them", async () => {
    const res = await put({
      readingRequired: true,
      readMinSeconds: 0,
      readMinScrollPercent: 90,
    });

    expect(res.status).toBe(200);
    const saved = (await res.json()) as Settings;
    expect(saved.readMinSeconds).toBe(0);

    const read = await extensionRoutes.request("/extension-settings");
    expect(await read.json()).toEqual(saved);
  });

  it("refuses values no reader could mean", async () => {
    for (const body of [
      { readingRequired: true, readMinSeconds: -1, readMinScrollPercent: 50 },
      { readingRequired: true, readMinSeconds: 30, readMinScrollPercent: 101 },
      { readingRequired: true, readMinSeconds: 1.5, readMinScrollPercent: 50 },
      { readingRequired: "yes", readMinSeconds: 30, readMinScrollPercent: 50 },
      { readMinSeconds: 30, readMinScrollPercent: 50 },
    ]) {
      expect((await put(body)).status).toBe(400);
    }
  });

  it("keeps one row however many times it is saved", async () => {
    await put({ ...DEFAULT_EXTENSION_SETTINGS, readMinSeconds: 10 });
    await put({ ...DEFAULT_EXTENSION_SETTINGS, readMinSeconds: 20 });

    expect(await prisma.extensionSettings.count()).toBe(1);
  });
});

describe("the absent row", () => {
  it("means the same values the columns default to", async () => {
    // A row created with nothing but its id carries the column defaults; they
    // and DEFAULT_EXTENSION_SETTINGS must be one answer, not two.
    const row = await prisma.extensionSettings.create({ data: { id: 1 } });

    expect({
      readingRequired: row.readingRequired,
      readMinSeconds: row.readMinSeconds,
      readMinScrollPercent: row.readMinScrollPercent,
    }).toEqual(DEFAULT_EXTENSION_SETTINGS);
  });
});

describe("the catalogue", () => {
  it("only carries regexes that compile", () => {
    const { detection } = EXTENSION_CATALOGUE;
    for (const pattern of [
      ...detection.chapterUrlPatterns,
      ...detection.readerPathPatterns,
    ]) {
      expect(() => new RegExp(pattern, "i")).not.toThrow();
    }
  });

  it("captures a chapter number in every chapter URL pattern", () => {
    // Group 1 is the number: a pattern without a group would mark a page as a
    // chapter and then have nothing to record as one.
    for (const pattern of EXTENSION_CATALOGUE.detection.chapterUrlPatterns) {
      expect(new RegExp(`${pattern}|`).exec("")?.length).toBeGreaterThan(1);
    }
  });

  it("gives every theme a marker and only selectors a browser can parse", () => {
    for (const theme of EXTENSION_CATALOGUE.themes) {
      expect(theme.name).toMatch(/^[a-z0-9-]+$/);
      expect(isParsableSelector(theme.readerMarker)).toBe(true);
      for (const selector of [
        theme.headingSelector,
        theme.seriesLinkSelector,
        theme.nextSelector,
      ]) {
        if (selector !== undefined) {
          expect(isParsableSelector(selector)).toBe(true);
        }
      }
    }
  });

  it("names each theme and each notice once", () => {
    const themes = EXTENSION_CATALOGUE.themes.map((theme) => theme.name);
    const notices = EXTENSION_CATALOGUE.notices.map((notice) => notice.id);
    expect(new Set(themes).size).toBe(themes.length);
    expect(new Set(notices).size).toBe(notices.length);
  });

  it("asks for a version the extension can compare", () => {
    expect(EXTENSION_CATALOGUE.minExtensionVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
