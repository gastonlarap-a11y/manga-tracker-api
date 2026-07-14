@AGENTS.md

## Config maintenance
- After ANY task that changed structure, commands or conventions: check that this file — and
  AGENTS.md if present — still matches reality; propose the exact edit in the same session.
- Same-session fix also when a documented command fails, a stated convention contradicts the
  code, or the user corrects the same thing twice.
- New repeated procedure → propose a `.claude/skills/` entry; new language/area convention →
  a `paths:`-scoped rule in `.claude/rules/` — never more always-loaded lines.
- After structural changes (new package, framework migration, tooling swap), re-run
  `/setup-project audit`.
