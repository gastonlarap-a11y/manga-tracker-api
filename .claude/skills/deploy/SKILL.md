---
name: deploy
description: Deploy the backend as a launchd LaunchAgent (macOS) or a Task Scheduler task (Windows) — prod DB migrations plus service restart. User-invoked only.
disable-model-invocation: true
---

# Deploy (LaunchAgent on macOS, Task Scheduler on Windows)

`deploy/lib/platform.ts` picks the right implementation at runtime (`process.platform`), so every
command below runs identically on both — only the underlying service manager, config file and
secret cache differ. See `deploy/lib/macos.ts` / `deploy/lib/windows.ts` for the platform-specific
pieces, and `PLAN.md` (Fase 3 and its Windows subsection) for the first-time install steps.

## macOS

Installed and validated 2026-07-16 (health probe + kill/auto-restart). The bun binary comes
from mise: `/Users/gaston/.local/share/mise/installs/bun/latest/bin/bun` — not Homebrew.

Production runs `bun run src/index.ts` from this repo via
`~/Library/LaunchAgents/com.mangatracker.plist` (RunAtLoad + KeepAlive), DB at
`~/Library/Application Support/MangaTracker/mangatracker.db`, port 5150, logs in
`~/Library/Logs/MangaTracker/`.

## Windows

Production runs the same `bun run src/index.ts`, launched via a Task Scheduler task named
`MangaTracker` (`LogonTrigger` + `RestartOnFailure` — the closest match to RunAtLoad+KeepAlive,
since a plain Windows Service can't run `bun.exe` at all: `sc.exe` requires the target binary to
speak the SCM's control protocol, which `bun.exe` doesn't implement). Config lives in
`%LOCALAPPDATA%\MangaTracker\prod.env` (the plist's equivalent), DB at
`%LOCALAPPDATA%\MangaTracker\mangatracker.db`, logs in `%LOCALAPPDATA%\MangaTracker\logs\`. The
secret cache (the Keychain's equivalent) is a DPAPI-encrypted file at
`%LOCALAPPDATA%\MangaTracker\secrets\mongodb-url.dpapi`, tied to this user and this machine.

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
| `bun run env:pull --prod` | Write the prod config (plist on macOS, `prod.env` on Windows). `sync:bootstrap` is an alias of this |
| `bun run env:show` | Every profile + whether `.env` and the prod config match. Read-only, no network |

Every command takes `--vault <name>`; `MANGATRACKER_VAULT` does the same. The default lives in
`deploy/azure.json` (`kv-mangatracker`, resource group `rg-proyectos-personales`, `brazilsouth`).

The prod config carries the sync config, and that is deliberate: it keeps `bun run dev` out of the
production database. Its env vars win over `.env`, so the same checkout serves both.

| Where | `MONGODB_DB` | Effect |
|---|---|---|
| plist / `prod.env` | `mangatracker` | Production syncs |
| `.env` | `mangatracker_dev` | Dev syncs somewhere harmless |

- The plist (macOS) holds the cluster password in plaintext → the tooling keeps it `chmod 600`.
  The Windows `prod.env` gets the equivalent treatment via `icacls` (real ACLs — Windows'
  `chmod` only toggles the read-only bit, it can't restrict to one user).
- Inspect what the cluster actually holds: `bun run sync:inspect` (add a database name to look
  at another, e.g. `bun run sync:inspect mangatracker_dev`).
- Check the sync took: `curl -s http://127.0.0.1:5150/api/sync/status`

## Manual fallback

Only if `bun run deploy` itself is broken.

### macOS

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

### Windows

1. `bun run lint` + `bun run typecheck` + `bun test`
2. `$env:DATABASE_URL = "file:$($env:LOCALAPPDATA -replace '\\','/')/MangaTracker/mangatracker.db"; bunx --bun prisma migrate deploy`
3. Full reload — end then run, so `bun --env-file=` rereads `prod.env`:
   ```powershell
   schtasks /End /TN MangaTracker
   # Wait for it to actually stop before running again, same reasoning as the macOS wait above.
   while ((schtasks /Query /TN MangaTracker /FO LIST /V | Select-String "Status:\s*Running")) { Start-Sleep -Milliseconds 250 }
   schtasks /Run /TN MangaTracker
   ```
   `bun run deploy` does exactly this, with a bounded wait and up to 3 run attempts.
4. `curl http://127.0.0.1:5150/health` → `{"status":"ok"}`

First-time install on a new machine: full plist XML (macOS) / scheduled task XML (Windows) and
steps in `PLAN.md` (Fase 3 and its Windows subsection).

## Dev vs prod port collision

macOS: `launchctl bootout gui/$(id -u)/com.mangatracker` frees port 5150 for `bun run dev`;
re-bootstrap the plist when done (or just `bun run deploy`).

Windows: `schtasks /End /TN MangaTracker` frees port 5150 for `bun run dev`; `schtasks /Run /TN
MangaTracker` when done (or just `bun run deploy`).
