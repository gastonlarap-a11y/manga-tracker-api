import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallServiceOptions, PlatformAdapter } from "./lib/platform";
import { createFakeRunner } from "./lib/run";
import {
  environmentFor,
  firstFreePort,
  parseArgs,
  runCommand,
} from "./service-cli";

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
        entry: "index.js",
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
        ["set-sync", "--url", "mongodb://user:secret@host/db"],
        fake.adapter,
      );

      const reply = await runCommand(runner(), ["status"], fake.adapter);

      expect(reply).toMatchObject({ syncConfigured: true });
      expect(JSON.stringify(reply)).not.toContain("secret");
    });
  });
});

describe("sync", () => {
  it("puts the credential in the system keystore, not only in the config", async () => {
    const fake = fakeAdapter("darwin");

    await runCommand(
      runner(),
      ["set-sync", "--url", "mongodb://host/db", "--db", "mangas"],
      fake.adapter,
    );

    expect(fake.secret).toBe("mongodb://host/db");
    expect(fake.written.get("MONGODB_DB")).toBe("mangas");
    expect(fake.steps.at(-1)).toBe("reload");
  });

  it("defaults the database name so the user only supplies a URL", async () => {
    const fake = fakeAdapter("darwin");

    await runCommand(
      runner(),
      ["set-sync", "--url", "mongodb://host/db"],
      fake.adapter,
    );

    expect(fake.written.get("MONGODB_DB")).toBe("mangatracker");
  });

  it("turns sync off by blanking the URL", async () => {
    // Blank rather than removed: an absent key and an empty one have to mean
    // the same thing to the reader, and only one of them is writable here.
    const fake = fakeAdapter("darwin");
    await runCommand(
      runner(),
      ["set-sync", "--url", "mongodb://host/db"],
      fake.adapter,
    );

    const reply = await runCommand(runner(), ["clear-sync"], fake.adapter);

    expect(reply).toMatchObject({ syncConfigured: false });
    expect(fake.written.get("MONGODB_URL")).toBe("");
  });

  it("refuses a set-sync with no URL", async () => {
    const fake = fakeAdapter("darwin");

    await expect(
      runCommand(runner(), ["set-sync"], fake.adapter),
    ).rejects.toThrow(/--url/);
  });
});

describe("unknown commands", () => {
  it("names what it expected instead of failing silently", async () => {
    const fake = fakeAdapter("darwin");

    await expect(
      runCommand(runner(), ["frobnicate"], fake.adapter),
    ).rejects.toThrow(/install, status, restart, set-sync or clear-sync/);
  });
});
