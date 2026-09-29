# 11 — Testing: what actually runs, and what is still design intent

> **Canonical status:** Partly superseded. **Read this banner before the rest.**
>
> This document was written as a *specification* for a test harness that was
> never built. On 2026-09-28 every claim below was re-checked against the
> physical repository. Large parts of it describe files, scripts and CI that do
> not exist. The aspirational text is retained below as design intent, but every
> section now carries its real status. **Do not read this file as a description
> of the gate.**

## 11.0 — What actually exists (measured 2026-09-28)

| Layer | Runner | Real status |
|---|---|---|
| Root unit | `npx vitest run` | **573 passing / 46 files**, colocated in `src/**/*.test.ts` |
| Desktop unit | `cd apps/desktop && npx vitest run` | **153 passing / 24 files** |
| Rust unit | `cargo test` | **27** `#[test]` in `src-tauri/src/main.rs` |
| E2E | `npx playwright test` (in `apps/desktop`) | 18 `test(` across 14 spec files, driven against `e2e/stub-daemon.mjs` — a **fake** control plane, no providers and no vault |
| Lint / types | `tsc --noEmit`, `eslint`, `oxlint` (8-warning ratchet) | all in `npm run test:vantrilex` |
| **CI** | — | **does not exist.** No `.github/` directory, no workflow file, no runner. Every gate above is run by hand |
| **Integration suite** | — | **does not exist.** There is no `test/` directory |
| **Mock server harness** | — | **does not exist.** There is no `test/mocks/` |
| **Benchmark harness** | — | **does not exist.** There is no `bench/` directory and no `bench` or `stress` npm script |
| **Coverage floor** | — | **none.** See §11.1 |

`npm run test:vantrilex` is `typecheck && lint && lint:ox && test &&
test:desktop && test:e2e`. It **does** include E2E, and it needs ports
4096/4097/4197 free — an installed build holding them makes it fail with
`EADDRINUSE`.

Note also that no stage typechecks the test files. Root `tsconfig.json` sets
`exclude: ["**/*.test.ts"]` and Vitest transpiles without checking types, so all
46 root test files and the whole desktop renderer compile under **no type
checker at all**. `npm run typecheck:tests` exposes this: it currently reports
**62 errors across 9 files**. It is deliberately not in the gate, because adding
it would turn the gate red on pre-existing debt.

## 11.1 — Test pyramid (aspirational; reality per §11.0)

The original table claimed an integration tier at `test/integration/`, benchmark
and stress tiers driven by `pnpm bench` and `pnpm stress`, and a **≥ 80 % line
coverage** expectation. Three corrections:

1. **`test/integration/`, `bench/`, `pnpm bench`, `pnpm stress` do not exist.**
   npm is the package manager; `pnpm-lock.yaml` in the repo is vestigial.
2. **The ≥ 80 % coverage expectation was never enforced and never measured.**
   `vitest.config.ts` declared `coverage.thresholds: { lines: 80 }` while nothing
   set `coverage.enabled`, which still defaults to `false` in Vitest 4 — so the
   threshold had never been evaluated once. A floor that never runs is worse
   than no floor, because it reads as a guarantee. It has been **deleted**, and
   the true line-coverage number is currently **unknown**. To reinstate a real
   floor: install `@vitest/coverage-v8`, run
   `npx vitest run --coverage.enabled --coverage.provider=v8`, record the
   result in `docs/10-CHECKPOINT.md`, and only then write the threshold and add
   a `--coverage` stage to the gate.
3. The unit tier is the only one that exists, and it is the one that carries the
   project.

## 11.2 — Mock servers — NOT IMPLEMENTED

All external I/O is mockable via interfaces, and the unit suite honours that:
Groq, Fish Audio and the OpenCode serve client are all injected. But there is no
shared `MockServe` / `MockGroq` / `MockFish` harness, and there is no
`test/mocks/` directory. The TypeScript interface block that used to stand here
was never valid TypeScript (`emit.Encode(envelope: EventEnvelope)`), which is
itself evidence it was never compiled or reviewed.

The closest real equivalents are `apps/desktop/e2e/stub-daemon.mjs` (a real
`UiServer` plus the real command router behind a fake control port `:4197`) and
the per-module `*.test.ts` injected doubles in `src/`.

## 11.3 — Latency benchmark harness — NOT IMPLEMENTED

There is no `bench/latency.ts` and no percentile harness. Latency has instead
been measured **live against real providers** and recorded in
`docs/10-CHECKPOINT.md` and the README "Measured behaviour" table — the only
numbers in this project that are not unit-test numbers. Those runs require vault
keys, burn free-tier quota, and are in **no gate**, which is why the free-tier
figures degrade over time without anything going red. The `BUDGETS` constant
below is design intent:

```ts
// NOT PRESENT IN THE REPO — target budgets for a future harness.
export const BUDGETS = {
  stt:            { p50Ms: 500 },
  brain:          { p50Ms: 2000, p99Ms: 5000 },
  'tts-first-chunk': { p50Ms: 800 },
  'cache-hit':    { p50Ms: 50 },
} as const;
```

## 11.4 — Rotation distribution proof — IMPLEMENTED

`src/voice/keyring.test.ts:11` implements the 25-acquisition rotation proof:
`test('25 concurrent acquisitions resolve slots 0-9/10-19/20-24', …)`.

One correction to the illustration that used to stand here. It asserted a
strict **order** — `expect(used.slice(0, 10)).toEqual(all('K1'))` — which is
wrong and was never what the test does. `keyring.test.ts:24` says so explicitly:
*"Slot order under concurrency is nondeterministic; counts are structural."*
The real invariant is that each pool yields its own count, not that pool 1
happens to win the race. Do not "fix" the test to match the old doc.

## 11.5 — Language audit — NOT IMPLEMENTED

The 100-briefing bilingual corpus, the non-technical-English scan, the
code-span/Arabic-script check and the trust-breaker scan described here **do not
exist**. There is no language-audit test in `src/`. The dialect itself *is*
locked and *is* asserted, but by much narrower tests in
`src/knowledge/personas.test.ts` and `src/knowledge/corpus.test.ts` — those
check the persona fixtures stay Ammani and keep English technical terms. That is
not the same guarantee, and this section should not be cited as if it were.

## 11.5A — Excerpt-cap, barge-in, destructive-intent and mute drills — PARTIALLY IMPLEMENTED

- **40-word cap:** not implemented as a test. There is no `bluf()` function.
  What exists is a `briefings: 'bluf' | 'full'` config enum
  (`src/common/config.ts:26`) and a BLUF instruction inside the brain system
  prompt (`src/voice/brain.ts:110`). The ≤ 45 s / ≤ 15-word limits are prompt
  instructions to a model, not an enforced invariant.
- **Barge-in:** implemented and gated — see the L6 row in
  `docs/10-CHECKPOINT.md` (generation counter re-checked after every await).
- **Destructive intent:** implemented via FR-12 two-way confirmation in
  `src/orchestrator/command-router.ts`, with parked-command caps recorded as L20.
- **Meeting mute:** see §11.6 — a real defect here was found, not a harness.

## 11.6 — Focus-steal harness — NOT IMPLEMENTED, and the concern is real

There is no focus-log hook and no 50-injection drill. Note that
`src/voice/tts.ts:12` records the design position directly: no focus APIs are
used. This remains an **unverified** claim about packaged behaviour, not a
measured one, and is the same class as the open SEC-7 / L18 microphone-grant
row. It is listed as unverified rather than closed.

## 11.7 — CI gates — NOT IMPLEMENTED

There is no `.github/` directory, no `ci.yml`, and no runner of any kind. The
yaml block that used to stand here was a shape sketch, not a file.

The real gate is a single manual command, `npm run test:vantrilex`, described in
§11.0. Its known blind spots, all of which have produced shipped defects:

- Every network client is an injected mock, and E2E drives a fake control
  plane, so **no gate stage exercises a real provider**. v0.6.0 passed every
  gate and could not boot at all.
- Test files are not typechecked (62 latent errors, §11.0).
- `oxlint` exits 0 on its warnings; the ratchet is a separate script that
  compares a count against a baseline file.
- `cargo test` is not part of the JS gate at all and needs the MSVC environment
  loaded via `VsDevCmd.bat` on Windows.

---

*End of `11-TESTING.md`. Next: `12-SECURITY.md`.*
