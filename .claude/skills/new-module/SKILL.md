---
name: new-module
description: Scaffold a new vertical-slice module under src/modules/ following the health exemplar. Use when adding a feature module (events, library, adapters, duplicates).
argument-hint: "<module-name>"
---

# New module (vertical slice)

1. Check `docs/GUIA-IMPLEMENTACION.md` for this module's spec (routes, validation, behavior)
   before inventing shapes.
2. Create `src/modules/<name>/` with three files, mirroring `src/modules/health/`:
   - `<name>.routes.ts` — every route built with `createRoute` (zod-openapi); Zod schemas get
     `.openapi("<SchemaName>")`; handlers only validate and map responses; export a single
     `OpenAPIHono` instance as named export `<name>Routes`.
   - `<name>.service.ts` — business logic; imports `prisma` from `src/db/client` and pure
     helpers from `src/lib/`; throws on failure (routes translate errors into HTTP responses).
   - `<name>.test.ts` — bun:test (`describe`/`it`/`expect`), colocated, required.
3. Mount in `src/index.ts` under the `/api` prefix: `app.route("/api", <name>Routes)` —
   route paths inside the module are relative (e.g. `path: "/events"` → `/api/events`).
   Exception: `health` stays mounted at the root (`/health`).
4. Derive request/response types from the Zod schemas (`z.infer`) — never hand-written.
5. Reading progress is append-only: services insert `ReadingEvent` rows, never UPDATE or
   DELETE them.
6. Run `bun run lint` + `bun run typecheck` + `bun test` and report real results.
