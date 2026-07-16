# manga-tracker-api

Local-first personal manga reading tracker — REST API in Bun + Hono 4 + Prisma 7 (SQLite via
the libSQL adapter). Consumed by a browser extension (MV3) and a same-origin static web
dashboard. Single instance by design: no cloud dependencies, no background scraping.

## Layout
- `src/index.ts` — entry point: builds the OpenAPIHono app, mounts modules, serves `/docs`
- `src/config.ts` — the only place that reads environment variables
- `src/db/client.ts` — PrismaClient wired to the libSQL adapter
- `src/modules/<feature>/` — one vertical slice: `*.routes.ts` + `*.service.ts` + `*.test.ts`
- `src/lib/` — pure shared utilities (slug normalization, chapter parsing) with colocated tests
- `src/generated/prisma/` — generated Prisma client (never edit; gitignored)
- `prisma/schema.prisma` — data model; migrations live in `prisma/migrations/`
- `PLAN.md` + `docs/GUIA-IMPLEMENTACION.md` — roadmap and module specs (events, library, adapters, duplicates)

## Commands
- Dev: `bun run dev` · Test: `bun test` · Single test: `bun test <file>`
- Lint: `bun run lint` · Format: `bun run format` · Typecheck: `bun run typecheck`
- Prisma client: `bun run db:generate` · Migrations: `bun run db:migrate`

> `typescript@7` is the native compiler (tsgo) — no `tsserver.js`; VS Code IntelliSense uses the
> "TypeScript (Native Preview)" ext via `js/ts.*` settings (see `.vscode/`), not `typescript.tsdk`.

## Rules
- Every route is defined with `createRoute` (zod-openapi) so it appears in `/openapi.json`
  and the `/docs` Swagger UI; Zod schemas are the source of truth for request/response types.
- Handlers in `*.routes.ts` only validate and map responses; business logic lives in the
  module's `*.service.ts`.
- Never edit `src/generated/**`; never commit `.env*` or `*.db` files.

## Architecture
- Reading progress is stored as append-only events; current state is derived by projection —
  event rows are never UPDATEd or DELETEd.
- One module = one vertical slice under `src/modules/<name>/` (routes + service + tests
  together).
- Dependency direction: `src/index.ts` → `src/modules/*` → `src/db` / `src/config` / `src/lib`;
  `db`, `config` and `lib` never import from `modules` (`lib` holds pure functions only).
- Only `src/config.ts` reads env vars; everything else receives values from it.

## Engineering standards
- Every feature ships with its tests. Run `bun run lint` + `bun run typecheck` + `bun test`
  before declaring work done; report real results.
- Handle errors explicitly at boundaries: route handlers translate failures into HTTP
  responses; services never swallow exceptions.
- No speculative abstractions: introduce a pattern only for a problem this repo has, and say
  which and why.
