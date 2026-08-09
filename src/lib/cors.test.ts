import { describe, expect, it } from "bun:test";
import {
  allowedOrigins,
  DEFAULT_EXTENSION_IDS,
  parseExtensionIds,
  STORE_EXTENSION_ID,
  UNPACKED_EXTENSION_ID,
} from "./cors";

const STORE_ID = "abcdefghijklmnopabcdefghijklmnop";

describe("parseExtensionIds", () => {
  it("falls back to every published id when nothing is configured", () => {
    // A machine with no .env has to reach the backend whichever build it
    // installed: the Web Store one or a hand-loaded developer build.
    expect(parseExtensionIds(undefined)).toEqual(DEFAULT_EXTENSION_IDS);
    expect(parseExtensionIds("")).toEqual(DEFAULT_EXTENSION_IDS);
    expect(parseExtensionIds("   ")).toEqual(DEFAULT_EXTENSION_IDS);
  });

  it("defaults to both the unpacked and the Web Store build", () => {
    expect(DEFAULT_EXTENSION_IDS).toContain(UNPACKED_EXTENSION_ID);
    expect(DEFAULT_EXTENSION_IDS).toContain(STORE_EXTENSION_ID);
  });

  it("accepts several ids so a published build and an unpacked one coexist", () => {
    // The transition that matters: the Web Store assigns a new id, and the old
    // one has to keep working until every machine has updated.
    expect(parseExtensionIds(`${UNPACKED_EXTENSION_ID},${STORE_ID}`)).toEqual([
      UNPACKED_EXTENSION_ID,
      STORE_ID,
    ]);
  });

  it("tolerates the spacing of a hand-edited env file", () => {
    expect(
      parseExtensionIds(` ${STORE_ID} , ${UNPACKED_EXTENSION_ID} ,`),
    ).toEqual([STORE_ID, UNPACKED_EXTENSION_ID]);
  });

  it("rejects a malformed id instead of dropping it", () => {
    // Silently skipping it would show up much later as an extension that
    // cannot reach the backend, with nothing in the logs pointing here.
    expect(() => parseExtensionIds("not-an-id")).toThrow(/not-an-id/);
    expect(() => parseExtensionIds(`${STORE_ID},nope`)).toThrow(/nope/);
    // 32 characters, but q is outside Chrome's a–p alphabet.
    expect(() => parseExtensionIds("q".repeat(32))).toThrow(/qqq/);
    expect(() => parseExtensionIds(UNPACKED_EXTENSION_ID.slice(1))).toThrow();
  });
});

describe("allowedOrigins", () => {
  it("follows the port the server actually listens on", () => {
    const origins = allowedOrigins({ port: 61234, extensionIds: [STORE_ID] });

    expect(origins).toContain("http://127.0.0.1:61234");
    expect(origins).toContain("http://localhost:61234");
    // The whole point of the change: no origin left pinned to 5150.
    expect(origins.some((origin) => origin.includes("5150"))).toBe(false);
  });

  it("lists one origin per configured extension", () => {
    const origins = allowedOrigins({
      port: 5150,
      extensionIds: [UNPACKED_EXTENSION_ID, STORE_ID],
    });

    expect(origins).toContain(`chrome-extension://${UNPACKED_EXTENSION_ID}`);
    expect(origins).toContain(`chrome-extension://${STORE_ID}`);
    expect(origins).toHaveLength(4);
  });

  it("admits nothing beyond loopback and the listed extensions", () => {
    const origins = allowedOrigins({ port: 5150, extensionIds: [STORE_ID] });

    expect(origins).not.toContain("https://example.com");
    expect(origins).not.toContain(
      "chrome-extension://cfjiinlnepkmlaafdclmlpjbmpofplop",
    );
    expect(origins).not.toContain("http://localhost:5173");
  });
});
