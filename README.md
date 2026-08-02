# manga-tracker-api

Local-first personal manga reading tracker. A REST API built with Bun + Hono 4 + Prisma 7
(SQLite via the libSQL adapter), consumed by a browser extension (Manifest V3) that records
reading progress through content-script heuristics, and by a same-origin static web dashboard.
Everything runs locally: single instance, no background scraping, and SQLite is the only source
of truth for reads and writes. Reading progress is stored as append-only events (event sourcing);
current state is derived by projection. An optional push-only replica mirrors the database to
Azure DocumentDB for off-site durability — it never sits in the request path, so the tracker
behaves identically with no network.

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
| `PORT` | no (5150) | Port the API listens on, always bound to `127.0.0.1` |
| `MONGODB_URL` | no | Azure DocumentDB connection string. **Unset means the replica is off** and the app behaves exactly as it did before it existed |
| `MONGODB_DB` | no (`mangatracker`) | Database name inside the cluster |

Production and development share this checkout, so they are kept apart by database name: the
LaunchAgent plist sets `MONGODB_DB=mangatracker` and `.env` sets `MONGODB_DB=mangatracker_dev`
(plist variables win over `.env`). Without that split, a change in dev — whose `dev.db` is nearly
empty — would push deletions that wipe the real library off the cluster.

`.env` is gitignored (and so is `.env.*`, which is why there is no `.env.example`). Never commit
the connection string: it carries the cluster password.

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
| `bun run sync:inspect` | Show what the off-site replica holds (counts, indexes, cover bytes, a sample document) |

## Project structure

- `src/index.ts` — entry point: OpenAPIHono app, module mounting, API docs
- `src/config.ts` — environment configuration (the only env reader)
- `src/db/` — Prisma client with the libSQL adapter
- `src/modules/<feature>/` — vertical slices: routes + service + tests per feature
  (`sync/` holds the off-site replica; it is the only place that imports the `mongodb` driver)
- `src/lib/` — pure shared utilities (slug normalization, chapter parsing, title
  similarity, shared Zod schemas) with tests
- `prisma/` — schema and migrations
- `public/` — static build of the web dashboard (gitignored; deployed from the sibling
  `manga-tracker-dashboard` repo), served by the API on `/`, `/manga/:id` and `/duplicates`
- `PLAN.md`, `docs/` — implementation roadmap and module specs
- `COMO-FUNCIONA.md` — in-depth walkthrough (es): every file explained, plus ops (Swagger, Postman, launchd, data locations)

## API documentation

Interactive Swagger UI at [`/docs`](http://127.0.0.1:5150/docs); the OpenAPI 3.1 spec is
generated from the Zod route schemas and served at `/openapi.json`.

## Off-site replica (Azure DocumentDB)

Optional and push-only: SQLite stays the source of truth for every read and write, and the
replica exists so the library survives losing the machine. It never answers a request, so
latency and offline behaviour are unchanged.

| Endpoint | What it does |
|---|---|
| `GET /api/sync/status` | Replication state (local-only, never touches the network) |
| `POST /api/sync/push?covers=true` | Forces a reconciliation; `covers=true` also uploads cover bytes |
| `POST /api/sync/restore?force=true` | Rebuilds SQLite from the replica; refuses over a populated database unless forced |

To look at the replica itself rather than the replication state, run `bun run sync:inspect`.

A push is a full reconciliation by key difference, not a delta feed: it needs no watermark table
and no `updatedAt` column, and a push that failed while offline is repaired by the next one.
Metadata is pushed 5 s after any library change; cover bytes ride a separate pass every 6 h,
because they are slow (~790 ms per MB against the cluster) and would otherwise sit in the hot
path of recording a chapter. That periodic traffic also keeps a free-tier cluster from being
paused for inactivity at 60 days.

**Restoring on a new Mac:** install, set both env vars, start the API, then
`curl -X POST http://127.0.0.1:5150/api/sync/restore`. Do this *before* recording anything —
the boot push is deliberately additive-only and an empty database refuses to push at all, so the
replica cannot be destroyed by starting fresh, but a restore is what actually brings the library
back.

> The free tier has **no backup/restore and no HA** of its own, and pauses after 60 days of
> inactivity. It is off-site durability, not a second copy of a copy: keep Time Machine on the
> local `.db` as well.

## Deployment

Runs permanently on the local Mac as a launchd LaunchAgent
(`~/Library/LaunchAgents/com.mangatracker.plist`) executing `bun run src/index.ts` from this
repo — no build step. The production database lives in
`~/Library/Application Support/MangaTracker/`. Full procedure in `PLAN.md` (Fase 3); the
repeatable steps are captured in `.claude/skills/deploy/`.
