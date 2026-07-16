@AGENTS.md

## Config maintenance
- After ANY task that changed structure, commands or conventions: check that this file — and
  AGENTS.md if present — still matches reality; propose the exact edit in the same session.
- Same-session fix also when a documented command fails, a stated convention contradicts the
  code, or the user corrects the same thing twice.
- New repeated procedure → propose a `.claude/skills/` entry; new language/area convention →
  a `paths:`-scoped rule in `.claude/rules/` — never more always-loaded lines.
- New technology appears in the repo (dependency, SDK, platform, infra — e.g. a cloud
  provider or a new datastore) → offer the matching plugins/skills/rules in the same
  session; ask first, never add silently.
- After structural changes (new package, framework migration, tooling swap), re-run
  `/setup-project audit`.
