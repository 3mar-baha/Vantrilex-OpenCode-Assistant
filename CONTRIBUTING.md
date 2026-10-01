# Contributing to Voxaura

> **Read `AGENTS.md` first.** It is the audit surface: every figure in it is
> re-derived from the tree by `npm run docs:verify`, and where this file and
> `AGENTS.md` disagree, **`package.json` is the authority** and `AGENTS.md` is
> the derived copy. Everything below is a subset of it, not a parallel source.

## Branches and commits

- Work on `main`. **There is no `.github/` directory in this repository and no
  CI**: the gates below are manual and local-only, so there is no PR to open and
  no remote check that will run for you. `main` is green only because whoever
  pushed last ran the gates.
- One concern per commit, Conventional Commits format:
  `feat(control-plane): …`, `fix(desktop): …`, `docs: …`, `chore: …`.
- Author line: `3mar-baha <omarbaha224@gmail.com>`.
- **Write commit-message files with the file-write tool, not PowerShell
  redirection.** `Out-File -Encoding utf8` and `Set-Content -Encoding utf8` on
  PS 5.1 emit U+FEFF first, `git commit -F` copies it verbatim, and the type
  then parses as `﻿fix` rather than `fix` — so
  `conventional-changelog`/semantic-release skip the commit **without an
  error**. 13 commits on `origin/main` carry this and are deliberately not
  rewritten; `AGENTS.md` records the measurement and the check
  (`charCodeAt(0) === 0xFEFF`).

## Gates

`npm run test:vantrilex` is the whole chain, and **`npm run test:e2e` is part of
it** — it is the seventh stage, not a separate opt-in:

```bash
npm run test:vantrilex
```

That is `typecheck` → `typecheck:tests` → `lint` → `lint:ox` → `test` (root) →
`test:desktop` → `test:e2e`. Read the `scripts` block of `package.json` for the
authoritative expansion; do not trust a prose summary of it, including this one.

Two more gates exist outside that chain and both must be green for a document
change:

```bash
npm run docs:verify          # re-derives every figure AGENTS.md claims
npm run docs:verify:self-test
```

`docs:verify` contains no expected values: it parses the documented figures out
of the markdown and derives the real ones from the tree and from live test runs.
**When it fails, fix the document, not the script** — with one deliberate
exception, a claim added to `scripts/docs-verify.mjs` must be added on purpose
and never to make a failure disappear. Deleting a figure from `AGENTS.md` turns
its check into a no-op that still exits 0, which is why UNVERIFIED is an error
rather than a warning.

Also useful, and neither is a gate: `npm run test:blindspots` (module-level test
reachability, measured) and `npm run sidecar:check` (content-hashed sidecar
staleness).

**Run gates serially and unpiped.** `$LASTEXITCODE` is meaningless through a
PowerShell pipe, and `>` under PowerShell writes UTF-16LE — redirect via
`cmd /c` and confirm the log landed by a non-zero byte count before trusting an
exit code. `AGENTS.md` carries the full list of shell gotchas.

## Rules

- **Verify a guard test by breaking the guard.** Disabling the fix and confirming
  the test fails is the only way to know the test is not vacuous. Several here
  were, and two asserted bugs as features. If an injection silently no-opped, a
  green "break" proves nothing — print a confirmation line that it landed.
- Measure, never assume: gates need committed artifacts or measured output.
- Zero breaking changes to WS-4097 client contracts (`src/ipc/protocol.ts`). Add
  frames additively; old shells ignore unknown types.
- No secrets in code, logs, tests, or console output — redact always, at the
  sink rather than at each call site.
- FR-12: destructive acts require explicit confirmation before dispatch.
- **There is no database.** No database rule applies to this repository, and
  there is no `*.db` file or database dependency in the tree. State lives in
  runtime files under `~/.opencode-voice-runtime/` (or `VOICE_RUNTIME_DIR`) and
  in the encrypted `vault/keyring.dat`.
- No hardcoded absolute paths in new code/config; resolve from `process.cwd()`,
  explicit bases, or OS-standard data directories.
- Update `docs/10-CHECKPOINT.md` with real measured numbers for any
  behaviour change — and leave its `§§10.1–10.6` FR-10 specification alone; it
  is a frozen norm, not a description of the tree.
