/**
 * Who may show the dashboard in a frame — measured before it is enforced.
 *
 * The desktop app shows the dashboard in an iframe, and nothing else should:
 * any page open in the browser can frame http://127.0.0.1:<port>/ and, once it
 * greets the embed bridge, receive every chapter link clicked inside. The fix
 * is a `frame-ancestors` policy naming the app's origins. Guessed wrong, it
 * blanks the dashboard inside the app — so it goes out Report-Only first, and
 * this module is where the reports land.
 *
 * Two policies ride on every dashboard page:
 *
 * - `allowlist`: the origins the app is served from — `wails://wails` on
 *   macOS, `http://wails.localhost` on Windows, `http://localhost:34115`
 *   under `wails dev`. A report from this one means enforcing it would have
 *   blocked the app.
 * - `control`: `'none'`, which every frame violates. It exists to prove the
 *   webview sends reports at all — without it, silence from the allowlist
 *   would mean nothing.
 *
 * Both are logged, one line per report, to the service's own log.
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

export const FRAME_POLICIES = [
  `frame-ancestors 'self' ${APP_ORIGINS.join(" ")}; report-uri ${REPORT_PATH}?policy=allowlist`,
  `frame-ancestors 'none'; report-uri ${REPORT_PATH}?policy=control`,
] as const;

/**
 * Adds both policies, Report-Only, to a dashboard page. Never enforcing: a
 * report costs nothing, a wrong block costs the app its window.
 */
export const reportFrameAncestors: MiddlewareHandler = async (c, next) => {
  await next();
  for (const policy of FRAME_POLICIES) {
    c.res.headers.append("Content-Security-Policy-Report-Only", policy);
  }
};

/**
 * A report is a few hundred bytes. Bounded so the endpoint cannot be used to
 * write arbitrary amounts into the log.
 */
const MAX_REPORT_BYTES = 16 * 1024;

type Log = (line: string) => void;

/**
 * What a CSP report says, reduced to what the measurement needs. The legacy
 * `report-uri` format wraps it in `csp-report`; the Reporting API's `body` is
 * accepted too, in case a webview sends that shape.
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
      log(`[csp] ${JSON.stringify(summarizeReport(policy, body))}`);
      return c.body(null, 204);
    },
  );
}
