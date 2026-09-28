# Phase 2 — Bounded Autonomous Forensic Audit

**Sprint:** 2026-09-28, immediately after v0.7.1.
**Mode:** READ-ONLY FORENSIC DISCOVERY. No source file was modified during the
sprint. One test file was written (`src/voice/fish-free-tier-header.test.ts`) and
it belongs to **Stage 1** item 4/5 work, not to this audit — recorded here for
completeness rather than claimed as an audit artifact.

**Baseline commit:** `b0d51ba` (v0.7.1). Every finding below is stated against
that exact tree.

**Mandate:** audit raw source from first principles in `src/orchestrator/`,
`src/voice/`, and `apps/desktop/src/audio/`, distrusting documentation. Classes:
race conditions, unhandled promise rejections, memory-growth boundaries,
edge-case error propagation.

**Circuit breakers honoured:**

| Breaker | Status |
|---|---|
| CB-1 cycle cap (3) | Stopped at 2 |
| CB-2 context saturation | Approaching; stopped early rather than start cycle 3 |
| CB-3 halt on a clean cycle | **Triggered at cycle 2** — did not loop |
| CB-4 no edits to `src/` or renderer | Honoured; all fixes are proposals |

---

## Executive summary

Two cycles. **One structural finding** (F-01, latent and not currently
reachable) and **one reproducibility defect** (F-02, found in Stage 1 and
carried in). Cycle 2 examined timers, collection growth and error propagation
across all three surfaces and found **nothing**, which halted the sprint under
CB-3.

The honest headline is that this codebase is in better shape than the audit
expected. Eight of the eleven candidates examined were cleared on inspection, and
five of those cleared because the code was *already* correct in a way that was not
obvious from the grep that found it.

---

## F-01 — `AudioPlayer.drain()` can reject from a `void`-ed promise

**Severity: LOW (latent, not reachable in the shipped app)**
**File:** `apps/desktop/src/audio/playback.ts:94-119`

### Defect

`drain()` is `async` and is invoked as a floating promise at three sites
(`playback.ts:67`, `:117`, and recursively from inside its own `finally`). Its
body is:

```
private async drain(): Promise<void> {
  if (this.draining) return;
  this.draining = true;
  const gen = this.generation;
  try {                       // <-- no catch
    for (;;) { ... }
  } finally {
    this.draining = false;
    if (this.queue.length === 0 && this.started) {
      this.started = false;
      this.options.onEnd?.();      // <-- consumer callback, in finally
    } else if (this.queue.length > 0) {
      void this.drain();            // <-- nested floating promise
    }
  }
}
```

The inner `try/catch` correctly swallows decode and `sink.play` failures, so a
corrupt chunk cannot reject. The gap is the **`finally` block**: `onEnd` is a
caller-supplied callback invoked there, and if it throws, the exception escapes
`drain()` — which nobody is awaiting. That is an unhandled promise rejection.

In the WebView2 renderer that surfaces as a global `unhandledrejection`, not a
crash, so the blast radius is a console error and a possible missed UI reset.

### Why it is not currently reachable

`onEnd` is supplied in exactly one place, `App.tsx:147`:

```
onEnd: () => { window.setTimeout(() => setSpeakingState(false), 1500); },
```

`window.setTimeout` does not throw. So **the defect cannot fire today**. It is
recorded because it becomes reachable the moment a second `onEnd` consumer is
added that can throw — a state update after unmount, an unguarded accessor — and
nothing in the type signature (`readonly onEnd?: () => void`) signals that the
callback is on a rejection path.

### Candidate fix (NOT APPLIED — CB-4)

Wrap the `finally` body so a throwing consumer callback cannot reject the
floating promise, and document the contract on the interface:

```
finally {
  this.draining = false;
  try {
    if (this.queue.length === 0 && this.started) {
      this.started = false;
      this.options.onEnd?.();
    } else if (this.queue.length > 0) {
      void this.drain().catch(() => undefined);
    }
  } catch {
    // A consumer callback must not reject the floating drain promise. The queue
    // is already consistent here; failing loudly would strand `draining`.
  }
}
```

### Candidate test

A test that supplies an `onEnd` which throws, drives one enqueue, awaits a tick,
and asserts no unhandled rejection was raised. Verified non-vacuous by reverting
the `try` and observing the rejection.

---

## F-02 — RESOLVED (2026-09-28): the lint gate is now local and reproducible

**Status: closed.** `oxlint@1.85.0` is installed in `node_modules`, `npm ci` exits 0
at both the root and `apps/desktop`, and `npm run test:vantrilex` is green with no
environment flags and no `VOXAURA_ALLOW_GLOBAL_OXLINT` override.

### The original finding was directionally right and mechanically wrong

The finding was correct that the gate ran an ambient global binary. The mechanism I
proposed was not. I attributed it to oxlint's optional `vite-plus` peer chain, and
then reported a second "pre-existing" blocker (`eslint-plugin-prettier` peer conflict).
**Neither survived investigation.**

- `eslint-plugin-prettier` is **not declared in this project at all**. That ERESOLVE
  came from a transient package.json state left by my own earlier pinning
  experiments. Reporting it as a pre-existing defect was wrong.
- The `vite-plus` / `link:./src/types` failure was real, but it was a *consequence* of
  the real blocker, not the cause: npm could not resolve `vitest@2.1.9` against the
  chain's `vitest@4.1.11`, so it never got far enough to matter.
- A third contributor I had not isolated: **`node_modules` was in a corrupt state**
  from those same failed experiments, surfacing as
  `Cannot read properties of null (reading 'matches')` — an npm internal crash, not a
  dependency error at all.

### The actual cause

**No root `package-lock.json` existed.** `npm ci` failed on the lockfile check before
dependency resolution was ever reached, and `npm install` failed on the vitest 2 vs
vitest 4 peer chain. Neither had been verified, because the lint gate silently
succeeded on a global binary the whole time — which is precisely the failure mode the
original finding described.

### The fix

| Package | Before | After |
|---|---|---|
| `vitest` (root + desktop) | `^2.0.0` / `2.1.9` | `4.1.11` |
| `vite` (root, desktop) | not declared / `5.4.21` | `^7.1.0` |
| `oxlint` | `1.85.0` declared, never installed | `1.85.0` installed locally |
| root `package-lock.json` | **absent** | 148,623 B, committed |

Targeted `4.1.11` rather than the current `5.0.2`, because that is the version the
oxlint chain pins; a floating range is what produced the original 1.86.0 breakage.

### Verification

```
npm ci                  root       exit 0   226 packages, 0 vulnerabilities
npm ci                  desktop    exit 0   182 packages, 0 vulnerabilities
npm run test:vantrilex  no flags   exit 0
  lint:ox               oxlint 8 warning(s) / 0 error(s), baseline 8, local binary
  root vitest           509 passed (41 files)
  desktop vitest        153 passed (24 files)
  E2E playwright        18 passed (14 specs)
cargo test              27 passed
tsc                     root 0, desktop 0
```

**Zero regressions across a two-major-version jump.** No test required modification.

### One breaking change worth recording

**vitest 4 removed the `basic` reporter.** The available set is now `default, agent,
minimal, blob, verbose, dot, json, tap, tap-flat, junit, tree, hanging-process,
github-actions`. Any script or CI invocation passing `--reporter=basic` fails with
`Failed to load custom Reporter from basic`. This bit the verification commands used
during the upgrade and would have bitten CI the same way.

### A second spawn trap, on Windows

`node_modules/.bin/oxlint.cmd` cannot be spawned by `execFileSync` — it returns
`EINVAL`, the same class of failure as spawning `npx` directly (`ENOENT`). Both are
Windows batch shims and both must go through `cmd /c`. `scripts/lint-baseline.mjs`
now does. The refusal-to-run-on-a-global guard is retained: it is what made this
blocker visible in the first place, and it is what will catch a future tree that
stops resolving.

## Candidates examined and CLEARED

Each of these looked like a finding from the grep and was correct on inspection.
Recorded because "checked and dismissed" is the useful half of an audit.

| # | Candidate | Why it is not a defect |
|---|---|---|
| C-1 | `inventory.ts:83,85` — `void this.pollOnce()` with no `.catch()` | `pollOnce` has an internal `try/catch` (L51/L73) and cannot reject |
| C-2 | `audio-pipeline.ts:56` — `private recent: string[] = []` unbounded | Capped at `REPEAT_MEMORY = 5`; `remember()` slices |
| C-3 | `inventory.ts:84` — `setInterval` | Cleared in `dispose()` (L88-90) and the timer is `unref`'d |
| C-4 | `brain.ts:196` — abort `setTimeout` not cleared | Cleared at L255 |
| C-5 | `brain.ts:297` — second abort `setTimeout` not cleared | Cleared at L358 |
| C-6 | `stt.ts:197`, `tts.ts:363` — timers | Both cleared (L202, L380) |
| C-7 | `mentions.ts:61-64`, `narrator.ts:82`, `prompt-optimizer.ts:88`, `coordinator.ts:60` — bare `string[]` locals | Per-call, bounded by input length and by `MENTION_MAX_*` caps |
| C-8 | `command-router.ts:65` — `new Set([...])` | Static, one entry, never mutated |
| C-9 | `prompt-optimizer.ts:30` — `NON_ACTIONABLE` Set | Static lookup table |
| C-10 | `capture.ts:172`, `playback.ts:161` — `void context.close()` | Both `.catch(() => undefined)` |

---

## Not examined, and why

- **`src/voice/cache.ts`, `src/voice/vault.ts`, `src/voice/keyring.ts` internals**
  — partially covered in Stage 1 (L16/L17 work exercised all three live).
- **Concurrency in `ServeClient` / `runtime/`** — outside the mandated surfaces.
- **The Rust supervisor beyond the `resolve:` logging** — outside the surfaces.
- **A third cycle** — CB-2 and CB-3 both apply. Cycle 2 was clean, and CB-3
  explicitly forbids manufacturing findings to fill a report.

---

## Recommended order

1. **F-02 first.** It is the more serious of the two, because a gate that runs an
   unpinned global binary is not the gate anyone believes is enforcing anything.
2. **F-01 when convenient.** Latent, unreachable, and the fix is four lines — but
   it is four lines that prevent a future unhandled rejection.
3. **Re-run this audit after either fix lands**, specifically because F-02's fix
   changes how the gate resolves its binary, which is itself audit-relevant.
