// Owns the replica connection and decides when a push happens. Module-level
// mutable state is deliberate here, in the same spirit as events.bus.ts: there
// is exactly one replica per process and one push in flight at a time.
//
// The hard rule: a sync failure must never reach a request handler. Recording a
// reading has to succeed with the cluster paused, the firewall stale, or the
// laptop on a plane.
import { config } from "../../config";
import { subscribeLibraryChanges } from "../events/events.bus";
import type { PushOptions, PushOutcome } from "./sync.service";
import { pushToReplica } from "./sync.service";
import { createMongoTarget, type SyncTarget } from "./sync.target";

// A burst of chapter reports should collapse into one push.
const DEBOUNCE_MS = 5_000;
// Cover bytes are slow (~790ms/MB measured against the cluster), so they ride a
// slow lane instead of the hot path. This interval doubles as the keep-alive
// that stops a free-tier cluster from being paused for inactivity at 60 days.
const COVER_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface SyncStatus {
  enabled: boolean;
  connected: boolean;
  lastPushAt: Date | null;
  lastResult: PushOutcome | null;
  lastError: { message: string; at: Date } | null;
}

let target: SyncTarget | null = null;
let connected = false;
let lastPushAt: Date | null = null;
let lastResult: PushOutcome | null = null;
let lastError: { message: string; at: Date } | null = null;
// Serializes every push so two triggers can never diff against the same
// remote key set and both decide to insert the same events.
let chain: Promise<unknown> = Promise.resolve();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let coverTimer: ReturnType<typeof setInterval> | null = null;

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
 * Runs a push and records the outcome. Rejects on failure — callers that must
 * not fail (the scheduler) swallow it; the manual endpoint surfaces it.
 */
export function pushNow(options: PushOptions): Promise<PushOutcome> {
  return serialize(async () => {
    try {
      const result = await pushToReplica(await connectedTarget(), options);
      lastPushAt = new Date();
      lastResult = result;
      lastError = null;
      return result;
    } catch (error) {
      // A dropped connection must not poison every later attempt: forget the
      // client so the next push dials again.
      connected = false;
      target = null;
      lastError = {
        message: error instanceof Error ? error.message : String(error),
        at: new Date(),
      };
      throw error;
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
    lastPushAt,
    lastResult,
    lastError,
  };
}

function schedulePush(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // Triggered by a real local change, so a document missing locally really
    // was deleted here: this is the push that may prune the replica.
    void pushNow({ covers: false, allowDeletions: true }).catch(
      (error: unknown) => {
        console.error(
          `[sync] push failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  }, DEBOUNCE_MS);
  // Never let a pending push hold the process open.
  debounceTimer.unref?.();
}

/**
 * Wires the replica to the library. Returns a stop function; a no-op when sync
 * is disabled, which is how the app behaves with no MONGODB_URL and how CI runs.
 */
export function startSyncScheduler(): () => void {
  if (!isSyncEnabled()) {
    return () => {};
  }

  const unsubscribe = subscribeLibraryChanges(schedulePush);

  // The slow lane also repairs deletions whose push failed while offline, so it
  // is not additive-only.
  coverTimer = setInterval(() => {
    void pushNow({ covers: true, allowDeletions: true }).catch(
      (error: unknown) => {
        console.error(
          `[sync] cover push failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  }, COVER_INTERVAL_MS);
  coverTimer.unref?.();

  // Catch-up for whatever accumulated while the process was down. Strictly
  // additive: at boot there is no evidence that anything absent locally was
  // deleted here rather than never restored, and guessing wrong destroys the
  // backup. Deletions ride the next change-triggered push instead.
  void pushNow({ covers: true, allowDeletions: false }).catch(
    (error: unknown) => {
      console.error(
        `[sync] initial push failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );

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
