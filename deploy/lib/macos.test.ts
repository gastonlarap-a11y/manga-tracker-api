import { describe, expect, it } from "bun:test";
import { reloadService } from "./macos";
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
