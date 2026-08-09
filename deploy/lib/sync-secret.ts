/**
 * Where the sync credential lives, and how the launcher finds it.
 *
 * There are two copies of it on a configured machine. One is encrypted — the
 * macOS Keychain, the Windows DPAPI blob — and survives a reinstall. The other
 * is the service's own configuration, in plaintext with the file locked to the
 * owning account, because that is the one the process reads at startup and
 * neither launchd's `EnvironmentVariables` nor `bun --env-file` can decrypt
 * anything.
 *
 * `launch.js` exists to remove the second one: it reads the encrypted copy and
 * puts the value in the server's environment, in memory, without it ever
 * landing on disk.
 *
 * The sentinel is what makes that safe to do.
 */

/**
 * What `MONGODB_URL` holds in the configuration when the real value is in the
 * system keystore.
 *
 * A marker rather than an empty value, and this is the whole reason it exists:
 * `clear-sync` blanks `MONGODB_URL` and **deliberately leaves the keystore
 * alone**, which is what lets someone turn sync back on later without retyping
 * anything. A launcher that reached for the keystore whenever the configuration
 * was empty would therefore turn sync back on by itself at the next login,
 * minutes after someone switched it off.
 *
 * So the configuration stays the one place that says whether sync is on:
 *   ""            → off
 *   "keystore"    → on, and the value is in the keystore
 *   "mongodb://…" → on, with the value right here (older installs, and the
 *                   fallback for a machine whose service cannot read its own
 *                   keystore at startup)
 */
export const KEYSTORE_SENTINEL = "keystore";

/** Where the value the launcher is about to use came from. */
export type SyncSecretSource = "config" | "keystore" | "none";

export interface ResolvedSyncSecret {
  url: string;
  source: SyncSecretSource;
}

/**
 * Works out which connection string the server should run with.
 *
 * `readSecret` is a parameter for the same reason every other outside call in
 * `deploy/` is one: the suite has to exercise every branch of this without a
 * keychain, on any platform.
 *
 * Retried, because of when this runs: at login, in the seconds after the
 * session comes up, and on macOS the login keychain is not necessarily unlocked
 * yet. Giving up on the first refusal would mean sync silently off until
 * somebody happened to restart the service by hand.
 */
export async function resolveSyncSecret(
  configured: string | undefined,
  readSecret: () => Promise<string | null>,
  attempts = 5,
  waitMs = 2000,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<ResolvedSyncSecret> {
  const value = (configured ?? "").trim();
  if (value === "") {
    return { url: "", source: "none" };
  }
  if (value !== KEYSTORE_SENTINEL) {
    return { url: value, source: "config" };
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const stored = await readSecret();
    if (stored !== null && stored !== "") {
      return { url: stored, source: "keystore" };
    }
    if (attempt < attempts) {
      await sleep(waitMs);
    }
  }
  // Never a thrown error: a backend that refuses to start because it could not
  // reach a cloud replica would take the local library down with it, and the
  // library is the part that has to work. Sync stays off and says why.
  return { url: "", source: "none" };
}
