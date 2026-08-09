/**
 * Publishes the current checkout to production in one command: checks, prod
 * migrations, a full LaunchAgent reload and a health probe.
 *
 * Production runs THIS working copy, not `main` — launchd points at the repo
 * directory. That is why the git state is checked before anything else.
 *
 * Usage:
 *   bun run deploy
 *   bun run deploy --with-env     # refresh the plist from Key Vault first
 *   bun run deploy --skip-checks  # skip lint/typecheck/test
 *   bun run deploy --dry-run      # report what it would do, change nothing
 */
import { homedir } from "node:os";
import { parsePort } from "../src/lib/port";
import { ENV_MANIFEST, resolveSpec } from "./lib/env";
import { waitForHealth } from "./lib/health";
import { platform } from "./lib/platform";
import { runVisible, spawnRunner } from "./lib/run";
import { done, fail, heading, installErrorHandler, step, warn } from "./lib/ui";

installErrorHandler();

const args = process.argv.slice(2);
const skipChecks = args.includes("--skip-checks");
const withEnv = args.includes("--with-env");
const dryRun = args.includes("--dry-run");
const run = spawnRunner;
const home = homedir();

/** Production values come from the manifest, so they cannot drift from the plist. */
const prodValue = (name: string): string => {
  const spec = ENV_MANIFEST.find((candidate) => candidate.name === name);
  const value =
    spec === undefined ? null : resolveSpec(spec, "prod", home, new Map());
  if (value === null) {
    throw new Error(`${name} is not a derivable production value`);
  }
  return value;
};

const databaseUrl = prodValue("DATABASE_URL");
// Same parser the server uses, so the health probe cannot end up polling NaN.
const port = parsePort(prodValue("PORT"));

heading(dryRun ? "Deploy (dry run)" : "Deploy");

if (!(await platform.configExists())) {
  fail(
    `no ${platform.serviceKind} at ${platform.configPath}`,
    "Production is not installed on this machine. See .claude/skills/deploy/.",
  );
}

// --- git state ---------------------------------------------------------------

const branch = (await run(["git", "branch", "--show-current"])).stdout;
const dirty = (await run(["git", "status", "--porcelain"])).stdout;
step(`Branch: ${branch || "(detached)"}`);
if (branch !== "main") {
  warn(`deploying "${branch}", not main — production will run this branch.`);
}
if (dirty !== "") {
  warn(`${dirty.split("\n").length} uncommitted change(s) will go live.`);
}

// --- pre-flight ---------------------------------------------------------------

if (skipChecks) {
  warn("Skipping lint, typecheck and tests.");
} else if (dryRun) {
  step("Would run: lint, typecheck, tests.");
} else {
  for (const [label, command] of [
    ["lint", ["bun", "run", "lint"]],
    ["typecheck", ["bun", "run", "typecheck"]],
    ["tests", ["bun", "test"]],
  ] as const) {
    heading(`Running ${label}…`);
    if (!(await runVisible(command))) {
      fail(`${label} failed — production was not touched`);
    }
  }
  done("Checks passed.");
}

// --- configuration --------------------------------------------------------------

if (withEnv) {
  heading("Refreshing the production configuration…");
  if (dryRun) {
    step("Would run: bun run env:pull --prod");
  } else if (
    !(await runVisible(["bun", "run", "deploy/env-pull.ts", "--prod"]))
  ) {
    fail("could not refresh the plist — production was not touched");
  }
}

// --- migrations ------------------------------------------------------------------

heading("Applying migrations to the production database…");
if (dryRun) {
  step(`Would run: prisma migrate deploy against ${databaseUrl}`);
} else if (
  !(await runVisible(["bunx", "--bun", "prisma", "migrate", "deploy"], {
    DATABASE_URL: databaseUrl,
  }))
) {
  fail(
    "migrations failed — production is still running the previous version",
    "Nothing was restarted, so the service is untouched. Fix the migration and re-run.",
  );
}

// --- restart -----------------------------------------------------------------------

heading(`Reloading the ${platform.serviceKind}…`);
if (dryRun) {
  step(`Would ${platform.reloadVerb} ${platform.serviceLabel}.`);
  done("Dry run complete. Nothing was changed.");
  process.exit(0);
}

// reloadService throws with the manual recovery command if it fails, so a
// broken deploy never leaves the service quietly down.
await platform.reloadService(run);

const health = await waitForHealth(port);
if (!health.ok) {
  fail(
    `the service did not become healthy on port ${port}: ${health.detail}`,
    `Logs:\n${platform.logsHint}`,
  );
}
done(`Healthy on port ${port}.`);

// --- sync status (informational) ------------------------------------------------

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/sync/status`);
  const status = (await response.json()) as { enabled?: boolean };
  step(
    status.enabled === true
      ? "Off-site sync is enabled."
      : "Off-site sync is disabled (no MONGODB_URL in the plist) — `bun run env:pull --prod`.",
  );
} catch (error) {
  // Never fail a healthy deploy over the status endpoint.
  warn(`could not read the sync status: ${String(error)}`);
}

console.log(`\nDeployed ${branch || "(detached)"} to production.`);
