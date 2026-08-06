/**
 * One command to bring a fresh Windows machine to parity with the Mac:
 * provisions/pulls the shared secret, registers the scheduled task, migrates
 * the production database, starts the backend, and builds the sibling
 * dashboard + extension repos.
 *
 * Does not reimplement anything `deploy.ts`/`provision.ts`/`env-pull.ts`
 * already do and test — it orchestrates them as subprocesses, the same way
 * `deploy.ts` itself already shells out to `env-pull.ts`.
 *
 * Assumes: Bun and git are installed, this repo is already cloned and
 * `bun install`ed, and `az login` has already been run — that is as far back
 * as a script running from inside this repo can reach on its own.
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
import { CONFIG_DIR, installTask, LOG_DIR, SECRET_DIR } from "./lib/windows";

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

// --- 5. secrets, migration, first start, health -----------------------------

heading("Pulling secrets, migrating and starting the backend…");
if (!(await runVisible(["bun", "run", "deploy/deploy.ts", "--with-env"]))) {
  fail("deploy failed — see above");
}

// --- 6. sibling repos ---------------------------------------------------------

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

// --- 7. what is left ----------------------------------------------------------

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
