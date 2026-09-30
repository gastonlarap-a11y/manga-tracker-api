import { describe, expect, it } from "bun:test";
import { type LaunchDeps, launch } from "./launcher";
import { KEYSTORE_SENTINEL } from "./lib/sync-secret";

const CREDENTIAL = "mongodb://dbreader93:tr0ub4dor@host.example.com/?tls=true";

/**
 * A launch with everything recorded: the environment the server would see at
 * the moment it is imported, whether it was served, and every log line.
 */
function recorder(configured: string | undefined, stored: string | null) {
  const target: Record<string, string | undefined> = {
    MONGODB_URL: configured,
  };
  const logs: string[] = [];
  const seenAtImport: (string | undefined)[] = [];
  let served = false;
  const deps: LaunchDeps = {
    env: { MONGODB_URL: configured },
    target,
    readSecret: async () => stored,
    secretCacheLabel: "keychain",
    importServer: async () => {
      seenAtImport.push(target.MONGODB_URL);
      return {
        default: {
          port: 5150,
          hostname: "127.0.0.1",
          idleTimeout: 120,
          fetch: () => new Response("ok"),
        },
      };
    },
    serve: () => {
      served = true;
    },
    log: {
      info: (line: string) => logs.push(line),
      error: (line: string) => logs.push(line),
    },
    retryWaitMs: 0,
  };
  return {
    deps,
    target,
    logs,
    seenAtImport,
    get served() {
      return served;
    },
  };
}

describe("launch", () => {
  it("hands the server the keystore's credential before it is imported", async () => {
    // config.ts reads MONGODB_URL at import time: set after, it would be
    // read as the sentinel.
    const run = recorder(KEYSTORE_SENTINEL, CREDENTIAL);

    await launch("./index.js", run.deps);

    expect(run.seenAtImport).toEqual([CREDENTIAL]);
    expect(run.served).toBe(true);
  });

  it("says where the credential came from, never what it is", async () => {
    const run = recorder(KEYSTORE_SENTINEL, CREDENTIAL);

    await launch("./index.js", run.deps);

    expect(run.logs.join("\n")).toContain("keystore");
    expect(run.logs.join("\n")).not.toContain("tr0ub4dor");
  });

  it("starts without sync, and says so, when the keystore cannot be read", async () => {
    // A Windows task running as S4U may not be able to unwrap DPAPI. The
    // library still has to come up: sync is the part that can wait.
    const run = recorder(KEYSTORE_SENTINEL, null);

    await launch("./index.js", run.deps);

    expect(run.seenAtImport).toEqual([undefined]);
    expect("MONGODB_URL" in run.target).toBe(false);
    expect(run.logs.join("\n")).toContain(
      "could not be read from the keychain",
    );
    expect(run.served).toBe(true);
  });

  it("never leaves the sentinel for the server to read as a connection string", async () => {
    const run = recorder(KEYSTORE_SENTINEL, "");

    await launch("./index.js", run.deps);

    expect(run.seenAtImport[0]).not.toBe(KEYSTORE_SENTINEL);
  });

  it("starts quietly without sync when none is configured", async () => {
    const run = recorder("", null);

    await launch("./index.js", run.deps);

    expect(run.seenAtImport).toEqual([undefined]);
    expect(run.logs).toEqual([]);
    expect(run.served).toBe(true);
  });

  it("uses a credential written in the configuration as it is", async () => {
    // Older installs, and the fallback pin-config-secret writes.
    const run = recorder(CREDENTIAL, null);

    await launch("./index.js", run.deps);

    expect(run.seenAtImport).toEqual([CREDENTIAL]);
  });
});
