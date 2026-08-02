---
name: deploy
description: Deploy the backend as a macOS LaunchAgent — prod DB migrations plus service restart. User-invoked only.
disable-model-invocation: true
---

# Deploy (macOS LaunchAgent)

Installed and validated 2026-07-16 (health probe + kill/auto-restart). The bun binary comes
from mise: `/Users/gaston/.local/share/mise/installs/bun/latest/bin/bun` — not Homebrew.

Production runs `bun run src/index.ts` from this repo via
`~/Library/LaunchAgents/com.mangatracker.plist` (RunAtLoad + KeepAlive), DB at
`~/Library/Application Support/MangaTracker/mangatracker.db`, port 5150, logs in
`~/Library/Logs/MangaTracker/`.

## First-time install (already done on this Mac; kept for reinstalls/migrations)
1. `mkdir -p ~/Library/Application\ Support/MangaTracker ~/Library/Logs/MangaTracker`
2. `DATABASE_URL="file:$HOME/Library/Application Support/MangaTracker/mangatracker.db" bunx --bun prisma migrate deploy`
3. Create the plist (full XML in `PLAN.md` Fase 3) and load it:
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mangatracker.plist`

## Publish a change
1. Pre-flight: `bun run lint` + `bun run typecheck` + `bun test` — all green before touching prod.
2. If there are new migrations:
   `DATABASE_URL="file:$HOME/Library/Application Support/MangaTracker/mangatracker.db" bunx --bun prisma migrate deploy`
3. Restart: `launchctl kickstart -k gui/$(id -u)/com.mangatracker`
4. Post-check: `curl -s http://127.0.0.1:5150/health` → `{"status":"ok"}`.

> Prod runs **the current checkout**, not `main`. After merging a PR, `git switch main`,
> `git pull`, then restart — otherwise prod keeps running whatever branch is checked out.

## Off-site replica (Azure DocumentDB)
The plist carries the replica config, and that is deliberate: it keeps `bun run dev` from
syncing to the production database. `MONGODB_URL` in `.env` would make dev — whose `dev.db` is
nearly empty — push deletions that wipe the real library off the cluster.

| Where | `MONGODB_DB` | Effect |
|---|---|---|
| plist `EnvironmentVariables` | `mangatracker` | Production replicates |
| `.env` | `mangatracker_dev` | Dev replicates somewhere harmless |

Plist env vars win over `.env`, so the same checkout serves both.

- The plist holds the cluster password in plaintext → keep it `chmod 600`.
- **Changing plist env vars needs a full reload**; `kickstart -k` restarts the process with the
  config already loaded and will silently ignore them:
  `launchctl bootout gui/$(id -u)/com.mangatracker && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mangatracker.plist`
- Check it took: `curl -s http://127.0.0.1:5150/api/sync/status`
- Inspect what the cluster actually holds: `bun run sync:inspect` (add a database name to look
  at another, e.g. `bun run sync:inspect mangatracker_dev`).

## Dev vs prod port collision
`launchctl bootout gui/$(id -u)/com.mangatracker` frees port 5150 for `bun run dev`;
re-bootstrap the plist when done.
