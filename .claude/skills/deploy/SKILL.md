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

## Publish a change

```bash
bun run deploy
```

Runs lint + typecheck + tests, applies pending migrations to the production database, does a
full LaunchAgent reload and waits for `/health`. It aborts before restarting anything if a check
or a migration fails, so the running service is never left in a half-deployed state.

| Flag | Effect |
|---|---|
| `--dry-run` | Print every step, change nothing |
| `--with-env` | Refresh the plist from Key Vault first (`env:pull --prod`) |
| `--skip-checks` | Skip lint, typecheck and tests |

> Prod runs **the current checkout**, not `main`. After merging a PR, `git switch main`,
> `git pull`, then deploy — otherwise prod keeps running whatever branch is checked out. The
> script warns about this but does not block you.

## Configuration and credentials

| Command | What it does |
|---|---|
| `bun run deploy:provision` | Create the Key Vault + grant yourself access. Idempotent |
| `bun run env:push` | Upload `MONGODB_URL` to the vault |
| `bun run env:pull` | Write `.env` (dev) |
| `bun run env:pull --prod` | Write the plist (prod). `sync:bootstrap` is an alias of this |
| `bun run env:show` | Every profile + whether `.env` and the plist match. Read-only, no network |

Every command takes `--vault <name>`; `MANGATRACKER_VAULT` does the same. The default lives in
`deploy/azure.json` (`kv-mangatracker`, resource group `rg-proyectos-personales`, `brazilsouth`).

The plist carries the sync config, and that is deliberate: it keeps `bun run dev` out of the
production database. Plist env vars win over `.env`, so the same checkout serves both.

| Where | `MONGODB_DB` | Effect |
|---|---|---|
| plist `EnvironmentVariables` | `mangatracker` | Production syncs |
| `.env` | `mangatracker_dev` | Dev syncs somewhere harmless |

- The plist holds the cluster password in plaintext → the tooling keeps it `chmod 600`.
- Inspect what the cluster actually holds: `bun run sync:inspect` (add a database name to look
  at another, e.g. `bun run sync:inspect mangatracker_dev`).
- Check the sync took: `curl -s http://127.0.0.1:5150/api/sync/status`

## Manual fallback

Only if `bun run deploy` itself is broken.

1. `bun run lint` + `bun run typecheck` + `bun test`
2. `DATABASE_URL="file:$HOME/Library/Application Support/MangaTracker/mangatracker.db" bunx --bun prisma migrate deploy`
3. Full reload — **not** `kickstart -k`, which restarts the process against the configuration
   launchd already has in memory and silently ignores changed env vars:
   ```bash
   launchctl bootout gui/$(id -u)/com.mangatracker
   # Wait for it to actually be gone before loading again, or bootstrap races the
   # teardown and dies with `Bootstrap failed: 5: Input/output error`, service down:
   while launchctl print gui/$(id -u)/com.mangatracker >/dev/null 2>&1; do sleep 0.25; done
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mangatracker.plist
   ```
   `bun run deploy` does exactly this, with a bounded wait and up to 3 bootstrap attempts.
4. `curl -s http://127.0.0.1:5150/health` → `{"status":"ok"}`

First-time install on a new machine: full XML and steps in `PLAN.md` (Fase 3).

## Dev vs prod port collision

`launchctl bootout gui/$(id -u)/com.mangatracker` frees port 5150 for `bun run dev`;
re-bootstrap the plist when done (or just `bun run deploy`).
