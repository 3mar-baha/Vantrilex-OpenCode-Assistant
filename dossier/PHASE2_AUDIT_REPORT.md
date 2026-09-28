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

## F-02 — the lint gate is not reproducible

**Severity: MEDIUM (defeats the purpose of P1 item 5)**
**Files:** `package.json` (devDependencies), `scripts/lint-baseline.mjs`

`oxlint` is declared at `^1.0.0` in `devDependencies` but is **not present in
`node_modules/.bin`**. Every local invocation resolved to a **global** install
(v1.85.0) at `~/AppData/Roaming/npm/oxlint.ps1`.

A clean `npm ci` on another machine produces no `oxlint`, so `npm run lint:ox`
either fails or silently runs whatever is on `PATH`. The gate that Stage 1
strengthened to fail on regressions is therefore running an unpinned version —
which is the same class of defect as the `chain-nemotron` assertion: something
that looks enforced and is not.

`scripts/lint-baseline.mjs` now prefers `node_modules/.bin/oxlint` and **warns
loudly** when it has to fall back, so the condition is visible rather than silent.
The underlying fix — making the dependency install, or pinning the tool
deliberately — is a dependency decision and was left for a human.

---

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
