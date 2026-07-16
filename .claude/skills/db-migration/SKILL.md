---
name: db-migration
description: Create and apply a Prisma schema migration and regenerate the client. Use when changing the data model in prisma/schema.prisma.
---

# DB migration

1. Edit `prisma/schema.prisma` (the datasource URL comes from `prisma.config.ts` →
   `DATABASE_URL`; dev uses `.env`).
2. Dev: `bun run db:migrate` (asks for a migration name, applies to the dev DB, regenerates
   the client). Regenerate manually with `bun run db:generate` if needed.
3. Append-only rule: never write a migration that UPDATEs or DELETEs `ReadingEvent` rows.
4. Prod (LaunchAgent DB): migrations are applied only via the `deploy` skill
   (`prisma migrate deploy`), never with `migrate dev`.
5. Run `bun run typecheck` + `bun test`; never edit `src/generated/**` or already-applied
   migrations under `prisma/migrations/`.
