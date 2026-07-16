---
name: verify
description: Launch the API and verify a change end-to-end against the real server. Use before declaring work done.
---

# Verify

1. Preconditions: `.env` with `DATABASE_URL` (dev: `file:./dev.db`) and the generated Prisma
   client (`bun run db:generate` if `src/generated/prisma/` is missing).
2. Start: `bun run dev` (background) — serves on `http://127.0.0.1:5150`.
3. Probe health: `curl -s http://127.0.0.1:5150/health` → expect `{"status":"ok"}`.
4. Probe the changed surface: hit the affected `/api/...` route with a real payload, and
   confirm new routes appear in `curl -s http://127.0.0.1:5150/openapi.json` (Swagger UI
   at `/docs`).
5. Stop the dev process; report what was actually observed, not what should happen.
