# manga-tracker-api

Local-first personal manga reading tracker — REST API in Bun + Hono 4 + Prisma 7 (SQLite via
the libSQL adapter). Consumed by a browser extension (MV3) and a same-origin static web
dashboard. Single instance by design: no cloud dependencies, no background scraping.

## Layout
- `src/index.ts` — entry point: builds the OpenAPIHono app, mounts modules, serves `/docs`
- `src/config.ts` — the only place that reads environment variables
- `src/db/client.ts` — PrismaClient wired to the libSQL adapter
- `src/modules/<feature>/` — one vertical slice: `*.routes.ts` + `*.service.ts` + `*.test.ts`
  (plus extra colocated units when needed, e.g. `events/events.bus.ts`)
- `src/modules/sync/` — optional two-way sync with Azure DocumentDB (`sync.target.ts` is the ONLY
  file allowed to import `mongodb`; `sync.mapper.ts` is pure and driver-free)
- `scripts/` — operator tools run by hand: `sync:inspect` (what the shared store holds) and
  `sync:bootstrap` (thin alias of `env:pull --prod`)
- `deploy/` — deployment and configuration tooling, outside `src/` because it never ships with
  the app: `provision.ts` (Key Vault), `env-push.ts` / `env-pull.ts` (secrets), `deploy.ts` (the
  one-command publish), `bootstrap-windows.ts` (first-time install on a new Windows machine —
  provisions, registers the scheduled task, and builds the sibling dashboard/extension repos;
  `bun run setup:windows`), `lib/` (a `Runner`-injected wrapper per external tool: `az`, plus one
  machine-specific module per OS — `macos.ts` wraps `plutil`/`security`/`launchctl`, `windows.ts`
  wraps `icacls`/`powershell`/`schtasks` — selected at runtime by `platform.ts`, which the four
  top-level scripts and `secrets.ts` depend on instead of importing either directly), and
  `azure.json` — committed, non-secret, names the resource group and vault
- `src/lib/` — pure shared utilities (normalization, chapter parsing, title similarity,
  shared Zod schemas + error hook) with colocated tests
- `src/generated/prisma/` — generated Prisma client (never edit; gitignored)
- `prisma/schema.prisma` — data model; migrations live in `prisma/migrations/`
- `public/` — dashboard static build (gitignored), deployed from the sibling
  `manga-tracker-dashboard` repo (`bun run deploy` there); served by `src/index.ts` on
  `/` + `/manga/:id` + `/duplicates`
- `bunfig.toml` + `test-setup.ts` — bun test preload: throwaway per-run SQLite DB (migrations via `bun:sqlite`)
- `PLAN.md` + `docs/GUIA-IMPLEMENTACION.md` — roadmap and module specs (events, library, adapters, duplicates)

## Commands
- Dev: `bun run dev` · Test: `bun test` · Single test: `bun test <file>`
- Lint: `bun run lint` · Format: `bun run format` · Typecheck: `bun run typecheck`
- Prisma client: `bun run db:generate` · Migrations: `bun run db:migrate`
- Deploy: `bun run deploy` (add `--dry-run` to see the steps without touching production)
- Azure: `bun run deploy:provision` (create the vault) · `bun run env:push` / `bun run env:pull`
- Inspect config: `bun run env:show` (every profile + drift on disk; read-only, no network)

> `typescript@7` is the native compiler (tsgo) — no `tsserver.js`; VS Code IntelliSense uses the
> "TypeScript (Native Preview)" ext via `js/ts.*` settings (see `.vscode/`), not `typescript.tsdk`.

## Rules
- Every route is defined with `createRoute` (zod-openapi) so it appears in `/openapi.json`
  and the `/docs` Swagger UI; Zod schemas are the source of truth for request/response types.
- Handlers in `*.routes.ts` only validate and map responses; business logic lives in the
  module's `*.service.ts`.
- Never edit `src/generated/**`; never commit `.env*` or `*.db` files.
- `.gitattributes` pins the working tree to LF on every platform. Biome's formatter enforces
  LF, so a CRLF checkout on Windows (`core.autocrlf=true`) fails `bun run lint` on every file
  in the repo — it reports 67 errors that are not lint errors at all. Never relax the rule to
  `crlf`: that would fail the same way on macOS and in CI.
- `mongodb` is pinned to `^6`: the 7.x line ships `bson@7`, which calls `node:v8`
  `isBuildingSnapshot` at import time and crashes under Bun. Do not bump it without re-running
  the connectivity check.
- Sync must never break a local write: failures are logged and surfaced through
  `GET /api/sync/status`, never propagated into a request handler.
- A new environment variable is declared in `deploy/lib/env.ts` (`ENV_MANIFEST`) as `secret`,
  `profile` or `machine`, and read in `src/config.ts`. Nothing else needs to change: push, pull
  and deploy all derive their behaviour from that classification. There is deliberately no
  per-environment file tree: Bun only auto-loads `.env`, `.env.<NODE_ENV>` and `.env.local` from
  the cwd, and `.gitignore` covers `.env*` but would not cover a nested `env/` directory.
- The Windows scheduled task is `LogonType=S4U` **plus an `icacls` grant afterwards**, and both
  halves matter. `InteractiveToken` runs it in the user's session, where the `cmd.exe` wrapper
  opens a visible console window — closing it kills the backend (`LastTaskResult 0xC000013A` +
  a trailing `^C` in err.log). S4U runs in session 0, with no console at all. But S4U needs
  elevation to register, and the task is then owned by `Administrators` with the user on
  read-only, locking that user out of the `/Run` and `/End` in `reloadService`. The grant must go
  through `icacls` on the task's file in `System32\Tasks`: `schtasks /Create /XML` **silently
  ignores** the `<SecurityDescriptor>` element the schema defines (verified — the registered task
  came back with an inherited `D:AI(...)` DACL). Consequence: `bun run setup:windows` needs an
  elevated terminal once; nothing else does.
- `MONGODB_URL` is stored in direct form (`mongodb://host:10260/?tls=true&…`), never
  `mongodb+srv://`. Bun on Windows does not read the system DNS servers — `dns.getServers()`
  returns `["127.0.0.1"]` — so every SRV lookup fails with `querySrv ECONNREFUSED` and sync never
  connects, while the OS resolver answers fine. The direct form skips the SRV lookup entirely;
  `tls=true` is spelled out because only `mongodb+srv` implies it.
- Reloading launchd is bootout → **wait until the job is gone** → bootstrap. `bootout` returns
  before the teardown finishes, and bootstrapping into a domain that still holds the dying job
  fails with `Bootstrap failed: 5: Input/output error` and leaves production down.
- `deploy/` talks to the outside world only through the `Runner` in `deploy/lib/run.ts`, so
  command construction stays testable without an Azure subscription. Secrets go to `az` through
  a 0600 temp file, never `--value`, which `ps` would expose.
- `test-setup.ts` deletes `MONGODB_URL` before anything imports `config.ts`. The suite must be
  hermetic by construction, not because a developer's `.env` happens to lack the credential —
  a `POST /sync/now` from a test run is a real write into the shared store, and events there
  can never be removed.

## Architecture
- Reading progress is stored as append-only events; current state is derived by projection —
  event rows are never UPDATEd or DELETEd. The only report that does not append: a chapter
  already present in the manga's history (re-reads/reloads) returns its existing event.
- One module = one vertical slice under `src/modules/<name>/` (routes + service + tests
  together).
- Dependency direction: `src/index.ts` → `src/modules/*` → `src/db` / `src/config` / `src/lib`;
  `db`, `config` and `lib` never import from `modules` (`lib` holds pure functions only).
  Modules never import each other's services/routes; the one sanctioned cross-module edge is
  the in-process event bus (`events/events.bus.ts`), imported to publish SSE change
  notifications.
- Only `src/config.ts` reads env vars; everything else receives values from it
  (`DATABASE_URL`, `PORT`, and the optional `MONGODB_URL` / `MONGODB_DB`).
- Azure DocumentDB is a **shared store several machines converge on**, never a read path: SQLite
  answers every request, and a sync only runs on the scheduler's triggers. Never make a request
  handler read from it — that would make the library depend on connectivity.
- Convergence rules, and why they are not negotiable:
  - `ReadingEvent` is a set union by uuid. **Nothing is ever removed for being absent on one
    side** — the target has no delete method at all. Inferring deletion from absence is what let
    a stale machine wipe a peer's history.
  - `Manga` and `SiteAdapter` merge last-write-wins on `updatedAt`, which every writer sets by
    hand. Never switch those fields to `@updatedAt`: it overwrites the value on write, so
    applying a peer's document would restamp it and the two machines would trade it forever.
  - Deletion is `Manga.deletedAt`, a value that converges like any other field. Queries that
    show mangas must filter it.
  - Documents are keyed by natural keys (`normalizedSlug`, `domain`), not by the local uuid, so
    two machines that discover the same title separately merge instead of colliding on the
    unique slug index.
- Known limitation: last-write-wins compares wall clocks across machines. Safe for one person on
  NTP-synced Macs who is not editing the same manga in two places at once.

## Engineering standards
- Every feature ships with its tests. Run `bun run lint` + `bun run typecheck` + `bun test`
  before declaring work done; report real results.
- The suite must pass on macOS, Windows and Linux (CI) — `bun run deploy` gates on it on every
  machine. A test never inherits the host: anything reading `process.platform` or
  `process.getuid` takes it as a parameter (see `PlatformAdapter.os` and `ReloadOptions.uid`)
  so the test pins it, exactly like `Runner` pins the commands.
- Handle errors explicitly at boundaries: route handlers translate failures into HTTP
  responses; services never swallow exceptions.
- No speculative abstractions: introduce a pattern only for a problem this repo has, and say
  which and why.
