import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { defaultHook, errorSchema } from "../../lib/http";
import {
  getSyncStatus,
  isSyncEnabled,
  pushNow,
  withTarget,
} from "./sync.scheduler";
import { restoreFromReplica } from "./sync.service";

const countsSchema = z.object({ upserted: z.number(), deleted: z.number() });

const pushResultSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("pushed"),
      deletionsApplied: z
        .boolean()
        .describe("False when the push was additive-only"),
      mangas: countsSchema,
      events: z.object({ inserted: z.number(), deleted: z.number() }),
      adapters: countsSchema,
      covers: z
        .object({ uploaded: z.number(), deleted: z.number() })
        .nullable()
        .describe("Null when this push skipped the cover pass"),
    }),
    z.object({
      kind: z.literal("skipped"),
      reason: z
        .literal("local-empty")
        .describe(
          "The local database is empty, which never justifies emptying the replica",
        ),
    }),
  ])
  .openapi("SyncPushResult");

const syncStatusSchema = z
  .object({
    enabled: z.boolean().describe("False when MONGODB_URL is not configured"),
    connected: z.boolean(),
    lastPushAt: z.iso.datetime().nullable(),
    lastResult: pushResultSchema.nullable(),
    lastError: z
      .object({ message: z.string(), at: z.iso.datetime() })
      .nullable(),
  })
  .openapi("SyncStatus");

const restoreResultSchema = z
  .object({
    mangas: z.number(),
    events: z.number(),
    adapters: z.number(),
    covers: z.number(),
  })
  .openapi("SyncRestoreResult");

const disabled = { error: "Sync is disabled: MONGODB_URL is not set" } as const;

const getStatusRoute = createRoute({
  method: "get",
  path: "/sync/status",
  tags: ["sync"],
  description:
    "Local-only snapshot of the replication state; never touches the network.",
  responses: {
    200: {
      description: "Current replication state",
      content: { "application/json": { schema: syncStatusSchema } },
    },
  },
});

const postPushRoute = createRoute({
  method: "post",
  path: "/sync/push",
  tags: ["sync"],
  description:
    "Forces a reconciliation against the replica. Pass covers=true to also upload cover bytes.",
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
      description: "What the push moved",
      content: { "application/json": { schema: pushResultSchema } },
    },
    502: {
      description: "The replica could not be reached or refused the write",
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
    "Rebuilds SQLite from the replica. Refuses to run over a populated database unless force=true.",
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
      content: { "application/json": { schema: restoreResultSchema } },
    },
    409: {
      description:
        "The local database already holds data and force was not set",
      content: { "application/json": { schema: errorSchema } },
    },
    502: {
      description: "The replica could not be reached",
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
        lastPushAt: status.lastPushAt?.toISOString() ?? null,
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
  .openapi(postPushRoute, async (c) => {
    if (!isSyncEnabled()) {
      return c.json(disabled, 503);
    }
    const { covers } = c.req.valid("query");
    try {
      // An explicit push is an explicit statement about local state, so it is
      // the one trigger allowed to prune the replica on demand.
      return c.json(
        await pushNow({ covers: covers === "true", allowDeletions: true }),
        200,
      );
    } catch (error) {
      // The replica being unreachable is an expected state here, not a bug:
      // report it as an upstream failure instead of a 500.
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
            error: `Local database is not empty (${outcome.mangas} mangas, ${outcome.events} events, ${outcome.adapters} adapters). Retry with force=true to replace it.`,
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
        },
        200,
      );
    } catch (error) {
      return c.json({ error: failureMessage(error) }, 502);
    }
  });
