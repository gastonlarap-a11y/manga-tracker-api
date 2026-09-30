import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { STORE_EXTENSION_ID, UNPACKED_EXTENSION_ID } from "./cors";
import { errorHandler } from "./http";
import { isLoopbackHost, localRequestGuards } from "./local-guard";

const PORT = 5150;
const SELF = `http://127.0.0.1:${PORT}`;

/**
 * The guards in front of three stand-in routes, wired the way src/index.ts
 * wires them — including the error handler, which is what turns csrf's
 * exception into a 403 rather than a 500.
 */
function guarded() {
  return new Hono()
    .use(
      "*",
      ...localRequestGuards({
        port: PORT,
        extensionIds: [UNPACKED_EXTENSION_ID, STORE_EXTENSION_ID],
      }),
    )
    .onError(errorHandler)
    .post("/api/sync/restore", (c) => c.json({ restored: true }))
    .post("/api/events", (c) => c.json({ recorded: true }))
    .delete("/api/mangas/:id", (c) => c.json({ deleted: true }))
    .get("/api/library", (c) => c.json([]));
}

describe("isLoopbackHost", () => {
  it.each([
    ["127.0.0.1:5150"],
    ["localhost:5150"],
    // The Vite dev proxy forwards its own Host unchanged.
    ["localhost:5173"],
    ["localhost"],
  ])("accepts %s", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    ["evil.example:5150"],
    // A name that merely starts like loopback is somebody else's.
    ["127.0.0.1.evil.example"],
    ["localhost.evil.example:5150"],
    [""],
  ])("refuses %s", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("localRequestGuards", () => {
  it("refuses a bodiless POST fired by another site", async () => {
    // The request that motivated this: CORS never blocked it, because the page
    // firing it does not need to read the answer.
    const res = await guarded().request(`${SELF}/api/sync/restore?force=true`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    });

    expect(res.status).toBe(403);
  });

  it("refuses a form-typed POST from another site", async () => {
    const res = await guarded().request(`${SELF}/api/events`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "text/plain",
      },
      body: "{}",
    });

    expect(res.status).toBe(403);
  });

  it("lets the dashboard it serves post to it", async () => {
    const res = await guarded().request(`${SELF}/api/sync/restore`, {
      method: "POST",
      headers: { origin: SELF, "sec-fetch-site": "same-origin" },
    });

    expect(res.status).toBe(200);
  });

  it("lets the dashboard through the Vite dev proxy", async () => {
    // The proxy keeps the dev server's Origin, which is not on the allowlist,
    // but the browser marked the request same-origin — and it was.
    const res = await guarded().request(`${SELF}/api/sync/restore`, {
      method: "POST",
      headers: {
        host: "localhost:5173",
        origin: "http://localhost:5173",
        "sec-fetch-site": "same-origin",
      },
    });

    expect(res.status).toBe(200);
  });

  it("lets either build of the extension through", async () => {
    for (const id of [UNPACKED_EXTENSION_ID, STORE_EXTENSION_ID]) {
      const res = await guarded().request(`${SELF}/api/mangas/abc`, {
        method: "DELETE",
        headers: {
          origin: `chrome-extension://${id}`,
          "sec-fetch-site": "none",
        },
      });

      expect(res.status).toBe(200);
    }
  });

  it("leaves JSON to CORS, which preflights it", async () => {
    // Not a gap: a cross-site page cannot send application/json without a
    // preflight, and CORS answers that preflight with no allowed origin.
    const res = await guarded().request(`${SELF}/api/events`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(200);
  });

  it("refuses a rebound hostname even when it is same-origin with itself", async () => {
    // After DNS rebinding the attacker's page and this server share an origin,
    // so Origin and Sec-Fetch-Site both look fine. Only Host gives it away.
    const res = await guarded().request(`${SELF}/api/library`, {
      headers: {
        host: `evil.example:${PORT}`,
        origin: `http://evil.example:${PORT}`,
        "sec-fetch-site": "same-origin",
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "This server only answers to this machine.",
    });
  });

  it("answers reads without asking where they came from", async () => {
    const res = await guarded().request(`${SELF}/api/library`);

    expect(res.status).toBe(200);
  });
});
