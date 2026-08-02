// Owns the connection to the shared store and decides when a sync happens.
// Module-level mutable state is deliberate here, in the same spirit as
// events.bus.ts: there is exactly one peer connection per process and one sync
// in flight at a time.
//
// The hard rule: a sync failure must never reach a request handler. Recording a
// reading has to succeed with the cluster paused, the firewall stale, or the
// laptop on a plane.
import { config } from "../../config";
import { subscribeLibraryChanges } from "../events/events.bus";
import type { SyncOptions, SyncResult } from "./sync.service";
import { syncWithReplica } from "./sync.service";
import { createMongoTarget, type SyncTarget } from "./sync.target";

// A burst of chapter reports should collapse into one sync.
const DEBOUNCE_MS = 5_000;
// Cover bytes are slow (~790ms/MB measured against the cluster), so they ride a
// slow lane. This interval doubles as the keep-alive that stops a free-tier
// cluster from being paused for inactivity at 60 days, and as the catch-up that
// notices what another machine recorded while this one sat idle.
const COVER_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface SyncStatus {
  enabled: boolean;
  connected: boolean;
  lastSyncAt: Date | null;
  lastResult: SyncResult | null;
  lastError: { message: string; at: Date } | null;
}

let target: SyncTarget | null = null;
let connected = false;
let lastSyncAt: Date | null = null;
let lastResult: SyncResult | null = null;
let lastError: { message: string; at: Date } | null = null;
// Serializes every sync so two triggers can never merge against the same
// snapshot and both decide to insert the same events.
let chain: Promise<unknown> = Promise.resolve();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let coverTimer: ReturnType<typeof setInterval> | null = null;
// A sync that pulls something publishes a library change, which would bounce
// straight back here and schedule a redundant round trip.
let applyingRemote = false;

export function isSyncEnabled(): boolean {
  return config.mongo !== null;
}

async function connectedTarget(): Promise<SyncTarget> {
  if (config.mongo === null) {
    throw new Error("Sync is disabled: MONGODB_URL is not set");
  }
  if (target === null) {
    target = createMongoTarget(config.mongo);
  }
  if (!connected) {
    await target.connect();
    connected = true;
  }
  return target;
}

function serialize<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run, run);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Runs a sync and records the outcome. Rejects on failure — callers that must
 * not fail (the scheduler) swallow it; the manual endpoint surfaces it.
 */
export function syncNow(options: SyncOptions): Promise<SyncResult> {
  return serialize(async () => {
    applyingRemote = true;
    try {
      const result = await syncWithReplica(await connectedTarget(), options);
      lastSyncAt = new Date();
      lastResult = result;
      lastError = null;
      return result;
    } catch (error) {
      // A dropped connection must not poison every later attempt: forget the
      // client so the next sync dials again.
      connected = false;
      target = null;
      lastError = {
        message: error instanceof Error ? error.message : String(error),
        at: new Date(),
      };
      throw error;
    } finally {
      applyingRemote = false;
    }
  });
}

/** For the restore route, which needs the same lazily-connected target. */
export function withTarget<T>(
  run: (target: SyncTarget) => Promise<T>,
): Promise<T> {
  return serialize(async () => run(await connectedTarget()));
}

export function getSyncStatus(): SyncStatus {
  return {
    enabled: isSyncEnabled(),
    connected,
    lastSyncAt,
    lastResult,
    lastError,
  };
}

function report(scope: string, error: unknown): void {
  console.error(
    `[sync] ${scope} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function scheduleSync(): void {
  if (applyingRemote) {
    return;
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void syncNow({ covers: false }).catch((error: unknown) => {
      report("sync", error);
    });
  }, DEBOUNCE_MS);
  // Never let a pending sync hold the process open.
  debounceTimer.unref?.();
}

/**
 * Wires the shared store to the library. Returns a stop function; a no-op when
 * sync is disabled, which is how the app behaves with no MONGODB_URL and how CI
 * runs.
 */
export function startSyncScheduler(): () => void {
  if (!isSyncEnabled()) {
    return () => {};
  }

  const unsubscribe = subscribeLibraryChanges(scheduleSync);

  coverTimer = setInterval(() => {
    void syncNow({ covers: true }).catch((error: unknown) => {
      report("periodic sync", error);
    });
  }, COVER_INTERVAL_MS);
  coverTimer.unref?.();

  // First sync after boot, covers included. This is what makes switching
  // machines require no action: whatever the other one recorded arrives here
  // before anything else happens.
  void syncNow({ covers: true }).catch((error: unknown) => {
    report("initial sync", error);
  });

  return () => {
    unsubscribe();
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (coverTimer !== null) {
      clearInterval(coverTimer);
      coverTimer = null;
    }
  };
}
