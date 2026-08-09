/**
 * Everything that is specific to this Mac: the Keychain, the LaunchAgent plist
 * and launchd itself. Kept apart from `az.ts` because none of it has a cloud
 * equivalent — this is the machine, not the account.
 */
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Runner } from "./run";

export const LAUNCHD_LABEL = "com.mangatracker";
export const PLIST_PATH = join(
  homedir(),
  "Library/LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);
export const KEYCHAIN_SERVICE = "manga-tracker-mongodb";
/** Where launchd is told to write stdout/stderr. */
export const LOG_DIR = join(homedir(), "Library/Logs/MangaTracker");

const PLIST_ENV = "EnvironmentVariables";

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

export async function readKeychain(
  run: Runner,
  service = KEYCHAIN_SERVICE,
): Promise<string | null> {
  const result = await run([
    "security",
    "find-generic-password",
    "-s",
    service,
    "-w",
  ]);
  return result.ok && result.stdout !== "" ? result.stdout : null;
}

/**
 * `-U` updates in place instead of stacking duplicate items.
 *
 * The value goes through argv because `security` has no file or stdin form, so
 * it is briefly visible to `ps`. That is not the weak link here: the plist
 * stores the same string in plaintext on disk permanently.
 */
export async function writeKeychain(
  run: Runner,
  value: string,
  service = KEYCHAIN_SERVICE,
): Promise<boolean> {
  const result = await run([
    "security",
    "add-generic-password",
    "-U",
    "-s",
    service,
    "-a",
    service,
    "-w",
    value,
  ]);
  return result.ok;
}

// ---------------------------------------------------------------------------
// LaunchAgent plist
// ---------------------------------------------------------------------------

export async function plistExists(path = PLIST_PATH): Promise<boolean> {
  return await Bun.file(path).exists();
}

export interface WritePlistOptions {
  /** Absolute path of the interpreter, e.g. a bundled `bun`. */
  readonly bunPath: string;
  /** What it runs, relative to `workingDirectory` — `src/index.ts` or `index.js`. */
  readonly entry: string;
  readonly workingDirectory: string;
  readonly logDir?: string;
  readonly label?: string;
  readonly path?: string;
}

/** `&`, `<` and `>` are the three that make a plist unparseable; a path may hold any. */
const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/**
 * Creates the LaunchAgent definition from nothing.
 *
 * Everything else here edits a plist that already exists — `writePlistEnv` is a
 * `plutil -replace`, which fails on a missing file. That was fine while the only
 * plist was written by hand once (see PLAN.md), and stops being fine the moment
 * an installer has to produce one on a machine that has never seen this project.
 *
 * `EnvironmentVariables` is deliberately created empty: the values go in through
 * `writePlistEnv`, so there is exactly one code path that writes them, and it is
 * the one that also re-tightens the file's permissions.
 */
export async function writePlist({
  bunPath,
  entry,
  workingDirectory,
  logDir = LOG_DIR,
  label = LAUNCHD_LABEL,
  path = PLIST_PATH,
}: WritePlistOptions): Promise<void> {
  // launchd does not create these, and a plist pointing at a missing log
  // directory fails to start with nothing written anywhere to say why.
  await mkdir(logDir, { recursive: true });
  await mkdir(dirname(path), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(bunPath)}</string>
    <string>run</string>
    <string>${xmlEscape(entry)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(workingDirectory)}</string>
  <key>${PLIST_ENV}</key>
  <dict/>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(join(logDir, "out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(logDir, "err.log"))}</string>
</dict>
</plist>
`;

  await Bun.write(path, plist);
  // Same reason as writePlistEnv: this file ends up holding the cluster
  // password, and launchd creates it world-readable by default.
  await chmod(path, 0o600);
}

export async function readPlistEnv(
  run: Runner,
  key: string,
  path = PLIST_PATH,
): Promise<string | null> {
  const result = await run([
    "plutil",
    "-extract",
    `${PLIST_ENV}.${key}`,
    "raw",
    "-o",
    "-",
    path,
  ]);
  return result.ok && result.stdout !== "" ? result.stdout : null;
}

/**
 * Re-tightens permissions on every write: the plist holds the cluster password
 * in plaintext and launchd creates it world-readable by default.
 */
export async function writePlistEnv(
  run: Runner,
  key: string,
  value: string,
  path = PLIST_PATH,
): Promise<boolean> {
  const result = await run([
    "plutil",
    "-replace",
    `${PLIST_ENV}.${key}`,
    "-string",
    value,
    path,
  ]);
  if (result.ok) {
    await chmod(path, 0o600);
  }
  return result.ok;
}

// ---------------------------------------------------------------------------
// launchd
// ---------------------------------------------------------------------------

/**
 * launchd domains are per-user, so every command carries the uid. It is the one
 * thing here that is read straight off the process instead of arriving through
 * a `Runner`, which made the whole reload sequence untestable from a machine
 * with no uid — `bun test` on Windows failed on four tests that only ever
 * assert how the launchctl commands are built. Callers may pass one in.
 */
const domain = (uid = process.getuid?.()): string => {
  if (uid === undefined) {
    throw new Error("launchd control needs a uid; this is macOS-only");
  }
  return `gui/${uid}`;
};

export async function isLoaded(
  run: Runner,
  label = LAUNCHD_LABEL,
  uid?: number,
): Promise<boolean> {
  return (await run(["launchctl", "print", `${domain(uid)}/${label}`])).ok;
}

export interface ReloadOptions {
  readonly path?: string;
  readonly label?: string;
  /** How long to wait for launchd to finish unloading the old job. */
  readonly settleAttempts?: number;
  readonly settleDelayMs?: number;
  readonly bootstrapAttempts?: number;
  /** Defaults to this process's uid; tests pass one so they run off a Mac. */
  readonly uid?: number;
}

/**
 * A full unload/load, not `kickstart -k`.
 *
 * kickstart restarts the process against the configuration launchd already has
 * in memory, so a changed `EnvironmentVariables` entry is silently ignored and
 * you end up debugging a deploy that "worked" against the old credential.
 *
 * The wait between the two halves is not politeness. `launchctl bootout` returns
 * as soon as launchd accepts the request, not when the job is gone; bootstrapping
 * into a domain that still holds the dying job fails with `Bootstrap failed: 5:
 * Input/output error` and leaves the service down. It is a race, so it only bites
 * when the service was actually running — which is every real deploy.
 */
/**
 * Boots the job out and waits until launchd has really let go of it.
 *
 * The wait is the whole point, and it is the same one that makes a hand-typed
 * `bootout; bootstrap` fail with `Bootstrap failed: 5: Input/output error`:
 * bootout returns before the teardown finishes. An update that extracts over
 * the backend while it is still dying has the same problem.
 */
export async function stopService(
  run: Runner,
  {
    label = LAUNCHD_LABEL,
    settleAttempts = 20,
    settleDelayMs = 250,
    uid,
  }: ReloadOptions = {},
): Promise<void> {
  // bootout fails when the service is not loaded, which is a fine starting state.
  await run(["launchctl", "bootout", `${domain(uid)}/${label}`]);

  for (let attempt = 0; attempt < settleAttempts; attempt++) {
    if (!(await isLoaded(run, label, uid))) {
      return;
    }
    await Bun.sleep(settleDelayMs);
  }
}

export async function reloadService(
  run: Runner,
  {
    path = PLIST_PATH,
    label = LAUNCHD_LABEL,
    settleAttempts = 20,
    settleDelayMs = 250,
    bootstrapAttempts = 3,
    uid,
  }: ReloadOptions = {},
): Promise<void> {
  await stopService(run, { label, settleAttempts, settleDelayMs, uid });

  // Teardown can still be settling after `print` stops finding the job, so the
  // bootstrap itself gets a few tries before we call it a failure.
  let last = await run(["launchctl", "bootstrap", domain(uid), path]);
  for (let attempt = 1; attempt < bootstrapAttempts && !last.ok; attempt++) {
    await Bun.sleep(settleDelayMs * 2);
    last = await run(["launchctl", "bootstrap", domain(uid), path]);
  }

  if (!last.ok) {
    throw new Error(
      `launchctl bootstrap failed after ${bootstrapAttempts} attempts: ` +
        `${last.stderr || last.stdout}\n` +
        `The service is now DOWN. Bring it back with:\n` +
        `  launchctl bootstrap ${domain(uid)} ${path}`,
    );
  }
}
