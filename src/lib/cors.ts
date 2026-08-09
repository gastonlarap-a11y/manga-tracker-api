/**
 * Who is allowed to call this API from a browser.
 *
 * The allowlist cannot be a constant, because both halves of it move:
 *
 * - The port comes from the environment. A packaged install picks whatever port
 *   is free on that machine, so an origin hardcoded to 5150 would reject the
 *   dashboard it is serving itself.
 * - The extension id changes on publication. Loaded unpacked, Chrome derives it
 *   from the committed manifest key; published, the Web Store assigns its own.
 *   Both ids have to be accepted at once, or updating means a flag day where
 *   whichever build is not listed goes mute.
 */

/** Chrome renders an extension id as 32 characters over the alphabet a–p. */
const EXTENSION_ID = /^[a-p]{32}$/;

/**
 * The id Chrome derives from the manifest key committed in
 * manga-tracker-extension, i.e. the one a developer checkout loads unpacked.
 * It is the default so that a machine with no EXTENSION_IDS set keeps working.
 *
 * `deploy/lib/env.ts` imports this to seed the generated `.env` files: the two
 * must never drift, or a pulled environment would silently lock the extension
 * out.
 */
export const UNPACKED_EXTENSION_ID = "cfjiinlnepkmlaafdclmlpjbmpofplop";

/**
 * The id the Chrome Web Store assigned on publication. A published build and a
 * locally loaded one are different extensions as far as the browser is
 * concerned, so both are defaults: whichever a machine happens to have
 * installed can reach the backend without anyone editing a config file.
 */
export const STORE_EXTENSION_ID = "acopmmaenbjdpcjcaiadcpdniomkikbd";

/** What EXTENSION_IDS falls back to: every id this project publishes under. */
export const DEFAULT_EXTENSION_IDS: readonly string[] = [
  UNPACKED_EXTENSION_ID,
  STORE_EXTENSION_ID,
];

/**
 * Reads the comma-separated EXTENSION_IDS.
 *
 * Unset or blank means the defaults, never "no extension at all": an env file
 * that declares the key empty is a missing value, not a decision to lock the
 * browser out. A malformed id throws instead of being skipped — dropping it
 * silently would surface much later as an extension that cannot reach the
 * backend, with nothing in the logs to say why.
 */
export function parseExtensionIds(raw: string | undefined): readonly string[] {
  const ids = (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (ids.length === 0) {
    return DEFAULT_EXTENSION_IDS;
  }
  for (const id of ids) {
    if (!EXTENSION_ID.test(id)) {
      throw new Error(
        `EXTENSION_IDS contains "${id}", which is not a Chrome extension id ` +
          "(32 characters, a through p).",
      );
    }
  }
  return ids;
}

export interface OriginOptions {
  /** The port this server listens on. */
  readonly port: number;
  readonly extensionIds: readonly string[];
}

/**
 * The exact origin list handed to `hono/cors`. Loopback entries are same-origin
 * in practice (the dashboard is served by this very process, and in development
 * Vite proxies instead of calling across origins), so they are kept narrow: the
 * port this server actually listens on, and no other.
 */
export function allowedOrigins({
  port,
  extensionIds,
}: OriginOptions): readonly string[] {
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    ...extensionIds.map((id) => `chrome-extension://${id}`),
  ];
}
