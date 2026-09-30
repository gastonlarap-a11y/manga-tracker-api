/**
 * Keeps requests that a web page makes behind someone's back from reaching a
 * server that only ever meant to talk to this machine.
 *
 * CORS alone does not do that. It decides which responses a page may *read*,
 * and a "simple" cross-origin request — a POST with no body, or a form-typed
 * one — is sent without asking first. `POST /api/sync/restore?force=true`
 * throws the local database away and has no body at all, so any page open in
 * the browser could have fired it at 127.0.0.1 and never needed the answer.
 *
 * Two checks, because they stop different things:
 *
 * - `csrf` (Hono's own) refuses an unsafe request whose Origin is not on the
 *   same allowlist CORS uses and whose Sec-Fetch-Site is not same-origin. It
 *   only looks at form-typed bodies — which includes no Content-Type at all,
 *   read as text/plain — because anything else, JSON included, is preflighted
 *   and CORS already refuses it.
 * - The Host check stops DNS rebinding, which csrf cannot: after a rebind the
 *   attacker's page is same-origin with its own hostname, and Origin agrees
 *   with Host. Only refusing a hostname that is not loopback closes that.
 */

import type { MiddlewareHandler } from "hono";
import { csrf } from "hono/csrf";
import { allowedOrigins, type OriginOptions } from "./cors";

/**
 * The names this server is reached by. Hostname only, never the port: the Vite
 * dev proxy forwards the dev server's own Host (`localhost:5173`), and the
 * port says nothing about who is asking anyway.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
]);

/**
 * Whether a Host header names this machine. A header that does not parse as a
 * host at all is not one.
 */
export function isLoopbackHost(host: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Refuses a request addressed to any hostname but loopback.
 *
 * Read from the Host header rather than from the request URL: the header is
 * what a rebound page controls, and it is what Bun builds the URL from — but a
 * test calling `app.request()` gets a URL that ignores the header entirely.
 */
export const loopbackHostOnly: MiddlewareHandler = async (c, next) => {
  const host = c.req.header("host") ?? new URL(c.req.url).host;
  if (!isLoopbackHost(host)) {
    return c.json({ error: "This server only answers to this machine." }, 403);
  }
  await next();
};

/**
 * Every guard, in the order they belong in: the Host check first, since a
 * rebound request is refused no matter what else it carries.
 */
export function localRequestGuards(
  options: OriginOptions,
): readonly MiddlewareHandler[] {
  return [loopbackHostOnly, csrf({ origin: [...allowedOrigins(options)] })];
}
