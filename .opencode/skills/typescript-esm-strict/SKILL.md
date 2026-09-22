---
name: TypeScript ESM (strict)
description: Repository conventions for TypeScript in this NodeNext ESM project — explicit .js import specifiers, strict-mode safety, zod boundaries, and the tsc/lint/vitest gate. Use when writing, refactoring, or reviewing any .ts file here.
---

# TypeScript ESM (strict)

Apply these conventions to every `.ts` change in this repository.

## Module system

- The package is `"type": "module"` with `module`/`moduleResolution` set to
  `NodeNext`. **Always** use explicit `.js` extensions on relative imports,
  even though the source file is `.ts`:

  ```ts
  import { Ledger } from './ledger.js';        // correct
  import { Ledger } from './ledger';           // breaks at runtime
  ```

- Prefer `import type` for type-only imports so they are erased at emit.
- No CommonJS (`require`, `module.exports`), no `__dirname`/`__filename` — use
  `import.meta.url` when a file path is required.

## Strict-mode safety

`noUncheckedIndexedAccess` is on. Treat every index/`Map.get` result as possibly
`undefined`:

- Narrow with an explicit guard before use, or assert only when the index is
  provably in range (e.g. immediately after a bounds check).
- Do not silence with `!` unless the invariant is obvious and local.
- Prefer `for (const x of arr)` over index loops when you do not need the index.

## Boundaries and types

- Parse external data (HTTP bodies, files, env) with `zod` at the boundary;
  do not hand-roll validators.
- Use the branded types in `src/common/brands.ts` (e.g. `SessionId`) rather than
  raw `string` where a brand exists.
- Avoid `any`. Prefer `unknown` plus narrowing. `@typescript-eslint/no-explicit-any`
  is enforced outside test files.

## Invariants specific to this repo

- The runtime is **advisory**: nothing in `src/runtime/laya/` may auto-execute a
  destructive action. Destructive intent is a signal for the FR-12 confirmation
  path only.
- Keep the ONNX session lazy and race-safe (cache the in-flight promise); never
  construct a session per call.

## Gate before calling work done

```sh
npx tsc --noEmit
npx eslint . --max-warnings 0
npx vitest run
```

All three must be clean. `tsc` and `eslint` treat any output as failure.
