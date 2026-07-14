---
paths:
  - "**/*.ts"
---

# TypeScript rules
- No `any`: use `unknown` plus narrowing, or a proper type. `as` casts need a comment
  justifying them.
- Type-only imports use `import type { ... }` (`verbatimModuleSyntax` is enabled).
- No floating promises: `await`, return, or explicitly `void` with a reason.
- Named exports only; `export default` is reserved for the Bun server entry (`src/index.ts`).
- Model states as discriminated unions instead of boolean flag combinations.
- Derive request/response types from Zod schemas (`z.infer`); never duplicate them by hand.
