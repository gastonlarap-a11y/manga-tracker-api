/**
 * Puts the sync credential back on a machine that does not have it — after a
 * format, or on a second Mac — without anyone retyping a connection string.
 *
 * The cascade (plist → Keychain → Azure Key Vault) and the upload now live in
 * `deploy/`, where the rest of the deployment tooling is. This stays as the
 * documented entry point so `bun run sync:bootstrap` keeps working.
 *
 * Usage:
 *   bun run sync:bootstrap            # recover and install into the plist
 *   bun run sync:bootstrap --store    # upload this machine's credential to Key Vault
 */
import { runVisible } from "../deploy/lib/run";

const args = process.argv.slice(2);
const store = args.includes("--store");
const passthrough = args.filter((arg) => arg !== "--store");

const script = store ? "deploy/env-push.ts" : "deploy/env-pull.ts";
// Both commands act on production: this recovers the LaunchAgent's config.
const ok = await runVisible(["bun", "run", script, "--prod", ...passthrough]);

process.exit(ok ? 0 : 1);
