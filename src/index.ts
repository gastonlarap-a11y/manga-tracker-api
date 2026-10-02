import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { config } from "./config";
import { refreshProjection } from "./db/library-projection";
import { applyMigrations } from "./db/migrate";
import { allowedOrigins } from "./lib/cors";
import { errorHandler } from "./lib/http";
import { localRequestGuards } from "./lib/local-guard";
import { adaptersRoutes } from "./modules/adapters/adapters.routes";
import { duplicatesRoutes } from "./modules/duplicates/duplicates.routes";
import {
  embeddingRoutes,
  frameAncestors,
} from "./modules/embedding/embedding.routes";
import { eventsRoutes } from "./modules/events/events.routes";
import { extensionRoutes } from "./modules/extension/extension.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { libraryRoutes } from "./modules/library/library.routes";
import { siteRulesRoutes } from "./modules/site-rules/site-rules.routes";
import { syncRoutes } from "./modules/sync/sync.routes";
import { startSyncScheduler } from "./modules/sync/sync.scheduler";

// Before anything opens a connection: a server that answers /health and then
// fails on the first query is worse than one that refuses to start. Idempotent,
// so the usual case (already up to date) is a read and nothing else.
const migration = applyMigrations(config.databaseUrl, config.migrationsDir);
if (migration.applied.length > 0) {
  console.info(
    `[db] applied ${migration.applied.length} migration(s): ${migration.applied.join(", ")}`,
  );
}

const app = new OpenAPIHono();

const origins = { port: config.port, extensionIds: config.extensionIds };

// Before CORS, because CORS only governs what a page may read: a request a
// page fires without needing the answer has to be refused here. See
// src/lib/local-guard.ts.
app.use("*", ...localRequestGuards(origins));

// Loopback on the port this process actually listens on, plus every configured
// extension id — see src/lib/cors.ts for why neither can be a literal.
app.use("*", cors({ origin: [...allowedOrigins(origins)] }));

app.onError(errorHandler);

app.route("/", healthRoutes);
app.route("/api", eventsRoutes);
app.route("/api", libraryRoutes);
app.route("/api", adaptersRoutes);
app.route("/api", siteRulesRoutes);
app.route("/api", extensionRoutes);
app.route("/api", duplicatesRoutes);
app.route("/api", syncRoutes);

// Off-site replica (Azure DocumentDB). Inert unless MONGODB_URL is set, and it
// never sits in the request path: SQLite remains the source of truth.
startSyncScheduler();

// The library's read model, brought current now rather than by the first
// dashboard request — after an update that added a migration, that is a
// whole rebuild, and the window should not be the one waiting on it.
const projectionStart = performance.now();
refreshProjection().then(
  () =>
    console.info(
      `[library] projection ready in ${Math.round(performance.now() - projectionStart)} ms`,
    ),
  (cause: unknown) =>
    // Not fatal: every read refreshes it again, and says so if it still fails.
    console.error("[library] projection refresh failed at startup:", cause),
);

// Dashboard: static build of manga-tracker-dashboard, copied into ./public by
// its `bun run deploy`. Only the known SPA routes fall back to index.html, so
// /api, /docs and /openapi.json keep returning real 404s. Until a build is
// deployed these paths just 404.
app.use("/assets/*", serveStatic({ root: "./public" }));
app.get("/favicon.svg", serveStatic({ path: "./public/favicon.svg" }));
// The dashboard pages carry the frame-ancestors policy: enforced on the
// platforms it was measured on, Report-Only elsewhere. src/modules/embedding
// says why, and where the reports land.
const dashboardFramePolicy = frameAncestors();
for (const spaPath of ["/", "/manga/:id", "/duplicates", "/extension"]) {
  app.get(
    spaPath,
    dashboardFramePolicy,
    serveStatic({ path: "./public/index.html" }),
  );
}
app.route("/", embeddingRoutes());

app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "manga-tracker-api",
    version: "0.1.0",
  },
});
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

export default {
  port: config.port,
  hostname: "127.0.0.1",
  // Bun closes idle connections after 10s BY DEFAULT, even mid-stream — that
  // killed the SSE feed between heartbeats. 120s + a 25s heartbeat keeps the
  // stream alive with a wide margin.
  idleTimeout: 120,
  fetch: app.fetch,
};
