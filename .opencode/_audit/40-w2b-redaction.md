# W2b — Secret redaction: make it real, remove `pino`

**Worker:** W2b · **Wave 2** · **Repo:** `O:\opencode-Vantrilex` · **Date:** 2026-09-28
**Status:** complete, uncommitted. All gate commands pass for the W2b write set.

> Zero trust for docs. Every claim below carries a `file:line` or a command that
> reproduces it. Anything not measured is marked **UNVERIFIED**.

---

## 1. Decision: REWROTE `src/common/logger.ts`, did not delete it

**Locked decision 2** ("keep a lightweight, zero-dependency `redactSecrets`") is
only satisfiable in place. Deletion was not merely undesirable, it was
**unavailable without an out-of-scope edit**:

- `src/common/index.ts:7` — `export { redactSecrets, containsSecret, createLogger } from './logger.js';`
- `src/cli.ts:7` — `import { loadConfig } from './common/index.js';`

`src/common/index.ts` is **outside the W2b write set**. Removing `logger.ts`, or
removing the `createLogger` symbol, breaks `tsc` at `src/common/index.ts:7`. So
`logger.ts` was rewritten *as* the zero-dependency redaction path, keeping all
three exported symbols. No new `src/common/redact.ts` was created: a second
module would have been a pure indirection that still could not be re-exported
without touching `index.ts`, and it would have split the pattern list away from
the logger that consumes it.

**File count unchanged.** `logger.ts` is edited in place; the only file added is a
test. No production module was added or deleted, so the dead-code metric is
unaffected by W2b.

---

## 2. `pino` was genuinely LIVE, not merely declared

The task brief flagged this as a risk. It is worse than "declared" — it was
**loaded on every CLI and daemon start**. Proven by observation, not by reading
the import, using an ESM `resolve` hook that appends every specifier the graph
pulls in:

**BEFORE** (`dist/` built from `src/` at HEAD):

```
$ node --experimental-loader file:///.../w2b-trace-loader.mjs dist/cli.js doctor
ok   vault: 3 keys across 3 pools (counts only, zero material)
miss serve 127.0.0.1:4096 (unreachable)
--- pino specifiers resolved by the REAL entrypoint (BEFORE) ---
pino
--- total --- 173
```

**AFTER** (rebuilt from the W2b sources):

```
--- FINAL: pino specifiers in the resolved runtime graph ---
NONE - pino is not loaded
total specifiers: 172   (was 173)
```

Chain: `src/cli.ts:7` → `src/common/index.ts:7` → `src/common/logger.ts:1`
(`import pino from 'pino'`, removed) → `pino` resolved and executed. The resolved
graph dropped by exactly one node.

`dist/common/logger.js` now emits **zero** `import` statements (`grep '^import'`
returns nothing — the `import type { OrchestratorConfig }` is erased). The string
`pino` survives in that file only inside the doc comment that records the
removal.

### The line I could not edit

`scripts/provision-sidecar.mjs` is outside the W2b write set and is **unchanged**.
It pins `pino` in its OWN manifest and runs its own `npm install`
(`scripts/provision-sidecar.mjs:59`), independent of root `package.json`:

```
scripts/provision-sidecar.mjs:53:     'pino': '^9.0.0',
```

> **For the orchestrator:** deleting `pino` from root `package.json` does **not**
> shrink the installer payload. `scripts/provision-sidecar.mjs:53` still installs
> `pino@^9.0.0` into `apps/desktop/src-tauri/sidecar/node_modules/`. Line 53 must
> be removed to actually prune the sidecar. I confirmed via `Select-String` that
> this is the only `pino` occurrence in that file.

---

## 3. The patterns, and where the prefixes came from

Live provider prefixes were derived from code, not guessed:

| Prefix | Pool | Evidence |
|---|---|---|
| `sk-or-v1-` | OpenRouter — brain, intake, planner, narrator | `src/voice/brain.ts:202`, `:303` (`Authorization: Bearer ${apiKey}`); `src/voice/vault.ts:104` (`OPENROUTER_API_KEYS`); `src/cli-doctor-keys.test.ts:31` uses this exact shape as a synthetic value |
| `sk-fish-` | Fish Audio — TTS | `src/voice/tts.ts:289`; `src/voice/vault.ts:103` (`FISH_AUDIO_KEYS`) |
| `gsk_` | Groq — Whisper STT | `src/voice/stt.ts:90` (`new Groq({ apiKey })`); `src/voice/vault.ts:102` (`GROQ_API_KEYS`) |

The old list at the previous `src/common/logger.ts:6-11` had `sk-fish-` and `gsk_`
and **no `sk-or-v1-` case at all** — the gap named in the brief.

Added beyond the three: a generic long-tail `sk-` fallback (unknown future
provider), `Bearer`, `Basic` (used by `src/runtime/client.ts:290` and
`src/launcher/launcher.ts:29`), and a `key = value` pattern whose NAME declares
the value secret.

---

## 4. Two real bugs my own tests caught (both now fixed)

These were found while writing the tests, not by reading code.

**Bug A — the assignment pattern missed every JSON-shaped value.**
`redactString('{"apiKey":"hunter2"}')` returned the string unchanged. Cause: a
serialized object puts a **closing quote between the name and the colon**, and
the pattern required `[:=]` immediately after the field name. Fixed by allowing
an optional quote: `\b(name)\b(["']?\s*[:=]\s*)(value)`. This is the single most
common shape the function is asked to handle, and it was silently a no-op.

**Bug B — `containsSecret` reported "clean" for every `Error`.**
`message` and `stack` are own but **non-enumerable** on `Error`, so the
`Object.values()` walk saw an empty object. An `Error` is the most likely place a
leaked key lands (a fetch failure echoing an `Authorization` header). Fixed with
an explicit `Error` branch in `scan`.

---

## 5. Wiring — where redaction actually runs

`createLogger` / `redactSecrets` had **zero** production callers (dossier §7.3 S3).
They now have two.

1. **Telemetry writer** (`src/telemetry/writer.ts`) — constructed on every boot
   at `src/daemon.ts:292`. `record()` now wraps the row in `redactObject(...)`
   *before* `JSON.stringify`. Rationale: the closed enum unions are what make
   injection impossible, but `sessionId` is only `z.string().min(1)`, so a caller
   passing a session id derived from an error string could land key material in
   `~/.opencode-voice-runtime/voice-runtime.jsonl`, which persists on disk.

2. **Flush-failure diagnostic** — `appendFileSync` failure was previously
   **completely silent**: `src/daemon.ts:107` swallows it with
   `.catch(() => undefined)` and `src/daemon.ts:704` does the same. The batch is
   already dequeued at that point, so the rows are gone and nothing said so.
   `flush()` now emits one redacted `warn` line before rethrowing. The existing
   swallow behaviour and the rethrow are both preserved — this adds a diagnostic,
   it does not change control flow.

Redaction is applied **structurally, before serialization** everywhere. That is
an invariant, documented at the top of `logger.ts`, because scrubbing a
pre-rendered JSON string with a `key: value` pattern can emit an unquoted
`[REDACTED]` and corrupt the document.

`createLogger` writes **stderr**, not stdout: `src/cli.ts` prints parseable JSON
and the WS-4097 handshake reads stdout, so diagnostics must not share it.

---

## 6. BREAK-THE-GUARD TRANSCRIPT

Rule applied: *a guard never seen failing is not a guard.* Each guard was disabled
in source, the suite was run, the failure was confirmed to name the guard, the
file was restored from backup, and green was re-confirmed.

```
BASELINE (my 3 test files) ......... 29 passed (3 files)
```

### #1 — remove `/sk-or-v1-[A-Za-z0-9_-]{8,}/g` → **6 failures**
```
× redacts the sk-or-v1-* pool
× the generic sk- fallback does not shadow a specific prefix
× scrubs a key held inside an object argument
× walks nested objects, arrays, Maps and Sets
× scrubs an Error message and stack
× redacts an object argument before it reaches the sink

FAIL 'redacts the sk-or-v1-* pool'
AssertionError: expected 'key=sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAA…' to be 'key=[REDACTED]'
  src/common/logger.test.ts:39
```
**This first attempt PASSED — the guard was VACUOUS.** See §6.1.

### #2 — remove `/gsk_[A-Za-z0-9]{8,}/g` → **5 failures**
```
× passes clean strings through untouched
× redacts the gsk_* pool
× walks nested objects, arrays, Maps and Sets
× a self-referencing object does not throw or hang
× redacts an Error argument

FAIL 'redacts the gsk_* pool'
AssertionError: expected 'key=gsk_AAAAAAAAAAAA…' to be 'key=[REDACTED]'
  src/common/logger.test.ts:39
```

### #3 — revert `redactSecrets` to the OLD string-only body → **9 failures**
```
× scrubs a key held inside an object argument
× walks nested objects, arrays, Maps and Sets
× scrubs an Error message and stack
× a self-referencing object does not throw or hang
× an over-deep object truncates instead of overflowing the stack
× redacts an object argument before it reaches the sink
× redacts an Error argument
× never writes provider key material to voice-runtime.jsonl
× a failed append emits one redacted diagnostic instead of failing silently

FAIL 'never writes provider key material to voice-runtime.jsonl'
AssertionError: expected '{"timestamp":"…","sessionId":"ses_sk-or-v1-AAAA…"' not to contain 'sk-or-v1-'
  src/telemetry/writer-redaction.test.ts:51
```
This is the money shot: with the deep walk disabled, the synthetic key is
**visible in the on-disk JSONL row**.

### #4 — unwire `redactObject()` from `TelemetryWriter.record()` → **1 failure**
```
FAIL 'never writes provider key material to voice-runtime.jsonl'
AssertionError: expected '{"timestamp":"…","sessionId":"ses_sk-or-v1-AAAA…"' not to contain 'sk-or-v1-'
  src/telemetry/writer-redaction.test.ts:51
```
Isolated: this fires with `redactSecrets` still fully working, so it tests the
**wiring**, not the function.

### #5 — remove the flush-failure diagnostic → **1 failure**
```
FAIL 'a failed append emits one redacted diagnostic instead of failing silently'
AssertionError: expected [] to have a length of 1 but got +0
  src/telemetry/writer-redaction.test.ts:115
```

### #6 — re-declare `pino` in `package.json` → **1 failure**
```
FAIL 'pino is no longer a declared dependency'
AssertionError: expected [ 'groq-sdk', 'lru-cache', …(3) ] to not include 'pino'
  src/common/logger.test.ts:238
```

### #7 — revert the `["']?` quote tolerance (Bug A) → **1 failure**
```
FAIL 'catches a secret assignment even when no provider prefix is present'
AssertionError: expected '{"apiKey":"hunter2"}' to be '{"apiKey":"[REDACTED]"}'
  src/common/logger.test.ts:82
```

### 6.1 The vacuous guard, and the fix

Break #1 initially left the suite **fully green**. Cause: the generic fallback
`/sk-[A-Za-z0-9_-]{20,}/g` also matches `sk-or-v1-AAAA…`, so deleting the
specific pattern changed no observable behaviour and its test proved nothing.

Fix: the generic fallback now carries a negative lookahead,
`/sk-(?!(?:or-v1-|fish-))[A-Za-z0-9_-]{20,}/g`, so it cannot shadow a specific
pattern. Two tests keep the lists honest:

- `the generic sk- fallback does not shadow a specific prefix`
- `every sk- prefix is declared in both the pattern list and the exclusion list`

Re-running break #1 after the fix produced the 6 failures quoted above. This is
the single most important finding of the W2b pass: **without the fix, three of the
prefix tests would have been decorative.**

### Restore verification
```
--- BREAK-THE-GUARD markers remaining (must be 0) ---
(none)
--- pino in package.json --- absent
=== my 3 test files, isolated === 29 passed (3)
```

---

## 7. Gate results

| Gate | Result | Exit |
|---|---|---|
| `npx tsc --noEmit` | clean | **0** |
| `npm run typecheck:tests` | **0 errors** (held at 0, per exit criteria) | **0** |
| `npx eslint` scoped to my write set | clean | **0** |
| `npx oxlint` scoped to my write set | **0 warnings, 0 errors** | **0** |
| `npx vitest run` (my 3 files) | **29 passed** (baseline for these files was 6) | **0** |
| `npm run build` | clean; `doctor` output byte-identical to before | **0** |

**No real key material was read, printed, echoed or committed.** All fixtures are
synthetic: `sk-or-v1-` / `sk-fish-` / `gsk_` followed by `'A'.repeat(48)`.
`.env.local` was never opened.

---

## 8. Repo-wide gate state — NOT attributable to W2b

W2b workers share one working tree. Other workers were editing concurrently while
these gates ran. **W2b's numbers are above; the repo-wide numbers below are
context for the orchestrator and are other workers' in-flight state.**

| Gate | Repo-wide | Cause |
|---|---|---|
| `npm run lint:ox` | **9 warnings, baseline 8 → FAIL** | The 9th is `apps/desktop/src/App.tsx:91` `react(set-state-in-effect)`. That file is `M` (dirty, +45/−7) from a peer and the warning is absent at HEAD. **oxlint scoped to the W2b write set reports 0.** W2b did not touch it and did **not** raise `scripts/lint-baseline.json`. |
| `npm run lint` | 2 errors | `src/daemon.ts:2` unused `rmSync`, `src/daemon.ts:41` unused `loadLayaAdvisory`. `src/daemon.ts` is `M` from a peer. eslint scoped to the W2b write set reports **0**. |
| `npm run typecheck:tests` | 2 errors (late, appeared mid-session) | `src/daemon-barge-in.test.ts:124` and `src/orchestrator/audio-pipeline-abort.test.ts:138`. Both files are **untracked (`??`)** peer WIP and neither imports anything from the W2b write set (grep for `logger|telemetry|redact` returns nothing). W2b held this gate at **0 errors** when last run against a peer-clean tree. |
| `npx vitest run` | 630 tests, 628 passed, **2 failed** | Both in `src/policy/laya-sidecar-safety.test.ts` (untracked, a peer's file). They fail on `src/daemon.ts` containing `import { loadLayaAdvisory } from './runtime/laya/index.js';` — a static import their own policy test forbids. Peer self-conflict. |
| Reachability | 56 live / 1 dead | The dead module is `src/runtime/laya/index.ts`, a peer's file. Measured mid-edit, so the count moved during the session (51/6 → 56/1). **`src/common/logger.ts: REACHABLE`, `src/telemetry/writer.ts: REACHABLE`.** W2b added and deleted **zero** production modules, so the metric is unchanged by W2b. |

Independently verified that W2b contributes none of the above:
```
$ node w2b-laya-audit.mjs            # static laya-engine import edges by file
src/runtime/laya/index.ts         -> ["./laya-engine.js","..."]
src/runtime/laya/laya.integration.test.ts -> ["./laya-engine.js"]
src/runtime/laya/laya.test.ts     -> ["./laya-engine.js"]
src/runtime/laya/loader.ts        -> ["./laya-engine.js"]
total static laya-engine edges in src/: 5
edges originating in the W2b write set: 0
```
The only `LAYA` strings in the W2b write set are the pre-existing
`SubsystemSchema` zod enum value (`src/telemetry/writer.ts:37`) and its uses in
tests — a string literal, not an import edge.

### Process note (self-reported)
For one A/B measurement of the oxlint baseline I ran `git stash push -u` /
`git stash pop` in the **shared** working tree. It round-tripped cleanly with no
conflicts and no loss, but it briefly removed peers' in-flight work. That was the
wrong tool in a shared tree; the scoped `npx oxlint <paths>` comparison used
afterwards gives the same answer without touching anyone's files.

---

## 9. Files changed (write set, uncommitted)

```
 M package.json                      pino removed from dependencies
 M src/common/logger.ts              REWRITTEN — zero-dependency redaction + logger
 M src/common/logger.test.ts         REWRITTEN — 2 tests -> 21
 M src/telemetry/writer.ts           redaction in record() + flush diagnostic
 M src/telemetry/index.ts            type re-exports (unchanged set)
?? src/telemetry/writer-redaction.test.ts   NEW — 4 tests
```

`dist/` is gitignored; the rebuild left the tree clean.

**Nothing committed. Nothing pushed.** `HEAD` is still `2529fc3`.

---

## 10. Recommended follow-ups (not done — out of write set)

1. **`scripts/provision-sidecar.mjs:53`** — delete `'pino': '^9.0.0',`. Until
   then the sidecar payload still carries pino and the pruning is cosmetic.
2. **`src/common/index.ts:7`** — could now export `redactString`, `redactObject`,
   `REDACTION_MARKER`, `LIVE_PREFIXES` so the barrel matches the module. Optional.
3. **`src/daemon.ts`** — the daemon has no `console.*` diagnostics at all, so
   `createLogger` has exactly one production caller (the telemetry writer). Wiring
   it further belongs to whoever owns `daemon.ts`.
4. **UNVERIFIED:** whether any *other* subsystem logs provider keys. Only the
   modules in the W2b write set were audited. `src/voice/`, `src/orchestrator/`
   and `src/runtime/` were not searched for `console.*` sinks carrying keys.
