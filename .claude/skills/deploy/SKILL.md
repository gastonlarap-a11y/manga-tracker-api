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

## Dev vs prod port collision
`launchctl bootout gui/$(id -u)/com.mangatracker` frees port 5150 for `bun run dev`;
re-bootstrap the plist when done.
