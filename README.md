# manga-tracker-api

Local-first personal manga reading tracker. A REST API built with Bun + Hono 4 + Prisma 7
(SQLite via the libSQL adapter), consumed by a browser extension (Manifest V3) that records
reading progress through content-script heuristics, and by a same-origin static web dashboard.
Everything runs locally: single instance, no background scraping, and SQLite is the only source
of truth for reads and writes. Reading progress is stored as append-only events (event sourcing);
current state is derived by projection. An optional two-way sync with Azure DocumentDB gives
off-site durability and lets several machines share one library — it never sits in the request
path, so the tracker behaves identically with no network.

## Prerequisites

- [Bun](https://bun.sh) 1.3+

## Setup

```sh
bun install

# Environment: create .env with the SQLite file location
echo 'DATABASE_URL="file:./dev.db"' > .env

# Generate the Prisma client and apply migrations
bun run db:generate
bun run db:migrate
```

### Environment variables

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | yes | SQLite file location — the source of truth |
| `PORT` | no (5150) | Port the API listens on, always bound to `127.0.0.1`. The CORS allowlist follows it, so a different port needs no other change. `0` is rejected: nothing could then find the server |
| `EXTENSION_IDS` | no (the unpacked id) | Comma-separated Chrome extension ids allowed through CORS. Several at once, so a Web Store build and a locally loaded one can both talk to the backend. A malformed id fails startup instead of being skipped |
| `MONGODB_URL` | no | Azure DocumentDB connection string, in direct `mongodb://host:10260/?tls=true&…` form — **not** `mongodb+srv://` (Bun on Windows returns `["127.0.0.1"]` from `dns.getServers()`, so every SRV lookup fails). **Unset means the replica is off** and the app behaves exactly as it did before it existed |
| `MONGODB_DB` | no (`mangatracker`) | Database name inside the cluster |

Production and development share this checkout, so they are kept apart by database name: the
LaunchAgent plist sets `MONGODB_DB=mangatracker` and `.env` sets `MONGODB_DB=mangatracker_dev`
(plist variables win over `.env`).

The split matters because everything dev does would otherwise converge into the real library, and
two of those effects have no undo:

- **Events are a set union that never removes anything** — the target has no delete method for
  them at all. Any event a test produces stays in your history, on every machine, forever.
- **`deletedAt` converges like any other field**, so exercising a delete in dev deletes the manga
  in production too.
- Mangas merge last-write-wins on `updatedAt`, so a dev edit overwrites the real one.

`.env` is gitignored (and so is `.env.*`, which is why there is no `.env.example`). Never commit
the connection string: it carries the cluster password.

You do not write these by hand. `bun run env:pull` composes them from
[`deploy/lib/env.ts`](deploy/lib/env.ts), which declares what each variable is: `MONGODB_URL` is a
shared secret that lives in Key Vault, `DATABASE_URL` is a path only valid on this machine, and the
other two are derived from the profile. Adding a variable means adding an entry there.

## Commands

| Command | What it does |
|---|---|
| `bun run dev` | Start the dev server with hot reload on http://127.0.0.1:5150 |
| `bun test` | Run the test suite (Bun's built-in runner) |
| `bun run lint` | Lint and check formatting with Biome |
| `bun run format` | Fix lint issues and format with Biome |
| `bun run typecheck` | Type-check with `tsc --noEmit` |
| `bun run db:generate` | Generate the Prisma client into `src/generated/prisma/` |
| `bun run db:migrate` | Create/apply development migrations (`prisma migrate dev`) |
| `bun run sync:inspect` | Show what the shared store holds (counts, indexes, cover bytes, a sample document) |
| `bun run sync:bootstrap` | Recover the sync credential on a new machine (alias of `env:pull --prod`) |

### Deployment and configuration

| Command | What it does |
|---|---|
| `bun run deploy` | Publish this checkout: checks → prod migrations → LaunchAgent reload → health probe |
| `bun run deploy --dry-run` | Report every step without changing anything |
| `bun run deploy:provision` | Create the Azure Key Vault and grant yourself access (idempotent) |
| `bun run env:push` | Upload the shared secrets to Key Vault |
| `bun run env:pull` | Write `.env` for development, resolving secrets from Key Vault |
| `bun run env:pull --prod` | Same, into the LaunchAgent plist |
| `bun run env:show` | Print every profile and whether the files on disk match. Read-only, no network |

Useful flags: `deploy --with-env` refreshes the plist first, `deploy --skip-checks` skips
lint/typecheck/tests, and every command takes `--vault <name>` to target a different vault.

## Project structure

- `src/index.ts` — entry point: OpenAPIHono app, module mounting, API docs
- `src/config.ts` — environment configuration (the only env reader)
- `src/db/` — Prisma client with the libSQL adapter
- `src/modules/<feature>/` — vertical slices: routes + service + tests per feature
  (`sync/` holds the off-site replica; it is the only place that imports the `mongodb` driver)
- `src/lib/` — pure shared utilities (slug normalization, chapter parsing, title
  similarity, shared Zod schemas) with tests
- `prisma/` — schema and migrations
- `scripts/` — operator tools run by hand (`sync:inspect`, `sync:bootstrap`)
- `deploy/` — deployment and configuration tooling: `provision.ts` (Key Vault), `env-push.ts` /
  `env-pull.ts` (secrets), `deploy.ts` (the one-command publish), and `azure.json`, the committed
  non-secret pointer to the resource group and vault
- `public/` — static build of the web dashboard (gitignored; deployed from the sibling
  `manga-tracker-dashboard` repo), served by the API on `/`, `/manga/:id` and `/duplicates`
- `PLAN.md`, `docs/` — implementation roadmap and module specs
- `COMO-FUNCIONA.md` — in-depth walkthrough (es): every file explained, plus ops (Swagger, Postman, launchd, data locations)

## API documentation

Interactive Swagger UI at [`/docs`](http://127.0.0.1:5150/docs); the OpenAPI 3.1 spec is
generated from the Zod route schemas and served at `/openapi.json`.

## Off-site sync (Azure DocumentDB)

Optional. SQLite still answers every read and write — the cluster never sits in a request path —
but it is no longer the only writer: several machines converge on one shared store, so switching
laptops needs no action at all.

| Endpoint | What it does |
|---|---|
| `GET /api/sync/status` | Sync state (local-only, never touches the network) |
| `POST /api/sync/now?covers=true` | Pulls, merges and pushes right now; `covers=true` also moves cover bytes |
| `POST /api/sync/restore?force=true` | Throws the local database away and rebuilds it. Not needed to switch machines — a plain sync merges both sides |

To look at the shared store itself rather than the sync state, run `bun run sync:inspect`.

### How it converges

- **Reading events** are append-only with immutable uuids, so merging is a set union. **Nothing
  is ever removed for being absent on one side.** That inference is what previously let a stale
  machine wipe another one's history.
- **Mangas and adapters** are mutable, so the newer `updatedAt` wins.
- **Deleting** a manga sets `deletedAt` instead of dropping the row, so the deletion travels as a
  fact and converges under the same rule. Reading the series again brings it back with its
  history.
- Documents are keyed by `normalizedSlug`, not by the local uuid, so two machines that discover
  the same title separately merge instead of colliding.

Syncs run 5 s after any library change, at boot, and every 6 h. Cover bytes ride the 6 h pass
because they are slow (~790 ms per MB against the cluster) and would otherwise sit in the path of
recording a chapter. That periodic traffic also keeps a free-tier cluster from being paused for
inactivity at 60 days.

### Using a second machine

Clone, `az login`, `bun install`, then:

```bash
bun run env:pull --prod   # recovers the credential and writes the plist
bun run deploy            # migrations, LaunchAgent, health check
```

The first sync pulls the whole library. From then on, just open the app on whichever machine you
are using — what you read on the other one is already there.

Last-write-wins compares wall clocks, so this assumes one person on NTP-synced machines who is
not editing the same manga in two places at once.

### Credential recovery

The connection string lives in the LaunchAgent plist (`chmod 600`), cached in the macOS Keychain,
and stored in Azure Key Vault as `mangatracker-mongodb-url` inside the vault named in
[`deploy/azure.json`](deploy/azure.json). `bun run env:pull` resolves it in that order —
cheapest first, network last — so a formatted machine only needs `az login`. `bun run env:push`
sends it the other way. Key Vault has no per-secret fee and charges ~$0.03 per 10,000 operations,
which at this usage rounds to nothing.

Key Vault is the root of trust precisely because your Azure account unlocks it — storing a
service-principal secret on disk to fetch a database secret from disk would solve nothing. That
is also why `deploy/azure.json` is committed: it holds no secret, and a machine that just cloned
the repo has to know which vault to ask before it can get anything else.

`bun run deploy:provision` creates the vault. It is idempotent, and it handles the two things
that make a first run fail: registering the `Microsoft.KeyVault` provider on a subscription that
has never used one, and granting yourself **Key Vault Secrets Officer** — because creating a
vault gives you no access to its secrets, so without it the next write returns 403.

> The free tier has **no backup/restore and no HA** of its own, and pauses after 60 days of
> inactivity. It is off-site durability, not a second copy of a copy: keep Time Machine on the
> local `.db` as well.

## Deployment

Runs permanently on the local Mac as a launchd LaunchAgent
(`~/Library/LaunchAgents/com.mangatracker.plist`) executing `bun run src/index.ts` from this
repo — no build step. The production database lives in
`~/Library/Application Support/MangaTracker/`.

```bash
bun run deploy
```

That runs lint, typecheck and the test suite, applies pending migrations to the production
database, reloads the LaunchAgent and waits for `/health` to answer. It stops before restarting
anything if a check or a migration fails, so a bad change never reaches a running service.

Two details it exists to get right:

- **Production runs this working copy, not `main`.** launchd points at the repo directory, so
  whatever is checked out is what serves. The deploy warns when the branch is not `main` or the
  tree is dirty, but it does not stop you.
- **The reload is a full `bootout` + `bootstrap`.** `launchctl kickstart -k` restarts the process
  against the configuration launchd already has in memory, so a changed credential would be
  silently ignored and you would debug a deploy that "worked" against the old value.

First-time install on a new machine is in `PLAN.md` (Fase 3); the manual fallback for every step
is in `.claude/skills/deploy/`.
