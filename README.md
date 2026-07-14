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
| `bun run dev` | Start the dev server with hot reload on http://localhost:3000 |
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
- `prisma/` — schema and migrations

## API documentation

Interactive Swagger UI at [`/docs`](http://localhost:3000/docs); the OpenAPI 3.1 spec is
generated from the Zod route schemas and served at `/openapi.json`.
