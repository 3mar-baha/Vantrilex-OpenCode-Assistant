# Contributing to Voxaura

## Branches

- `main` is always green and releasable. Work on `feat/<scope>`, `fix/<scope>`,
  `docs/<scope>`, or `sec/<scope>` branches; open a PR per atomic unit.
- One concern per commit, Conventional Commits format:
  `feat(control-plane): …`, `fix(desktop): …`, `docs: …`, `sec: …`, `chore: …`.
- Author line: `3mar-baha <omarbaha224@gmail.com>`.

## Local gates (all must pass)

```bash
npm run test:vantrilex   # tsc + eslint + oxlint + root tests + desktop tests
cd apps/desktop && npm run test:e2e
```

## Rules

- Strict TDD: failing test first, minimal implementation, green. No test edits
  to make red code pass without a code fix.
- Measure, never assume: gates need committed artifacts or measured output.
- Zero breaking changes to WS-4097 client contracts (`src/ipc/protocol.ts`).
- No secrets in code, logs, tests, or console output — redact always.
- FR-12: destructive acts require explicit confirmation before dispatch.
- Back up the shared DB before any mutation; zero data loss.
- No hardcoded absolute paths in new code/config; resolve from `process.cwd()`,
  explicit bases, or OS-standard data directories.
- Update `docs/10-CHECKPOINT.md` with every behavior-changing commit.
