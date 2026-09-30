/**
 * Builds the shippable tree: what a machine that has never seen this project
 * needs in order to run the backend.
 *
 * This lived inline in `.github/workflows/package-smoke.yml`, which was fine
 * while one workflow needed it. The desktop app's release needs the exact same
 * tree, and the same logic written twice in two repositories' YAML is a promise
 * that they will drift — the smoke test would keep passing while the thing
 * people download is built differently.
 *
 * Why a bundle instead of the source plus `node_modules`: `bun install
 * --production` still weighs ~360 MB, because `@prisma/client` drags in Prisma
 * Studio (React and all), the CLI and the TypeScript compiler, none of which
 * the server imports. Bundling keeps only what is reachable from the entry
 * points and brings it down to ~19 MB. `@libsql` stays external: it loads a
 * platform-specific `.node` binary that cannot be bundled.
 *
 * Usage:
 *   bun run package -- --out <dir> [--dashboard <dist-dir>]
 */
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

function parseArgs(argv: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !flag.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(flag.slice(2), next);
      index += 1;
    }
  }
  return options;
}

/**
 * The output directory gets deleted before it is rebuilt, so this refuses
 * anything that is not clearly a build directory of its own. A typo in `--out`
 * should cost nothing.
 */
export function assertSafeOutDir(out: string, root = repoRoot): void {
  const base = resolve(root);
  const target = resolve(base, out);
  // `relative` rather than a string prefix: a prefix test has to pick a
  // separator, and picking "/" silently stops catching anything on Windows —
  // where `--out C:\Users\you` with the repo inside it would have been accepted.
  const fromTargetToRoot = relative(target, base);
  const targetContainsRoot =
    fromTargetToRoot === "" ||
    (!fromTargetToRoot.startsWith("..") && !isAbsolute(fromTargetToRoot));
  if (targetContainsRoot) {
    throw new Error(
      `--out ${out} resolves to ${target}, which contains the repository. Refusing to delete it.`,
    );
  }
}

/**
 * The committed manifest and lockfile the shipped tree installs its native
 * driver from.
 *
 * Committed rather than written at build time: a manifest generated here with
 * the repository's caret range, installed with `--no-save`, resolved
 * `@prisma/adapter-libsql` and every `@libsql/*` package afresh on each build —
 * so rebuilding a tag did not produce the same app, which is the promise
 * `sources.json` in the desktop repository makes. The lockfile records the
 * native packages of every platform, and bun installs only the one it runs on.
 */
export const runtimeDir = join(repoRoot, "runtime");

/**
 * The packages the runtime must resolve exactly as the repository does, since
 * the server is bundled against the repository's copy of the client and only
 * the driver is installed at the destination.
 */
export const NATIVE_DRIVER_PACKAGES = [
  "@prisma/adapter-libsql",
  "@prisma/driver-adapter-utils",
  "@libsql/client",
] as const;

/** The version a `bun.lock` resolved for a package, or null when it has none. */
export function lockedVersion(lock: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const match = new RegExp(`"${escaped}": \\["${escaped}@([^"]+)"`).exec(lock);
  return match?.[1] ?? null;
}

/**
 * Refuses a runtime lockfile that has drifted from the repository's: the day
 * the adapter is bumped here and `runtime/` is forgotten, the tree would ship a
 * driver the tests never ran against.
 */
export function assertRuntimeMatchesRepo(
  repoLock: string,
  runtimeLock: string,
): void {
  for (const name of NATIVE_DRIVER_PACKAGES) {
    const repo = lockedVersion(repoLock, name);
    const runtime = lockedVersion(runtimeLock, name);
    if (repo === null || repo !== runtime) {
      throw new Error(
        `runtime/bun.lock resolves ${name} to ${runtime ?? "nothing"} while bun.lock has ${repo ?? "nothing"}. ` +
          "Set the same version in runtime/package.json, then `bun install --lockfile-only` in runtime/.",
      );
    }
  }
}

async function run(command: string[], cwd = repoRoot): Promise<void> {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with code ${result.exitCode}`);
  }
}

export async function buildPackage(options: {
  out: string;
  dashboard?: string;
}): Promise<void> {
  assertSafeOutDir(options.out);
  const out = resolve(options.out);

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  // The server and the service control, each as one file. Everything
  // unreachable from these two entry points is dropped.
  await run([
    "bun",
    "build",
    "src/index.ts",
    "--target=bun",
    "--outdir",
    out,
    "--external",
    "@libsql/*",
  ]);
  await run([
    "bun",
    "build",
    "deploy/service-cli.ts",
    "--target=bun",
    "--outfile",
    join(out, "service.js"),
    "--external",
    "@libsql/*",
  ]);
  // The launcher: what the service actually starts. It reads the credential
  // out of the system keystore and hands it to the server in memory, so the
  // service's own configuration never holds it. index.js stays a separate file
  // — the launcher imports it by a path built at run time, which is why the
  // bundler leaves it alone.
  await run([
    "bun",
    "build",
    "deploy/launcher.ts",
    "--target=bun",
    "--outfile",
    join(out, "launch.js"),
    "--external",
    "@libsql/*",
  ]);

  // The migrations travel as data: the server applies them on startup.
  await cp(join(repoRoot, "prisma", "migrations"), join(out, "migrations"), {
    recursive: true,
  });

  // The native driver, from the committed runtime lockfile, checked against
  // the repository's first: see runtimeDir.
  const [repoLock, runtimeLock] = await Promise.all([
    Bun.file(join(repoRoot, "bun.lock")).text(),
    Bun.file(join(runtimeDir, "bun.lock")).text(),
  ]);
  assertRuntimeMatchesRepo(repoLock, runtimeLock);
  await cp(join(runtimeDir, "package.json"), join(out, "package.json"));
  await cp(join(runtimeDir, "bun.lock"), join(out, "bun.lock"));
  // --production implies a frozen lockfile: a lock that does not match its
  // manifest fails the build instead of being rewritten.
  await run(["bun", "install", "--production", "--frozen-lockfile"], out);

  // The dashboard: without it the server answers 404 on `/`, which is the
  // page the desktop app's window loads. Optional because the smoke test can
  // run without building a sibling repository, but a release must pass it.
  if (options.dashboard !== undefined) {
    const dist = resolve(options.dashboard);
    if (!(await stat(dist).catch(() => null))?.isDirectory()) {
      throw new Error(`--dashboard ${options.dashboard} is not a directory`);
    }
    await cp(dist, join(out, "public"), { recursive: true });
  }
}

if (import.meta.main) {
  const options = parseArgs(Bun.argv.slice(2));
  const out = options.get("out");
  if (out === undefined) {
    console.error(
      "usage: bun run package -- --out <dir> [--dashboard <dist-dir>]",
    );
    process.exit(1);
  }
  await buildPackage({ out, dashboard: options.get("dashboard") });
  console.log(`packaged into ${resolve(out)}`);
}
