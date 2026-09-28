# 50 — W5: Laya System-1 restoration, quarantined behind `import()`

Wave 2, Worker W5. Stage 1 only. **Not committed.**

Every claim below is cited to `file:line` in the tree as it stood at the end of
this lane. Anything I did not run is marked UNVERIFIED.

---

## 1. The headline answer

**`src/runtime/laya/laya-engine.ts` imports `onnxruntime-node` STATICALLY
(`laya-engine.ts:1`). Nothing statically reachable from the daemon reaches that
file. The only sanctioned entry, `src/runtime/laya/loader.ts`, reaches it through
`await import('./laya-engine.js')` (`loader.ts:95`).**

That is the same shape as `vad.ts:2` + `daemon.ts:338`, plus one extra layer:
`loader.ts` holds **no specifier-bearing edge to the engine at all**, so even a
static `import { loadLayaAdvisory } from './runtime/laya/loader.js'` in the daemon
would be survivable. Two layers, so one careless re-export cannot re-arm v0.6.0.

---

## 2. Write set

| Path | State |
|---|---|
| `src/runtime/laya/tokenizer.ts` | restored verbatim from quarantine |
| `src/runtime/laya/laya-engine.ts` | restored; indentation of `decide()` fixed (`:91-102` was a botched block); constants split out; `NATIVE MODULE BOUNDARY` header added |
| `src/runtime/laya/index.ts` | rewritten as the documented public surface |
| `src/runtime/laya/__fixtures__/tokenizer_golden.json` | restored verbatim |
| `src/runtime/laya/constants.ts` | **new** — dependency-free, so `loader.ts` needs no edge to the engine |
| `src/runtime/laya/types.ts` | **new** — `LayaDecision` moved here for the same reason |
| `src/runtime/laya/loader.ts` | **new** — the seam |
| `src/runtime/laya/telemetry.ts` | **new** — the LAYA producer |
| `src/runtime/laya/laya.test.ts` | **new** — hermetic, 10 tests |
| `src/runtime/laya/loader.test.ts` | **new** — 13 tests |
| `src/runtime/laya/laya.integration.test.ts` | **new** — opt-in live gates, 3 tests |
| `src/policy/laya-sidecar-safety.test.ts` | **new** — the guard, 10 tests |

`git status` shows only these paths for this lane. No tracked file was modified:
`git diff --name-only` lists only other lanes' in-flight work
(`src/daemon.ts`, `src/telemetry/*`, `src/common/logger*`, `src/knowledge/shared/commands.ts`,
`src/orchestrator/audio-pipeline.ts`, `scripts/provision-sidecar.mjs`, `apps/**`,
`package.json`).

---

## 3. The two edges that must never be static

`src/runtime/laya/loader.ts:95`

```ts
    const mod = await import('./laya-engine.js');
```

`src/runtime/laya/loader.ts` has **no other** engine specifier. The `LayaDecision`
type it needs lives in `types.ts`; the head list lives in `constants.ts`. This was
not the original design and I changed it because of §6.2.

`src/runtime/laya/index.ts:27` re-exports `LayaEngine` from `./laya-engine.js`, so
**the barrel is poison**. `index.ts:1-16` says so at the top. The daemon must not
name it.

---

## 4. The guard test

`src/policy/laya-sidecar-safety.test.ts` — 10 tests. The two load-bearing ones,
verbatim:

```ts
  test('laya-engine.ts is NEVER statically reachable from src/daemon.ts', () => {
    const result = walkFrom(DAEMON);
    expect(
      result.statics.has(LAYA_ENGINE),
      'src/daemon.ts reaches src/runtime/laya/laya-engine.ts through a static import. ' +
        'That file imports onnxruntime-node, which the sidecar does not bundle: the daemon ' +
        'will die with ERR_MODULE_NOT_FOUND and never bind 4097. Import it with `import()`.',
    ).toBe(false);
    // And the broader invariant, stated once, over every native package.
    expect(
      result.offenders,
      `native packages STATICALLY reachable from daemon.ts:\n${result.offenders.join('\n')}`,
    ).toEqual([]);
  });
```

```ts
  test('the sanctioned entry holds NO specifier-bearing edge to the engine', () => {
    // B: loader.js is the file the daemon is told to name. It must be safe even
    // if someone imports it STATICALLY, which means it must not reach the engine
    // by any static edge — not even an `import type`, which TypeScript erases and
    // which is therefore safe but unreadable-as-safe. The `LayaDecision` type was
    // moved to ./types.js so this file has nothing to exempt.
    const src = readFileSync(LAYA_LOADER, 'utf8');
    expect(src).toMatch(/import\(\s*'\.\/laya-engine\.js'\s*\)/);
    const staticEdges = src
      .split('\n')
      .map((line, i) => [`${LAYA_LOADER}:${i + 1}`, line] as const)
      .filter(([, line]) => /\bfrom\s+'[^']*laya-engine/.test(line) || /^\s*import\s+['"][^'"]*laya-engine/.test(line));
    expect(
      staticEdges.map(([where, line]) => `${where}  ${line.trim()}`),
      'src/runtime/laya/loader.ts must hold no static edge to the engine. An `import type` is ' +
        'erased by tsc and is therefore safe, but a reader should not need to know that to ' +
        'trust this file. Put the type in ./types.js.',
    ).toEqual([]);
```

The other eight: the scanner catches a static edge to a native package on a
synthetic tree; the scanner ignores an unreached subtree; a comment that looks like
an import is not an edge; a static cycle terminates; the premise holds
(`laya-engine.ts` really does statically import ORT); no module under
`src/runtime/laya/` except the engine imports a native package; `daemon.ts` holds
no static import of anything under `runtime/laya/`; the LAYA producer exists and
the writer's union member is not orphaned.

---

## 5. Break-the-guard transcript

Both edits were made, the suite was run, and both edits were reverted. The
`daemon.ts` revert was verified by SHA-256 of the whole file before and after.

### 5.1 Value import in `loader.ts`

```
> Copy-Item src\runtime\laya\loader.ts $env:TEMP\w5-loader.bak -Force
> (Get-Content $b) -replace "^import \{ LayaBpeTokenizer \} from './tokenizer.js';$",
    "import { LayaBpeTokenizer } from './tokenizer.js';`nimport { LayaEngine } from './laya-engine.js';"
  | Set-Content src\runtime\laya\loader.ts

  5 import { LayaEngine } from './laya-engine.js';     <- injected

> npx vitest run src/policy/laya-sidecar-safety.test.ts

  Tests  2 failed | 8 passed (10)

  AssertionError: src/daemon.ts reaches src/runtime/laya/laya-engine.ts through a
    static import. That file imports onnxruntime-node, which the sidecar does not
    bundle: the daemon will die with ERR_MODULE_NOT_FOUND and never bind 4097.
    Import it with `import()`.: expected true to be false

  + [ "O:\opencode-Vantrilex\src\runtime\laya\loader.ts:5  import { LayaEngine } from './laya-engine.js';", ]

> Copy-Item $b src\runtime\laya\loader.ts -Force      <- reverted
```

**Two** tests went red, not one: the graph walk and the line-anchored check.

### 5.2 Static barrel import in `daemon.ts`

```
> Copy-Item src\daemon.ts $env:TEMP\w5-daemon2.bak -Force
> (Get-FileHash src\daemon.ts -Algorithm SHA256).Hash
  FDFF7FA78429CB34686C2471EA56E6B150BFFA2D9F5618532342307276DB8213

> # inject: import { loadLayaAdvisory } from './runtime/laya/index.js';
  47 import { loadLayaAdvisory } from './runtime/laya/index.js';     <- injected

> npx vitest run src/policy/laya-sidecar-safety.test.ts

  Tests  2 failed | 8 passed (10)

  AssertionError: src/daemon.ts reaches src/runtime/laya/laya-engine.ts through a
    static import. ... expected true to be false

  AssertionError: expected 'import { randomBytes, randomUUID } fr…' not to match
    /^\s*import\s[^\n]*from\s+['"][^'"]*runtime\/laya[^'"]*['"]/m

> Copy-Item $env:TEMP\w5-daemon2.bak src\daemon.ts -Force
> (Get-FileHash src\daemon.ts -Algorithm SHA256).Hash
  FDFF7FA78429CB34686C2471EA56E6B150BFFA2D9F5618532342307276DB8213   <- identical
```

`src/daemon.ts` today contains **zero** occurrences of `laya` (case-insensitive),
verified after all experiments.

---

## 6. Two defects found in the guard infrastructure itself

### 6.1 The pre-existing walker in `sidecar-safety.test.ts` is exponential — **HIGH, must fix before wiring**

`src/policy/sidecar-safety.test.ts:67-70`:

```ts
      const known = queue.some(([f]) => f === cand);
      if (!known || (isStatic && !anyReach.has(cand))) {
        queue.push([cand, isStatic]);
      }
```

`known` is only true while the file is *in the queue*. Once popped, a file is
"unknown" again, so every static edge back into a popped module re-queues it, and
re-processing a module re-runs its own `enqueue` calls. The walk is therefore
re-executed once per path — exponential in the number of joins.

**Measured A/B, in memory, repo never written to** (script kept in
`%LOCALAPPDATA%\Temp\opencode\w5-ab.mjs`, copies the walker verbatim from
`sidecar-safety.test.ts:42-93` and injects one line into the daemon *source
string*):

```
> node w5-ab.mjs head
mode=head runaway=false pops=45 anyReach=33 elapsed=16ms
  laya-engine statically reachable: false

> node w5-ab.matched patched     # + the sanctioned import('./runtime/laya/loader.js')
<no output — did not terminate in 300 s, with a 3,000,000-pop safety cap>
```

Via vitest, the same defect presents as a hang and then a worker OOM:

```
  FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
   1: 00007FF62C3B8B26 node::OnFatalError+1318
  Error: [vitest-pool]: Worker forks emitted error.
  Caused by: Error: Worker exited unexpectedly
```

This is **pre-existing and not caused by the laya files** — the files are eight
leaf modules with no cycles. The laya dynamic edge simply adds a second route
into `src/runtime/`, and that is the last straw. `src/policy/sidecar-safety.test.ts`
is not in my write set and was being edited by another lane while I worked, so I
did **not** apply the fix. It belongs in the same commit as the `daemon.ts` edit.

Verified fix (11 ms, 34 pops, 0 offenders, still reports `vad` and `laya-engine`
correctly):

```ts
    const done = new Set<string>();            // next to `staticReach`
    ...
      const key = `${cand}|${isStatic ? 's' : 'd'}`;
      if (!done.has(key)) { done.add(key); queue.push([cand, isStatic]); }
    ...
      const [file, isStatic] = queue.pop() as [string, boolean];
      if (done.has(`${file}|seen`)) continue;
      done.add(`${file}|seen`);
      if (!existsSync(file)) continue;
      const src = readFileSync(file, 'utf8');
      const isStaticNode = staticReach.has(file) || isStatic;   // replaces staticReach.has(file)
```

Keying on `file|isStatic` (not just `file`) matters: a module first reached
dynamically must still be re-scanned when a static edge to it turns up, or the
`offenders` list goes silently blind.

### 6.2 A comment that looks like an import is an edge — found in my own scanner, fixed

My first scanner read the header comment in `loader.ts` — "loaded through
`` import('./runtime/vad.js') ``" — as a real dynamic edge, and the comment in
`laya-engine.ts` mentioning `` import('./laya-engine.js') `` as a self-edge. The
self-edge then tripped the same non-termination as §6.1 and reported
`laya-engine.ts` as statically reachable **through itself**.

`stripComments()` (`laya-sidecar-safety.test.ts:37-49`) now removes full-line and
block comments before matching, and a dedicated test
(`'a comment that looks like an import is NOT an edge'`) pins it. Trailing `//`
after code is deliberately left alone so the URL in `vad.ts:11` is not mangled.

I did not retrofit this into `sidecar-safety.test.ts`; same reasoning as §6.1.

---

## 7. The seam — the exact `daemon.ts` edit the orchestrator must apply

Mirrors `daemon.ts:332-343` (the VAD). Insert near the `record` helper
(`daemon.ts:293`), inside `startDaemon`:

```ts
  type LayaAdvisoryLike = { decide(text: string): Promise<unknown | null> };
  let layaLoad: Promise<LayaAdvisoryLike | null> | null = null;
  const loadLaya = (): Promise<LayaAdvisoryLike | null> => {
    if (layaLoad === null) {
      layaLoad = import('./runtime/laya/loader.js')
        .then((m) => m.loadLayaAdvisory({ sink: record }) as Promise<LayaAdvisoryLike>)
        .catch(() => null);
    }
    return layaLoad;
  };
```

The single line that matters is:

```ts
      layaLoad = import('./runtime/laya/loader.js')
```

**`loader.js`, never `index.js`.** `index.js` re-exports the engine and is
therefore fatal if imported statically. `record` is `daemon.ts:293`'s
`Omit<TelemetryInput,'sessionId'|'eventId'>` helper and satisfies
`LayaTelemetrySink` structurally — no adapter.

`loadLayaAdvisory` never throws (`loader.ts:73-130`): a missing model, a missing
tokenizer, a corrupt vocab and a missing native binary all return `null`, and
`decide()` fails **open** — `null`, so the caller speaks (`loader.ts:110-129`).

**Before applying this, apply the §6.1 fix to `sidecar-safety.test.ts` in the same
commit**, or the gate hangs.

---

## 8. Telemetry — the LAYA producer and its call site

`src/telemetry/writer.ts:36` has accepted `'LAYA'` since the schema was written.
Verified at the time of writing that no module in `src/` produced one. (A lane has
since added `LAYA` rows to `writer.test.ts` and `writer-redaction.test.ts`; those
are schema tests, not a producer.)

`src/runtime/laya/telemetry.ts` is the producer. It exports
`layaTelemetryRow(facts)` (pure) and `emitLayaTelemetry(sink, facts)`
(swallows everything, like `daemon.ts:293-299`).

Design decisions, all forced by `writer.ts`:

- **No text, ever.** The schema has no transcript field (`writer.ts:6-7`), so
  `LayaTelemetryFacts` carries only numbers and closed-union members. A test
  asserts the key set is exactly `['latencyMs','sanitizedErrorClass','status','subsystem']`
  and that the JSON never matches `/transcript|utterance|prompt|reply|text/i`.
- **No invented `errorCode`.** The closed union at `writer.ts:38-61` has no LAYA
  member, and `writer.ts:45-48` says in as many words that reusing a sibling
  subsystem's code "would have put a lie in the data, which is the one thing this
  file must not do". So: a model that will not load is `DEGRADED` +
  `errorCode: 'CONFIG_INVALID'` (honest — the path is wrong or absent) and
  `sanitizedErrorClass: 'OnnxError'`, which is the one union member that is
  specifically about a local ONNX graph and previously had no producer
  (`writer.ts:14`). Never `ERROR`: Laya is advisory.
- **Missing heads are `ContractDrift`.** `laya-engine.ts:107-111` scores an absent
  `logit_*` as `0.0`, which downstream reads as "confidently not destructive".
  A silent zero is the dangerous case, so it is `DEGRADED` /
  `sanitizedErrorClass: 'ContractDrift'`, not a quiet `OK`.

**Call site:** none needed in `daemon.ts` — pass `record` as the `sink` in the
`loadLayaAdvisory({ sink: record })` call above and every decision is reported.
`src/telemetry/writer.ts` was **not** modified by this lane.

---

## 9. Measured numbers

`npx vitest run` — **655 passed, 53 files, 0 skipped, exit 0.** My lane adds
**34 tests across 4 files** (10 + 13 + 3 + 10... precisely: `laya.test.ts` 10,
`loader.test.ts` 13, `laya.integration.test.ts` 3, `laya-sidecar-safety.test.ts`
10 = 36). Baseline before this lane was 573 / 46; other lanes added the rest.

Opt-in live gates, actually run (this is a real measurement, not a doc number):

```
$ LAYA_LIVE=1 LAYA_TOKENIZER_PATH=<hf cache>/tokenizer.json npx vitest run src/runtime/laya/laya.integration.test.ts
LAYA live: n=40 p50=20.0ms destructiveMean=0.854 routineMean=0.076
  ✓ tokenizer matches the Python `tokenizers` output byte-for-byte   1374ms
  ✓ p50 decision < 40 ms and the destructive head separates held-out classes  5697ms
  ✓ a missing model surfaces as a rejected decision, not a silent 0.0  1224ms
Tests  3 passed (3)
```

- Tokenizer parity against the Python `tokenizers` library: **byte-for-byte, 0
  mismatches** over the whole golden fixture.
- **p50 = 20.0 ms** at the 32-token operating length (budget 40 ms). This confirms
  the `p50 25.8 ms` figure in the quarantined comment rather than repeating it.
- Destructive head separation: 0.854 vs 0.076 routine, i.e. a **0.778** gap
  (gate requires > 0.3).

Gates: `tsc --noEmit` **0** · `npm run typecheck:tests` **0** ·
`eslint src/runtime/laya src/policy/laya-sidecar-safety.test.ts --max-warnings 0`
**0** · `npm run lint:ox` **8 warnings, 0 errors; baseline 8** (unchanged).

**UNVERIFIED:** Stage 2. No native bundling, no `provision-sidecar.mjs` change, no
`Cargo.toml`, no `models/`, no `ml/`, no installer change. An installed build has
not been launched; per this project's own history, green gates do not mean the
sidecar boots.

**UNVERIFIED:** the live numbers above are from this machine, CPU provider,
`intraOpNumThreads: 0`, one run. Not a p99, and not a distribution.

---

## 10. Not done, deliberately

- **Stage 2.** No native dependency added to the shipped sidecar. The measured
  20 ms p50 is real, but it buys nothing until a model is actually bundled, and
  bundling a second native module is the exact failure class this project is
  recovering from.
- **No `models/` or `ml/` edits.** The int8 graph and the Python were read only.
- **`src/common/config.ts` untouched** (not in my write set). The loader reads
  `LAYA_MODEL_PATH` / `LAYA_TOKENIZER_PATH` from the environment instead, with
  `models/laya-m7-int8.onnx` as the model default (`loader.ts:56`). The
  tokenizer has **no** default on purpose: the checkpoint `tokenizer.json` is a
  ~40 MB HF artifact that is not vendored, so the honest answer when it is absent
  is `null`.
- **`laya.integration.test.ts` uses an early `return`, not `skipIf`**, matching
  `vad.test.ts:59`, so the suite stays "0 skipped" and the headline count keeps
  meaning something.

## 11. Concurrency hazards observed

This lane ran against four other workers editing the same tree. Two transient
failures were theirs, not mine, and both cleared:

- `tsc` reported `TS2724: '"./telemetry/index.js"' has no exported member named
  'SanitizedErrorClass'` at `daemon.ts:42` mid-edit by a telemetry lane.
- `typecheck:tests` reported `TS2304: Cannot find name 'LayaAdvisoryLike'` ×3 at
  `daemon.ts:370-374` while a `daemon.ts` laya wiring was being written.

Both resolved to 0 on re-run. The `daemon.ts` laya wiring I was asked to report
was applied and then removed by another lane during this session; `daemon.ts` has
zero `laya` references now, so §7 is un-applied as of this writing.
