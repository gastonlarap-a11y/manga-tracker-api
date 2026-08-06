import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./run";
import { createFakeRunner, type FakeResponse } from "./run";
import {
  installTask,
  readConfigEnv,
  readSecret,
  reloadService,
  writeConfigEnv,
  writeSecret,
} from "./windows";

/** Timings collapsed so the tests do not actually sleep. */
const FAST = { settleAttempts: 5, settleDelayMs: 0, runAttempts: 3 };

const is = (call: readonly string[], verb: string) =>
  call[0] === "schtasks" && call[1] === verb;

/** `schtasks /Query` reports Running while the task is up, then stops. */
const runningTimes = (times: number): FakeResponse => {
  let remaining = times;
  return {
    when: ["schtasks", "/Query"],
    stdout: "Status:               Running",
    get code() {
      return remaining-- > 0 ? 0 : 1;
    },
  };
};

describe("reloadService", () => {
  it("waits for the previous run to stop before running again", async () => {
    const fake = createFakeRunner([
      { when: ["schtasks", "/End"] },
      runningTimes(2),
      { when: ["schtasks", "/Run"] },
    ]);

    await reloadService(fake.run, FAST);

    const order = fake.calls.map((call) => call[1]);
    const runAt = order.indexOf("/Run");
    const queriesBefore = order.slice(0, runAt).filter((v) => v === "/Query");

    expect(runAt).toBeGreaterThan(0);
    expect(queriesBefore.length).toBe(3); // two running, one gone
    expect(order.indexOf("/End")).toBeLessThan(runAt);
  });

  it("retries a run that loses the race anyway", async () => {
    let attempts = 0;
    const fake = createFakeRunner([
      { when: ["schtasks", "/End"] },
      { when: ["schtasks", "/Query"], code: 1 },
      {
        when: ["schtasks", "/Run"],
        get code() {
          return attempts++ === 0 ? 1 : 0;
        },
      },
    ]);

    await reloadService(fake.run, FAST);

    expect(fake.calls.filter((call) => is(call, "/Run")).length).toBe(2);
  });

  it("gives up with the recovery command when every attempt fails", async () => {
    const fake = createFakeRunner([
      { when: ["schtasks", "/End"] },
      { when: ["schtasks", "/Query"], code: 1 },
      { when: ["schtasks", "/Run"], code: 1, stderr: "access denied" },
    ]);

    await expect(reloadService(fake.run, FAST)).rejects.toThrow(
      /service is now DOWN[\s\S]*schtasks \/Run/,
    );
    expect(fake.calls.filter((call) => is(call, "/Run")).length).toBe(3);
  });

  it("still reloads when the task was not running to begin with", async () => {
    const fake = createFakeRunner([
      // /End fails: nothing was running. That is a fine starting state.
      { when: ["schtasks", "/End"], code: 1, stderr: "not running" },
      { when: ["schtasks", "/Query"], code: 1 },
      { when: ["schtasks", "/Run"] },
    ]);

    await reloadService(fake.run, FAST);

    expect(fake.calls.filter((call) => is(call, "/Run")).length).toBe(1);
  });
});

describe("readSecret / writeSecret", () => {
  it("keeps the value out of argv, going through a file instead", async () => {
    const fake = createFakeRunner([{ when: ["powershell"] }]);

    await writeSecret(fake.run, "s3cr3t");

    const call = fake.calls[0] ?? [];
    expect(call[0]).toBe("powershell");
    expect(call.join(" ")).not.toContain("s3cr3t");
    // The plaintext travels through a temp file the -Command script reads.
    expect(call.join(" ")).toContain("Get-Content");
  });

  it("returns null instead of the raw command output when nothing is cached", async () => {
    // No SECRET_PATH file on disk: readSecret must short-circuit before
    // invoking PowerShell at all.
    expect(await readSecret(createFakeRunner([]).run)).toBeNull();
  });
});

describe("readConfigEnv / writeConfigEnv", () => {
  it("round-trips a value through prod.env and tightens permissions with icacls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mangatracker-windows-test-"));
    const path = join(dir, "prod.env");
    try {
      const fake = createFakeRunner([{ when: ["icacls"] }]);

      const wrote = await writeConfigEnv(fake.run, "PORT", "5150", path);
      expect(wrote).toBe(true);
      expect(fake.calls[0]?.[0]).toBe("icacls");
      expect(fake.calls[0]).not.toContain("5150");

      expect(await readConfigEnv(fake.run, "PORT", path)).toBe("5150");
      expect(await readConfigEnv(fake.run, "MISSING", path)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replaces an existing entry in place instead of duplicating it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mangatracker-windows-test-"));
    const path = join(dir, "prod.env");
    try {
      const fake = createFakeRunner([{ when: ["icacls"] }]);

      await writeConfigEnv(fake.run, "PORT", "5150", path);
      await writeConfigEnv(fake.run, "PORT", "5151", path);

      const text = await Bun.file(path).text();
      expect(text.match(/PORT=/g)?.length).toBe(1);
      expect(await readConfigEnv(fake.run, "PORT", path)).toBe("5151");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("installTask", () => {
  it("writes a task with no execution time limit and registers it with /F", async () => {
    let xml = "";
    let call: readonly string[] = [];
    const run: Runner = async (command) => {
      call = command;
      const xmlIndex = command.indexOf("/XML");
      if (xmlIndex >= 0) {
        xml = await Bun.file(command[xmlIndex + 1] ?? "").text();
      }
      return { ok: true, code: 0, stdout: "", stderr: "" };
    };

    await installTask(run, {
      bunPath: "C:\\Users\\gaston\\.bun\\bin\\bun.exe",
      workingDirectory: "C:\\Users\\gaston\\Documents\\Git\\manga-tracker-api",
    });

    expect(call[0]).toBe("schtasks");
    expect(call).toContain("/Create");
    expect(call).toContain("/F");
    // The default 72h limit would silently kill an indefinitely-running backend.
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("C:\\Users\\gaston\\.bun\\bin\\bun.exe");
    expect(xml).toContain(
      "<WorkingDirectory>C:\\Users\\gaston\\Documents\\Git\\manga-tracker-api</WorkingDirectory>",
    );
  });

  it("throws with the value still readable when schtasks rejects the definition", async () => {
    const run: Runner = async () => ({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "ERROR: Access is denied.",
    });

    await expect(
      installTask(run, { bunPath: "bun.exe", workingDirectory: "C:\\repo" }),
    ).rejects.toThrow(/Access is denied/);
  });
});
