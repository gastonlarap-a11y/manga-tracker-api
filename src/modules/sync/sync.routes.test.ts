// Tests run with no MONGODB_URL (the same shape as CI and as any machine that
// never opted into the replica), so this file pins the contract that matters
// most: with sync off, the app is exactly the app it was before.
import { describe, expect, it } from "bun:test";
import { syncRoutes } from "./sync.routes";
import { isSyncEnabled, startSyncScheduler } from "./sync.scheduler";

describe("Sync routes with the replica not configured", () => {
  it("should report sync as disabled without touching the network", async () => {
    expect(isSyncEnabled()).toBe(false);

    const res = await syncRoutes.request("/sync/status");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      enabled: false,
      connected: false,
      lastPushAt: null,
      lastResult: null,
      lastError: null,
    });
  });

  it("should refuse a push with 503 instead of failing obscurely", async () => {
    const res = await syncRoutes.request("/sync/push", { method: "POST" });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "Sync is disabled: MONGODB_URL is not set",
    });
  });

  it("should refuse a restore with 503 and leave the database alone", async () => {
    const res = await syncRoutes.request("/sync/restore?force=true", {
      method: "POST",
    });

    expect(res.status).toBe(503);
  });

  it("should reject an unknown value for the covers flag", async () => {
    const res = await syncRoutes.request("/sync/push?covers=maybe", {
      method: "POST",
    });

    expect(res.status).toBe(400);
  });

  it("should start as an inert no-op scheduler", () => {
    const stop = startSyncScheduler();
    // No subscription, no timers, nothing to unwind.
    expect(() => stop()).not.toThrow();
  });
});
