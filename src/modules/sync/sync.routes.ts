import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { defaultHook, errorSchema } from "../../lib/http";
import {
  getSyncStatus,
  isSyncEnabled,
  syncNow,
  withTarget,
} from "./sync.scheduler";
import { restoreFromReplica } from "./sync.service";

const movedSchema = z.object({
  mangas: z.number(),
  events: z.number(),
  adapters: z.number(),
  covers: z.number(),
  dismissals: z.number().describe("Rejected duplicate pairs"),
});

const syncResultSchema = z
  .object({
    pulled: movedSchema.describe("Brought in from other machines"),
    pushed: movedSchema.describe("Sent to the shared store"),
  })
  .openapi("SyncResult");

const syncStatusSchema = z
  .object({
    enabled: z.boolean().describe("False when MONGODB_URL is not configured"),
    connected: z.boolean(),
    lastSyncAt: z.iso.datetime().nullable(),
    lastResult: syncResultSchema.nullable(),
    lastError: z
      .object({ message: z.string(), at: z.iso.datetime() })
      .nullable(),
  })
  .openapi("SyncStatus");

const disabled = { error: "Sync is disabled: MONGODB_URL is not set" } as const;

const getStatusRoute = createRoute({
  method: "get",
  path: "/sync/status",
  tags: ["sync"],
  description:
    "Local-only snapshot of the sync state; never touches the network.",
  responses: {
    200: {
      description: "Current sync state",
      content: { "application/json": { schema: syncStatusSchema } },
    },
  },
});

const postSyncRoute = createRoute({
  method: "post",
  path: "/sync/now",
  tags: ["sync"],
  description:
    "Pulls what other machines recorded, merges it, and pushes what is new here. Pass covers=true to also move cover bytes.",
  request: {
    query: z.object({
      covers: z
        .enum(["true", "false"])
        .optional()
        .openapi({ description: "Include the cover byte pass" }),
    }),
  },
  responses: {
    200: {
      description: "What the sync moved, in each direction",
      content: { "application/json": { schema: syncResultSchema } },
    },
    502: {
      description: "The shared store could not be reached",
      content: { "application/json": { schema: errorSchema } },
    },
    503: {
      description: "Sync is disabled",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

const postRestoreRoute = createRoute({
  method: "post",
  path: "/sync/restore",
  tags: ["sync"],
  description:
    "Throws the local database away and rebuilds it from the shared store. Ordinary machine switches do not need this — a plain sync merges both sides. Refuses to run over a populated database unless force=true.",
  request: {
    query: z.object({
      force: z
        .enum(["true", "false"])
        .optional()
        .openapi({ description: "Replace the local database" }),
    }),
  },
  responses: {
    200: {
      description: "What was restored",
      content: { "application/json": { schema: movedSchema } },
    },
    409: {
      description:
        "The local database already holds data and force was not set",
      content: { "application/json": { schema: errorSchema } },
    },
    502: {
      description: "The shared store could not be reached",
      content: { "application/json": { schema: errorSchema } },
    },
    503: {
      description: "Sync is disabled",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

const failureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const syncRoutes = new OpenAPIHono({ defaultHook })
  .openapi(getStatusRoute, (c) => {
    const status = getSyncStatus();
    return c.json(
      {
        ...status,
        lastSyncAt: status.lastSyncAt?.toISOString() ?? null,
        lastError:
          status.lastError === null
            ? null
            : {
                message: status.lastError.message,
                at: status.lastError.at.toISOString(),
              },
      },
      200,
    );
  })
  .openapi(postSyncRoute, async (c) => {
    if (!isSyncEnabled()) {
      return c.json(disabled, 503);
    }
    const { covers } = c.req.valid("query");
    try {
      return c.json(await syncNow({ covers: covers === "true" }), 200);
    } catch (error) {
      // The shared store being unreachable is an expected state here, not a
      // bug: report it as an upstream failure instead of a 500.
      return c.json({ error: failureMessage(error) }, 502);
    }
  })
  .openapi(postRestoreRoute, async (c) => {
    if (!isSyncEnabled()) {
      return c.json(disabled, 503);
    }
    const { force } = c.req.valid("query");
    try {
      const outcome = await withTarget((target) =>
        restoreFromReplica(target, { force: force === "true" }),
      );
      if (outcome.kind === "local-not-empty") {
        return c.json(
          {
            error: `Local database is not empty (${outcome.mangas} mangas, ${outcome.events} events, ${outcome.adapters} adapters). A plain sync merges both sides; retry with force=true only to replace this machine's data.`,
          },
          409,
        );
      }
      return c.json(
        {
          mangas: outcome.mangas,
          events: outcome.events,
          adapters: outcome.adapters,
          covers: outcome.covers,
          dismissals: outcome.dismissals,
        },
        200,
      );
    } catch (error) {
      return c.json({ error: failureMessage(error) }, 502);
    }
  });
