import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import {
  APP_ORIGINS,
  embeddingRoutes,
  frameAncestors,
  summarizeReport,
} from "./embedding.routes";

const pageOn = (platform: NodeJS.Platform) =>
  new Hono().get("/", frameAncestors(platform), (c) =>
    c.html("<p>dashboard</p>"),
  );

describe("frameAncestors on a platform it was measured on", () => {
  it("enforces the app's origins, and still reports what it blocks", async () => {
    const res = await pageOn("darwin").request("/");
    const policy = res.headers.get("content-security-policy") ?? "";

    expect(res.status).toBe(200);
    for (const origin of APP_ORIGINS) {
      expect(policy).toContain(origin);
    }
    expect(policy).toContain("policy=enforced");
  });

  it("drops the control, whose only job was to prove reports arrive", async () => {
    const res = await pageOn("darwin").request("/");

    expect(res.headers.get("content-security-policy")).not.toContain("'none'");
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
  });
});

describe("frameAncestors on a platform nobody has measured", () => {
  it("measures, and never blocks", async () => {
    // Enforced and wrong, the policy would blank the dashboard inside the
    // desktop app. Report-Only cannot.
    const res = await pageOn("win32").request("/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("sends the app's origins, and a control that every frame violates", async () => {
    const res = await pageOn("win32").request("/");
    const policies =
      res.headers.get("content-security-policy-report-only") ?? "";

    for (const origin of APP_ORIGINS) {
      expect(policies).toContain(origin);
    }
    expect(policies).toContain("frame-ancestors 'none'");
    expect(policies).toContain("policy=allowlist");
    expect(policies).toContain("policy=control");
  });
});

describe("embeddingRoutes", () => {
  it("logs one line per report, naming the policy", async () => {
    const lines: string[] = [];
    const app = embeddingRoutes((line) => lines.push(line));

    const res = await app.request("/api/csp-report?policy=control", {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: JSON.stringify({
        "csp-report": {
          "document-uri": "http://127.0.0.1:5150/",
          "effective-directive": "frame-ancestors",
          "blocked-uri": "wails://wails",
        },
      }),
    });

    expect(res.status).toBe(204);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"policy":"control"');
    expect(lines[0]).toContain("wails://wails");
  });

  it("logs each entry of a Reporting API list on a line of its own", async () => {
    const lines: string[] = [];
    const app = embeddingRoutes((line) => lines.push(line));

    const res = await app.request("/api/csp-report?policy=enforced", {
      method: "POST",
      headers: { "content-type": "application/reports+json" },
      body: JSON.stringify([
        {
          type: "csp-violation",
          body: {
            effectiveDirective: "frame-ancestors",
            blockedURL: "http://127.0.0.1:5150/",
          },
        },
        {
          type: "csp-violation",
          body: {
            effectiveDirective: "frame-ancestors",
            blockedURL: "http://127.0.0.1:5150/manga/1",
          },
        },
      ]),
    });

    expect(res.status).toBe(204);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"directive":"frame-ancestors"');
    expect(lines[1]).toContain("/manga/1");
  });

  it("refuses a body too big to be a report", async () => {
    const lines: string[] = [];
    const app = embeddingRoutes((line) => lines.push(line));

    const res = await app.request("/api/csp-report?policy=control", {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: "x".repeat(17 * 1024),
    });

    expect(res.status).toBe(413);
    expect(lines).toEqual([]);
  });

  it("records nothing for a body that is not a report", async () => {
    const lines: string[] = [];
    const app = embeddingRoutes((line) => lines.push(line));

    const res = await app.request("/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    expect(lines).toEqual([]);
  });
});

describe("summarizeReport", () => {
  it("reads the Reporting API shape as well as the legacy one", () => {
    expect(
      summarizeReport("allowlist", {
        body: {
          effectiveDirective: "frame-ancestors",
          blockedURL: "http://wails.localhost",
          documentURL: "http://127.0.0.1:5150/",
        },
      }),
    ).toMatchObject({
      policy: "allowlist",
      directive: "frame-ancestors",
      blocked: "http://wails.localhost",
    });
  });
});
