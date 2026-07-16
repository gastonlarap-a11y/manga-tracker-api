# manga-tracker-api

Local-first personal manga reading tracker. A REST API built with Bun + Hono 4 + Prisma 7
(SQLite via the libSQL adapter), consumed by a browser extension (Manifest V3) that records
reading progress through content-script heuristics, and by a same-origin static web dashboard.
Everything runs locally: single instance, no cloud dependencies, no background scraping.
Reading progress is stored as append-only events (event sourcing); current state is derived by
projection.

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

## Project structure

- `src/index.ts` — entry point: OpenAPIHono app, module mounting, API docs
- `src/config.ts` — environment configuration (the only env reader)
- `src/db/` — Prisma client with the libSQL adapter
- `src/modules/<feature>/` — vertical slices: routes + service + tests per feature
- `src/lib/` — pure shared utilities (slug normalization, chapter parsing) with tests
- `prisma/` — schema and migrations
- `PLAN.md`, `docs/` — implementation roadmap and module specs
- `COMO-FUNCIONA.md` — in-depth walkthrough (es): every file explained, plus ops (Swagger, Postman, launchd, data locations)

## API documentation

Interactive Swagger UI at [`/docs`](http://127.0.0.1:5150/docs); the OpenAPI 3.1 spec is
generated from the Zod route schemas and served at `/openapi.json`.

## Deployment

Runs permanently on the local Mac as a launchd LaunchAgent
(`~/Library/LaunchAgents/com.mangatracker.plist`) executing `bun run src/index.ts` from this
repo — no build step. The production database lives in
`~/Library/Application Support/MangaTracker/`. Full procedure in `PLAN.md` (Fase 3); the
repeatable steps are captured in `.claude/skills/deploy/`.
