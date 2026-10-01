
---

## OPERATING RULES — owner-ruled, standing

These are not guidance. They are acceptance criteria for a wave.

### 1. A wave closes with zero `??`

**`git status --porcelain` must show zero untracked entries when a wave lands.** Every new file is committed or deleted before the wave closes. Not "the agent reported its own files clean" — the **orchestrator verifies the full tree between waves**, because seven agents with seven clean consciences produced one dirty tree. Per-slice self-reporting is what let a green suite of 1594 tests exist in files git did not hold.

**Corollary:** the previous rule (paste the porcelain in the completion report) was necessary but not sufficient. It produced *visibility* without *ownership*. Visibility alone changes nothing.

### 2. Claim integrity: no derived claim may depend on untracked state

If `docs:verify` derives a figure from a file, that file must be tracked. `live modules 75→76` was derived from `src/telemetry/error-class.ts`, which was untracked — a claim resting on state version control did not hold. This is a **claim-integrity rule, not hygiene**.

### 3. Confirm intent before staging, not just before writing

The `zz-debug` lesson applies to staging as much as to scratch. An untracked file is not automatically wanted. Each must be attributed to a landed change and judged: production module, test, deliberate artifact, or unattributable. **A commit message must say what kind of thing it is** — a commit containing a production module says so.

### 4. Silent-shrink: any "all X satisfy P" must also assert X is non-empty

`every()` over an empty set is vacuously true, so a check whose subject silently stops matching reports PASS. This repo has produced **four** instances:

1. the `.rs` citation regex — the 10 Rust citations silently dropped out of the total
2. the `docs:verify` self-test's `every()` over a parsed anchor set
3. a raw-text schema census satisfied by a **doc comment** mentioning `AckFrameSchema.parse` in prose
4. the count-claim regexes, where deleting a figure turned its check into a no-op that still exited 0

The third is the one worth keeping: **the first instance caught by an agent rather than by audit.** The `codeOnly` stripper that fixed it has a test of its own — a tool that guards the guard needs its own guard.

### 5. Verify the fix breaks; verify the guard is not a fiction

Mutate, confirm red, print `INJECTION LANDED: true` **and confirm the injection is present by reading the file back**. Three times this session a break came back green for the wrong reason: a mis-quoted injection-check line, a reporter that did not exist in the installed vitest, and a comment satisfying a text match. **A green-looking break is worse than a broken one.**

### 6. Anti-gaming constraints, verbatim, in every reconciliation brief

- The agent **may not** edit `scripts/docs-verify.mjs`.
- The agent **may not** delete a claim to make it pass.

### 7. Never `git stash` in a shared tree

Three agents reached for it; one captured another's in-flight work. Use explicit paths and read the tree.

### 8. Known debt is recorded debt, with a trigger

The declined `CommandOutcome.detail` brand is recorded with its **measured** cost — 48 sites in `command-router.ts`, 1 in `daemon.ts`, ~64 assertions across 7 test files — and reopens if a provider-text incident ever traces to one of those 48 sites. A trade with no trigger is a forgotten trade.

### 9. Labels, do not removals, for what is unverified

`npm run test:e2e` and `release:verify` stages 3–7 are **known-unverified** until a build environment with NSIS and Tauri exists. They do not block wave completion, but they stay labelled until they run. "Guards proven through exported pure functions" is not "an installed build boots."

---

## KNOWN OPEN DEBT, post-W29

- **W2 rotation** — owner action, not discharged. `.env.local` is ACL-restricted; the three keys are still live.
- **`CommandOutcome.detail`** open string — scrubbed at the `buildAckFrame` sink, not a compile error. Trigger above.
- **`broadcast()` / `UiEventSchema`** — applied, but `broadcast()` has **zero production callers** today. The guard's production value is latent. Correct, and labelled as such.
- **Frozen dossier** — `dossier/sections/06-api.md:38` and `PROJECT_MASTER_DOSSIER.md:3254` say `error` has no schema. Now false. **Owner ruled: leave frozen.** The supersession lives here and in `AGENTS.md`.
- **Empty `lint-baseline.json`** parses to `0`, not `NaN`, so it passes all three guards and yields a plausible-looking "warnings > baseline" message rather than a corruption error. It fails **closed**, which is the direction that matters, but the message misleads. One line closes it.
