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

/** Only the native driver: bun resolves its own dependency tree from here. */
export function runtimeManifest(adapterVersion: string): string {
  return `${JSON.stringify(
    {
      name: "manga-tracker-runtime",
      private: true,
      type: "module",
      dependencies: { "@prisma/adapter-libsql": adapterVersion },
    },
    null,
    2,
  )}\n`;
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

  // The migrations travel as data: the server applies them on startup.
  await cp(join(repoRoot, "prisma", "migrations"), join(out, "migrations"), {
    recursive: true,
  });

  // Read from this repo's package.json rather than repeated by hand: a
  // hardcoded version drifts the day the dependency is bumped, and the failure
  // shows up as a native module mismatch at run time.
  const { dependencies } = await Bun.file(
    join(repoRoot, "package.json"),
  ).json();
  const adapterVersion = dependencies?.["@prisma/adapter-libsql"];
  if (typeof adapterVersion !== "string") {
    throw new Error(
      "@prisma/adapter-libsql is not a dependency of this repository",
    );
  }
  await Bun.write(join(out, "package.json"), runtimeManifest(adapterVersion));
  await run(["bun", "install", "--production", "--no-save"], out);

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
