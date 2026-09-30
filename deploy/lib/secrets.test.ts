import { describe, expect, it } from "bun:test";
import type { PlatformAdapter } from "./platform";
import { createFakeRunner } from "./run";
import { resolveSecret, type SecretSpec } from "./secrets";
import { KEYSTORE_SENTINEL } from "./sync-secret";

const spec: SecretSpec = {
  name: "MONGODB_URL",
  kind: "secret",
  secretName: "mangatracker-mongodb-url",
  comment: "the sync store's connection string",
};

/**
 * A machine whose configuration holds `configured` and whose keystore holds
 * `stored`, recording every write to the keystore.
 *
 * Cast justified: resolveSecret touches only these members of the adapter,
 * and a full one would mean pretending to be launchd or the Task Scheduler.
 */
function machine(configured: string | null, stored: string | null) {
  const cached: string[] = [];
  const adapter = {
    os: "darwin",
    configLabel: "plist",
    secretCacheLabel: "keychain",
    readConfigEnv: async () => configured,
    readSecret: async () => stored,
    writeSecret: async (_run: unknown, value: string) => {
      cached.push(value);
      return true;
    },
  } as unknown as PlatformAdapter;
  return { adapter, cached };
}

const run = createFakeRunner([]).run;

describe("resolveSecret", () => {
  it("follows the sentinel to the keystore instead of caching the word", async () => {
    // The bug: `env:pull --prod` read "keystore" out of the plist as if it
    // were the credential and wrote it into the Keychain over the real one.
    const { adapter, cached } = machine(
      KEYSTORE_SENTINEL,
      "mongodb://real-host/db",
    );

    const resolved = await resolveSecret(run, spec, {
      vault: "unused",
      platform: adapter,
    });

    expect(resolved).toEqual({
      value: "mongodb://real-host/db",
      from: "cache",
    });
    expect(cached).not.toContain(KEYSTORE_SENTINEL);
  });

  it("still takes a credential written in the configuration itself", async () => {
    // Older installs, and the fallback for a service that cannot read its
    // keystore: the value really is in the file.
    const { adapter, cached } = machine("mongodb://in-file/db", null);

    const resolved = await resolveSecret(run, spec, {
      vault: "unused",
      platform: adapter,
    });

    expect(resolved).toEqual({ value: "mongodb://in-file/db", from: "config" });
    expect(cached).toEqual(["mongodb://in-file/db"]);
  });
});
