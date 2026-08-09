import { describe, expect, it } from "bun:test";
import { KEYSTORE_SENTINEL, resolveSyncSecret } from "./sync-secret";

/**
 * A keystore that answers a fixed sequence, and counts how often it was asked.
 *
 * Indexed strictly rather than with `??`: a `null` answer is the whole point of
 * these tests, and `answers[i] ?? answers.at(-1)` would skip straight past it
 * to the last one — which is exactly how the first version of this helper
 * reported a passing retry test that never retried.
 */
function keystore(...answers: (string | null)[]) {
  const reads: number[] = [];
  return {
    reads,
    read: () => {
      const index = reads.length;
      reads.push(index);
      return Promise.resolve(
        index < answers.length ? answers[index] : (answers.at(-1) ?? null),
      );
    },
  };
}

const noWait = () => Promise.resolve();

describe("resolveSyncSecret", () => {
  it("reads the credential from the keystore when the config points there", async () => {
    const store = keystore("mongodb://host/db");

    const resolved = await resolveSyncSecret(
      KEYSTORE_SENTINEL,
      store.read,
      5,
      0,
      noWait,
    );

    expect(resolved).toEqual({ url: "mongodb://host/db", source: "keystore" });
  });

  it("never touches the keystore when sync is off", async () => {
    // The one that matters. `clear-sync` blanks the configuration and leaves
    // the keystore alone on purpose, so that turning sync back on later needs
    // no retyping. A launcher that reached for the keystore whenever the
    // configuration was empty would turn sync back on by itself at the next
    // login, minutes after somebody switched it off.
    const store = keystore("mongodb://host/db");

    const resolved = await resolveSyncSecret("", store.read, 5, 0, noWait);

    expect(resolved).toEqual({ url: "", source: "none" });
    expect(store.reads).toHaveLength(0);
  });

  it("uses a real url in the config as it is", async () => {
    // Installs that predate the launcher, and the fallback for a machine whose
    // service cannot read its own keystore at startup.
    const store = keystore("mongodb://from-keystore/db");

    const resolved = await resolveSyncSecret(
      "mongodb://from-config/db",
      store.read,
      5,
      0,
      noWait,
    );

    expect(resolved).toEqual({
      url: "mongodb://from-config/db",
      source: "config",
    });
    expect(store.reads).toHaveLength(0);
  });

  it("waits for a keychain that is not unlocked yet", async () => {
    // This runs at login, in the seconds after the session comes up, and on
    // macOS the login keychain is not necessarily unlocked by then. Giving up
    // on the first refusal would leave sync silently off until somebody
    // restarted the service by hand.
    const store = keystore(null, null, "mongodb://host/db");

    const resolved = await resolveSyncSecret(
      KEYSTORE_SENTINEL,
      store.read,
      5,
      0,
      noWait,
    );

    expect(resolved.source).toBe("keystore");
    expect(store.reads).toHaveLength(3);
  });

  it("gives up quietly rather than refusing to start", async () => {
    // A backend that would not start because it could not reach a cloud
    // replica takes the local library down with it, and the library is the part
    // that has to work. Sync stays off; the window says why.
    const store = keystore(null);

    const resolved = await resolveSyncSecret(
      KEYSTORE_SENTINEL,
      store.read,
      3,
      0,
      noWait,
    );

    expect(resolved).toEqual({ url: "", source: "none" });
    expect(store.reads).toHaveLength(3);
  });

  it("treats an empty keystore answer as no answer", async () => {
    const store = keystore("");

    const resolved = await resolveSyncSecret(
      KEYSTORE_SENTINEL,
      store.read,
      2,
      0,
      noWait,
    );

    expect(resolved.url).toBe("");
  });
});
