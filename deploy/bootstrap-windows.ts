/**
 * One command to bring a fresh Windows machine to parity with the Mac:
 * provisions/pulls the shared secret, registers the scheduled task, generates
 * the Prisma client, migrates the production database, starts the backend, and
 * builds the sibling dashboard + extension repos.
 *
 * Does not reimplement anything `deploy.ts`/`provision.ts`/`env-pull.ts`
 * already do and test — it orchestrates them as subprocesses, the same way
 * `deploy.ts` itself already shells out to `env-pull.ts`.
 *
 * Assumes: Bun and git are installed, this repo is already cloned and
 * `bun install`ed, and `az login` has already been run — that is as far back
 * as a script running from inside this repo can reach on its own.
 *
 * Run it from an elevated terminal, on the SAME account you log in with:
 * registering the S4U task needs administrator rights (see `installTask`), and
 * elevating with a different account would put `prod.env`, the DPAPI secret and
 * the database in that account's profile instead of yours. This is the only
 * step that needs elevation — `bun run deploy` afterwards does not.
 *
 * Usage:
 *   bun run setup:windows
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ENV_MANIFEST, resolveSpec } from "./lib/env";
import { platform } from "./lib/platform";
import { runVisible, spawnRunner } from "./lib/run";
import { done, fail, heading, installErrorHandler, step, warn } from "./lib/ui";
import {
  CONFIG_DIR,
  installTask,
  isElevated,
  LOG_DIR,
  SECRET_DIR,
} from "./lib/windows";

installErrorHandler();

if (process.platform !== "win32") {
  fail(
    "this script only runs on Windows",
    "On macOS, the first-time install is manual — see PLAN.md (Fase 3).",
  );
}

const run = spawnRunner;
const home = homedir();
const repoRoot = resolve(import.meta.dir, "..");
const gitRoot = dirname(repoRoot);
const bunPath = process.execPath;

// Checked before anything else on purpose: the step that needs elevation is the
// fourth one, and finding out there means a Key Vault has already been
// provisioned over the network for a run that cannot finish.
if (!(await isElevated(run))) {
  fail(
    "this needs an elevated terminal",
    "Registering the scheduled task requires administrator rights.\n" +
      "Open a terminal as administrator — on the SAME account you log in with,\n" +
      "so the config, the secret and the database land in your profile — and\n" +
      "run `bun run setup:windows` again.\n\n" +
      "This is the only step that needs it: `bun run deploy` afterwards does not.",
  );
}

heading("Bootstrapping manga-tracker on Windows");
step(`Repo root: ${repoRoot}`);
step(`Bun: ${bunPath}`);

// --- 1. fail fast on the one prerequisite this can actually check ----------

heading("Provisioning the Key Vault (idempotent)…");
if (!(await runVisible(["bun", "run", "deploy/provision.ts"]))) {
  fail("provisioning failed — see above", "Make sure `az login` has been run.");
}

// --- 2. the folders every write below assumes already exist ----------------

for (const dir of [CONFIG_DIR, LOG_DIR, SECRET_DIR]) {
  await mkdir(dir, { recursive: true });
}
done(`Prepared ${CONFIG_DIR}.`);

// --- 3. seed prod.env with what does not need Azure -------------------------

if (await platform.configExists()) {
  step(`${platform.configLabel} already exists — leaving it as is.`);
} else {
  heading(
    `Seeding ${platform.configLabel} with the values that do not need Azure…`,
  );
  for (const spec of ENV_MANIFEST) {
    if (spec.kind === "secret") {
      continue;
    }
    const value = resolveSpec(spec, "prod", home, new Map());
    if (value === null) {
      continue;
    }
    await platform.writeConfigEnv(run, spec.name, value);
    step(`${spec.name} → ${platform.configLabel}`);
  }
}

// --- 4. register the scheduled task -----------------------------------------

heading("Registering the scheduled task…");
await installTask(run, { bunPath, workingDirectory: repoRoot });
done(`Task "${platform.serviceLabel}" registered.`);

// --- 5. the generated Prisma client the checks in deploy.ts type against ------

// `src/generated/prisma` is gitignored, so a fresh clone has none and the
// typecheck gate inside deploy.ts fails on every service that imports it. CI
// generates it for the same reason. prisma.config.ts resolves the datasource
// from DATABASE_URL, which nothing has exported into this process, so it is
// passed explicitly — exactly how deploy.ts runs `prisma migrate deploy`.
const databaseUrlSpec = ENV_MANIFEST.find(
  (spec) => spec.name === "DATABASE_URL",
);
const databaseUrl =
  databaseUrlSpec === undefined
    ? null
    : resolveSpec(databaseUrlSpec, "prod", home, new Map());
if (databaseUrl === null) {
  fail("DATABASE_URL is not a derivable production value");
}

heading("Generating the Prisma client…");
if (
  !(await runVisible(["bun", "run", "db:generate"], {
    DATABASE_URL: databaseUrl,
  }))
) {
  fail("could not generate the Prisma client — see above");
}
done("Prisma client generated.");

// --- 6. secrets, migration, first start, health -----------------------------

heading("Pulling secrets, migrating and starting the backend…");
if (!(await runVisible(["bun", "run", "deploy/deploy.ts", "--with-env"]))) {
  fail("deploy failed — see above");
}

// --- 7. sibling repos ---------------------------------------------------------

const SIBLINGS = {
  "manga-tracker-dashboard":
    "https://github.com/gastonlarap-a11y/manga-tracker-dashboard.git",
  "manga-tracker-extension":
    "https://github.com/gastonlarap-a11y/manga-tracker-extension.git",
} as const;

async function ensureSibling(name: keyof typeof SIBLINGS): Promise<string> {
  const path = join(gitRoot, name);
  if (await Bun.file(join(path, "package.json")).exists()) {
    step(`${name} already cloned at ${path}.`);
  } else {
    heading(`Cloning ${name}…`);
    if (!(await runVisible(["git", "clone", SIBLINGS[name], path]))) {
      fail(`could not clone ${name}`);
    }
  }
  if (!(await runVisible(["bun", `--cwd=${path}`, "install"]))) {
    fail(`bun install failed in ${name}`);
  }
  return path;
}

heading("Building the dashboard…");
const dashboardPath = await ensureSibling("manga-tracker-dashboard");
if (!(await runVisible(["bun", `--cwd=${dashboardPath}`, "run", "deploy"]))) {
  fail(
    "dashboard build/publish failed",
    `Its own deploy script copies the build into ${repoRoot}\\public.`,
  );
}
done("Dashboard built and published.");

heading("Building the extension…");
const extensionPath = await ensureSibling("manga-tracker-extension");
if (!(await runVisible(["bun", `--cwd=${extensionPath}`, "run", "build"]))) {
  fail("extension build failed");
}
const extensionOutput = join(extensionPath, ".output", "chrome-mv3");
done(`Extension built at ${extensionOutput}.`);

// --- 8. what is left ----------------------------------------------------------

heading("Done");
done("Backend is up: http://127.0.0.1:5150/health");
console.log(`Dashboard:     http://127.0.0.1:5150/`);
warn(
  "One manual step left — Chrome will not load an unpacked extension from a " +
    "script for security reasons:\n" +
    `  1. chrome://extensions\n` +
    "  2. Enable Developer mode\n" +
    `  3. Load unpacked → ${extensionOutput}\n` +
    "This is a one-time step per machine: the extension id is fixed by its " +
    "signing key, so it never changes across rebuilds.",
);
