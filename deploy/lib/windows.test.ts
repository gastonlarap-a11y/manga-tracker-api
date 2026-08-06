import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./run";
import { createFakeRunner, type FakeResponse } from "./run";
import {
  installTask,
  isElevated,
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
    // The path is passed explicitly: defaulting to the real SECRET_PATH made
    // this pass or fail depending on whether the machine running the suite had
    // been bootstrapped. With no file there, readSecret must short-circuit
    // before invoking PowerShell at all — the empty fake runner throws if it
    // does not.
    const missing = join(tmpdir(), "mangatracker-no-such-secret.dpapi");
    expect(await readSecret(createFakeRunner([]).run, missing)).toBeNull();
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
  /** Captures every command plus the XML that reached `schtasks /Create`. */
  function recordingRunner(icaclsOk = true) {
    const calls: (readonly string[])[] = [];
    let xml = "";
    const run: Runner = async (command) => {
      calls.push(command);
      const xmlIndex = command.indexOf("/XML");
      if (xmlIndex >= 0) {
        xml = await Bun.file(command[xmlIndex + 1] ?? "").text();
      }
      const ok = command[0] !== "icacls" || icaclsOk;
      return { ok, code: ok ? 0 : 1, stdout: "", stderr: "" };
    };
    return { run, calls, xml: () => xml };
  }

  it("writes a task with no execution time limit and registers it with /F", async () => {
    const fake = recordingRunner();

    await installTask(fake.run, {
      bunPath: "C:\\Users\\gaston\\.bun\\bin\\bun.exe",
      workingDirectory: "C:\\Users\\gaston\\Documents\\Git\\manga-tracker-api",
    });

    const xml = fake.xml();
    const call = fake.calls[0] ?? [];
    expect(call[0]).toBe("schtasks");
    expect(call).toContain("/Create");
    expect(call).toContain("/F");
    // The default 72h limit would silently kill an indefinitely-running backend.
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    // InteractiveToken would run the task in the user's session, where the
    // cmd.exe wrapper opens a visible console window — closing it kills the
    // backend. S4U runs in session 0, which has no console at all.
    expect(xml).toContain("<LogonType>S4U</LogonType>");
    expect(xml).not.toContain("InteractiveToken");
    // An elevated /Create leaves the invoking user with read only, and
    // reloadService (/End + /Run) needs execute. The XML's own
    // <SecurityDescriptor> element does not work — schtasks ignores it — so the
    // grant has to happen through icacls afterwards.
    expect(xml).not.toContain("<SecurityDescriptor>");
    expect(xml).toContain("C:\\Users\\gaston\\.bun\\bin\\bun.exe");
    expect(xml).toContain(
      "<WorkingDirectory>C:\\Users\\gaston\\Documents\\Git\\manga-tracker-api</WorkingDirectory>",
    );
  });

  it("grants the user read+execute on the task file, and nothing more", async () => {
    // Without this the elevated /Create leaves the user on read-only and every
    // `bun run deploy` needs an elevated terminal, because reloadService is
    // schtasks /End + /Run. Write is deliberately not granted: redefining the
    // task should still take elevation.
    const fake = recordingRunner();

    const outcome = await installTask(fake.run, {
      bunPath: "bun.exe",
      workingDirectory: "C:\\repo",
    });

    const grant = fake.calls.find((call) => call[0] === "icacls") ?? [];
    expect(grant[1]).toContain("System32");
    expect(grant[1]).toContain("Tasks");
    expect(grant).toContain("/grant");
    expect(grant.at(-1)).toMatch(/:\(RX\)$/);
    expect(outcome.userCanControlIt).toBe(true);
  });

  it("reports a failed grant instead of pretending the install is complete", async () => {
    // The task still runs, so this is not fatal — but the caller has to be able
    // to say that deploys will need elevation until it is fixed.
    const fake = recordingRunner(false);

    const outcome = await installTask(fake.run, {
      bunPath: "bun.exe",
      workingDirectory: "C:\\repo",
    });

    expect(outcome.userCanControlIt).toBe(false);
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

  it("points at the leftover task even when Windows localizes the error", async () => {
    // A Spanish install answers "Acceso denegado", so the remedy cannot be
    // gated on the English string — it has to come out either way.
    const run: Runner = async () => ({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "Error: Acceso denegado.",
    });

    await expect(
      installTask(run, { bunPath: "bun.exe", workingDirectory: "C:\\repo" }),
    ).rejects.toThrow(
      /Acceso denegado[\s\S]*schtasks \/Delete \/TN MangaTracker/,
    );
  });
});

describe("isElevated", () => {
  it("reads PowerShell's literal True, not a localized string", async () => {
    const fake = createFakeRunner([{ when: ["powershell"], stdout: "True" }]);
    expect(await isElevated(fake.run)).toBe(true);
    expect(fake.calls[0]?.join(" ")).toContain("WindowsBuiltInRole");
  });

  it("is false for an unelevated shell", async () => {
    const fake = createFakeRunner([{ when: ["powershell"], stdout: "False" }]);
    expect(await isElevated(fake.run)).toBe(false);
  });

  it("does not claim elevation when the probe itself fails", async () => {
    // Answering "elevated" here would send the bootstrap into a /Create it
    // cannot complete, after it has already provisioned the vault.
    const fake = createFakeRunner([{ when: ["powershell"], code: 1 }]);
    expect(await isElevated(fake.run)).toBe(false);
  });
});
