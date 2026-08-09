import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadService, writePlist } from "./macos";
import { createFakeRunner, type FakeResponse } from "./run";

/**
 * Timings collapsed so the tests do not actually sleep, and a fixed uid so the
 * launchd domain does not depend on the host: `process.getuid` is undefined on
 * Windows, where `bun run deploy` still gates on this suite.
 */
const FAST = {
  settleAttempts: 5,
  settleDelayMs: 0,
  bootstrapAttempts: 3,
  uid: 501,
};

const EIO = "Bootstrap failed: 5: Input/output error";

const is = (call: readonly string[], verb: string) =>
  call[0] === "launchctl" && call[1] === verb;

/** `launchctl print` succeeds while the job is loaded, fails once it is gone. */
const printLoadedTimes = (times: number): FakeResponse => {
  let remaining = times;
  return {
    when: ["launchctl", "print"],
    // The fake runner reads `code` per call, so flip it through a getter.
    get code() {
      return remaining-- > 0 ? 0 : 1;
    },
  };
};

describe("reloadService", () => {
  it("waits for the old job to disappear before bootstrapping", async () => {
    const fake = createFakeRunner([
      { when: ["launchctl", "bootout"] },
      printLoadedTimes(2),
      { when: ["launchctl", "bootstrap"] },
    ]);

    await reloadService(fake.run, FAST);

    const order = fake.calls.map((call) => call[1]);
    const bootstrapAt = order.indexOf("bootstrap");
    const printsBefore = order
      .slice(0, bootstrapAt)
      .filter((v) => v === "print");

    // Bootstrapping into a domain that still holds the dying job is the EIO.
    expect(bootstrapAt).toBeGreaterThan(0);
    expect(printsBefore.length).toBe(3); // two loaded, one gone
    expect(order.indexOf("bootout")).toBeLessThan(bootstrapAt);
  });

  it("retries a bootstrap that loses the race anyway", async () => {
    let attempts = 0;
    const fake = createFakeRunner([
      { when: ["launchctl", "bootout"] },
      { when: ["launchctl", "print"], code: 1 },
      {
        when: ["launchctl", "bootstrap"],
        stderr: EIO,
        get code() {
          // Fails once, then succeeds — teardown can settle late.
          return attempts++ === 0 ? 1 : 0;
        },
      },
    ]);

    await reloadService(fake.run, FAST);

    expect(fake.calls.filter((call) => is(call, "bootstrap")).length).toBe(2);
  });

  it("gives up with the recovery command when every attempt fails", async () => {
    const fake = createFakeRunner([
      { when: ["launchctl", "bootout"] },
      { when: ["launchctl", "print"], code: 1 },
      { when: ["launchctl", "bootstrap"], code: 1, stderr: EIO },
    ]);

    // A deploy that leaves the service down must say so, and say how to fix it.
    await expect(reloadService(fake.run, FAST)).rejects.toThrow(
      /service is now DOWN[\s\S]*launchctl bootstrap gui/,
    );
    expect(fake.calls.filter((call) => is(call, "bootstrap")).length).toBe(3);
  });

  it("still reloads when the service was not running to begin with", async () => {
    const fake = createFakeRunner([
      // bootout fails: nothing was loaded. That is a fine starting state.
      { when: ["launchctl", "bootout"], code: 1, stderr: "No such process" },
      { when: ["launchctl", "print"], code: 1 },
      { when: ["launchctl", "bootstrap"] },
    ]);

    await reloadService(fake.run, FAST);

    expect(fake.calls.filter((call) => is(call, "bootstrap")).length).toBe(1);
  });
});

describe("writePlist", () => {
  /** Never the real PLIST_PATH: this suite must not touch the production agent. */
  async function inTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "plist-test-"));
    try {
      return await body(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const options = (dir: string) => ({
    bunPath: "/opt/app/bun",
    entry: "index.js",
    workingDirectory: "/opt/app",
    logDir: join(dir, "logs"),
    path: join(dir, "com.mangatracker.plist"),
  });

  // `plutil` ships with macOS and nowhere else, and this suite has to pass on
  // Linux and Windows too. Where it exists it is the authority on whether the
  // file is valid — far better evidence than any regex over the XML.
  const onMac = it.skipIf(process.platform !== "darwin");

  onMac("writes a plist launchd can parse", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "com.mangatracker.plist");
      await writePlist(options(dir));

      expect(Bun.spawnSync(["plutil", "-lint", path]).exitCode).toBe(0);
    });
  });

  it("points launchd at the bundled interpreter and entry point", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "com.mangatracker.plist");
      await writePlist(options(dir));
      const plist = await Bun.file(path).text();

      expect(plist).toContain("<string>/opt/app/bun</string>");
      expect(plist).toContain("<string>index.js</string>");
      expect(plist).toContain("<string>/opt/app</string>");
      // An installed copy has no src/ tree at all.
      expect(plist).not.toContain("src/index.ts");
    });
  });

  it("leaves the environment empty for writePlistEnv to fill", async () => {
    // One code path writes the values, and it is the one that also re-tightens
    // the file's permissions.
    await inTempDir(async (dir) => {
      const path = join(dir, "com.mangatracker.plist");
      await writePlist(options(dir));

      expect(await Bun.file(path).text()).toContain("<dict/>");
    });
  });

  it("creates the log directory, without which launchd refuses to start", async () => {
    await inTempDir(async (dir) => {
      await writePlist(options(dir));

      expect((await stat(join(dir, "logs"))).isDirectory()).toBe(true);
    });
  });

  // Windows has no POSIX permission bits to assert on.
  it.skipIf(process.platform === "win32")(
    "keeps the file unreadable by other accounts",
    async () => {
      // It ends up holding the cluster password, and launchd creates plists
      // world-readable by default.
      await inTempDir(async (dir) => {
        const path = join(dir, "com.mangatracker.plist");
        await writePlist(options(dir));

        expect((await stat(path)).mode & 0o777).toBe(0o600);
      });
    },
  );

  it("escapes a path that would otherwise break the XML", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "com.mangatracker.plist");
      await writePlist({
        ...options(dir),
        workingDirectory: "/opt/Rock & Roll/<app>",
      });

      expect(await Bun.file(path).text()).toContain(
        "Rock &amp; Roll/&lt;app&gt;",
      );
    });
  });

  onMac("stays parseable when a path carries XML metacharacters", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "com.mangatracker.plist");
      await writePlist({
        ...options(dir),
        workingDirectory: "/opt/Rock & Roll/<app>",
      });

      expect(Bun.spawnSync(["plutil", "-lint", path]).exitCode).toBe(0);
    });
  });
});
