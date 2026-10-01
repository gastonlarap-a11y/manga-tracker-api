/**
 * Who may show the dashboard in a frame — enforced where it was measured.
 *
 * The desktop app shows the dashboard in an iframe, and nothing else should:
 * any page open in the browser can frame http://127.0.0.1:<port>/ and, once it
 * greets the embed bridge, receive every chapter link clicked inside. The fix
 * is a `frame-ancestors` policy naming the app's origins. Guessed wrong, it
 * blanks the dashboard inside the app — so on a platform nobody has measured
 * yet it goes out Report-Only, as two policies:
 *
 * - `allowlist`: the origins the app is served from — `wails://wails` on
 *   macOS, `http://wails.localhost` on Windows (both read from Wails 2.12's
 *   own `startURL`), `http://localhost:34115` under `wails dev`. A report from
 *   this one means enforcing it would have blocked the app.
 * - `control`: `'none'`, which every frame violates. It exists to prove the
 *   webview sends reports at all — without it, silence from the allowlist
 *   would mean nothing.
 *
 * Measured, the allowlist is enforced and still reports, as `enforced`: a line
 * from it is either a page that tried to frame the dashboard, or the app's own
 * window after its origin changed — and the second is a blank window whose
 * only trace is that line.
 *
 * Every report is logged, one line each, to the service's own log.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

/** The origins the desktop app's window is served from. */
export const APP_ORIGINS = [
  "wails://wails",
  "http://wails.localhost",
  "http://localhost:34115",
] as const;

const REPORT_PATH = "/api/csp-report";

const ALLOWLIST = `frame-ancestors 'self' ${APP_ORIGINS.join(" ")}`;

/**
 * Where a real app window produced a control report and no allowlist report.
 * macOS: 2026-10-01, WKWebView on v0.1.15. Windows has produced no report yet,
 * so WebView2 stays measured, not trusted.
 */
const MEASURED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin"]);

type PolicyHeader = readonly [
  name: "Content-Security-Policy" | "Content-Security-Policy-Report-Only",
  value: string,
];

/** The frame-ancestors headers a dashboard page carries on `platform`. */
export function framePolicies(
  platform: NodeJS.Platform,
): readonly PolicyHeader[] {
  if (MEASURED_PLATFORMS.has(platform)) {
    return [
      [
        "Content-Security-Policy",
        `${ALLOWLIST}; report-uri ${REPORT_PATH}?policy=enforced`,
      ],
    ];
  }
  return [
    [
      "Content-Security-Policy-Report-Only",
      `${ALLOWLIST}; report-uri ${REPORT_PATH}?policy=allowlist`,
    ],
    [
      "Content-Security-Policy-Report-Only",
      `frame-ancestors 'none'; report-uri ${REPORT_PATH}?policy=control`,
    ],
  ];
}

/** Adds this platform's frame-ancestors policies to a dashboard page. */
export function frameAncestors(
  platform: NodeJS.Platform = process.platform,
): MiddlewareHandler {
  const policies = framePolicies(platform);
  return async (c, next) => {
    await next();
    for (const [name, value] of policies) {
      c.res.headers.append(name, value);
    }
  };
}

/**
 * A report is a few hundred bytes. Bounded so the endpoint cannot be used to
 * write arbitrary amounts into the log.
 */
const MAX_REPORT_BYTES = 16 * 1024;

type Log = (line: string) => void;

/**
 * What a CSP report says, reduced to what the measurement needs. The legacy
 * `report-uri` format wraps it in `csp-report`; a Reporting API entry's `body`
 * is accepted too, in case a webview sends that shape. Those arrive as an
 * array of entries, which the route splits before calling this.
 */
export function summarizeReport(
  policy: string,
  body: unknown,
): Record<string, unknown> {
  // Casts justified: a report is JSON the webview wrote, read field by field;
  // a missing field comes out undefined, which is what the log line shows.
  const report =
    typeof body === "object" && body !== null
      ? ((body as Record<string, unknown>)["csp-report"] ??
        (body as Record<string, unknown>).body ??
        body)
      : {};
  const fields = (
    typeof report === "object" && report !== null ? report : {}
  ) as Record<string, unknown>;
  return {
    policy,
    directive:
      fields["effective-directive"] ??
      fields.effectiveDirective ??
      fields["violated-directive"],
    blocked: fields["blocked-uri"] ?? fields.blockedURL,
    document: fields["document-uri"] ?? fields.documentURL,
    referrer: fields.referrer,
  };
}

export function embeddingRoutes(log: Log = (line) => console.info(line)) {
  return new Hono().post(
    REPORT_PATH,
    bodyLimit({
      maxSize: MAX_REPORT_BYTES,
      onError: (c) => c.body(null, 413),
    }),
    async (c) => {
      const policy = c.req.query("policy") ?? "unknown";
      let body: unknown = null;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        // Not JSON is not a report; there is nothing in it to record.
        return c.body(null, 400);
      }
      // `application/reports+json` is a list; read as one object it logged a
      // line with nothing in it but the policy. Bounded by the body limit.
      for (const report of Array.isArray(body) ? body : [body]) {
        log(`[csp] ${JSON.stringify(summarizeReport(policy, report))}`);
      }
      return c.body(null, 204);
    },
  );
}
