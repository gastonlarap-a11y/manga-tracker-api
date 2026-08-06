/**
 * Everything that is specific to this Mac: the Keychain, the LaunchAgent plist
 * and launchd itself. Kept apart from `az.ts` because none of it has a cloud
 * equivalent — this is the machine, not the account.
 */
import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./run";

export const LAUNCHD_LABEL = "com.mangatracker";
export const PLIST_PATH = join(
  homedir(),
  "Library/LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);
export const KEYCHAIN_SERVICE = "manga-tracker-mongodb";

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
  // bootout fails when the service is not loaded, which is a fine starting state.
  await run(["launchctl", "bootout", `${domain(uid)}/${label}`]);

  for (let attempt = 0; attempt < settleAttempts; attempt++) {
    if (!(await isLoaded(run, label, uid))) {
      break;
    }
    await Bun.sleep(settleDelayMs);
  }

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
