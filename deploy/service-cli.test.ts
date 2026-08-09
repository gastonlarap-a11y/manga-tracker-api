import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallServiceOptions, PlatformAdapter } from "./lib/platform";
import { createFakeRunner } from "./lib/run";
import {
  environmentFor,
  firstFreePort,
  hostOf,
  parseArgs,
  runCommand,
  type StdinReader,
} from "./service-cli";

/**
 * The connection string `set-sync` will read. A function rather than a value
 * because that is the seam: the real one waits on a process's stdin, and a test
 * that had to write to one would be exercising Bun rather than this file.
 */
const onStdin =
  (value: string): StdinReader =>
  () =>
    Promise.resolve(value);

/**
 * A recording adapter, never the real one. `macosAdapter.installService` writes
 * to the actual LaunchAgent path, so a suite that used it would overwrite the
 * production service of whoever ran it.
 */
function fakeAdapter(
  os: NodeJS.Platform,
  overrides: Partial<PlatformAdapter> = {},
) {
  const written = new Map<string, string>();
  /** Every side effect, in order — the order is part of what is under test. */
  const steps: string[] = [];
  let installed: InstallServiceOptions | null = null;
  let secret: string | null = null;

  const adapter: PlatformAdapter = {
    os,
    serviceLabel: "com.mangatracker",
    configPath: "/fake/config",
    configLabel: os === "win32" ? "prod.env" : "plist",
    secretCacheLabel: os === "win32" ? "dpapi cache" : "keychain",
    serviceKind: os === "win32" ? "scheduled task" : "LaunchAgent",
    reloadVerb: "reload",
    logsHint: "",
    configExists: async () => written.size > 0,
    readConfigEnv: async (_run, key) => written.get(key) ?? null,
    writeConfigEnv: async (_run, key, value) => {
      steps.push(`write:${key}`);
      written.set(key, value);
      return true;
    },
    readSecret: async () => secret,
    writeSecret: async (_run, value) => {
      steps.push("secret");
      secret = value;
      return true;
    },
    reloadService: async () => {
      steps.push("reload");
    },
    stopService: async () => {
      steps.push("stop");
    },
    installService: async (_run, options) => {
      steps.push("define");
      installed = options;
      return { userCanControlIt: true };
    },
    ...overrides,
  };

  return {
    adapter,
    written,
    steps,
    get installed() {
      return installed;
    },
    get secret() {
      return secret;
    },
  };
}

const runner = () => createFakeRunner([]).run;

async function inTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "service-cli-test-"));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("parseArgs", () => {
  it("reads flags with values", () => {
    const { command, options } = parseArgs([
      "install",
      "--app-dir",
      "/opt/app",
      "--port",
      "5153",
    ]);

    expect(command).toBe("install");
    expect(options.get("app-dir")).toBe("/opt/app");
    expect(options.get("port")).toBe("5153");
  });

  it("does not swallow the next flag as a value", () => {
    // `--clear --db x` must not read "--db" as the value of --clear.
    const { options } = parseArgs(["set-sync", "--clear", "--db", "mangas"]);

    expect(options.get("clear")).toBe("");
    expect(options.get("db")).toBe("mangas");
  });
});

describe("environmentFor", () => {
  it("carries the four values an installed backend needs, and nothing else", () => {
    const env = environmentFor("/opt/app", "/data", 5153);

    expect([...env.keys()].sort()).toEqual([
      "DATABASE_URL",
      "EXTENSION_IDS",
      "MIGRATIONS_DIR",
      "PORT",
    ]);
  });

  it("points the migrator at the packaged .sql files", () => {
    // The bundled server is a single file with no src/ tree above it to walk
    // up from, so this is not optional in a package.
    const env = environmentFor("/opt/app", "/data", 5150);

    expect(env.get("MIGRATIONS_DIR")).toBe(join("/opt/app", "migrations"));
  });

  it("allows both published extension ids", () => {
    // A store install and a hand-loaded build must both reach the backend.
    const ids = environmentFor("/opt/app", "/data", 5150).get("EXTENSION_IDS");

    expect(ids?.split(",").length).toBe(2);
  });

  it("carries nothing about the author's own infrastructure", () => {
    const values = [...environmentFor("/opt/app", "/data", 5150).values()].join(
      " ",
    );

    expect(values).not.toContain("mongodb");
    expect(values).not.toContain("kv-mangatracker");
  });
});

describe("install", () => {
  const args = (dir: string) => [
    "install",
    "--app-dir",
    "/opt/app",
    "--data-dir",
    dir,
    "--port",
    "5153",
  ];

  it("defines the service before writing any value into it", async () => {
    // On macOS the environment is written with `plutil -replace`, which fails
    // on a plist that does not exist yet. Getting this order wrong produces an
    // install that looks fine and has no configuration.
    await inTempDir(async (dir) => {
      const fake = fakeAdapter("darwin");

      await runCommand(runner(), args(dir), fake.adapter);

      expect(fake.steps[0]).toBe("define");
      expect(fake.steps.at(-1)).toBe("reload");
    });
  });

  it("writes the environment the backend needs", async () => {
    await inTempDir(async (dir) => {
      const fake = fakeAdapter("darwin");

      const reply = await runCommand(runner(), args(dir), fake.adapter);

      expect(reply).toMatchObject({ ok: true, port: 5153 });
      expect(fake.written.get("PORT")).toBe("5153");
      expect(fake.written.get("DATABASE_URL")).toBe(
        `file:${join(dir, "mangatracker.db")}`,
      );
    });
  });

  it("runs the bundled interpreter, not whatever bun the machine has", async () => {
    await inTempDir(async (dir) => {
      const fake = fakeAdapter("darwin");

      await runCommand(runner(), args(dir), fake.adapter);

      expect(fake.installed).toMatchObject({
        bunPath: join("/opt/app", "bun"),
        // The launcher, not the server: it reads the credential out of the
        // keystore and hands it to the server in memory, which is what keeps
        // it out of the service's own configuration file.
        entry: "launch.js",
        workingDirectory: "/opt/app",
      });
    });
  });

  it("asks for bun.exe on Windows", async () => {
    await inTempDir(async (dir) => {
      const fake = fakeAdapter("win32");

      await runCommand(runner(), args(dir), fake.adapter);

      expect(fake.installed).toMatchObject({
        bunPath: join("/opt/app", "bun.exe"),
      });
    });
  });

  it("surfaces that the account cannot control the service", async () => {
    // The Windows ACL case. Reported, not swallowed: the install works, but
    // the app has to say so instead of failing later without explanation.
    await inTempDir(async (dir) => {
      const fake = fakeAdapter("win32", {
        installService: async () => ({ userCanControlIt: false }),
      });

      const reply = await runCommand(runner(), args(dir), fake.adapter);

      expect(reply).toMatchObject({ ok: true, userCanControlIt: false });
    });
  });

  it("refuses to guess a missing directory", async () => {
    const fake = fakeAdapter("darwin");

    await expect(
      runCommand(runner(), ["install", "--app-dir", "/opt/app"], fake.adapter),
    ).rejects.toThrow(/--data-dir/);
  });

  it("rejects a port outside what anything can reach", async () => {
    await inTempDir(async (dir) => {
      const fake = fakeAdapter("darwin");

      await expect(
        runCommand(
          runner(),
          [
            "install",
            "--app-dir",
            "/opt/app",
            "--data-dir",
            dir,
            "--port",
            "0",
          ],
          fake.adapter,
        ),
      ).rejects.toThrow(/PORT/);
    });
  });

  it("stops before touching anything when the config cannot be written", async () => {
    await inTempDir(async (dir) => {
      const fake = fakeAdapter("darwin", {
        writeConfigEnv: async () => false,
      });

      await expect(
        runCommand(runner(), args(dir), fake.adapter),
      ).rejects.toThrow(/could not write/);
      // A half-configured service must not be left running.
      expect(fake.steps).not.toContain("reload");
    });
  });
});

describe("firstFreePort", () => {
  it("skips a port that is taken", async () => {
    // Occupy whatever it would have chosen rather than a hardcoded number: on
    // this developer's machine 5150 is already the production backend, and a
    // test that assumes otherwise is a test that inherits the host.
    const first = await firstFreePort();
    const squatter = Bun.serve({
      port: first,
      hostname: "127.0.0.1",
      fetch: () => new Response(),
    });
    try {
      expect(await firstFreePort()).toBeGreaterThan(first);
    } finally {
      squatter.stop(true);
    }
  });

  it("stays inside the window the extension and the app probe", async () => {
    const port = await firstFreePort();

    expect(port).toBeGreaterThanOrEqual(5150);
    expect(port).toBeLessThanOrEqual(5159);
  });
});

describe("status", () => {
  it("reports nothing installed on a fresh machine", async () => {
    const fake = fakeAdapter("darwin");

    expect(await runCommand(runner(), ["status"], fake.adapter)).toMatchObject({
      installed: false,
      port: null,
      syncConfigured: false,
    });
  });

  it("says sync is configured without ever echoing the credential", async () => {
    await inTempDir(async (dir) => {
      const fake = fakeAdapter("darwin");
      await runCommand(
        runner(),
        ["install", "--app-dir", "/a", "--data-dir", dir, "--port", "5151"],
        fake.adapter,
      );
      await runCommand(
        runner(),
        ["set-sync"],
        fake.adapter,
        onStdin("mongodb://dbreader93:tr0ub4dor@host/db"),
      );

      const reply = await runCommand(runner(), ["status"], fake.adapter);

      expect(reply).toMatchObject({ syncConfigured: true });
      // A distinctive password, not the word "secret": the reply now carries a
      // field called secretInConfig, and a needle that matches a field name
      // proves nothing about the values.
      expect(JSON.stringify(reply)).not.toContain("tr0ub4dor");
      expect(JSON.stringify(reply)).not.toContain("dbreader93");
    });
  });

  it("reports where it points, so the app can say what it syncs against", async () => {
    await inTempDir(async (dir) => {
      const fake = fakeAdapter("darwin");
      await runCommand(
        runner(),
        ["install", "--app-dir", "/a", "--data-dir", dir, "--port", "5151"],
        fake.adapter,
      );
      await runCommand(
        runner(),
        ["set-sync", "--db", "mangas"],
        fake.adapter,
        onStdin(
          "mongodb://dbreader93:hunter2@cluster.example.com:10260/?tls=true",
        ),
      );

      const reply = await runCommand(runner(), ["status"], fake.adapter);

      expect(reply).toMatchObject({
        syncHost: "cluster.example.com:10260",
        syncDb: "mangas",
      });
      // The whole point of parsing it here rather than in the window. Both
      // halves of the credential: a distinctive account name, not "user",
      // which is too common a substring to prove anything.
      expect(JSON.stringify(reply)).not.toContain("hunter2");
      expect(JSON.stringify(reply)).not.toContain("dbreader93");
    });
  });
});

describe("hostOf", () => {
  it.each([
    [
      "mongodb://cluster.example.com:10260/?tls=true",
      "cluster.example.com:10260",
    ],
    [
      "mongodb://user:pass@cluster.example.com:10260/db",
      "cluster.example.com:10260",
    ],
    ["mongodb+srv://user:pass@cluster.example.com/", "cluster.example.com"],
    ["mongodb://host", "host"],
    // A seed list: legal in a MongoDB URI, and not a URL at all — `new URL()`
    // throws on precisely the addresses a replica set produces.
    [
      "mongodb://a.example.com:27017,b.example.com:27018/?tls=true",
      "a.example.com:27017,b.example.com:27018",
    ],
  ])("takes the server out of %s", (raw, expected) => {
    expect(hostOf(raw)).toBe(expected);
  });

  it("never hands back a credential", () => {
    // The last @, not the first: a password may hold an encoded one, and
    // splitting on the first would return the tail of the secret as a hostname.
    expect(hostOf("mongodb://user:p%40ss@real-host:10260/db")).toBe(
      "real-host:10260",
    );
  });

  it.each([null, ""])("answers with nothing for %p", (raw) => {
    expect(hostOf(raw)).toBe("");
  });
});

describe("sync", () => {
  it("puts the credential in the system keystore, not only in the config", async () => {
    const fake = fakeAdapter("darwin");

    await runCommand(
      runner(),
      ["set-sync", "--db", "mangas"],
      fake.adapter,
      onStdin("mongodb://host/db"),
    );

    expect(fake.secret).toBe("mongodb://host/db");
    expect(fake.written.get("MONGODB_DB")).toBe("mangas");
    expect(fake.steps.at(-1)).toBe("reload");
  });

  it("keeps the credential out of the configuration entirely", async () => {
    // The point of the launcher. Every install until now wrote the cluster
    // password into the plist or prod.env in plaintext — locked to the account,
    // but permanently, and it had to be, because launchd and `bun --env-file`
    // can only hand a process a string. Now the file records that sync is on
    // and nothing else.
    const fake = fakeAdapter("darwin");

    await runCommand(
      runner(),
      ["set-sync"],
      fake.adapter,
      onStdin("mongodb://dbreader93:tr0ub4dor@host/db"),
    );

    expect(fake.written.get("MONGODB_URL")).toBe("keystore");
    for (const value of fake.written.values()) {
      expect(value).not.toContain("tr0ub4dor");
    }
  });

  it("puts the credential back in the configuration when asked", async () => {
    // For a machine whose service cannot read its own keystore at startup —
    // a Windows task running as S4U may not be able to unwrap a DPAPI blob.
    // Nothing about that is knowable in advance, so it is discovered by trying
    // and coming back here.
    const fake = fakeAdapter("darwin");
    await runCommand(
      runner(),
      ["set-sync"],
      fake.adapter,
      onStdin("mongodb://host/db"),
    );

    const reply = await runCommand(
      runner(),
      ["pin-config-secret"],
      fake.adapter,
    );

    expect(reply).toMatchObject({ ok: true, secretInConfig: true });
    expect(fake.written.get("MONGODB_URL")).toBe("mongodb://host/db");
    expect(fake.steps.at(-1)).toBe("reload");
  });

  it("refuses to pin a credential this machine does not have", async () => {
    const fake = fakeAdapter("darwin");

    await expect(
      runCommand(runner(), ["pin-config-secret"], fake.adapter),
    ).rejects.toThrow(/no credential is stored/);
  });

  it("defaults the database name so the user only supplies a URL", async () => {
    const fake = fakeAdapter("darwin");

    await runCommand(
      runner(),
      ["set-sync"],
      fake.adapter,
      onStdin("mongodb://host/db"),
    );

    expect(fake.written.get("MONGODB_DB")).toBe("mangatracker");
  });

  it("turns sync off by blanking the URL", async () => {
    // Blank rather than removed: an absent key and an empty one have to mean
    // the same thing to the reader, and only one of them is writable here.
    const fake = fakeAdapter("darwin");
    await runCommand(
      runner(),
      ["set-sync"],
      fake.adapter,
      onStdin("mongodb://host/db"),
    );

    const reply = await runCommand(runner(), ["clear-sync"], fake.adapter);

    expect(reply).toMatchObject({ syncConfigured: false });
    expect(fake.written.get("MONGODB_URL")).toBe("");
  });

  it("refuses a set-sync with nothing on stdin", async () => {
    const fake = fakeAdapter("darwin");

    await expect(
      runCommand(runner(), ["set-sync"], fake.adapter, onStdin("  \n")),
    ).rejects.toThrow(/no connection string/);
  });

  it("will not take the credential from a flag, however it is offered", async () => {
    // The point of the whole change: a secret on the command line is readable
    // by every process on the machine through `ps`. Closing the channel means
    // the flag has to stop working, not merely stop being used.
    const fake = fakeAdapter("darwin");

    await expect(
      runCommand(
        runner(),
        ["set-sync", "--url", "mongodb://user:hunter2@host/db"],
        fake.adapter,
        onStdin(""),
      ),
    ).rejects.toThrow(/no connection string/);
    expect(fake.secret).toBeNull();
  });
});

describe("the credential this machine already had", () => {
  it("reports that one exists, without ever returning it", async () => {
    // Installing writes four values and none is personal, which is what keeps
    // the author's infrastructure out of anyone else's copy — and is also why
    // installing over an existing setup switched sync off silently.
    await inTempDir(async (dir) => {
      const fake = fakeAdapter("darwin");
      await runCommand(
        runner(),
        [
          "install",
          "--app-dir",
          "/opt/app",
          "--data-dir",
          dir,
          "--port",
          "5151",
        ],
        fake.adapter,
      );
      await runCommand(
        runner(),
        ["set-sync"],
        fake.adapter,
        onStdin("mongodb://user:hunter2@host/db"),
      );
      // A fresh install: the configuration loses the URL, the keystore keeps it.
      await runCommand(runner(), ["clear-sync"], fake.adapter);

      const reply = await runCommand(runner(), ["status"], fake.adapter);

      expect(reply).toMatchObject({
        syncConfigured: false,
        hasStoredCredential: true,
      });
      expect(JSON.stringify(reply)).not.toContain("hunter2");
    });
  });

  it("turns sync back on from the keystore", async () => {
    const fake = fakeAdapter("darwin");
    await runCommand(
      runner(),
      ["set-sync"],
      fake.adapter,
      onStdin("mongodb://host/db"),
    );
    await runCommand(runner(), ["clear-sync"], fake.adapter);

    const reply = await runCommand(
      runner(),
      ["use-stored-sync", "--db", "mangas"],
      fake.adapter,
    );

    expect(reply).toMatchObject({
      ok: true,
      syncConfigured: true,
      db: "mangas",
    });
    // The sentinel, not the credential: reusing it means pointing the launcher
    // at the keystore, not copying the value back into a file.
    expect(fake.written.get("MONGODB_URL")).toBe("keystore");
    expect(fake.secret).toBe("mongodb://host/db");
    expect(fake.steps.at(-1)).toBe("reload");
  });

  it("flags a stored srv URL instead of refusing it", async () => {
    // It works on macOS and never connects on Windows. Refusing would break a
    // setup that is working today; saying nothing would repeat the problem.
    const fake = fakeAdapter("darwin", {
      readSecret: async () => "mongodb+srv://cluster.example.com/db",
    });

    const reply = await runCommand(runner(), ["use-stored-sync"], fake.adapter);

    expect(reply).toMatchObject({ ok: true, usesSrv: true });
  });

  it("says so plainly when there is nothing stored", async () => {
    const fake = fakeAdapter("darwin");

    await expect(
      runCommand(runner(), ["use-stored-sync"], fake.adapter),
    ).rejects.toThrow(/no credential is stored/);
  });
});

describe("stop", () => {
  it("stops without starting again", async () => {
    // An update replaces files the running backend holds open, which on
    // Windows fails outright while the process is alive.
    const fake = fakeAdapter("darwin");

    const reply = await runCommand(runner(), ["stop"], fake.adapter);

    expect(reply).toMatchObject({ ok: true });
    expect(fake.steps).toEqual(["stop"]);
  });
});

describe("unknown commands", () => {
  it("names what it expected instead of failing silently", async () => {
    const fake = fakeAdapter("darwin");

    // Every command it accepts, not a list that drifts: the old message named
    // five of the seven, and the two it left out were the two the desktop app
    // had most recently learned to send.
    const message = await runCommand(
      runner(),
      ["frobnicate"],
      fake.adapter,
    ).then(
      () => "",
      (error: unknown) => String(error),
    );
    for (const command of [
      "install",
      "status",
      "restart",
      "set-sync",
      "use-stored-sync",
      "clear-sync",
      "stop",
    ]) {
      expect(message).toContain(command);
    }
  });
});
