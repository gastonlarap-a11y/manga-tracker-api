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
- `scripts/` — operator tools run by hand: `sync:inspect` (what the shared store holds),
  `sync:bootstrap` (thin alias of `env:pull --prod`) and `package.ts` (builds the shippable
  tree; the smoke test and the desktop app's release both call it, so the thing CI proves and
  the thing people download are built by the same code)
- `deploy/` — deployment and configuration tooling, outside `src/` because it never ships with
  the app: `provision.ts` (Key Vault), `env-push.ts` / `env-pull.ts` (secrets), `deploy.ts` (the
  one-command publish), `service-cli.ts` (service control as a process — bundled as
  `service.js`, because the Go desktop app installs the backend by spawning it and reading one
  JSON object) and `launcher.ts` (bundled as `launch.js`, what the installed service actually
  starts: it reads the sync credential from the system keystore and serves `index.js` in the
  same process, so the credential never lands in a file) — the two pieces of `deploy/` that DO
  ship,
  `bootstrap-windows.ts` (first-time install on a new Windows machine —
  provisions, registers the scheduled task, and builds the sibling dashboard/extension repos;
  `bun run setup:windows`), `lib/` (a `Runner`-injected wrapper per external tool: `az`, plus one
  machine-specific module per OS — `macos.ts` wraps `plutil`/`security`/`launchctl`, `windows.ts`
  wraps `icacls`/`powershell`/`schtasks` — selected at runtime by `platform.ts`, which the four
  top-level scripts and `secrets.ts` depend on instead of importing either directly), and
  `azure.json` — committed, non-secret, names the resource group and vault
- `src/lib/` — pure shared utilities (normalization, chapter parsing, series keys, title
  similarity, merge-group resolution, CORS allowlist, port parsing, shared Zod schemas + error
  hook) with colocated tests
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
- Package: `bun run package -- --out <dir> [--dashboard <dist>]`
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
  and deploy all derive their behaviour from that classification.
  - The one exception is `MIGRATIONS_DIR`, which is deliberately **not** in the manifest: it is
    not a secret, has no dev/prod value and is not derived per machine. A checkout must leave it
    unset (the default next to the source is correct); only the packaged app sets it, because
    there the server is a single bundled file with no `src/` tree above it to walk up from. There is deliberately no
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
- Nothing in `src/` may import from `deploy/`; the reverse is allowed **only for pure constants
  and parsers in `src/lib/`** that describe a value both sides handle — today `parsePort` and
  `UNPACKED_EXTENSION_ID`. The manifest declares a default that `src/config.ts` also falls back
  to, and a second copy of that value drifts exactly once: the day the extension goes silent for
  no visible reason. Anything with a side effect stays on its own side of the line.
- The port and the allowed extension ids are configuration, never literals. `PORT` is chosen by
  whoever installs (the CORS allowlist follows it, and `deploy/` reads it from the manifest);
  `EXTENSION_IDS` holds several ids at once because the Web Store assigns one on publication and
  the unpacked build has to keep working until every machine has updated. Port `0` is rejected on
  purpose: it would make the OS pick, and nothing that has to reach this server afterwards — the
  extension, the desktop app, the health probe — could learn which port it got.
- `GET /health` answers `{status, service}`. The `service` string is a contract, not decoration:
  a client that discovers the backend by probing loopback ports uses it to tell this process from
  anything else answering 200 on the same machine.
- **The shippable package must carry the dashboard build.** `src/index.ts` serves `/` from
  `./public`, so a package without it answers 404 on the very page the desktop app's window
  loads — while `/health` and `/api/*` keep passing, which is exactly how it went unnoticed.
  `scripts/package.ts --dashboard <dist>` puts it there and the smoke test now asserts `/`
  returns the dashboard and that its assets resolve.
- `deploy/service-cli.ts` and `deploy/launcher.ts` are the two parts of `deploy/` that ship.
  Their adapter is a parameter rather than `process.platform`, so the suite exercises both
  platforms from either — and so no test can overwrite the LaunchAgent of whoever runs it.
- **The service starts `launch.js`, not `index.js`.** The launcher reads the sync credential out
  of the system keystore and puts it in the server's environment in memory, so the service's own
  configuration never holds it. It serves in the same process — `Bun.serve(indexModule.default)`
  — because Bun starts a server from an *entrypoint's* default export and only an entrypoint's;
  a module reached through `import()` is just a module. One process, and the PID the service
  manager watches is the one serving.
  - **`MONGODB_URL` in the configuration is a three-valued thing**: empty (off), `keystore` (on,
    value in the keystore), or a real URL (older installs, and the fallback below). A sentinel
    rather than "empty means look in the keystore", because `clear-sync` blanks the
    configuration and **deliberately leaves the keystore alone** — so that rule would turn sync
    back on by itself at the next login, minutes after someone switched it off.
  - **Whether a service can read its own keystore at startup is not knowable in advance.** A
    Windows task running as S4U has no password behind it, and user-scope DPAPI derives its key
    from one. So the app tries the keystore, watches whether sync comes up, and calls
    `pin-config-secret` if it did not — back to plaintext in a file locked to the account, which
    is what every install did until now. A sync that does not run is worse.
  - `repair` re-registers the service definition, preserving the port and the sync settings.
    `restart` only reloads what is already registered, so without this a machine installed
    before the launcher existed would start `index.js` forever. `Prepare` calls it after an
    update; that is the whole migration.
  - `src/` knows nothing about any of this. `config.ts` goes on reading `Bun.env.MONGODB_URL`,
    and no platform code crosses into the server.
- **`set-sync` reads the connection string from stdin, and there is no flag that will take it.**
  Same rule as `az` above: an argument is readable by every process on the machine through `ps`
  for as long as the command runs, and what the desktop app forwards here is a cluster password.
  The flag was removed rather than deprecated — a channel that still works is a channel someone
  uses. `StdinReader` is a parameter for the same reason `Runner` is: a test that had to write
  to a real stdin would be exercising Bun.
- `test-setup.ts` deletes `MONGODB_URL` before anything imports `config.ts`. The suite must be
  hermetic by construction, not because a developer's `.env` happens to lack the credential —
  a `POST /sync/now` from a test run is a real write into the shared store, and events there
  can never be removed.

## Architecture
- Reading progress is stored as append-only events; current state is derived by projection —
  event rows are never UPDATEd or DELETEd. The only report that does not append: a chapter
  already present in the manga's history (re-reads/reloads) returns its existing event.
- **A card is a GROUP of mangas, not a row.** One series read on two sites under two different
  titles produces two `Manga` rows; merging them sets `mergedIntoSlug` on the absorbed one,
  which turns it into an *alias*: it stops projecting a card of its own and its events are read
  as part of the canonical's history. **No `ReadingEvent` is ever moved** — that is what makes
  merging compatible with the append-only rule, and what makes unmerge a lossless undo.
  - Anything that reads or writes a card goes through the group: `resolveMangaGroups`
    (`src/lib/manga-groups.ts`, pure) is the single implementation, shared by library, events
    and duplicates. It tolerates a pointer to a slug this machine has not synced yet (treated as
    canonical) and a cycle (both treated as canonical) — a request can never hang on it.
  - Chapters are deduplicated across the group with `chapterKey` (`src/lib/normalize.ts`), the
    same identity the ingestion uses, so a chapter read on both sites is listed once and
    `readCount` counts chapters, not rows.
  - Merge chains are flattened on write: `A→B→C` is never persisted.
- Duplicate detection is `titleSimilarity` (`src/lib/similarity.ts`): fuzzy token pairing
  weighted by word length, with whole-string edit distance as a floor. Plain Levenshtein over
  slugs was not enough — two sites translating one Japanese title differently score 0.79 as
  whole strings and 0.96 by tokens. Leftover words that name a season or a spin-off raise
  `sequelSuspicion`, which blocks automatic merging (never the suggestion).
  - `AUTO_MERGE_SCORE` (0.92) is what the ingestion merges without asking; `SUGGEST_SCORE`
    (0.75) is what `/duplicates` lists. Both live in `lib` because the ingestion needs them and
    modules never import each other.
  - `DuplicateDismissal` is the mandatory counterpart of the lower suggestion threshold: without
    a way to reject a pair, a false positive returns on every load.
  - There is deliberately **no external catalogue lookup** (MangaDex/AniList) for multi-language
    aliases: it would trade `no cloud dependencies` for a guess. Titles no local heuristic can
    relate are joined by hand from the dashboard (`POST /api/duplicates/merge` accepts any pair).
- Within one site, `ReadingEvent.seriesKey` (host + path of the series page, derived by the
  server from the extension's `seriesUrl`) outranks the title: a site that reformats its
  `<title>` cannot split a series it already tracks into a second manga.
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
  - `Manga.mergedIntoSlug` converges last-write-wins like every other field, and is stored as a
    **slug** for the same reason documents are: a local uuid means nothing to a peer. A pointer
    to a slug that has not arrived yet is kept as written and resolves on the next pass — never
    cleared, or the two machines would strip each other's merge forever.
  - `DuplicateDismissal` is a set union keyed by the ordered slug pair, exactly like
    `ReadingEvent`: nothing is ever removed for being absent on one side.
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
