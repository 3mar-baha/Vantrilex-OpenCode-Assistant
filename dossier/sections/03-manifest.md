# 03 — Exhaustive Directory & File Manifest

**Snapshot:** `2026-09-30T12:04:16.274Z` · **HEAD:** `9f41c96` · **Working tree:** dirty (see §0.4).
**Method:** every claim below is derived from a file on disk. No documentation was opened. See §0.1.

---

## 0. Method, scope and honesty statement

### 0.1 Documents deliberately NOT opened

Per the zero-trust rule, I did **not** read, cite, or rely on any of:

`docs/` (all 52 tracked files, including `docs/HEADLESS-BRIDGE-VERIFY.md`), `README.md`, `README.ar.md`, `CHANGELOG.md`, `AGENTS.md`, `CONTRIBUTING.md`, and `dossier/PROJECT_MASTER_DOSSIER.md` (74,552 B).

**Code comments were also excluded as evidence.** Where a comment asserts a fact, I either verified the fact independently and cite the code, or I report the comment as unverified. Two places where a comment contradicts its own code are called out in §9.

The briefing I was given was treated as a **lead list, not evidence**. Every numeric and structural claim in it was re-derived; §9 lists every point where the tree disagreed with it.

### 0.2 Scope definition — and where it differs from the briefing

I define a **project source file** as any file under `src/`, `apps/`, `scripts/` or `ml/` carrying a code extension (`.ts .tsx .mjs .js .py`), excluding `node_modules`, `.venv`, `dist`, `target`, `sidecar`, `__pycache__`, `test-results`, `playwright-report`, `artifacts`, `audio-cache`, `models`, `vault`, `.hf_cache`, `.opencode`, `dossier`, `docs`, `assets`.

Command used (`C:\Users\omarb\AppData\Local\Temp\opencode\recensus.mjs`, Node, no repo writes):

```
Get-ChildItem -Path src,apps,scripts,ml -Recurse -File   # after the exclusion filter
```

| Set | Count |
|---|---|
| **All files** under the 4 roots (incl. icons, data, configs) | **400** |
| **Code files** (`.ts .tsx .mjs .js .py`) | **306** |
| — production (non-test) code files | **158** |
| — test code files (`*.test.*` / `*.spec.*`) | **148** |
| Git-tracked files, whole repo | 643 |
| Git-tracked `.py` files | 18 (all under `ml/`) |

By root:

| Root | All files | Code | Production | Test |
|---|---|---|---|---|
| `src/` | 169 | 168 | 82 | 86 |
| `apps/desktop/` | 179 | 109 | 47 | 62 |
| `scripts/` | 11 | 10 | 10 | 0 |
| `ml/` | 41 | 19 | 19 | 0 |
| **Total** | **400** | **306** | **158** | **148** |

**The briefing said 279 files (`src` 157, `apps` 110, `scripts` 10, `ml` 1). I measure 306
(`src` 168, `apps` 109, `scripts` 10, `ml` 19).**
The gap is almost entirely `ml/`: the briefing's `ml` 1 is wrong by 18 — there are **19** code files
there (18 `.py` + 1 `.mjs`). `scripts` 10 matches exactly. `src` is +11 and
`apps` is -1; part of the `src` delta is 11 untracked files in
`src/cli/` that a concurrent agent created *during this audit* (§0.4).

### 0.3 Python files — the `.venv` claim is false as stated

| Command | Result |
|---|---|
| `Get-ChildItem -Recurse -Filter *.py -File | Measure-Object` | **12339** |
| same, under `.venv` | **12317** |
| same, **outside** `.venv` | **22** |
| `git ls-files '*.py' | Measure-Object` | **18** |

The briefing said "12,338 `.py` files exist and ALL are inside `.venv`". Both numbers are wrong:
12,339 exist, and 22 are outside `.venv`. The *substantive* conclusion survives and is what matters
for the census — **exactly 18 are project code, all under `ml/`**. The other 4 outside `.venv` are:- `.hf_cache/hub/datasets--KareemBb--Jordanian-Dialect-Instruct-QA/.no_exist/…/Jordanian-Dialect-Instruct-QA.py` — 0 B
- `.hf_cache/modules/__init__.py` — 0 B
- `.hf_cache/modules/datasets_modules/__init__.py` — 0 B
- `node_modules/flatted/python/flatted.py` — 3,773 B

None is project code. All `.venv` and `node_modules` `.py` files are excluded from every count below.

### 0.4 The tree is a moving target — read this before trusting any row

**A concurrent agent is actively writing `src/cli/` and `src/cli.ts`.** Observed during this audit:

| Time (local) | `src/cli/` file count | `src/cli.ts` |
|---|---|---|
| 14:41 | 5 | tracked, clean |
| 14:48 | 8 | tracked, clean |
| 14:54 | 11 | **modified, +14 lines** |
| 15:04 (final snapshot) | **13** (5 of them `*.test.ts`) | **modified, +22 lines** |

`git status --short --untracked-files=all src/` at the final snapshot: **13 untracked files** under
`src/cli/`, plus `src/cli.ts` listed as modified — **14 entries, none of them mine.**

**Consequences, stated plainly:**

1. `src/cli/` is **NOT complete** and I do not report it as complete. Its 13 rows in §1 are a snapshot, not a census of a finished subsystem. Three of its files grew between my first and last read: `intents.ts` 13,099 → 13,913 B, `serve.ts` 11,168 → 12,235 B, `turn.ts` 18,026 → 21,836 B.
2. `src/cli.ts` is **modified in the working tree**, so my rows for it describe the working-tree file, not HEAD `9f41c96`.
3. Every count in this section is **computed at the snapshot stamp in the header**, not transcribed by hand. A later change can move them.
4. **I modified no source file.** The ` M src/cli.ts` line is the concurrent agent's edit, not mine. I wrote exactly one file: this section.

### 0.5 Entrypoints — found from code, not from docs

| Entrypoint | Physical evidence |
|---|---|
| `src/cli.ts` | `package.json:8` — `"bin": { "opencode-voice": "./dist/cli.js" }` |
| `apps/desktop/src/main.tsx` | `apps/desktop/index.html` loads `/src/main.tsx` |
| `apps/desktop/src-tauri/src/main.rs` | `fn main()` at `main.rs:3256`, `tauri::Builder` at :3259 |
| `scripts/docs-verify.mjs` | `package.json` `scripts.docs:verify` |
| `scripts/docs-verify-self-test.mjs` | `package.json` `scripts.docs:verify:self-test` |
| `scripts/lint-baseline.mjs` | `package.json` `scripts.lint:ox` |
| `scripts/release-verify.mjs` | `package.json` `scripts.release:verify` |
| `scripts/test-blindspots.mjs` | `package.json` `scripts.test:blindspots` |
| `scripts/packaging-preflight.mjs` | imported/invoked by `scripts/release-verify.mjs` |
| `scripts/provision-sidecar.mjs` | release flow; no `package.json` script |
| `scripts/generate-whiteboard-assets.mjs` | manual; no `package.json` script |
| `scripts/key-report.mjs` | manual; no `package.json` script |
| `scripts/live_console_test.ts` | `live_console_test.ts:5` — `// Run: node scripts/live_console_test.ts` |
| `apps/desktop/e2e/stub-daemon.mjs` | Playwright `webServer` target |
| `apps/desktop/playwright.config.ts` | `package.json` (desktop) `test:e2e` → `playwright test` |
| `apps/desktop/vite.config.ts`, `vitest.config.ts`, `tailwind.config.ts`, `postcss.config.js` | build/test pipeline roots |
| `apps/desktop/scripts/gen-icons.mjs` | manual icon regeneration |
| every `*.test.ts` / `*.spec.ts` | a test root by construction |

**`main.rs` is NOT in the TypeScript import graph.** It reaches the daemon through a *process* edge, not an *import* edge: `main.rs:1529-1531` builds `Command::new(&node)`, then `.arg(plain_path(&entry))` where `entry` comes from `resolve_daemon_entry()` (`main.rs:1263`), then `.arg("serve")`. That is why the TS graph's LIVE set is seeded by `src/cli.ts` and not by the Rust binary. I state this because a walk that only follows imports would call the whole daemon unreachable from the shipped desktop app, which is false.

### 0.6 The reachability algorithm — stated in full

A dead-code claim without an algorithm is an assertion. Mine, in order:

1. **Collect.** Walk `src/`, `apps/desktop/src/`, `apps/desktop/e2e/`, `apps/desktop/scripts/`, `scripts/` plus 9 named config/Rust files. Keep `.ts .tsx .mjs .js`. Result: **287 modules**.
2. **Mask before matching.** For each file, build a character mask that blanks **comment bodies, string-literal bodies, template-literal bodies and regex literals**, preserving byte offsets and newlines. I match import keywords in the masked space and read the specifier from the **raw** text at the same offset. Regex-literal masking is not optional: `src/policy/laya-sidecar-safety.test.ts` embeds `import` inside four regex literals, and without this step my first run produced a **phantom edge to `./laya-engine.js`**. That was a false positive in my own tool, found and fixed before any number was reported.
3. **Extract triggers.** `import`, `export … from`, `require(`, `vi.mock|importActual|importMock`, `jest.mock`. **Dynamic `import()` is captured as an edge** — required, because the tree contains a deliberately-late-loaded module (§7).
4. **Resolve.** NodeNext semantics: a `./x.js` specifier written in TS resolves to `x.ts`/`x.tsx` on disk; extensionless specifiers try `.ts .tsx .js .mjs /index.ts /index.tsx /index.js`; Vite `?raw`/`?url` query suffixes are stripped. A repo-root `dist/**` target is **remapped back to `src/**`**, because `dist/` is tsc output and those specifiers name the module's origin, not a source file.
5. **BFS** from the production roots and separately from every test file, over the same graph.
6. **Classify** each non-test module: reachable from a production root → `LIVE` (or `LIVE+TEST` if a test also reaches it); reachable only from tests → `TEST-ONLY`; from neither → `DEAD`. Test files are `TEST-FILE`.

**Measured totals — 287 modules in the graph:**

| Class | Count |
|---|---|
| **LIVE** (production-reachable, no test touches it) | **22** |
| **LIVE+TEST** (production-reachable and test-reachable) | **106** |
| **TEST-ONLY** (test-reachable, never production-reachable) | **10** |
| **DEAD** (no root reaches it, not even a test) | **1** |
| **TEST-FILE** (a test file itself) | **148** |
| **Total** | **287** |

Restated over **production modules only** (287 − 148 = 139):

- **LIVE production modules: 128** (22 + 106)
- **TEST-ONLY production modules: 10**
- **DEAD production modules: 1**

**The single DEAD module:** `src/runtime/laya/index.ts`

**The 10 TEST-ONLY modules:** `src/policy/claim-matcher.ts`, `src/runtime/laya/constants.ts`, `src/runtime/laya/laya-engine.ts`, `src/runtime/laya/loader.ts`, `src/runtime/laya/telemetry.ts`, `src/runtime/laya/tokenizer.ts`, `src/runtime/laya/types.ts`, `apps/desktop/src/components/brand/Crest.tsx`, `apps/desktop/src/matrix/script-check.ts`, `apps/desktop/e2e/keys-window.ts`

### 0.7 What the scan could NOT resolve — the honest limits

- **1 unresolved specifier, and it is a real break:**
  `scripts/live_console_test.ts:10` imports `../dist/orchestrator/index.js`, which maps to `src/orchestrator/index.ts` — **a file that does not exist.** Verified: `Get-ChildItem src/orchestrator -Filter "index*"` returns nothing, and the 8 barrels that do exist are `src/common`, `src/ipc`, `src/knowledge`, `src/launcher`, `src/runtime`, `src/runtime/laya`, `src/tasks`, `src/telemetry`.
- **Stale `dist/` masks the break.** `dist/orchestrator/` currently contains 7 modules with **no `src/` counterpart**: `index`, `dispatch`, `events`, `laya-advisor`, `ledger`, `orchestrator`, `queue`. `dist/` is 303 files of tsc output from an earlier tree. A green `npm run build` without a clean would leave the stale `dist/orchestrator/index.js` in place and the break would go unseen.
- **Bare (npm) specifiers are recorded but not resolved.** I counted them and listed notable ones per row, but I did not walk `node_modules`, so a package that reaches back into `src/` via a path alias would be invisible. No tsconfig `paths` alias exists to do that (`tsconfig.json` has `rootDir: "src"`, no `paths`).
- **Three non-module relative targets** are real files that are not TS modules and are excluded from the graph: `apps/desktop/src/index.css` (imported by `App.tsx` and `main.tsx`), and `ml/data/splits/test.jsonl` (imported by `laya.integration.test.ts`).
- **Python is not walked at all.** The 18 `ml/*.py` files form a separate offline toolchain with its own internal imports; they are tabulated in §2 but are not in the reachability classification.
- **The E2E layer is a fake control plane.** `apps/desktop/e2e/stub-daemon.mjs` runs a real `UiServer` and a real command router but on a fake control port (4197) with no providers and no vault. E2E specs therefore do **not** prove `src/cli.ts` works, and do not touch the real `serve` on 4096.

---

## 1. The manifest — TypeScript / JavaScript (288 files)

`imports` = count of **resolved relative** edges. `→` lists up to 6 notable targets (test files filtered out).
`LIVE` = production-reachable · `LIVE+TEST` = both · `TEST-ONLY` = tests only · `DEAD` = nothing · `TEST-FILE` = is a test.

| path | bytes | purpose (derived from exports + body) | exports | imports | reachable |
|---|---|---|---|---|---|
| `apps/desktop/e2e/abort.spec.ts` | 1007 | Asserts: abort: wave snaps to idle and the daemon receives the command — 0 describe / 1 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/apikeys.spec.ts` | 3738 | Asserts: API key intake mandates all three keys, then dispatches saveApiKeys — 0 describe / 3 test blocks. | — (no exports) | 1 → apps/desktop/e2e/keys-window.ts | TEST-FILE |
| `apps/desktop/e2e/bargein.spec.ts` | 3126 | Asserts: voice during playback stops the daemon SPEECH, without cancelling the turn — 0 describe / 1 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/boot.spec.ts` | 2483 | Asserts: boot: HUD renders, status pill live, controls wired — 0 describe / 2 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/calibration.spec.ts` | 5160 | Asserts: the footer opens the calibration portal and the three phases run in order — 0 describe / 3 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/capture.spec.ts` | 1472 | Asserts: mic toggle streams PCM frames to the daemon, then stops — 0 describe / 1 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/controls.spec.ts` | 3085 | Asserts: agent/model switch round-trips with session scope — 0 describe / 2 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/credit.spec.ts` | 7372 | Asserts: an exhausted-credit notice renders the warn banner with the daemon wording — 0 describe / 6 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/delivery.spec.ts` | 6109 | Asserts: the player tells the daemon playback started, with a bounded correlation id — 0 describe / 3 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/disconnect.spec.ts` | 673 | Asserts: disconnect: killing the daemon degrades the bridge — 0 describe / 1 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/downlink.spec.ts` | 1151 | Asserts: spoken reply lights the speaking indicator — 0 describe / 1 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/fr12.spec.ts` | 2991 | Asserts: destructive shell parks until confirmed, then executes once — 0 describe / 1 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/inventory.spec.ts` | 1841 | Asserts: inventory snapshot populates chip; switch executes and acks — 0 describe / 1 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/keys-dacl.spec.ts` | 2777 | Asserts: C.1 — no Tauri host renders NO dacl line: an unverified lock must never read as a confirmed one — 0 describe / 2 test blocks. | — (no exports) | 1 → apps/desktop/e2e/keys-window.ts | TEST-FILE |
| `apps/desktop/e2e/keys-window.ts` | 3352 | Playwright page-object for the API-keys window. Reachable only from the e2e specs, not from any production entrypoint. | type DaclAnswer, openKeysWindow(), installVaultDaclShim(), shimLog(), fillKeys() | 0 → — | TEST-ONLY |
| `apps/desktop/e2e/matrix.spec.ts` | 946 | Asserts: wave follows daemon lifecycle: running→active, abort→idle — 0 describe / 1 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/portals.spec.ts` | 2671 | Asserts: settings opens in its own window, tabs swap content, Esc closes — 0 describe / 2 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/session-compact.spec.ts` | 2087 | Asserts: many historical sessions keep the HUD compact and the mic visible — 0 describe / 1 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/e2e/stub-daemon.mjs` | 5643 | E2E fake control plane: a real UiServer + real command router on a fake control port 4197, with no providers and no vault. | — (no exports) | 2 → src/ipc/ui-server.ts, src/orchestrator/command-router.ts | LIVE |
| `apps/desktop/e2e/ux.spec.ts` | 1881 | Asserts: voice phases drive the status pill (thinking → speaking) — 0 describe / 2 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `apps/desktop/playwright.config.ts` | 937 | Playwright config; defines the webServer that boots the stub daemon. | default | 0 → — | LIVE |
| `apps/desktop/postcss.config.js` | 81 | PostCSS/Tailwind plugin chain. | default | 0 → — | LIVE |
| `apps/desktop/scripts/gen-icons.mjs` | 3016 | Generates the Tauri icon set from a source image. | — (no exports) | 0 → — | LIVE |
| `apps/desktop/src/App.bento.test.tsx` | 29107 | Asserts: bento: the four surfaces compose, once each — 4 describe / 25 test blocks. | — (no exports) | 7 → apps/desktop/src/App.tsx, apps/desktop/src/components/bento/layoutBudget.ts, apps/desktop/src/components/terminal/TerminalDrawer.tsx, apps/desktop/src/settings/ipc-token.ts, apps/desktop/src/bridge/ws.ts, apps/desktop/src/audio/capture.ts | TEST-FILE |
| `apps/desktop/src/App.escape.test.tsx` | 14213 | Asserts: the escape slot survives a serve outage — 2 describe / 9 test blocks. | — (no exports) | 6 → apps/desktop/src/App.tsx, apps/desktop/src/serve-health-signal.ts, apps/desktop/src/settings/ipc-token.ts, apps/desktop/src/bridge/ws.ts, apps/desktop/src/audio/capture.ts, apps/desktop/src/audio/playback.ts | TEST-FILE |
| `apps/desktop/src/App.task-cards.test.tsx` | 14816 | Asserts: C.5: each inventory state lands as the right card — 4 describe / 8 test blocks. | — (no exports) | 6 → apps/desktop/src/App.tsx, apps/desktop/src/matrix/task-state.ts, apps/desktop/src/settings/ipc-token.ts, apps/desktop/src/bridge/ws.ts, apps/desktop/src/audio/capture.ts, apps/desktop/src/audio/playback.ts | TEST-FILE |
| `apps/desktop/src/App.test.tsx` | 17458 | Asserts: App: assistant mute is a real gate, not an ok:true (W6) — 3 describe / 13 test blocks. | — (no exports) | 5 → apps/desktop/src/App.tsx, apps/desktop/src/settings/ipc-token.ts, apps/desktop/src/bridge/ws.ts, apps/desktop/src/audio/capture.ts, apps/desktop/src/audio/playback.ts | TEST-FILE |
| `apps/desktop/src/App.tsx` | 52332 | The HUD root: composes the bento surfaces, owns the bridge subscription, and routes every user action to a WS command or a local state change. 23 imports. | App() | 23 → apps/desktop/src/bridge/ws.ts, apps/desktop/src/components/brand/WaveformEmblem.tsx, apps/desktop/src/components/waveform/SiriWaveCanvas.tsx, apps/desktop/src/components/session/AgentModelBadge.tsx, apps/desktop/src/components/session/ContextGauge.tsx, apps/desktop/src/components/bento/BentoGrid.tsx | LIVE+TEST |
| `apps/desktop/src/audio/calibration-meter.test.ts` | 9354 | Asserts: bandForFloorDb — three outcomes, probed at both boundaries — 4 describe / 14 test blocks. | — (no exports) | 2 → apps/desktop/src/audio/vad.ts, apps/desktop/src/audio/calibration-meter.ts | TEST-FILE |
| `apps/desktop/src/audio/calibration-meter.ts` | 6166 | Noise-floor calibration maths: band classification from a measured floor with a 15 dB quiet margin and p90 percentile floor. | const GATE_DB, const QUIET_MARGIN_DB, const MIN_SAMPLES, const FLOOR_PERCENTILE, type CalibrationBand, type CalibrationVerdict, bandForFloorDb(), calibrationVerdict() | 1 → apps/desktop/src/audio/vad.ts | LIVE+TEST |
| `apps/desktop/src/audio/capture-energy.test.ts` | 8801 | Asserts: A2 — capture emits energy measured with frameEnergyDb — 1 describe / 6 test blocks. | — (no exports) | 2 → apps/desktop/src/audio/capture.ts, apps/desktop/src/audio/vad.ts | TEST-FILE |
| `apps/desktop/src/audio/capture-permission.test.ts` | 3460 | Asserts: microphone failure preserves the DOMException name (SEC-7) — 1 describe / 3 test blocks. | — (no exports) | 2 → apps/desktop/src/audio/capture.ts, apps/desktop/src/audio/vad.ts | TEST-FILE |
| `apps/desktop/src/audio/capture.test.ts` | 1746 | Asserts: capture DSP — 1 describe / 7 test blocks. | — (no exports) | 1 → apps/desktop/src/audio/capture.ts | TEST-FILE |
| `apps/desktop/src/audio/capture.ts` | 7257 | getUserMedia capture at 16 kHz, downsample to 16 kHz Int16 and 100 ms frame encoding, with an AudioWorklet and a ScriptProcessor fallback. | const TARGET_RATE, floatToInt16(), downsample(), encodeFrame(), type CaptureEvents, class AudioCapture | 1 → apps/desktop/src/audio/vad.ts | LIVE+TEST |
| `apps/desktop/src/audio/mic-policy.test.ts` | 3533 | Asserts: mic hardware policy (L19) — 2 describe / 9 test blocks. | — (no exports) | 1 → apps/desktop/src/audio/vad.ts | TEST-FILE |
| `apps/desktop/src/audio/playback-f01.test.ts` | 4013 | Asserts: a throwing onEnd cannot reject the floating drain promise (F-01) — 1 describe / 4 test blocks. | — (no exports) | 1 → apps/desktop/src/audio/playback.ts | TEST-FILE |
| `apps/desktop/src/audio/playback.test.ts` | 37656 | Asserts: AudioPlayer — 10 describe / 38 test blocks. | — (no exports) | 1 → apps/desktop/src/audio/playback.ts | TEST-FILE |
| `apps/desktop/src/audio/playback.ts` | 17598 | Strict-FIFO downlink player: 32-chunk drop-oldest queue, 0.9 gain, bounded coalescing, corrupt-chunk skip. | type PlaybackDecoder, type PlaybackSink, type AudioPlayerOptions, const PLAYBACK_QUEUE_CAP, const MAX_COALESCE_TICKS, class AudioPlayer, const PLAYBACK_GAIN, const PLAYBACK_START_LEAD_S, createDefaultPlayer() | 0 → — | LIVE+TEST |
| `apps/desktop/src/audio/uplink-gate.test.ts` | 12875 | Asserts: A1(a) — a silent window puts ZERO bytes on the wire — 6 describe / 27 test blocks. | — (no exports) | 3 → apps/desktop/src/audio/vad.ts, apps/desktop/src/audio/calibration-meter.ts, src/voice/ingest.ts | TEST-FILE |
| `apps/desktop/src/audio/vad.test.ts` | 1484 | Asserts: voice activity detection — 1 describe / 4 test blocks. | — (no exports) | 1 → apps/desktop/src/audio/vad.ts | TEST-FILE |
| `apps/desktop/src/audio/vad.ts` | 13136 | Renderer-side VAD: frame energy in dBFS, the -30 dB speech gate, barge policy, uplink verdict windowing and the mic-failure policy. | const SPEECH_GATE_DB, const SILENCE_DB, frameEnergyDb(), isSpeechFrame(), dbToWaveEnergy(), bytesToSamples(), type BargeDecision, bargePolicy(), type UplinkVerdict, type UplinkOptions, const WINDOW_TAIL_FRAMES, class UplinkGate, uplinkVerdict(), type MicPolicy, micPolicy(), micFailureNotice() | 0 → — | LIVE+TEST |
| `apps/desktop/src/bridge/ws-output-bound.test.ts` | 18349 | Asserts: isOutputFrame cannot be bypassed by a frame that skips validation — 2 describe / 15 test blocks. | — (no exports) | 1 → apps/desktop/src/bridge/ws.ts | TEST-FILE |
| `apps/desktop/src/bridge/ws-output.test.ts` | 20861 | Asserts: the output branch: forwarding — 5 describe / 14 test blocks. | — (no exports) | 1 → apps/desktop/src/bridge/ws.ts | TEST-FILE |
| `apps/desktop/src/bridge/ws.test.ts` | 26252 | Asserts: computeBackoff (staggered reconnect) — 5 describe / 23 test blocks. | — (no exports) | 1 → apps/desktop/src/bridge/ws.ts | TEST-FILE |
| `apps/desktop/src/bridge/ws.ts` | 32631 | The WS-4097 client: subprotocol + bearer auth, staggered reconnect backoff, ack ledger with a 5 s timeout, frame type guards, and the CommandKind union the shell may send. | const UI_WS_URL, const UI_SUBPROTOCOL, const RECONNECT_BASE_MS, const RECONNECT_JITTER_MS, const RECONNECT_CAP_MS, const ACK_TIMEOUT_MS, type HelloMsg, type EventMsg, type NoticeMsg, type VoiceMsg, type ContextMsg, type FlowMsg, type ShellOutputStatus, type ShellOutputOutcome, type OutputFrameMsg, type CommandKind, type CommandMsg, type CommandOutcome, type SocketLike, type InventorySession, type AgentEntry, computeBackoff(), withQuery(), type BridgeOptions, class VoxauraBridge | 0 → — | LIVE+TEST |
| `apps/desktop/src/components/bento/BentoGrid.test.tsx` | 11687 | Asserts: BentoGrid: 440 × 600 — no horizontal overflow — 3 describe / 12 test blocks. | — (no exports) | 6 → apps/desktop/src/components/bento/BentoGrid.tsx, apps/desktop/src/components/bento/ReconnectBanner.tsx, apps/desktop/src/components/bento/layoutBudget.ts, apps/desktop/src/matrix/task-state.ts, apps/desktop/src/components/session/SessionChip.tsx, apps/desktop/src/components/terminal/TerminalDrawer.tsx | TEST-FILE |
| `apps/desktop/src/components/bento/BentoGrid.tsx` | 9510 | The 440x600 bento layout primitive. | type BentoGridProps, BentoGrid() | 7 → apps/desktop/src/components/bento/ReconnectBanner.tsx, apps/desktop/src/components/session/SessionBar.tsx, apps/desktop/src/components/session/TaskCards.tsx, apps/desktop/src/components/terminal/TerminalDrawer.tsx, apps/desktop/src/components/bento/layoutBudget.ts, apps/desktop/src/matrix/task-state.ts | LIVE+TEST |
| `apps/desktop/src/components/bento/ReconnectBanner.test.tsx` | 8496 | Asserts: ReconnectBanner: dismissal hides the words, never frees the actions — 4 describe / 17 test blocks. | — (no exports) | 2 → apps/desktop/src/components/bento/ReconnectBanner.tsx, apps/desktop/src/components/bento/layoutBudget.ts | TEST-FILE |
| `apps/desktop/src/components/bento/ReconnectBanner.tsx` | 7052 | Reconnect episode reducer and banner; dismissal hides words but never frees the actions. | type ReconnectEpisode, type ReconnectState, const INITIAL_RECONNECT, type ReconnectEvent, reconnectReducer(), actionsBlocked(), const RECONNECT_DETAIL_AR, type ReconnectBannerProps, ReconnectBanner() | 0 → — | LIVE+TEST |
| `apps/desktop/src/components/bento/layoutBudget.test.ts` | 7320 | Asserts: layoutBudget: the numbers — 6 describe / 18 test blocks. | — (no exports) | 1 → apps/desktop/src/components/bento/layoutBudget.ts | TEST-FILE |
| `apps/desktop/src/components/bento/layoutBudget.ts` | 9987 | Static layout auditor: declared vs rendered width and text containment, used to keep the window from growing. | const BENTO_BASE_WIDTH_PX, const BENTO_BASE_HEIGHT_PX, const LONG_TEXT_CHARS, type BudgetViolation, isWidthContained(), declaredWidthPx(), auditWidthBudget(), auditTextContainment(), directText(), auditBento(), formatViolations() | 0 → — | LIVE+TEST |
| `apps/desktop/src/components/brand/Crest.test.tsx` | 982 | Asserts: Crest — 1 describe / 0 test blocks. | — (no exports) | 1 → apps/desktop/src/components/brand/Crest.tsx | TEST-FILE |
| `apps/desktop/src/components/brand/Crest.tsx` | 847 | Brand crest SVG component. Reachable ONLY from its own test — no production importer. | type CrestProps, Crest() | 0 → — | TEST-ONLY |
| `apps/desktop/src/components/brand/WaveformEmblem.test.tsx` | 934 | Asserts: WaveformEmblem (pure-blue 5-bar mark) — 1 describe / 1 test blocks. | — (no exports) | 1 → apps/desktop/src/components/brand/WaveformEmblem.tsx | TEST-FILE |
| `apps/desktop/src/components/brand/WaveformEmblem.tsx` | 789 | Pure-blue 5-bar waveform mark. | WaveformEmblem() | 0 → — | LIVE+TEST |
| `apps/desktop/src/components/icons/ControlGlyphs.test.tsx` | 5471 | Asserts: ControlGlyphs (custom vector icons) — 1 describe / 4 test blocks. | — (no exports) | 1 → apps/desktop/src/components/icons/ControlGlyphs.tsx | TEST-FILE |
| `apps/desktop/src/components/icons/ControlGlyphs.tsx` | 2656 | Four hand-drawn control glyphs (mic, mic-off, bot, bot-off) as inline SVG. | MicGlyph(), MicOffGlyph(), BotGlyph(), BotOffGlyph() | 0 → — | LIVE+TEST |
| `apps/desktop/src/components/portals/ApiKeysModal.test.tsx` | 4700 | Asserts: ApiKeysModal (3-key mandatory intake) — 1 describe / 5 test blocks. | — (no exports) | 1 → apps/desktop/src/components/portals/ApiKeysModal.tsx | TEST-FILE |
| `apps/desktop/src/components/portals/ApiKeysModal.tsx` | 5231 | Three-key mandatory intake modal; refuses to submit until all three providers are present. | type ApiKeyBundle, type ApiKeysModalProps, ApiKeysModal() | 1 → apps/desktop/src/components/portals/PortalShell.tsx | LIVE+TEST |
| `apps/desktop/src/components/portals/CalibrationWizard.test.tsx` | 17748 | Asserts: C.6: the three phases run in order over ~10 s — 4 describe / 11 test blocks. | — (no exports) | 3 → apps/desktop/src/audio/capture.ts, apps/desktop/src/audio/vad.ts, apps/desktop/src/components/portals/CalibrationWizard.tsx | TEST-FILE |
| `apps/desktop/src/components/portals/CalibrationWizard.tsx` | 13207 | Three-phase mic calibration wizard (listen 3 s, measure 5 s, verdict 2 s) with an explicit unmeasured state. | const LISTEN_MS, const MEASURE_MS, const VERDICT_MS, const TOTAL_MS, type CalibrationPhase, type CalibrationClock, type CalibrationSource, type CalibrationWizardProps, CalibrationWizard() | 4 → apps/desktop/src/audio/capture.ts, apps/desktop/src/audio/calibration-meter.ts, apps/desktop/src/audio/vad.ts, apps/desktop/src/components/portals/PortalShell.tsx | LIVE+TEST |
| `apps/desktop/src/components/portals/ConfirmPortal.tsx` | 1162 | The FR-12 confirmation surface (T2). | type ConfirmPortalProps, ConfirmPortal() | 1 → apps/desktop/src/components/portals/PortalShell.tsx | LIVE+TEST |
| `apps/desktop/src/components/portals/PortalShell.tsx` | 2384 | Shared portal chrome: focus trap, Esc handling, focusable selector. | type PortalShellProps, PortalShell() | 0 → — | LIVE+TEST |
| `apps/desktop/src/components/portals/portals.test.tsx` | 2034 | Asserts: ConfirmPortal (FR-12 T2 surface) — 1 describe / 1 test blocks. | — (no exports) | 1 → apps/desktop/src/components/portals/ConfirmPortal.tsx | TEST-FILE |
| `apps/desktop/src/components/session/AgentModelBadge.test.tsx` | 3336 | Asserts: AgentModelBadge — 1 describe / 4 test blocks. | — (no exports) | 1 → apps/desktop/src/components/session/AgentModelBadge.tsx | TEST-FILE |
| `apps/desktop/src/components/session/AgentModelBadge.tsx` | 2257 | Agent/model selector badge. | type AgentOption, type AgentModelBadgeProps, AgentModelBadge() | 0 → — | LIVE+TEST |
| `apps/desktop/src/components/session/ContextGauge.test.tsx` | 3915 | Asserts: formatTokens — 2 describe / 10 test blocks. | — (no exports) | 1 → apps/desktop/src/components/session/ContextGauge.tsx | TEST-FILE |
| `apps/desktop/src/components/session/ContextGauge.tsx` | 2777 | Context-window fill gauge with token formatting. | type ContextGaugeProps, formatTokens(), ContextGauge() | 0 → — | LIVE+TEST |
| `apps/desktop/src/components/session/SessionBar.test.tsx` | 8832 | Asserts: SessionBar: it composes the chip, it does not replace it — 4 describe / 17 test blocks. | — (no exports) | 3 → apps/desktop/src/components/session/SessionBar.tsx, apps/desktop/src/components/session/SessionChip.tsx, apps/desktop/src/components/bento/layoutBudget.ts | TEST-FILE |
| `apps/desktop/src/components/session/SessionBar.tsx` | 6003 | Session tab strip that composes SessionChip rather than replacing it. | type SessionBarProps, const DEFAULT_MAX_VISIBLE_TABS, SessionBar() | 1 → apps/desktop/src/components/session/SessionChip.tsx | LIVE+TEST |
| `apps/desktop/src/components/session/SessionChip.test.tsx` | 3519 | Asserts: SessionChip (compact dropdown) — 1 describe / 5 test blocks. | — (no exports) | 1 → apps/desktop/src/components/session/SessionChip.tsx | TEST-FILE |
| `apps/desktop/src/components/session/SessionChip.tsx` | 4301 | Compact session dropdown chip. | type ChipSession, type SessionChipProps, SessionChip() | 0 → — | LIVE+TEST |
| `apps/desktop/src/components/session/TaskCards.test.tsx` | 10275 | Asserts: TaskCards: the DOM contract App already asserts — 3 describe / 16 test blocks. | — (no exports) | 3 → apps/desktop/src/components/session/TaskCards.tsx, apps/desktop/src/matrix/task-state.ts, apps/desktop/src/components/bento/layoutBudget.ts | TEST-FILE |
| `apps/desktop/src/components/session/TaskCards.tsx` | 6614 | Task card strip with a per-state glyph. | const TASK_GLYPH, type TaskCardsProps, TaskCards() | 1 → apps/desktop/src/matrix/task-state.ts | LIVE+TEST |
| `apps/desktop/src/components/settings/KeysView.test.tsx` | 8020 | Asserts: KeysView (dedicated API-keys window) — 1 describe / 5 test blocks. | — (no exports) | 3 → apps/desktop/src/components/settings/KeysView.tsx, apps/desktop/src/settings/ipc-token.ts, apps/desktop/src/bridge/ws.ts | TEST-FILE |
| `apps/desktop/src/components/settings/KeysView.tsx` | 9419 | Dedicated API-keys window body. | KeysView() | 6 → apps/desktop/src/components/portals/ApiKeysModal.tsx, apps/desktop/src/bridge/ws.ts, apps/desktop/src/settings/ipc-token.ts, apps/desktop/src/settings/vault-dacl.ts, apps/desktop/src/window/useAutoSize.ts, apps/desktop/src/window/close-current-window.ts | LIVE+TEST |
| `apps/desktop/src/components/settings/SettingsView.test.tsx` | 3357 | Asserts: SettingsView (general settings window; keys are decoupled) — 1 describe / 6 test blocks. | — (no exports) | 1 → apps/desktop/src/components/settings/SettingsView.tsx | TEST-FILE |
| `apps/desktop/src/components/settings/SettingsView.tsx` | 14098 | General settings window body with a typed chain list. | type ChainEntry, type SettingsViewProps, SettingsView() | 4 → apps/desktop/src/bridge/ws.ts, apps/desktop/src/settings/ipc-token.ts, apps/desktop/src/window/useAutoSize.ts, apps/desktop/src/window/close-current-window.ts | LIVE+TEST |
| `apps/desktop/src/components/status/CreditBanner.test.tsx` | 11059 | Asserts: credit arm mapping — 3 describe / 11 test blocks. | — (no exports) | 1 → apps/desktop/src/components/status/CreditBanner.tsx | TEST-FILE |
| `apps/desktop/src/components/status/CreditBanner.tsx` | 8712 | TTS credit banner: maps a credit notice to a dismissible or non-dismissible arm. | type CreditArm, const CREDIT_ARMS, creditArm(), isCreditNotice(), isArmDismissible(), type CreditEntry, type CreditState, const INITIAL_CREDIT, creditNotice(), creditVoice(), creditDismiss(), type CreditBannerProps, CreditBanner() | 0 → — | LIVE+TEST |
| `apps/desktop/src/components/terminal/TerminalDrawer.test.tsx` | 38625 | Asserts: TerminalDrawer: SILENT BY DESIGN — 9 describe / 59 test blocks. | — (no exports) | 2 → apps/desktop/src/components/terminal/TerminalDrawer.tsx, apps/desktop/src/components/bento/layoutBudget.ts | TEST-FILE |
| `apps/desktop/src/components/terminal/TerminalDrawer.tsx` | 33710 | Shell output drawer: 500-line / 8192-char clamps, shell-outcome resolution from the output frame, session labelling. 59 tests — the largest single test file in the tree. | type TerminalLineKind, type TerminalLine, const MAX_TERMINAL_LINES, const MAX_LINE_CHARS, type ShellOutputStatus, type OutputFrameLike, deriveShellOutcomeFallback(), type ResolvedShellOutcome, resolveShellOutcome(), sessionOf(), const SESSION_LABEL_EDGE_CHARS, const SESSION_LABEL_MAX, const SESSION_LABEL_SEPARATOR, sessionLabel(), linesFromOutputFrame(), type TerminalDrawerProps, clampLine(), appendTerminalLines(), TerminalDrawer() | 1 → apps/desktop/src/bridge/ws.ts | LIVE+TEST |
| `apps/desktop/src/components/waveform/SiriWaveCanvas.test.tsx` | 9989 | Asserts: SiriWaveCanvas — thread only (D6) — 3 describe / 17 test blocks. | — (no exports) | 2 → apps/desktop/src/components/waveform/SiriWaveCanvas.tsx, apps/desktop/src/audio/vad.ts | TEST-FILE |
| `apps/desktop/src/components/waveform/SiriWaveCanvas.tsx` | 6951 | The persona-coloured Siri-style wave; palette per speaker (kareem/nour/user). | type SiriWaveMode, type WaveSpeaker, const SPEAKER_PALETTE, speakerPalette(), mixHex(), type SiriWaveCanvasProps, SiriWaveCanvas() | 0 → — | LIVE+TEST |
| `apps/desktop/src/main.tsx` | 1048 | React 18 mount point for the webview; the graph entry from index.html. | — (no exports) | 5 → apps/desktop/src/App.tsx, apps/desktop/src/components/settings/SettingsView.tsx, apps/desktop/src/components/settings/KeysView.tsx, apps/desktop/src/settings/chain.ts, apps/desktop/src/settings/open-settings.ts | LIVE |
| `apps/desktop/src/matrix/matrix-state.test.ts` | 937 | Asserts: matrixForDaemonState (4B surface) — 1 describe / 1 test blocks. | — (no exports) | 1 → apps/desktop/src/matrix/matrix-state.ts | TEST-FILE |
| `apps/desktop/src/matrix/matrix-state.ts` | 1817 | Maps daemon lifecycle state to the four-state wave matrix. | type MatrixState, matrixForDaemonState() | 0 → — | LIVE+TEST |
| `apps/desktop/src/matrix/script-check.test.ts` | 5593 | Asserts: looksNonArabic (C.7 — Latin echo only) — 1 describe / 10 test blocks. | — (no exports) | 1 → apps/desktop/src/matrix/script-check.ts | TEST-FILE |
| `apps/desktop/src/matrix/script-check.ts` | 5057 | Latin-echo detector: flags a reply that is mostly Latin with a token Arabic presence. Reachable ONLY from its own test. | const LATIN_ECHO_PERCENT, const ARABIC_PRESENCE_PERCENT, const MIN_LETTERS, looksNonArabic() | 0 → — | TEST-ONLY |
| `apps/desktop/src/matrix/task-state.test.ts` | 8762 | Asserts: taskStateFor: the vocabulary that IS ours — 5 describe / 14 test blocks. | — (no exports) | 1 → apps/desktop/src/matrix/task-state.ts | TEST-FILE |
| `apps/desktop/src/matrix/task-state.ts` | 13269 | Inventory row -> task card projection with a closed state vocabulary, 24-card cap and Arabic labels. | type TaskState, type InventoryTaskState, type TaskTone, const TASK_STATES, taskStateFor(), isKnownTaskState(), const TASK_CHIP_CLASS, const TASK_TONE, const TASK_LABEL_AR, type TaskCard, const LOCAL_TASK_KEY, const TASK_CARD_OVERFLOW_KEY, const MAX_TASK_CARDS, const TASK_STRIP_MAX_HEIGHT_PX, queuedCard(), type InventoryRow, taskCardsFromInventory() | 0 → — | LIVE+TEST |
| `apps/desktop/src/serve-health-signal.test.ts` | 14650 | Asserts: serve-health-signal: only the documented codes are serve-health — 5 describe / 17 test blocks. | — (no exports) | 3 → apps/desktop/src/components/bento/ReconnectBanner.tsx, apps/desktop/src/serve-health-signal.ts, apps/desktop/src/bridge/ws.ts | TEST-FILE |
| `apps/desktop/src/serve-health-signal.ts` | 13949 | Classifies notice/ack codes into serve-health vs local-only commands, so a local command is not blocked by a serve outage. | const SERVE_HEALTH_CODES, type ServeHealthCode, isServeHealthCode(), const SERVE_LOCAL_ONLY_COMMANDS, const SERVE_COMMAND_CLASS, isServeLocalOnlyCommand(), const SERVE_REACHING_COMMANDS, const SERVE_PROBE_COMMANDS, reconnectFromNotice(), reconnectFromAck() | 2 → apps/desktop/src/components/bento/ReconnectBanner.tsx, apps/desktop/src/bridge/ws.ts | LIVE+TEST |
| `apps/desktop/src/sessions/store.test.ts` | 937 | Asserts: sessionsReducer — 1 describe / 2 test blocks. | — (no exports) | 1 → apps/desktop/src/sessions/store.ts | TEST-FILE |
| `apps/desktop/src/sessions/store.ts` | 906 | useReducer store for the listed sessions. | type ListedSession, type SessionsState, type SessionsAction, const initialSessionsState, sessionsReducer() | 0 → — | LIVE+TEST |
| `apps/desktop/src/settings/chain.ts` | 764 | The static agent chain entry list. | const AGENT_CHAIN | 0 → — | LIVE |
| `apps/desktop/src/settings/ipc-token.test.ts` | 1611 | Asserts: resolveIpcTokenWithRetry — 1 describe / 3 test blocks. | — (no exports) | 1 → apps/desktop/src/settings/ipc-token.ts | TEST-FILE |
| `apps/desktop/src/settings/ipc-token.ts` | 2672 | Resolves the WS bearer: env token, Tauri host check, and a bounded retry that rides out the supervisor race. | envToken(), isTauriHost(), resolveIpcToken(), type TokenRetryOptions, resolveIpcTokenWithRetry() | 0 → — | LIVE+TEST |
| `apps/desktop/src/settings/open-settings.ts` | 2250 | Opens the settings and api-keys windows as separate Tauri windows and parses the view label back. | const SETTINGS_LABEL, const KEYS_LABEL, isTauriHost(), openSettingsWindow(), openKeysWindow(), isSettingsView(), isKeysView() | 0 → — | LIVE+TEST |
| `apps/desktop/src/settings/services.test.ts` | 3373 | Asserts: ensureServices — 1 describe / 7 test blocks. | — (no exports) | 1 → apps/desktop/src/settings/services.ts | TEST-FILE |
| `apps/desktop/src/settings/services.ts` | 2580 | Calls ensure_all_services with a bounded retry and classifies the raw result. | type EnsureResult, ensureServices() | 0 → — | LIVE+TEST |
| `apps/desktop/src/settings/vault-dacl.test.ts` | 4781 | Asserts: restrictVaultFile (A.2) — 1 describe / 9 test blocks. | — (no exports) | 1 → apps/desktop/src/settings/vault-dacl.ts | TEST-FILE |
| `apps/desktop/src/settings/vault-dacl.ts` | 3467 | Calls restrict_vault_file and maps the result to ok / unconfirmed / keyring-lost. Its ONLY importer is vault-dacl.test.ts — no production caller re-locks the vault after a save. | type VaultDaclState, type VaultDaclResult, restrictVaultFile() | 0 → — | LIVE+TEST |
| `apps/desktop/src/window/close-current-window.ts` | 671 | Closes the focused Tauri window. | closeCurrentWindow() | 0 → — | LIVE+TEST |
| `apps/desktop/src/window/useAutoSize.test.tsx` | 7036 | Asserts: useAutoSize: the stand-down is real, and the opt-in is real — 2 describe / 10 test blocks. | — (no exports) | 1 → apps/desktop/src/window/useAutoSize.ts | TEST-FILE |
| `apps/desktop/src/window/useAutoSize.ts` | 6405 | Measures scrollHeight and resizes the OS window to content, with a stand-down window so it does not fight the user. | type SetWindowSize, const AUTO_SIZE_STAND_DOWN, type AutoSizeOptions, useAutoSize() | 0 → — | LIVE+TEST |
| `apps/desktop/tailwind.config.ts` | 293 | Tailwind content globs and theme extension. | default | 0 → tailwindcss | LIVE |
| `apps/desktop/vite.config.ts` | 487 | Vite config for the renderer build. | default | 0 → @vitejs/plugin-react, vite | LIVE |
| `apps/desktop/vitest.config.ts` | 231 | Desktop unit-test config (happy-dom). | default | 0 → @vitejs/plugin-react | LIVE |
| `ml/memory_probe.mjs` | 1110 | Standalone Node memory probe for the Laya ONNX session. Outside the TS import graph entirely. | — (no exports) | 0 → — | NOT-IN-GRAPH |
| `scripts/docs-verify-self-test.mjs` | 3321 | Self-test for docs-verify: asserts every `file:line` anchor it cites still resolves. | selfTestCitedAnchors() | 0 → — | LIVE |
| `scripts/docs-verify.mjs` | 35146 | Re-derives documented claims from the tree and fails when prose and code disagree. It is the repo's own falsification harness. | — (no exports) | 1 → scripts/docs-verify-self-test.mjs | LIVE |
| `scripts/generate-whiteboard-assets.mjs` | 25882 | Generates the whiteboard SVG assets with deterministic seeded jitter. | — (no exports) | 0 → — | LIVE |
| `scripts/key-report.mjs` | 3232 | Reports key storage source and SHA-256 fingerprints per provider, never values. Imports the COMPILED vault from ../dist. | — (no exports) | 1 → src/voice/vault.ts | LIVE |
| `scripts/lint-baseline.mjs` | 6573 | oxlint baseline gate: fails on new warnings above the recorded count of 8. | — (no exports) | 0 → — | LIVE |
| `scripts/live_console_test.ts` | 16589 | Real-network live console harness: real serve, real WS-4097, real Fish, real Whisper. Imports eight modules from ../dist (build output), not from src. | — (no exports) | 8 → src/ipc/index.ts, src/common/brands.ts, src/runtime/client.ts, src/voice/vault.ts, src/voice/keyring.ts, src/voice/tts.ts | LIVE |
| `scripts/packaging-preflight.mjs` | 3106 | Read-only readiness matrix for packaging; builds nothing. | — (no exports) | 0 → — | LIVE |
| `scripts/provision-sidecar.mjs` | 3350 | Builds the bundled node.exe + dist + pruned-deps payload for the installer, with its own manifest and its own npm install. | — (no exports) | 0 → — | LIVE |
| `scripts/release-verify.mjs` | 12838 | Seven-stage release gate: gate, preflight, build, install, boot, assert, cleanup, with --stage bisection. | — (no exports) | 0 → — | LIVE |
| `scripts/test-blindspots.mjs` | 5947 | Module-level reachability measurement over the import graph; reports which modules no test reaches. | — (no exports) | 0 → — | LIVE |
| `src/cli-doctor-keys.test.ts` | 2932 | Asserts: doctor reports the vault, not the environment — 1 describe / 6 test blocks. | — (no exports) | 2 → src/voice/key-store.ts, src/voice/vault.ts | TEST-FILE |
| `src/cli.ts` | 15654 | Process entry for `opencode-voice` (package.json `bin` -> dist/cli.js). Argv ladder dispatching doctor/vault/live/serve/headless; fail-closed on empty serve password; dynamic-imports daemon.js and cli/headless.js so the heavy graph loads only on the serve leg. | — (no exports) | 16 → src/common/index.ts, src/launcher/index.ts, src/voice/vault.ts, src/voice/key-store.ts, src/voice/keyring.ts, src/voice/stt.ts | LIVE |
| `src/cli/bridge.ts` | 14742 | Per-session serve subcommand helpers (sessions/mcp/lsp/skills/createSession/prompt/spec/shell) for the headless CLI. | sessionsCommand(), mcpCommand(), lspCommand(), skillsCommand(), createSessionCommand(), promptCommand(), specCommand(), shellCommand() | 5 → src/common/brands.ts, src/common/errors.ts, src/runtime/client.ts, src/cli/serve.ts, src/cli/report.ts | LIVE+TEST |
| `src/cli/commands.test.ts` | 5622 | Asserts: commands.ts stays dependency-free — 3 describe / 10 test blocks. | — (no exports) | 2 → src/cli/commands.ts, src/cli/headless.ts | TEST-FILE |
| `src/cli/commands.ts` | 1545 | Typed table of the headless subcommands plus the usage suffix appended to the top-level help. | const HEADLESS_COMMANDS, type HeadlessCommand, isHeadlessCommand(), const HEADLESS_USAGE_SUFFIX | 0 → — | LIVE+TEST |
| `src/cli/headless.test.ts` | 5292 | Asserts: the command guard and the usage — 4 describe / 9 test blocks. | — (no exports) | 2 → src/cli/commands.ts, src/cli/headless.ts | TEST-FILE |
| `src/cli/headless.ts` | 16142 | Runs a headless turn: wires the Coordinator, the serve client and the report renderer, and hosts the `invariant` subcommand that measures the coordinator structural invariant from source. | runHeadless(), invariantCommand(), headlessUsage, HEADLESS_COMMANDS, isHeadlessCommand | 12 → src/voice/vault.ts, src/voice/key-store.ts, src/daemon.ts, src/orchestrator/permission.ts, src/orchestrator/coordinator.ts, src/voice/keyring.ts | LIVE+TEST |
| `src/cli/intents.test.ts` | 9636 | Asserts: the table, replayed through parseAddressee — 3 describe / 13 test blocks. | — (no exports) | 3 → src/orchestrator/coordinator.ts, src/orchestrator/permission.ts, src/cli/intents.ts | TEST-FILE |
| `src/cli/intents.ts` | 13913 | Intent-classification matrix for the permission gate; `probePermissionSlot` exercises a real PermissionSlot, and `liveGateChat`/`replayGateChat` drive the addressee model live or from a transcript. | type IntentCase, const INTENT_CASES, type VerdictSource, type IntentRow, type IntentReport, runIntentTable(), structuralFaultsOf(), type SlotProbe, probePermissionSlot(), liveGateChat(), replayGateChat() | 3 → src/orchestrator/permission.ts, src/voice/brain.ts, src/orchestrator/coordinator.ts | LIVE+TEST |
| `src/cli/reason.ts` | 20614 | `reason` subcommand: prints a derived, cited rationale for the current tree, including the gate invariant row. | type ReasonOptions, reasonCommand() | 12 → src/common/brands.ts, src/common/errors.ts, src/voice/vault.ts, src/voice/keyring.ts, src/daemon.ts, src/orchestrator/coordinator.ts | LIVE+TEST |
| `src/cli/report.ts` | 2241 | ANSI reporter primitives (heading/field/note/warn/pass/fail/verdict/json/clip). Pure formatting, zero imports. | heading(), field(), note(), warnLine(), pass(), fail(), verdict(), source(), json(), clip() | 0 → — | LIVE+TEST |
| `src/cli/serve.test.ts` | 13562 | Asserts: spaFallbackContentType — the rule, restated — 9 describe / 24 test blocks. | — (no exports) | 4 → src/common/errors.ts, src/common/brands.ts, src/runtime/client.ts, src/cli/serve.ts | TEST-FILE |
| `src/cli/serve.ts` | 12235 | Serve target resolution, password resolution and the route prober: `spaFallbackContentType` is the rule that distinguishes a real JSON route answer from the SPA HTML fallback. | type ServeTarget, resolveServePassword(), type PromptEnvelope, openServeTarget(), requirePassword(), spaFallbackContentType(), type RouteKind, type RouteProbe, requestPathOf(), probeRoute(), readSpec() | 5 → src/common/config.ts, src/common/errors.ts, src/runtime/client.ts, src/runtime/opencode-bridge.ts, src/launcher/index.ts | LIVE+TEST |
| `src/cli/turn.test.ts` | 21984 | Asserts: the structural invariant, counted from coordinator.ts source — 4 describe / 25 test blocks. | — (no exports) | 4 → src/orchestrator/permission.ts, src/orchestrator/coordinator.ts, src/common/brands.ts, src/cli/turn.ts | TEST-FILE |
| `src/cli/turn.ts` | 21433 | `HeadlessBrain` — a non-Windows headless turn driver — plus `measureGateInvariant`/`assertGateInvariant`, which count `return { kind: 'proceed'` and `this.deps.dispatch(` in coordinator.ts source and the permission-slot consume count. | type ChatStage, type ChatCall, type DispatchRecord, type TurnTrace, type HeadlessBrainOptions, class HeadlessBrain, type CoordinatorContext, type SourceCount, type GateInvariant, measureGateInvariant(), readCoordinatorSource(), assertGateInvariant(), type RuntimeInvariant, checkRuntimeInvariant(), const GATE_TTL_MS, ADDRESSEE_CHAT_OPTIONS | 4 → src/common/brands.ts, src/common/errors.ts, src/orchestrator/coordinator.ts, src/orchestrator/permission.ts | LIVE+TEST |
| `src/common/brands.ts` | 1224 | Branded identifier types (SessionId/EventId/ApprovalId/VoiceId/PersonaId) plus the persona->voice and persona->label maps and `nowIso`. | type ISODateString, type SessionId, type EventId, type ApprovalId, type VoiceId, type PersonaId, const PERSONA_VOICE, const PERSONA_LABEL, const VOICE_IDS, type SessionState, type SessionOutcome, nowIso() | 0 → — | LIVE+TEST |
| `src/common/config.ts` | 2781 | Reads env into a typed OrchestratorConfig (ports, model paths, thresholds) with defaults; the only place env strings become numbers. | type OrchestratorConfig, loadConfig() | 2 → src/voice/cache.ts, src/common/brands.ts | LIVE+TEST |
| `src/common/errors.ts` | 12039 | The typed error surface: ErrorCode union, ShellStopReason set, OrchestratorError carrying (code, retryable, detail), and the error->HTTP-status mapping the WS server uses. | type ErrorCode, type ShellStopReason, const SHELL_STOP_REASON_CODES, stopReasonOf(), errorCodeFor(), class OrchestratorError, httpStatusOf() | 0 → — | LIVE+TEST |
| `src/common/index.ts` | 437 | Barrel re-exporting the five common surfaces. Only `src/cli.ts` imports it. | VOICE_IDS, nowIso, OrchestratorError, loadConfig, redactSecrets, containsSecret, createLogger | 4 → src/common/brands.ts, src/common/errors.ts, src/common/config.ts, src/common/logger.ts | LIVE |
| `src/common/logger.test.ts` | 11506 | Asserts: secret redaction (I-2) — 4 describe / 20 test blocks. | — (no exports) | 1 → src/common/logger.ts | TEST-FILE |
| `src/common/logger.ts` | 13231 | Recursive secret redaction (depth 8, 1000 nodes) with a live-prefix allowlist and generic sk- exclusions, plus a level-ranked logger factory. `redactString` is the sink used at provider-error call sites. | const REDACTION_MARKER, const LIVE_PREFIXES, const GENERIC_SK_EXCLUSIONS, redactString(), redactSecrets(), redactObject(), containsSecret(), type LoggerOptions, type Logger, createLogger() | 1 → src/common/config.ts | LIVE+TEST |
| `src/daemon-barge-in.test.ts` | 27906 | Asserts: abort cancels the turn, not just the audio (C4) — 1 describe / 23 test blocks. | — (no exports) | 7 → src/common/brands.ts, src/ipc/protocol.ts, src/orchestrator/audio-pipeline.ts, src/orchestrator/command-router.ts, src/daemon.ts, src/voice/ingest.ts | TEST-FILE |
| `src/daemon-integration.test.ts` | 34350 | Asserts: POINT 1 — the monitor is constructed only after the boot probe passed — 6 describe / 30 test blocks. | — (no exports) | 5 → src/daemon.ts, src/ipc/protocol.ts, src/runtime/serve-health.ts, src/tasks/index.ts, src/daemon/shell-tasks.ts | TEST-FILE |
| `src/daemon-narration-ceiling.test.ts` | 2137 | Asserts: the narration ceiling has measured headroom (P1 item 3) — 1 describe / 5 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `src/daemon-persona-wiring.test.ts` | 4663 | Asserts: daemon threads the active persona into the narrator — 2 describe / 6 test blocks. | — (no exports) | 2 → src/orchestrator/narrator.ts, src/knowledge/personas.ts | TEST-FILE |
| `src/daemon.test.ts` | 39012 | Asserts: daemon composition (production wiring) — 6 describe / 19 test blocks. | — (no exports) | 7 → src/daemon.ts, src/ipc/audio.ts, src/ipc/protocol.ts, src/voice/tts.ts, src/voice/key-store.ts, src/voice/vault.ts | TEST-FILE |
| `src/daemon.ts` | 88577 | The composition root. Builds the WS-4097 UiServer, ServeClient, keyring, STT/TTS pipeline, AudioPipeline, task queue, telemetry and the two coordinator legs (intake then plan); owns daemon.owner marker, TTS-credit monitor, SpeechGate and the keyless degraded path. 33 imports, the widest fan-in in the tree. | type DaemonOptions, type DaemonHandle, const DAEMON_OWNER_VERSION, const DAEMON_OWNER_FILE, const DAEMON_OWNER_KEY_ENV, type DaemonOwnerMarker, daemonOwnerMarker(), parseDaemonOwnerMarker(), type SpeechGateLike, abortTurn(), startDaemon(), vaultPathFromEnv(), ipcTokenFromEnv(), ipcTokenPath(), ensureIpcToken() | 33 → src/common/errors.ts, src/common/logger.ts, src/common/config.ts, src/common/brands.ts, src/ipc/index.ts, src/runtime/index.ts | LIVE+TEST |
| `src/daemon/shell-command-id.test.ts` | 21531 | Asserts: DEFECT 1a — the bridge uses the id it is given, not the task id — 3 describe / 12 test blocks. | — (no exports) | 6 → src/common/brands.ts, src/orchestrator/command-router.ts, src/ipc/protocol.ts, src/runtime/client.ts, src/daemon/shell-tasks.ts, src/daemon.ts | TEST-FILE |
| `src/daemon/shell-task-stop-reason.test.ts` | 18830 | Asserts: DEFECT 3a — the throw sites set stopReason, so the text shim decides nothing — 3 describe / 11 test blocks. | — (no exports) | 5 → src/common/errors.ts, src/tasks/index.ts, src/common/brands.ts, src/daemon/shell-tasks.ts, src/runtime/client.ts | TEST-FILE |
| `src/daemon/shell-tasks.ts` | 32233 | Bridges WS `output` frames to the task queue: qualifies a shell outcome into a task notice and maps stop reasons onto the typed ShellStopReason set. | const SHELL_TASK_KIND, const SHELL_TASK_TIMEOUT_MS, type ShellTaskBridgeOptions, type ShellTaskBridge, createShellTaskBridge(), shellStopFailure(), type QualifiedTaskNotice, qualifyTaskNotice() | 5 → src/common/errors.ts, src/common/brands.ts, src/tasks/index.ts, src/ipc/protocol.ts, src/runtime/client.ts | LIVE+TEST |
| `src/diag/bundle.integration.test.ts` | 14556 | Asserts: a real UiServer on an ephemeral port is authenticated 101, and nothing leaks — 0 describe / 8 test blocks. | — (no exports) | 4 → src/diag/bundle.ts, src/ipc/ui-server.ts, src/voice/vault.ts, src/voice/key-store.ts | TEST-FILE |
| `src/diag/bundle.test.ts` | 51164 | Asserts: parseDoctorFlags — 13 describe / 73 test blocks. | — (no exports) | 2 → src/common/logger.ts, src/diag/bundle.ts | TEST-FILE |
| `src/diag/bundle.ts` | 63641 | Diagnostic bundle collector: reads key pools, logs, telemetry and the owner marker, fingerprints keys by hash, probes the serve port and the UI bridge handshake, scrubs every line, and asserts no residual secret material before rendering. | const BUNDLE_SCHEMA_VERSION, const LOG_FILES, const TELEMETRY_FILE, const KEY_ENTROPY_FLOOR_BYTES, const UI_CONTRACT_VERSION, type DoctorFlags, parseDoctorFlags(), type PortRole, type PortRefusal, type PortEntry, type DaemonClassification, type BringUpMirror, type DaemonEntry, type ConfigEntry, type KeyFingerprint, type KeyPoolEntry, type KeysEntry, type LogEntry, type TelemetryRow, type TelemetryEntry, type DocsVerifyStatus, type DocsVerifyEntry, type RedactionEntry, type DiagnosticBundle, type CollectResult, class RedactionTrip, type ServeProbeResult, type UiProbeResult, type OwnerMarkerRead, type KeysRead, type TelemetryRead, type DocsVerifyRun, type BundleSources, type ScrubbedLine, scrubLogLine(), hasResidualMaterial(), assertRedactionSafe(), renderBundle(), probeServePort(), probeUiBridgeHandshake(), type DefaultSourceOptions, type DefaultSources, defaultBundleSources(), insideTestRun(), collectBundle() | 6 → src/common/logger.ts, src/common/config.ts, src/launcher/index.ts, src/ipc/protocol.ts, src/voice/vault.ts, src/voice/key-store.ts | LIVE+TEST |
| `src/ipc/audio.test.ts` | 1291 | Asserts: audio downlink framing — 1 describe / 4 test blocks. | — (no exports) | 1 → src/ipc/audio.ts | TEST-FILE |
| `src/ipc/audio.ts` | 1555 | Downlink audio envelope: [0x01|seq|mp3] frame encode/decode and a 32 KiB chunk splitter for MP3 payloads. | const AUDIO_DOWNLINK_TYPE, const MAX_AUDIO_CHUNK, encodeAudioChunk(), type DecodedAudioChunk, decodeAudioChunk(), splitAudio() | 0 → — | LIVE+TEST |
| `src/ipc/index.ts` | 848 | Barrel exporting UiServer. Imported by scripts/live_console_test.ts and the E2E stub. | UiServer | 3 → src/ipc/protocol.ts, src/ipc/audio.ts, src/ipc/ui-server.ts | LIVE+TEST |
| `src/ipc/output-frame.test.ts` | 16906 | Asserts: output frame — schema and additivity — 6 describe / 27 test blocks. | — (no exports) | 2 → src/ipc/protocol.ts, src/ipc/ui-server.ts | TEST-FILE |
| `src/ipc/persona-propagation.test.ts` | 8038 | Asserts: a persona change reaches every surface (L22) — 2 describe / 8 test blocks. | — (no exports) | 2 → src/ipc/protocol.ts, src/ipc/ui-server.ts | TEST-FILE |
| `src/ipc/protocol-reassembly-cap.test.ts` | 9404 | Asserts: FrameReassembler bounds the ASSEMBLED message, not just each frame — 1 describe / 8 test blocks. | — (no exports) | 1 → src/ipc/protocol.ts | TEST-FILE |
| `src/ipc/protocol.test.ts` | 25804 | Asserts: protocol constants (ADR-010) — 12 describe / 41 test blocks. | — (no exports) | 1 → src/ipc/protocol.ts | TEST-FILE |
| `src/ipc/protocol.ts` | 43456 | The frozen WS-4097 wire contract: RFC 6455 frame encode/decode, FrameReassembler with a per-message cumulative cap, all outbound zod frame schemas, the UiCommand inbound schema, and the 4-output-frame assembler. | const UI_WS_PORT, const UI_WS_PATH, const UI_SUBPROTOCOL, const IPC_TOKEN_ENV, const SERVE_PORT, const PING_INTERVAL_MS, const MISSED_PINGS_LIMIT, const MAX_CONNECTIONS, const RESUME_BUFFER_CAP, const MAX_MESSAGE_BYTES, const MAX_PREHEADER_BYTES, const AUDIO_SAMPLE_RATE, const AUDIO_FRAME_MS, const AUDIO_FRAME_BYTES, const MAX_AUDIO_BYTES, const ACK_KIND, const ERROR_KIND, const OUTPUT_KIND, type Opcode, type WsFrame, encodeTextFrame(), encodeBinaryFrame(), maskFrame(), decodeFrames(), class WsProtocolError, class FrameReassembler, parseSeq(), const HelloFrameSchema, type HelloFrame, const UiEventSchema, type UiEvent, const UiCommandSchema, type UiCommand, const AckFrameSchema, const InventorySessionSchema, const INVENTORY_MAX_SESSIONS, const InventoryFrameSchema, type InventoryFrame, buildInventoryFrame(), const AgentEntrySchema, const AgentFrameSchema, type AgentFrame, type AgentEntry, buildAgentFrame(), const NoticeFrameSchema, type NoticeFrame, const VoicePhaseSchema, type VoicePhase, const VoiceFrameSchema, type VoiceFrame, const ContextFrameSchema, type ContextFrame, const FlowFrameSchema, type FlowFrame, type FlowState, const MAX_OUTPUT_TEXT_BYTES, const OUTPUT_MAX_COMMAND_CHARS, const OUTPUT_MAX_COMMAND_ID_CHARS, const ShellOutputStatusSchema, const ShellOutputOutcomeSchema, deriveShellOutcome(), class OutputAssembler, const OutputFrameSchema, type OutputFrame, type OutputFrameInput, buildOutputFrame() | 0 → — | LIVE+TEST |
| `src/ipc/ui-server-output.test.ts` | 15347 | Asserts: UiServer.output — emission — 3 describe / 10 test blocks. | — (no exports) | 2 → src/ipc/protocol.ts, src/ipc/ui-server.ts | TEST-FILE |
| `src/ipc/ui-server.test.ts` | 36880 | Asserts: UiServer authentication (fail-closed) — 6 describe / 29 test blocks. | — (no exports) | 3 → src/ipc/protocol.ts, src/ipc/ui-server.ts, src/ipc/audio.ts | TEST-FILE |
| `src/ipc/ui-server.ts` | 31656 | The WS-4097 server: bearer/subprotocol auth enforced pre-upgrade, connection and resume caps, ping/missed-ping liveness, frame dispatch, and the notice redaction sink. Hardcodes layaReady:false. | const RESUME_BUFFER_MAX_BYTES, type UiServerOptions, type CommandOutcome, class UiServer | 2 → src/common/logger.ts, src/ipc/audio.ts | LIVE+TEST |
| `src/knowledge/build.ts` | 5191 | Assembles Tier 1 from the five shared chunk modules, Tier 2/3 styling, and the FNV-1a `sharedDigest` change detector; `verifyKnowledge` reports chunk counts, digest, persona-key leaks and styling-situation asymmetry; `assertParity` throws on either. | const SHARED_CHUNKS, const STYLISTIC_EXAMPLES, sharedDigest(), buildIndex(), type KnowledgeReport, verifyKnowledge(), assertParity() | 9 → src/knowledge/retriever.ts, src/knowledge/shared/architecture.ts, src/knowledge/shared/capabilities.ts, src/knowledge/shared/commands.ts, src/knowledge/shared/failures.ts, src/knowledge/shared/lexicon.ts | LIVE+TEST |
| `src/knowledge/corpus.test.ts` | 7097 | Asserts: Tier 1 carries no persona — 4 describe / 16 test blocks. | — (no exports) | 5 → src/knowledge/build.ts, src/knowledge/personas.ts, src/knowledge/styles/kareem.ts, src/knowledge/styles/nour.ts, src/knowledge/types.ts | TEST-FILE |
| `src/knowledge/guard.ts` | 1816 | Tier-D off-topic prefilter: screens Arabic text and returns an Arabic refusal string for out-of-scope input. | const REFUSAL_AR, type GuardVerdict, screenText(), guardText() | 1 → src/knowledge/normalize.ts | LIVE+TEST |
| `src/knowledge/index.ts` | 1490 | Knowledge barrel — normalizer, retriever, guard, personas and the chunk arrays. Imported by `src/cli.ts` only. | normalizeArabic, normalizeToken, tokenize, isIdempotent, InMemoryRetriever, screenText, guardText, REFUSAL_AR, type GuardVerdict, KAREEM, NOUR, PERSONAS, shieldHolds, type PersonaProfile, ARCHITECTURE_CHUNKS, CAPABILITIES_CHUNKS, COMMAND_CHUNKS, FAILURE_CHUNKS, LEXICON_CHUNKS, NOUR_EXAMPLES, KAREEM_EXAMPLES | 13 → src/knowledge/normalize.ts, src/knowledge/retriever.ts, src/knowledge/guard.ts, src/knowledge/personas.ts, src/knowledge/build.ts, src/knowledge/types.ts | LIVE |
| `src/knowledge/normalize.test.ts` | 6481 | Asserts: normalizeArabic — 6 describe / 15 test blocks. | — (no exports) | 2 → src/knowledge/normalize.ts, src/knowledge/retriever.ts | TEST-FILE |
| `src/knowledge/normalize.ts` | 3751 | Arabic orthographic normalizer (NFKC, tashkeel/tatweel strip, alef and yeh unification) plus the analyzer tokenizer and a Latin-aware term folder. The tashkeel class is written as explicit escapes to exclude the Arabic-Indic digits. | normalizeArabic(), isIdempotent(), tokenize(), normalizeToken() | 0 → — | LIVE+TEST |
| `src/knowledge/personas.test.ts` | 3489 | Asserts: personas (Kareem/Nour) — 3 describe / 8 test blocks. | — (no exports) | 2 → src/knowledge/guard.ts, src/knowledge/personas.ts | TEST-FILE |
| `src/knowledge/personas.ts` | 4950 | The persona registry: Kareem and Nour as data (tone markers, shield lexicon, spoken directive), PERSONA_DIRECTIVES keyed by the PersonaId union, and the first-person shield check. | type PersonaProfile, const KAREEM, const NOUR, const PERSONA_DIRECTIVES, const PERSONAS, shieldHolds() | 1 → src/common/brands.ts | LIVE+TEST |
| `src/knowledge/retriever.test.ts` | 4174 | Asserts: InMemoryRetriever (BM25) — 1 describe / 8 test blocks. | — (no exports) | 2 → src/knowledge/retriever.ts, src/knowledge/types.ts | TEST-FILE |
| `src/knowledge/retriever.ts` | 3715 | Hand-rolled dependency-free BM25 (K1 1.2, B 0.75) with idf = log(1 + (N-df+0.5)/(df+0.5)) and a length-normalised tf term. Normalizes on BOTH the index and query path. | class InMemoryRetriever | 2 → src/knowledge/normalize.ts, src/knowledge/types.ts | LIVE+TEST |
| `src/knowledge/shared/architecture.ts` | 4231 | 8 Tier-1 chunks describing the runtime topology and process layout (verified: ARCHITECTURE_CHUNKS.length === 8). | const ARCHITECTURE_CHUNKS | 1 → src/knowledge/types.ts | LIVE+TEST |
| `src/knowledge/shared/capabilities.ts` | 5302 | 11 Tier-1 chunks describing what the product can do (verified: 11). | const CAPABILITIES_CHUNKS | 1 → src/knowledge/types.ts | LIVE+TEST |
| `src/knowledge/shared/commands.ts` | 4616 | 8 Tier-1 chunks describing the governable command set (verified: 8). | const COMMAND_CHUNKS | 1 → src/knowledge/types.ts | LIVE+TEST |
| `src/knowledge/shared/failures.ts` | 3711 | 8 Tier-1 chunks describing failure modes and their remediation (verified: 8). | const FAILURE_CHUNKS | 1 → src/knowledge/types.ts | LIVE+TEST |
| `src/knowledge/shared/lexicon.ts` | 4199 | 8 Tier-1 chunks of Ammani/technical vocabulary (verified: 8). | const LEXICON_CHUNKS | 1 → src/knowledge/types.ts | LIVE+TEST |
| `src/knowledge/styles/kareem.ts` | 2327 | 8 stylistic examples for Kareem, selected by a `when` situation key; never retrieved. | const KAREEM_EXAMPLES | 1 → src/knowledge/types.ts | LIVE+TEST |
| `src/knowledge/styles/nour.ts` | 2383 | 8 stylistic examples for Nour, same shape; the two sets are verified symmetric on `when`. | const NOUR_EXAMPLES | 1 → src/knowledge/types.ts | LIVE+TEST |
| `src/knowledge/types.ts` | 4226 | SharedChunk/SharedHit/StylisticExample shapes, the compile-time `SHARED_HAS_NO_PERSONA = false` marker, and `assertSharedChunks` which throws if any chunk crossed the boundary carrying a persona key. | type SharedChunk, type SharedHit, type StylisticExample, const SHARED_HAS_NO_PERSONA, class KnowledgeParityError, assertSharedChunks(), const PARITY_INVARIANT | 1 → src/common/brands.ts | LIVE+TEST |
| `src/launcher/index.ts` | 45 | Barrel re-exporting probeHealth. | probeHealth | 1 → src/launcher/launcher.ts | LIVE+TEST |
| `src/launcher/launcher.test.ts` | 1617 | Asserts: probeHealth (Basic auth against /api/session) — 1 describe / 1 test blocks. | — (no exports) | 2 → src/runtime/client.ts, src/launcher/launcher.ts | TEST-FILE |
| `src/launcher/launcher.ts` | 1779 | Health probe for the local serve endpoint; returns a boolean the launcher uses to decide whether to start a child. | probeHealth() | 1 → src/runtime/client.ts | LIVE+TEST |
| `src/memory/vault.test.ts` | 2071 | Asserts: resolveVaultRoot — 2 describe / 4 test blocks. | — (no exports) | 1 → src/memory/vault.ts | TEST-FILE |
| `src/memory/vault.ts` | 2531 | Locates (and on first run scaffolds) the local notes directory that gives the assistant durable memory; returns the scaffold result so the CLI can report a non-fatal degradation. | const VAULT_NOTES, type VaultNote, resolveVaultRoot(), type VaultScaffold, ensureVault() | 0 → — | LIVE+TEST |
| `src/orchestrator/ack-truth.test.ts` | 32655 | Asserts: FIX 1 — `ok` is DISPATCH, and the verdict is not thrown away — 4 describe / 23 test blocks. | — (no exports) | 6 → src/common/brands.ts, src/common/errors.ts, src/ipc/protocol.ts, src/runtime/client.ts, src/orchestrator/command-router.ts, src/daemon/shell-tasks.ts | TEST-FILE |
| `src/orchestrator/audio-pipeline-abort.test.ts` | 11896 | Asserts: a cancel abandons the turn in flight (C4) — 1 describe / 10 test blocks. | — (no exports) | 2 → src/voice/ingest.ts, src/orchestrator/audio-pipeline.ts | TEST-FILE |
| `src/orchestrator/audio-pipeline-reset.test.ts` | 9171 | Asserts: a reset abandons the turn in flight (L6) — 1 describe / 9 test blocks. | — (no exports) | 2 → src/voice/ingest.ts, src/orchestrator/audio-pipeline.ts | TEST-FILE |
| `src/orchestrator/audio-pipeline.test.ts` | 11421 | Asserts: AudioPipeline — 1 describe / 15 test blocks. | — (no exports) | 2 → src/voice/ingest.ts, src/orchestrator/audio-pipeline.ts | TEST-FILE |
| `src/orchestrator/audio-pipeline.ts` | 9603 | Turn pipeline over one ingest window: no_speech_prob drop, repeat dedupe, transcribe, think, optional implicit dispatch. Generation counter makes reset()/cancel() invalidate an in-flight pushChunk. | type Utterance, type Transcription, const NO_SPEECH_DROP, type AudioPipelineDeps, class AudioPipeline | 3 → src/common/brands.ts, src/voice/ingest.ts, src/voice/stt.ts | LIVE+TEST |
| `src/orchestrator/command-router.test.ts` | 24909 | Asserts: shellCommandError (L21) — 5 describe / 35 test blocks. | — (no exports) | 4 → src/common/brands.ts, src/common/errors.ts, src/ipc/protocol.ts, src/orchestrator/command-router.ts | TEST-FILE |
| `src/orchestrator/command-router.ts` | 42507 | The verb router and the governance tier model. `COMMAND_TIERS` is `satisfies Record<GovernedKind, CommandTier>` so totality is compiler-enforced; the state-mutating branch is the single park point (60 s TTL, 8 parked max). | type CommandOutcome, type ShellOutcomeLike, type ShellResultLike, const SHELL_OUTCOME_DETAIL, outcomeOf(), type CommandClient, type ContextUsageLike, type KeySaver, type CommandRouterDeps, type CommandTier, type WorkCommandKind, const PENDING_PROTOCOL_KINDS, type PendingProtocolKind, type GovernedKind, const COMMAND_TIERS, tierOf(), isPendingProtocolKind(), const DESTRUCTIVE_KINDS, type GovernedCommand, type PendingProtocolCommand, const CONFIRMATION_TTL_MS, const MAX_PARKED, shellCommandError(), filePathError(), parseModelRef(), type CommandHandlerOptions, describeAction(), createCommandHandler() | 4 → src/common/brands.ts, src/common/errors.ts, src/ipc/protocol.ts, src/orchestrator/permission.ts | LIVE+TEST |
| `src/orchestrator/command-tiers.test.ts` | 33790 | Asserts: tier 1 — read-only and conversational: NO GATE [ANTI-DEFECT] — 7 describe / 40 test blocks. | — (no exports) | 4 → src/common/brands.ts, src/ipc/protocol.ts, src/orchestrator/command-router.ts, src/orchestrator/permission.ts | TEST-FILE |
| `src/orchestrator/coordinator.test.ts` | 33396 | Asserts: coordinator chain — 4 describe / 27 test blocks. | — (no exports) | 2 → src/orchestrator/coordinator.ts, src/voice/tts.ts | TEST-FILE |
| `src/orchestrator/coordinator.ts` | 34868 | The intake->plan->dispatch chain and the contextual permission gate. Holds both model slugs, the outcome-claim detector, the strict plan schema, and the ONLY deps.dispatch call site in the tree (:737). | const INTAKE_MODEL, const COORDINATOR_MODEL, const IntakeSchema, type Intake, const PlanStepSchema, type PlanStep, const PlanSchema, type Plan, type IntakeContext, type ChatFn, type ChatOptions, type CoordinatorDeps, type MissionResult, type IntakeAck, buildHandoff(), class Coordinator | 4 → src/common/brands.ts, src/common/logger.ts, src/voice/brain.ts, src/orchestrator/permission.ts | LIVE+TEST |
| `src/orchestrator/delivery.test.ts` | 15419 | Asserts: M2-P3 channelFree — 5 describe / 12 test blocks. | — (no exports) | 4 → src/orchestrator/delivery.ts, src/orchestrator/task-queue.ts, src/ipc/protocol.ts, src/orchestrator/command-router.ts | TEST-FILE |
| `src/orchestrator/delivery.ts` | 12182 | Bounded outbound channel buffer (cap 4, 30 s TTL) that coalesces assistant lines so a backlog cannot replay a stale turn. | type DeliveryChannelState, channelFree(), type DeliveryItem, type DeliveryStats, type DeliveryBufferOptions, const DELIVERY_CAP, const DELIVERY_TTL_MS, type DeliveryOutcome, class DeliveryBuffer | 1 → src/orchestrator/task-queue.ts | LIVE+TEST |
| `src/orchestrator/fr12-route.test.ts` | 3878 | Asserts: FR-12 execution gate — 1 describe / 5 test blocks. | — (no exports) | 3 → src/common/brands.ts, src/ipc/protocol.ts, src/orchestrator/command-router.ts | TEST-FILE |
| `src/orchestrator/inventory.test.ts` | 4255 | Asserts: SessionInventory snapshot + diffs — 2 describe / 5 test blocks. | — (no exports) | 1 → src/orchestrator/inventory.ts | TEST-FILE |
| `src/orchestrator/inventory.ts` | 3256 | Polling session inventory that normalises serve session rows into the inventory frame payload. | type SessionRecord, type InventoryEvent, type InventoryClient, type InventoryOptions, class SessionInventory | 1 → src/common/brands.ts | LIVE+TEST |
| `src/orchestrator/mentions-wiring.test.ts` | 5694 | Asserts: a rejected mention never reaches the model as text — 3 describe / 11 test blocks. | — (no exports) | 1 → src/orchestrator/mentions.ts | TEST-FILE |
| `src/orchestrator/mentions.test.ts` | 6743 | Asserts: resolveMentions — 1 describe / 18 test blocks. | — (no exports) | 1 → src/orchestrator/mentions.ts | TEST-FILE |
| `src/orchestrator/mentions.ts` | 6150 | Resolves @file mentions in the transcript: caps at 20 files / 60 tokens, strips trailing punctuation, and decides path-looking tokens. | const MENTION_MAX_FILES, const MENTION_MAX_TOKENS, type MentionOptions, type ResolvedMentions, resolveMentions(), mentionSummary(), looksLikePath() | 0 → — | LIVE+TEST |
| `src/orchestrator/narrator-persona.test.ts` | 5783 | Asserts: persona directives (narrator seam) — 1 describe / 9 test blocks. | — (no exports) | 3 → src/orchestrator/narrator.ts, src/knowledge/personas.ts, src/common/brands.ts | TEST-FILE |
| `src/orchestrator/narrator.test.ts` | 11090 | Asserts: narrate (zero canned replies) — 4 describe / 22 test blocks. | — (no exports) | 1 → src/orchestrator/narrator.ts | TEST-FILE |
| `src/orchestrator/narrator.ts` | 7539 | Spoken confirmations. Prepends the persona directive to NARRATOR_SYSTEM, forces a strict json_schema reply, caps output at 240 chars and 20 words. | type NarratorPersona, type NarratorChat, const NARRATOR_MODEL, const NARRATOR_RESPONSE_FORMAT, type NarrationContext, const NARRATOR_SYSTEM, narrationContextLine(), narrate() | 2 → src/voice/brain.ts, src/common/brands.ts | LIVE+TEST |
| `src/orchestrator/permission-gate.test.ts` | 18579 | Asserts: B(d) — a question is answered VERBALLY and dispatches nothing — 7 describe / 25 test blocks. | — (no exports) | 1 → src/orchestrator/coordinator.ts | TEST-FILE |
| `src/orchestrator/permission.ts` | 16335 | The addressee/permission model: the strict addressee schema, a 30 s permission slot TTL, the Arabic spoken ask, and `parseAddressee`. Contains NO `kind: 'proceed'` and NO `deps.dispatch(` — the gate outcome type lives in coordinator.ts. | type AddresseeDecision, const ADDRESSEE_SCHEMA, const ADDRESSEE_RESPONSE_FORMAT, const ADDRESSEE_CHAT_OPTIONS, const PERMISSION_TTL_MS, const MAX_SPOKEN_ASK_WORDS, spokenAsk(), type PendingConfirmation, type PendingPermission, type AddresseeVerdict, addresseeSystem(), parseAddressee(), type PermissionSlotOptions, class PermissionSlot | 1 → src/voice/brain.ts | LIVE+TEST |
| `src/orchestrator/prompt-optimizer-wiring.test.ts` | 3518 | Asserts: acknowledgements are never turned into tasks — 2 describe / 9 test blocks. | — (no exports) | 1 → src/orchestrator/prompt-optimizer.ts | TEST-FILE |
| `src/orchestrator/prompt-optimizer.test.ts` | 5434 | Asserts: optimizePrompt — 3 describe / 16 test blocks. | — (no exports) | 1 → src/orchestrator/prompt-optimizer.ts | TEST-FILE |
| `src/orchestrator/prompt-optimizer.ts` | 4079 | Rewrites the user turn into a precise English prompt; gated on `isActionableInstruction` so chat replies are passed through unchanged. | type OptimizerChat, type PromptContext, isActionableInstruction(), const PROMPT_SYSTEM, optimizePrompt() | 0 → — | LIVE+TEST |
| `src/orchestrator/slash-wiring.test.ts` | 4037 | Asserts: slash parsing is a hard boundary, not a convenience — 1 describe / 10 test blocks. | — (no exports) | 1 → src/orchestrator/slash.ts | TEST-FILE |
| `src/orchestrator/slash.test.ts` | 4622 | Asserts: parseSlashCommand — 3 describe / 17 test blocks. | — (no exports) | 1 → src/orchestrator/slash.ts | TEST-FILE |
| `src/orchestrator/slash.ts` | 3400 | Slash-command table and parser for commands the shell may send (200-arg cap, control-char rejection). | type SlashCommand, const SLASH_COMMANDS, type ParsedSlash, const SLASH_MAX_ARGS, parseSlashCommand(), slashCommandError(), describeSlashCommands() | 0 → — | LIVE+TEST |
| `src/orchestrator/task-queue.test.ts` | 12870 | Asserts: M2 Pattern 1 — task queue — 1 describe / 13 test blocks. | — (no exports) | 1 → src/orchestrator/task-queue.ts | TEST-FILE |
| `src/orchestrator/task-queue.ts` | 15331 | Voice-level task queue: FIFO records, 30 s planning deadline, depth 8, 64-record cap, snapshot/notify callbacks. | type TaskStatus, type TaskOwner, type TaskKind, type TaskResult, type TaskRecord, type EnqueueInput, type TaskStats, type TaskQueueOptions, const PLAN_DEADLINE_MS, const TASK_MAX_DEPTH, const TASK_RECORDS_CAP, class TaskQueue | 0 → — | LIVE+TEST |
| `src/policy/claim-matcher.test.ts` | 3614 | Asserts: hasClaimIn — 1 describe / 10 test blocks. | — (no exports) | 1 → src/policy/claim-matcher.ts | TEST-FILE |
| `src/policy/claim-matcher.ts` | 2894 | Detects a factual claim inside quoted prose in a markdown file. Reachable ONLY from src/policy/docs-verify-coverage.test.ts — ships to nothing. | hasClaimIn() | 0 → — | TEST-ONLY |
| `src/policy/docs-verify-coverage.test.ts` | 5007 | Asserts: docs:verify keeps its claim set — 1 describe / 5 test blocks. | — (no exports) | 1 → src/policy/claim-matcher.ts | TEST-FILE |
| `src/policy/laya-sidecar-safety.test.ts` | 14010 | Asserts: Laya is quarantined behind import() (v0.6.0 regression class) — 1 describe / 13 test blocks. | type Walk | 0 → — | TEST-FILE |
| `src/policy/sidecar-safety.test.ts` | 7825 | Asserts: sidecar-safe VAD wiring (v0.6.0 regression) — 2 describe / 6 test blocks. | — (no exports) | 2 → src/voice/ingest.ts, src/orchestrator/audio-pipeline.ts | TEST-FILE |
| `src/policy/telemetry-wired.test.ts` | 5582 | Asserts: telemetry is wired into the daemon (was dead code) — 2 describe / 7 test blocks. | — (no exports) | 1 → src/telemetry/index.ts | TEST-FILE |
| `src/policy/zero-canned.test.ts` | 6138 | Asserts: zero canned replies (Phase 5) — 1 describe / 11 test blocks. | — (no exports) | 0 → — | TEST-FILE |
| `src/runtime/client-shell.test.ts` | 15002 | Asserts: execSessionShell — the response is no longer discarded — 4 describe / 13 test blocks. | — (no exports) | 1 → src/runtime/client.ts | TEST-FILE |
| `src/runtime/client.test.ts` | 28298 | Asserts: ServeClient vs mock serve — 2 describe / 25 test blocks. | — (no exports) | 1 → src/runtime/client.ts | TEST-FILE |
| `src/runtime/client.ts` | 48937 | The serve (port 4096) HTTP client: 20 route call sites, Basic auth, a 4xx/409/401 taxonomy, an opt-in SPA-fallback guard, and per-method honesty about which routes are measured to exist. | basicAuth(), type SessionTokens, type SessionInfo, type MessageTokens, type ContextUsage, type SessionStatusInfo, type ModelRef, type AgentInfo, type Provenance, type DispatchProvenance, const DEFAULT_SHELL_AGENT, type ShellStatus, type ShellOutcome, type ShellToolResult, type SessionShellResult, class ServeClient | 3 → src/common/brands.ts, src/common/errors.ts, src/ipc/protocol.ts | LIVE+TEST |
| `src/runtime/fuzzy-match.test.ts` | 4240 | Asserts: normalizeForMatch — 2 describe / 15 test blocks. | — (no exports) | 1 → src/runtime/fuzzy-match.ts | TEST-FILE |
| `src/runtime/fuzzy-match.ts` | 4176 | Arabic/technical fuzzy picker: normalises for match, scores candidates and returns the best plus the runner-up set. | normalizeForMatch(), fuzzyPick(), fuzzyCandidates() | 0 → — | LIVE+TEST |
| `src/runtime/index.ts` | 90 | Barrel exporting ServeClient. | ServeClient | 1 → src/runtime/client.ts | LIVE+TEST |
| `src/runtime/laya/constants.ts` | 1035 | Dependency-free Laya constants: operating length 32 and the four head names. Split out so loader.ts can name the heads without an edge to the engine. | const LAYA_OPERATING_LENGTH, const LAYA_HEADS, type LayaHead | 0 → — | TEST-ONLY |
| `src/runtime/laya/index.ts` | 1520 | Laya public barrel. Re-exports LayaEngine, so a STATIC import of this file is fatal at load time. NOTHING imports it — it is the only DEAD module in the tree. | LAYA_HEADS, LAYA_OPERATING_LENGTH, loadLayaAdvisory, LAYA_MODEL_PATH_DEFAULT, emitLayaTelemetry, layaTelemetryRow, LayaBpeTokenizer, LayaEngine | 6 → src/runtime/laya/constants.ts, src/runtime/laya/loader.ts, src/runtime/laya/telemetry.ts, src/runtime/laya/tokenizer.ts, src/runtime/laya/types.ts, src/runtime/laya/laya-engine.ts | DEAD |
| `src/runtime/laya/laya-engine.ts` | 5072 | ORT-backed LayaEngine: loads the ONNX session, tokenizes, runs the four heads and mean-pools. Statically imports onnxruntime-node. Never constructed anywhere in the tree. | LAYA_HEADS, LAYA_OPERATING_LENGTH, type LayaSession, class LayaEngine | 4 → src/common/brands.ts, src/runtime/laya/tokenizer.ts, src/runtime/laya/constants.ts, src/runtime/laya/types.ts, onnxruntime-node | TEST-ONLY |
| `src/runtime/laya/laya.integration.test.ts` | 4338 | Asserts: Laya live model (opt-in: LAYA_LIVE=1) — 1 describe / 3 test blocks. | — (no exports) | 3 → src/runtime/laya/constants.ts, src/runtime/laya/laya-engine.ts, src/runtime/laya/tokenizer.ts | TEST-FILE |
| `src/runtime/laya/laya.test.ts` | 7276 | Asserts: LayaBpeTokenizer — 3 describe / 10 test blocks. | — (no exports) | 3 → src/runtime/laya/laya-engine.ts, src/runtime/laya/constants.ts, src/runtime/laya/tokenizer.ts, onnxruntime-node | TEST-FILE |
| `src/runtime/laya/loader.test.ts` | 8778 | Asserts: loadLayaAdvisory fail-soft contract — 2 describe / 13 test blocks. | — (no exports) | 4 → src/runtime/laya/constants.ts, src/runtime/laya/loader.ts, src/runtime/laya/telemetry.ts, src/telemetry/index.ts | TEST-FILE |
| `src/runtime/laya/loader.ts` | 5706 | The safe façade: `loadLayaAdvisory` reaches the engine only through `import()`. `loadLayaAdvisory` has ZERO call sites in the whole tree, including tests. | type LayaAdvisory, type LoadLayaOptions, const LAYA_MODEL_PATH_DEFAULT, loadLayaAdvisory() | 5 → src/runtime/laya/constants.ts, src/runtime/laya/tokenizer.ts, src/runtime/laya/telemetry.ts, src/runtime/laya/types.ts, src/runtime/laya/laya-engine.ts | TEST-ONLY |
| `src/runtime/laya/telemetry.ts` | 4372 | Shapes the Laya decision into a telemetry row and emits it. Reachable only from the Laya tests. | type LayaTelemetrySink, type LayaTelemetryRow, type LayaTelemetryFacts, layaTelemetryRow(), emitLayaTelemetry() | 1 → src/telemetry/index.ts | TEST-ONLY |
| `src/runtime/laya/tokenizer.ts` | 5184 | Byte-level BPE tokenizer reconstructed from a tokenizer.json vocabulary; U+2581 as the replacement marker. Reachable only from the Laya tests. | type LayaTokenizer, type TokenizerJson, class LayaBpeTokenizer | 0 → — | TEST-ONLY |
| `src/runtime/laya/types.ts` | 1050 | The LayaDecision shape, deliberately in a module with no specifier-bearing edge to the engine. | type LayaDecision | 1 → src/runtime/laya/constants.ts | TEST-ONLY |
| `src/runtime/opencode-bridge.test.ts` | 11283 | Asserts: OpenCodeBridge.getSessionDetails — 4 describe / 20 test blocks. | — (no exports) | 3 → src/runtime/client.ts, src/runtime/opencode-bridge.ts, src/runtime/fuzzy-match.ts | TEST-FILE |
| `src/runtime/opencode-bridge.ts` | 9710 | Adapts ServeClient into the view types the WS inventory/agent frames carry, and filters the internal slash commands that must not be surfaced as user actions. | type SessionTokensView, type SessionDetails, type AgentInfoView, type CommandInfoView, type EnvironmentStatus, class OpenCodeBridge | 3 → src/runtime/client.ts, src/common/brands.ts, src/runtime/fuzzy-match.ts | LIVE+TEST |
| `src/runtime/serve-health.test.ts` | 28496 | Asserts: loss is declared only at the failure threshold — 7 describe / 31 test blocks. | — (no exports) | 2 → src/runtime/client.ts, src/ipc/protocol.ts | TEST-FILE |
| `src/runtime/serve-health.ts` | 28276 | Periodic serve health monitor with hysteresis (fail at 2, recover at 2), exponential backoff 1s->30s, max 6 reconnect attempts, and the gate that blocks serve-dependent commands while degraded. | const SERVE_HEALTH_INTERVAL_MS, const SERVE_HEALTH_PROBE_TIMEOUT_MS, const SERVE_HEALTH_WATCHDOG_GRACE_MS, const SERVE_HEALTH_FAILURE_THRESHOLD, const SERVE_HEALTH_RECOVERY_THRESHOLD, const SERVE_HEALTH_BACKOFF_MS, const SERVE_HEALTH_BACKOFF_MAX_MS, const SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS, type ServeHealthState, type ServeProbe, type ServeHealthStatus, type ServeHealthEvent, const SERVE_BLOCKED_DETAIL_DEGRADED, const SERVE_BLOCKED_DETAIL_RECONNECTING, const SERVE_BLOCKED_DETAIL_EXHAUSTED, const SERVE_NOTICE_RECONNECTING, const SERVE_LOCAL_ONLY_COMMANDS, isServeAvailable(), serveBlockedDetail(), withServeGate(), type ServeHealthMonitorOptions, type CheckResult, class ServeHealthMonitor | 1 → src/launcher/index.ts | LIVE+TEST |
| `src/runtime/vad-gate.test.ts` | 9609 | Asserts: with no model the gate answers from the fallback and arms no timer per window — 0 describe / 8 test blocks. | — (no exports) | 1 → src/runtime/vad-gate.ts | TEST-FILE |
| `src/runtime/vad-gate.ts` | 8470 | The transport-blind gate seam: wraps a lazily loaded Silero module with a timeout and an RMS fallback, and never imports onnxruntime-node itself. | const VAD_GATE_TIMEOUT_MS, type VadModule, type VadLoad, type VadFallback, type VadGate, makeVadGate() | 1 → src/voice/ingest.ts | LIVE+TEST |
| `src/runtime/vad.test.ts` | 3822 | Asserts: SileroVad geometry — 3 describe / 5 test blocks. | — (no exports) | 1 → src/runtime/vad.ts | TEST-FILE |
| `src/runtime/vad.ts` | 6185 | Silero VAD wrapper. Statically imports onnxruntime-node, which is exactly why the daemon loads it through `import()` (daemon.ts:1055) rather than a static edge. | const VAD_SAMPLE_RATE, const VAD_WINDOW_SAMPLES, class VadModelMissing, class VadModelError, type VadSession, class SileroVad | 0 → onnxruntime-node | LIVE+TEST |
| `src/tasks/bounds.test.ts` | 11532 | Asserts: the exported bounds are constants with the documented relationship — 5 describe / 16 test blocks. | — (no exports) | 2 → src/tasks/engine.ts, src/tasks/types.ts | TEST-FILE |
| `src/tasks/engine.ts` | 24560 | Durable task engine: concurrency 2, pending 8, history 64, 15-min default / 4-h max timeout, timeout enforcement and recovery classification. | const MAX_CONCURRENCY, const MAX_PENDING, const MAX_HISTORY, const MAX_TASK_TIMEOUT_MS, const MIN_TASK_TIMEOUT_MS, const DEFAULT_TASK_TIMEOUT_MS, type EnqueueResult, type TaskEvent, type TaskRecovery, type QueueStats, type TaskQueueOptions, class TaskQueue | 2 → src/tasks/store.ts, src/tasks/types.ts | LIVE+TEST |
| `src/tasks/fsm.test.ts` | 9797 | Asserts: task FSM — the transition table — 4 describe / 13 test blocks. | — (no exports) | 2 → src/tasks/engine.ts, src/tasks/types.ts | TEST-FILE |
| `src/tasks/index.ts` | 1225 | Tasks barrel: queue, stores, FSM helpers and notice builder. | TaskQueue, FileTaskStore, MemoryTaskStore, SNAPSHOT_VERSION, TaskStoreError, nodeFs, canTransition, isTerminal, LEGAL_TRANSITIONS, TERMINAL_STATES, taskId, buildTaskNotice | 4 → src/tasks/engine.ts, src/tasks/store.ts, src/tasks/types.ts, src/tasks/notices.ts | LIVE+TEST |
| `src/tasks/notices.test.ts` | 4432 | Asserts: classification — 2 describe / 11 test blocks. | — (no exports) | 2 → src/tasks/notices.ts, src/tasks/types.ts | TEST-FILE |
| `src/tasks/notices.ts` | 3513 | Builds the Arabic notice text for a task state transition, from the state plus a context object. | type NoticeSeverity, type TaskNotice, type NoticeContext, buildTaskNotice() | 1 → src/tasks/types.ts | LIVE+TEST |
| `src/tasks/persistence.test.ts` | 16727 | Asserts: what is durable — 5 describe / 17 test blocks. | — (no exports) | 3 → src/tasks/engine.ts, src/tasks/store.ts, src/tasks/types.ts | TEST-FILE |
| `src/tasks/store.ts` | 5298 | Snapshot persistence behind an injectable fs port: FileTaskStore (atomic write) and MemoryTaskStore, versioned at SNAPSHOT_VERSION 1. | const SNAPSHOT_VERSION, type FsPort, const nodeFs, type TaskSnapshot, type StoreRead, type TaskStore, class TaskStoreError, class FileTaskStore, class MemoryTaskStore | 0 → — | LIVE+TEST |
| `src/tasks/timeout.test.ts` | 14310 | Asserts: a hung task times out and FREES ITS SLOT — 4 describe / 14 test blocks. | — (no exports) | 2 → src/tasks/engine.ts, src/tasks/types.ts | TEST-FILE |
| `src/tasks/types.ts` | 6874 | The task FSM: TaskId brand, TaskState union, TERMINAL_STATES, LEGAL_TRANSITIONS and canTransition(). | type TaskId, taskId(), type TaskState, const TERMINAL_STATES, isTerminal(), const LEGAL_TRANSITIONS, canTransition(), type TaskFailureCode, type RecoveryCode, type TaskFailure, type TaskOutcomeCode, type TaskSpec, type TaskRecord, type TaskExecutor | 0 → — | LIVE+TEST |
| `src/telemetry/index.ts` | 189 | Telemetry barrel exporting the writer and its two schemas. | RemediationSchema, SanitizedErrorClassSchema, TelemetryWriter | 1 → src/telemetry/writer.ts | LIVE+TEST |
| `src/telemetry/writer-redaction.test.ts` | 5171 | Asserts: TelemetryWriter redaction — 1 describe / 4 test blocks. | — (no exports) | 2 → src/common/logger.ts, src/telemetry/writer.ts | TEST-FILE |
| `src/telemetry/writer.test.ts` | 3695 | Asserts: TelemetryWriter — 1 describe / 4 test blocks. | — (no exports) | 1 → src/telemetry/writer.ts | TEST-FILE |
| `src/telemetry/writer.ts` | 6220 | Appends redacted JSONL telemetry rows (voice-runtime.jsonl) through an injected sink, with a closed remediation and error-class vocabulary. | const SanitizedErrorClassSchema, type SanitizedErrorClass, const RemediationSchema, type RemediationAttempted, type TelemetryInput, type TelemetryWriterOptions, class TelemetryWriter | 1 → src/common/logger.ts | LIVE+TEST |
| `src/voice/brain.test.ts` | 14659 | Asserts: OpenRouterBrainClient — 4 describe / 28 test blocks. | — (no exports) | 1 → src/voice/brain.ts | TEST-FILE |
| `src/voice/brain.ts` | 17186 | OpenRouter conversational client: agentic User-Agent, 2 s golden / 5 s ceiling budgets, Ammani system prompt, extractJson, and the requiresConfirmation destructive-verb detector. | const BRAIN_GOLDEN_MS, const BRAIN_CEILING_MS, const OPENROUTER_USER_AGENT, const BrainOutputSchema, type BrainOutput, normalizeBrainJson(), requiresConfirmation(), const AMMANI_SYSTEM_PROMPT, extractJson(), type BrainClient, const BRAIN_OPENROUTER_MODEL, const OPENROUTER_CHAT_URL, openRouterChat(), class OpenRouterBrainClient | 1 → src/common/errors.ts | LIVE+TEST |
| `src/voice/cache.test.ts` | 660 | Asserts: cache key derivation — 1 describe / 3 test blocks. | — (no exports) | 1 → src/voice/cache.ts | TEST-FILE |
| `src/voice/cache.ts` | 2966 | Content-addressed TTS audio cache keyed on normalised text+voice; stats and eviction. Imported by daemon? no — see reachability column. | type AudioCacheEntry, type AudioCacheStats, type AudioCacheConfig, normalizeForCache(), cacheKey(), class AudioCache | 1 → src/common/brands.ts, lru-cache | LIVE+TEST |
| `src/voice/fish-free-tier-header.test.ts` | 2680 | Asserts: the free model is selected by header, not by body field — 1 describe / 6 test blocks. | — (no exports) | 1 → src/voice/tts.ts | TEST-FILE |
| `src/voice/fish-ws.test.ts` | 15009 | Asserts: fish-ws msgpack framing — 5 describe / 15 test blocks. | — (no exports) | 4 → src/voice/fish-ws.ts, src/voice/tts.ts, src/voice/keyring.ts, src/voice/vault.ts | TEST-FILE |
| `src/voice/fish-ws.ts` | 22466 | Hand-rolled MessagePack codec plus the Fish WebSocket transport, selected by ttsTransportMode(). | type MsgValue, encodeMsgpack(), decodeMsgpack(), type FishWsEvent, type FishWsSocket, type FishWsConnector, class FishWsError, class FishWsTransport, ttsTransportMode(), createFishTransport() | 2 → src/voice/tts.ts, src/voice/keyring.ts | LIVE+TEST |
| `src/voice/ingest.test.ts` | 15109 | Asserts: AudioIngest — 6 describe / 26 test blocks. | — (no exports) | 1 → src/voice/ingest.ts | TEST-FILE |
| `src/voice/ingest.ts` | 10279 | PCM window accumulator: 160,000 B windows, 6-window shed cap, 256 KiB/32 KiB backpressure watermarks, and the RMS speech gate at -30 dBFS shared with the renderer. | const WINDOW_BYTES, const MAX_BUFFERED_BYTES, const PAUSE_BYTES, const RESUME_BYTES, type WatermarkState, type AudioIngestOptions, const SPEECH_GATE_DB, windowRmsDb(), isLoudWindow(), bytesToFloat32(), class AudioIngest | 0 → — | LIVE+TEST |
| `src/voice/key-advanced-telemetry.test.ts` | 3967 | Asserts: keyAdvanced reports only a real rotation — 1 describe / 6 test blocks. | — (no exports) | 2 → src/voice/keyring.ts, src/common/errors.ts | TEST-FILE |
| `src/voice/key-release-status.test.ts` | 9685 | Asserts: httpStatusOf recovers the status a rotation depends on — 2 describe / 20 test blocks. | — (no exports) | 2 → src/voice/keyring.ts, src/common/errors.ts | TEST-FILE |
| `src/voice/key-store.test.ts` | 2142 | Asserts: key-store (daemon key intake → vault) — 1 describe / 5 test blocks. | — (no exports) | 2 → src/voice/key-store.ts, src/voice/vault.ts | TEST-FILE |
| `src/voice/key-store.ts` | 3200 | Reads, merges and writes the encrypted key pools, and reports vault key status by fingerprint only. | type KeyPools, readKeyPools(), mergeKeyPools(), writeKeyPools(), vaultKeyStatus() | 1 → src/voice/vault.ts | LIVE+TEST |
| `src/voice/keyring.test.ts` | 5668 | Asserts: lock-free rotation distribution (ADR-005 proof) — 2 describe / 8 test blocks. | — (no exports) | 2 → src/voice/keyring.ts, src/voice/vault.ts | TEST-FILE |
| `src/voice/keyring.ts` | 7516 | Key pool rotation: per-call copies, ROTATION_LIMIT 10, advance only on 401/403/429, a keyAdvanced symbol for the advanced-telemetry path. | const ROTATION_LIMIT, type AcquiredKey, type RolloverInfo, class Keyring, withKey(), keyAdvanced() | 3 → src/common/brands.ts, src/common/errors.ts, src/voice/vault.ts | LIVE+TEST |
| `src/voice/stt.test.ts` | 7279 | Asserts: meanNoSpeechProb — 3 describe / 15 test blocks. | — (no exports) | 3 → src/voice/ingest.ts, src/orchestrator/audio-pipeline.ts, src/voice/stt.ts | TEST-FILE |
| `src/voice/stt.ts` | 7223 | Groq Whisper large-v3-turbo client: 5 s chunks with 0.5 s overlap, 15 s hard timeout with a typed SttTimeoutError, mean no_speech_prob. | const SAMPLE_RATE, const BYTES_PER_SAMPLE, const CHUNK_MS, const OVERLAP_MS, const CHUNK_BYTES, const OVERLAP_BYTES, type AudioChunk, type Transcript, type WhisperSegment, meanNoSpeechProb(), chunkPcm(), type WhisperClient, type WhisperResult, class GroqWhisperClient, const STT_TIMEOUT_MS, class SttTimeoutError, type TranscribeOptions, transcribeStream() | 1 → src/common/brands.ts, groq-sdk | LIVE+TEST |
| `src/voice/tts-credit.test.ts` | 5790 | Asserts: FishCreditError — 2 describe / 10 test blocks. | — (no exports) | 2 → src/voice/tts.ts, src/voice/tts-credit.ts | TEST-FILE |
| `src/voice/tts-credit.ts` | 4891 | TTS credit exhaustion monitor: first-fault clock, 7-day top-up advisory escalation, status/remediation output. | const TOPUP_ADVISORY_DAYS, type TtsCreditState, type TtsCreditStatus, class TtsCreditMonitor | 1 → src/voice/tts.ts | LIVE+TEST |
| `src/voice/tts-r3-errors.test.ts` | 9992 | Asserts: a Fish status produces an actionable message (R3) — 4 describe / 21 test blocks. | — (no exports) | 2 → src/voice/tts.ts, src/voice/keyring.ts | TEST-FILE |
| `src/voice/tts.test.ts` | 24440 | Asserts: splitSentences — 9 describe / 47 test blocks. | — (no exports) | 3 → src/voice/tts.ts, src/common/brands.ts, src/voice/cache.ts | TEST-FILE |
| `src/voice/tts.ts` | 33542 | Fish TTS: sentence splitting, SpeechGate for barge-in, the typed FishCreditError taxonomy for 402/429, HTTP and WS transports, and TtsEngine with the audio cache. | const TTS_MODEL, const TTS_FIRST_CHUNK_BUDGET_MS, const MAX_SENTENCE_CHARS, const SPEECH_FILLERS, stripSpeechText(), isSpeakable(), type AudioOut, splitSentences(), class SpeechGate, class FileAudioOut, type FishTransport, fishHeaders(), class FishCreditError, fishErrorMessage(), fishErrorDetail(), fishRequestBody(), const FISH_TIMEOUT_MS, const SPEECH_CACHE_MAX_ENTRY_BYTES, const PLAYBACK_RETENTION_MS, sweepOldPlaybackFiles(), class TtsTimeoutError, fetchWithTimeout(), class FishHttpTransport, class TtsEngine | 3 → src/common/brands.ts, src/voice/cache.ts, src/voice/keyring.ts | LIVE+TEST |
| `src/voice/vault.ts` | 7412 | AES-256-GCM encrypted key pool storage: scrypt-derived app key, per-pool checksum, temp+rename save. | const KEY_POOLS, type KeyPool, type VaultBlob, encryptPool(), decryptPool(), class FileVault | 3 → src/common/brands.ts, src/voice/win-acl.ts, src/common/errors.ts | LIVE+TEST |
| `src/voice/win-acl.test.ts` | 1361 | Asserts: owner-only ACL capability, as measured on this platform — 1 describe / 2 test blocks. | — (no exports) | 1 → src/voice/win-acl.ts | TEST-FILE |
| `src/voice/win-acl.ts` | 3544 | Probes whether an owner-only ACL can be set from Node on this host. Returns false with a reason rather than shipping a silent no-op. | type AclCapability, ownerOnlyAclAvailable(), icaclsAvailable() | 0 → — | LIVE+TEST |

---

## 2. The manifest — Python (18 files, offline ML toolchain, not in the TS graph)

All 18 have a `#!/usr/bin/env python3` shebang. `ml/export_onnx.py` is the only one importing a sibling
(`train_laya`). None is reachable from any shipped entrypoint; they are the training/eval/export harness for
the quarantined Laya heads.

| path | bytes | purpose (from module docstring / defs) | defs | imports | reachable |
|---|---|---|---|---|---|
| `ml/bench_onnx.py` | 2570 | !/usr/bin/env python3 | `def`: main | 10 → json, os, statistics, time, pathlib, numpy | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/data/generate_synth.py` | 42306 | !/usr/bin/env python3 | `def`: build_frames, frame_fill_space, split_of_frame, contrast_split, stratify_labels, _load_token_len, _with_barge_loop, _roll_barge_loop | 9 → argparse, json, random, collections, pathlib, itertools | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/data/harvest_joda.py` | 2242 | !/usr/bin/env python3 | `def`: extract_text, main | 5 → json, pathlib, datasets, datasets.exceptions | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/diagnose_shortcut.py` | 7246 | !/usr/bin/env python3 | `def`: load_rows, has_marker, is_negated, main | 8 → json, math, pathlib, numpy, torch, onnxruntime | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/eval_adversarial.py` | 5990 | !/usr/bin/env python3 | `def`: pad, predict, evaluate, main | 7 → json, sys, pathlib, numpy, onnxruntime, tokenizers | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/eval_onnx.py` | 3145 | !/usr/bin/env python3 | `def`: pad, evaluate, main | 9 → json, sys, pathlib, numpy, onnxruntime, yaml | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/export_onnx.py` | 2391 | !/usr/bin/env python3 | `def`: main | 7 → sys, pathlib, torch, yaml, onnxruntime.quantization, train_laya | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/finalize_l2.py` | 5661 | !/usr/bin/env python3 | `def`: pad, main | 14 → json, os, statistics, sys, time, pathlib | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/gen_tokenizer_golden.py` | 1809 | !/usr/bin/env python3 | `def`: main | 4 → json, pathlib, tokenizers | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/head_metrics.py` | 3829 | !/usr/bin/env python3 | `def`: pad, logits_for, bce, main | 9 → json, sys, pathlib, numpy, onnxruntime, yaml | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/latency_compare.py` | 2613 | !/usr/bin/env python3 | `def`: main | 11 → json, os, statistics, sys, time, pathlib | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/laya_hub.py` | 2006 | !/usr/bin/env python3 | `def`: stage_snapshot, load_backbone | 6 → shutil, pathlib, huggingface_hub, safetensors.torch, transformers | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/negation_probe.py` | 2118 | !/usr/bin/env python3 | `def`: pad, main | 6 → json, pathlib, numpy, onnxruntime, tokenizers | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/score_probe.py` | 2080 | !/usr/bin/env python3 | `def`: pad, main | 6 → sys, pathlib, numpy, onnxruntime, tokenizers | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/stress_battery.py` | 10972 | !/usr/bin/env python3 | `def`: pad, main | 10 → json, statistics, sys, time, pathlib, numpy | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/train_laya.py` | 13000 | !/usr/bin/env python3 | `def`: set_seed, unfreeze_top_blocks, find_layer_blocks, load_trained_laya, pool_dataset, main | 14 → json, os, random, pathlib, numpy, torch | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/verify_g1.py` | 5209 | !/usr/bin/env python3 | `def`: main | 6 → json, re, sys, pathlib, tokenizers | OFFLINE-TOOLCHAIN (not in the TS graph) |
| `ml/verify_g2.py` | 4559 | !/usr/bin/env python3 | `def`: norm, main | 5 → json, re, sys, pathlib | OFFLINE-TOOLCHAIN (not in the TS graph) |

---

## 3. Non-code files under the roots (for completeness, not source)

94 files. The bulk is the Tauri icon set, which is inert scaffold.

| Group | Count | Notes |
|---|---|---|
| `apps/desktop/src-tauri/icons/**` (PNG/ICNS/ICO/SVG/XML) | 65 | Desktop + Android + iOS icon sets |
| `ml/data/**` (jsonl/json/pt) | 11 | 3.19 MB train.jsonl, 3.98 MB synth set, 40.1 MB `best.pt` checkpoint |
| `ml/*.json` result artifacts | 8 | head_metrics, l2_report, latency_compare, negation_report, phase1_diagnosis, quant_report, stress_results, adversarial_report/suite |
| `__pycache__/*.pyc` | 4 | byte-compiled, gitignored |
| `apps/desktop/src-tauri/gen/schemas/**` | 4 | Tauri-generated ACL/capability/desktop/windows schemas |
| `src-tauri` + `apps/desktop` manifests | 6 | `Cargo.lock`, `Cargo.toml`, `tauri.conf.json`, `capabilities/default.json`, `package.json`, `package-lock.json`, `tsconfig.json` |
| root configs | 4 | `vite/vitest/tailwind/postcss` configs, `src/index.css`, `styles/tokens.css` |
| `src/runtime/laya/__fixtures__/tokenizer_golden.json` | 1 | 5,632 B golden tokenizer fixture |
| `ml/*.md`, `*.yaml`, `*.txt` | 4 | eval_report.md, phase1_data_spec.md, training_config.yaml, requirements-cpu.txt |
| `scripts/lint-baseline.json` | 1 | 1 B — the recorded oxlint baseline |

**No `go.mod`, no `pyproject.toml`, no root `Cargo.toml`.** Verified: the only `Cargo.toml` in the tree is
`apps/desktop/src-tauri/Cargo.toml` (1,739 B), reachable from `main.rs` (`143,826 B, 3,296 lines`).
`pyrightconfig.json` (220 B) exists at the root but there is no Python package to typecheck —
`ml/` is a flat directory of scripts, not an installable package.

---

## 4. Core-logic deep dive

### 4.1 The coordinator / intake / plan chain

`Coordinator` in `src/orchestrator/coordinator.ts` is split into two legs with opposite latency profiles.

**Leg 1 — `intake()` (`coordinator.ts:517-585`).** Calls the chat model with
`INTAKE_MODEL = 'dots-studio/dots-3-note-preview:free'` (`coordinator.ts:31`). Decoding controls are fixed
at `coordinator.ts:537`: `{ reasoning: { effort: 'none' }, maxTokens: 200, temperature: 0.2, timeoutMs: 10_000 }`.

Decision points, in order:
1. **Failover loop** (`:529-551`) over `[intakeModel, fallbackModel]` where `fallbackModel` defaults to
   `COORDINATOR_MODEL` (`:519`). A **throw** sets `intakeTransportFailed = true` and continues (`:541`).
2. **Parse** via `parseSchema(IntakeSchema, raw)` (`:544`). On failure it sets
   `intakeTransportFailed = false` (`:550`) and falls through to the next model.
3. **Terminal classification** (`:552-554`): `intake === null` returns
   `detail: intakeTransportFailed ? 'intake-failed' : 'intake-invalid'`.
4. **Outcome-claim guard** (`:571-575`). `claimsOutcome()` (`:117-120`) tests `reply_ar` against
   `OUTCOME_CLAIM_AR` (`:103-106`, built from a 32-verb explicit list at `:98-102`, requiring whitespace
   after `تم` so `تمام` does not match) and `OUTCOME_CLAIM_EN` (`:108`). On a hit it re-asks once via
   `reaskIntake()` (`:601-617`, 3 s budget) and, if the retry still claims a result, sets
   `replyAr = ''`.

**⚠ The step-2/3 interaction is a live defect and the code's own comment denies it.**
`coordinator.ts:509-511` states: *"Those flags are load-bearing: primary 500 + fallback 200-garbage must
report `intake-failed`, not `intake-invalid`."* The code at `:550` does the opposite — an unparseable
fallback body **resets** the transport flag, so that exact scenario reports `intake-invalid`.

**Leg 2 — `plan()` (`coordinator.ts:628-739`).** Gates, in order:

| # | Gate | Location | Behaviour on hit |
|---|---|---|---|
| 1 | ack shape | `:632-637` | `replyAr === undefined || taskEn === undefined` → return `intake-failed`, no planning call |
| 2 | `aborted()` | `:652`, and re-checked after **every** await (`:687, 691, 704, 731`) | `cancelled()` — cancel landing during a 25 s plan still refuses the dispatch |
| 3 | **permission gate** | `:662-670` | `kind: 'stop'` → the gate's own `MissionResult`, nothing dispatched |
| 4 | plan call | `:678-683` | `timeoutMs: 25_000`, `temperature: 0.2`, `maxTokens: 300`, `responseFormat: PLAN_RESPONSE_FORMAT` |
| 5 | one bounded retry | `:689-703` | adds `CRITICAL: output ONLY the JSON object`; no unbounded loop |
| 6 | **destructive-step park (FR-12)** | `:709-722` | `requiresConfirmation(kind + ' ' + detail)` over each step; any hit returns `needsConfirmation: true` + `flagged` unless `opts.approve === true` |
| 7 | no active session | `:724-727` | returns `ok: true` **with the plan and `receipt: null`** — deliberately not an error |
| 8 | final abort re-check | `:731` | `cancelled()` |
| 9 | **dispatch** | `:737` | the single egress |

`run()` (`:746+`) is the retained pre-split chain: `intake()` then `plan()`, with the ack spoken
fire-and-forget at `:776-787`. The `.catch()` there is mandatory — an unhandled rejection in a detached
promise would take the process down, and the message is scrubbed by `redactString` at the interpolation (`:784`).

`PLAN_RESPONSE_FORMAT` (`:162-190`) is `type: 'json_schema'` with `strict: true` and
`additionalProperties: false` on both the root and the step object.

### 4.2 The contextual permission gate — both invariant counts, MEASURED

**The briefing located this invariant in `permission.ts`. It is not there.** Measured on
`src/orchestrator/permission.ts`: `kind: 'proceed'` = **0**, `deps.dispatch(` = **0**, `kind: 'stop'` = **0**.
The gate outcome type and the dispatch call site both live in `coordinator.ts`.

Counts measured by script over the raw file text:

| Pattern | File | Count | Sites |
|---|---|---|---|
| `kind: 'proceed'` (naive textual) | `coordinator.ts` | **2** | `:372` (the **type member** in the return annotation), `:438` (the returned value) |
| `return { kind: 'proceed'` (anchored) | `coordinator.ts` | **1** | `:438` |
| `kind: 'stop'` | `coordinator.ts` | 8 | — |
| `deps.dispatch(` (naive textual) | `coordinator.ts` | **1** | `:737` |
| `this.deps.dispatch(` (anchored) | `coordinator.ts` | **1** | `:737` |
| `permission.consume(` | `coordinator.ts` | 2 | `:364` (comment), `:427` (the call) |
| `deps.dispatch(` | `permission.ts` | **0** | — |
| `deps.dispatch(` | `audio-pipeline.ts` | 1 | `:186` — a **different** `deps` object, so the invariant is per-module |

**So: the invariant holds, but only in its anchored form.** "Exactly one `kind: 'proceed'`" is **false** as a
naive count (2). "Exactly one `deps.dispatch(`" is **true** (1). The repo already knows the distinction:
`src/orchestrator/command-tiers.test.ts:631` asserts `/return { kind: 'proceed'/g` length 1, and the
concurrent agent's `src/cli/turn.ts:331` hard-codes both patterns —
`{ label: "return { kind: 'proceed'", pattern: /return \{ kind: 'proceed'/g, expected: 1 }` and
`{ label: 'this.deps.dispatch(', pattern: /this\.deps\.dispatch\(/g, expected: 1 }` — while separately
reporting the naive figure as `naiveProceedMentions` (`turn.ts:345`). **This file is a machine-checked
statement that the naive count is the wrong instrument.**

**Why the gate is structurally safe** (`coordinator.ts:367-472`): `gate()` is called from exactly one place
(`:662`) and `deps.dispatch` from exactly one place (`:737`), immediately after. `kind: 'proceed'` is
reachable only at `:438`, and only via `this.permission.consume(verdict.approvesId)` at `:427`, which
returns `null` unless the id matches exactly (`:428-431` → re-ask). Every other exit is `kind: 'stop'`:
deny (`:409`), answer (`:441`), not_addressed (`:455`), and a fallthrough that funnels
`ask_permission`/`undecided`/unclassifiable into `ask()` (`:471`, which opens the slot and notifies,
never dispatches).

`permission.ts` supplies the machinery: `PERMISSION_TTL_MS = 30_000` (`:105`), `MAX_SPOKEN_ASK_WORDS = 20`
(`:131`), `ADDRESSEE_RESPONSE_FORMAT` (`:65`), `ADDRESSEE_CHAT_OPTIONS` (`:90`), and
`parseAddressee()` which maps anything unrecognised to `undecided` — never to a proceed (`permission.ts:270`).

### 4.3 The tier model that classifies commands

`COMMAND_TIERS` at `src/orchestrator/command-router.ts:280-340` is declared
`satisfies { readonly [K in GovernedKind]: CommandTier }`, so it is **total over the union by construction**:
adding a kind to `UiCommand['kind']` fails to compile until someone writes down what it does to the machine.
`tierOf()` (`:343-345`) is a bare table read with **no default branch and no `unknown` tier**.

| Tier | Count | Members |
|---|---|---|
| `read-only` | 13 | `switchSession`, `sessionContext`, `abort`, `stopSpeech`, `playbackStarted`, `mute`, `deafen`, `arm`, `setSessionAgent`, `setSessionModel`, `setPersona`, `saveApiKeys` |
| `state-mutating` | 6 | `execSessionShell`, `writeFile`, `deleteFile`, `setSensitiveConfig`, `toggleSessionSkill`, `createSession` |

Two classifications are explicitly argued in-place rather than defaulted:

- `saveApiKeys: 'read-only'` (**:318**) — writes encrypted key material, but the actor is the local user in
  their own first-party key window and **there is no approval affordance in the renderer**, so gating it would
  make first-run provisioning impossible. Marked "THE ONE DEVIATION FROM THE OWNER'S TIER-2 LIST".
- `toggleSessionSkill` (**:335**) and `createSession` (**:339**) — classified strictly, flagged for overrule,
  on the stated grounds that the HUD sends neither today.

**Three kinds are classified but not on the wire.** `PENDING_PROTOCOL_KINDS` (**:269**) =
`['writeFile', 'deleteFile', 'setSensitiveConfig']`. They are gated and classified now, but
`protocol.ts` does not carry them, so each resolves to a structured "unavailable" refusal rather than
executing. `isPendingProtocolKind()` (**:350**) is the type guard; `DESTRUCTIVE_KINDS` (**:363-367**) is a
**derived view** that deliberately excludes the pending three and is typed over `WorkCommandKind`
(`Exclude<UiCommand['kind'], 'confirm'>`, **:243**) so `confirm` cannot enter it.

The single lookup is at **:793** — `if (tierOf(cmd.kind) === 'state-mutating')` — the park point, bounded by
`CONFIRMATION_TTL_MS = 60_000` (**:397**) and `MAX_PARKED = 8` (**:404**).
Input validators: `SESSION_ID_RE = /^ses_[A-Za-z0-9_-]{1,120}$/` (**:413**), `UNSAFE_SHELL_RE` (**:429**),
`TRAVERSAL_RE = /\.\./` (**:431**), `CONTROL_CHARS_RE` (**:433**).

### 4.4 The serve client — every route, and whether it was verified

`ServeClient` in `src/runtime/client.ts`. **20 route call sites**, every one extracted by script. The
client is unusually honest about this, and I am reporting its claims as *code-stated* status, not as
independently verified — I did not run a serve instance.

| # | Route | Verb | Call site | Route status per the code |
|---|---|---|---|---|
| 1 | `/api/session` | POST | :506 | canonical create, documented contract |
| 2 | `/api/session/{id}/prompt` | POST | :559 | documented contract |
| 3 | `/api/session/{id}` | GET | :575, :952 | documented contract |
| 4 | `/api/session/{id}/agent` | POST | :657 | **UNVERIFIED** — `client.ts:647` "the status this answers with has never been measured"; path presence in `/doc` likewise |
| 5 | `/api/session/{id}/model` | POST | :675 | **UNVERIFIED** — `:671` "status and the route's presence in `/doc` have both never been measured" |
| 6 | `/api/experimental/session/{id}/skill` | POST | :714 | **MEASURED ABSENT** — `:689` "MEASURED 2026-09-30: **this path does not exist.**" |
| 7 | `/api/session/{id}/shell` | POST | :731 | **MEASURED NOT A ROUTE** — `:736`; kept deliberately as a fallback-detector probe |
| 8 | `/session/{id}/shell` (v1) | POST | :790 | **VERIFIED against `/doc`** — `:749` cites `operationId: session.shell` |
| 9 | `/api/agent?directory=` | GET | :849 | documented 2.0.x contract |
| 10 | `/api/session` | GET | :868 | documented contract |
| 11 | `/api/session/{id}/context` | GET | :891 | documented contract |
| 12 | `/api/model` | GET | :972 | — |
| 13 | `/api/skill` | GET | :997 | — |
| 14 | `/api/session/{id}/compact` | POST | :1015 | **unmeasured** — guardSpaFallback OFF (`:606-609`) |
| 15 | `/api/session/{id}/interrupt` | POST | :1027 | **unmeasured** — guard OFF |
| 16 | `/api/session/{id}/revert/{phase}` | POST | :1035 | **unmeasured** — guard OFF; `:607` "nobody has measured whether their routes exist at all" |
| 17 | `/api/command` | GET | :1048 | — |
| 18 | `/api/session/{id}/message` | GET | :1068 | — |
| 19 | `/openapi.json` | GET | :1092 | **known-wrong path** — `:33` "The real spec is at `/doc`, not `/openapi.json`" |

**The load-bearing finding is the SPA fallback.** `client.ts:596-601`: an unknown path answers **200 with an
HTML body**, so `res.ok` is **true for a route that does not exist** — a mutating verb that only checks the
status reports success against nothing. `toggleSessionSkill` did exactly that, for every call, for as long as
the assumption stood (`:600-601`). The mitigation is `guardSpaFallback`, an **opt-in per-caller** flag
(`:618`) that is ON only for the verb measured to hit the fallback, and OFF for the five unmeasured verbs
(`:606-609`) — a deliberate refusal to fabricate a failure on a route that may work.

### 4.5 Knowledge / RAG path — measured by execution, not by reading

I compiled `src/` to a temp outDir **outside the repo** (`npx tsc -p tsconfig.json --outDir %LOCALAPPDATA%\Temp\opencode\kc`, exit 0) and ran the corpus code. These are **executed** numbers.

```
{ "sharedChunks": 43, "digest": "b5b1c410aa2d47fa",
  "nourExamples": 8, "kareemExamples": 8,
  "personaKeyLeaks": 0, "styleIdAsymmetries": 0 }
retriever.size = 43 ; assertParity() threw nothing
```

| Tier | Module | Chunks (executed) |
|---|---|---|
| 1 shared | `shared/architecture.ts` | 8 |
| 1 shared | `shared/capabilities.ts` | 11 |
| 1 shared | `shared/commands.ts` | 8 |
| 1 shared | `shared/failures.ts` | 8 |
| 1 shared | `shared/lexicon.ts` | 8 |
| — | **Tier-1 total** | **43** (matches `sharedChunks`) |
| 2/3 styling | `styles/nour.ts` | 8 |
| 2/3 styling | `styles/kareem.ts` | 8 |
| — | **Styling total** | **16** |

**BM25 implementation** (`retriever.ts:30-89`), hand-rolled, zero-dependency:
`K1 = 1.2` (**:30**), `B = 0.75` (**:31**),
idf = `log(1 + (N - df + 0.5) / (df + 0.5))` (**:81**),
tf-norm = `(tf × (K1+1)) / (tf + K1 × (1 - B + B·len/avgLen))` (**:82**).
`avgLen` is computed once in the constructor (**:62**). `normalizeToken` is applied on **both** the index
path (**:53**) and the query path (**:71**) — the asymmetry the module header calls out as the reason the
quarantined version failed on `EADDRINUSE` vs `eaddrinuse`.

**The normalizer** (`normalize.ts`) writes its classes as **explicit escapes with the gaps as the comment**
(`:23-26`) — `TASHKEEL = /[\u064B-\u065F\u066A\u066D-\u0672]/g` deliberately **excludes** U+0660-U+0669,
because the historical `U+064B-U+0672` range swallowed Arabic-Indic digits and deleted port numbers from
queries before scoring (`:11-18`). Digits are **not** folded to ASCII (`:31-37`). `normalizeToken` (`:74-76`)
lowercases Latin runs and normalises Arabic runs, branching on `/[\u0600-\u06FF]/`.

**Live probe** (executed): `idx.search('المنفذ ٤٠٩٦ مشغول', 3)` returns
`arch-ports` (3.2139), `lex-runtime` (3.0435), `fail-ports-busy` (2.4711) — the Arabic-Indic-digit query
does retrieve. The docstring's honest limit stands: recall is limited by **corpus coverage**, not scoring.

**Persona registry** (`personas.ts`): `PERSONA_DIRECTIVES` (**:79-82**) is
`satisfies Record<PersonaId, string>`, so a persona without a directive is a compile error.
`PERSONAS = { kareem: KAREEM, nour: NOUR }` (**:84**). `shieldHolds()` (**:91-94**) requires a first-person
reply containing `أنا` to also contain a shield phrase. Verified asymmetry = **0** on the `when` key.

**Reachability of the RAG half — measured, and it matters:** `src/knowledge/index.ts` (the barrel) has
exactly **one** production importer, `src/cli.ts`. `daemon.ts` imports `PERSONA_DIRECTIVES` from
`src/knowledge/personas.ts` **directly** (deep, not via the barrel), so the daemon never pulls the BM25
index into its graph. **No chunk is retrieved, ranked or interpolated into any prompt on the shipped path** —
the retriever is reachable only through the `knowledge` CLI subcommand.

### 4.6 The audio pipeline — capture, ingest, VAD, playback

| Stage | Module | Constants (value, `path:line`) |
|---|---|---|
| Capture (renderer) | `apps/desktop/src/audio/capture.ts` | `TARGET_RATE = 16000` (`:9`); AudioWorklet + ScriptProcessor fallback; `floatToInt16`, `downsample`, `encodeFrame` |
| Uplink frame | `src/ipc/protocol.ts` | `AUDIO_SAMPLE_RATE = 16000` (`:26`), `AUDIO_FRAME_MS = 100` (`:27`), `AUDIO_FRAME_BYTES = ((16000 × 100)/1000) × 2 = 3200` (`:28`) |
| Ingest | `src/voice/ingest.ts` | `WINDOW_BYTES = 160_000` (`:6`), `MAX_BUFFERED_BYTES = 960_000` (`:8`), `PAUSE_BYTES = 262_144` (`:47`), `RESUME_BYTES = 32_768` (`:48`), `SPEECH_GATE_DB = -30` (`:71`) |
| Speech gate | `src/voice/ingest.ts:74` | `windowRmsDb` via DataView, not an Int16Array view (odd `byteLength`/`byteOffset` would throw); returns −100 on empty |
| VAD seam | `src/runtime/vad-gate.ts` | `VAD_GATE_TIMEOUT_MS = 2000` (`:45`) — wraps the lazy Silero load, falls back to RMS |
| Silero | `src/runtime/vad.ts` | `VAD_SAMPLE_RATE = 16000` (`:8`), `VAD_WINDOW_SAMPLES = 512` (`:9`), `VAD_MODEL_URL` → huggingface silero-vad (`:11`) |
| Renderer VAD | `apps/desktop/src/audio/vad.ts` | `SPEECH_GATE_DB = -30` (`:22`), `SILENCE_DB = -100` (`:25`), `BELOW_GATE_SPAN_DB = 20` (`:35`), `KNEE = 0.4` (`:36`), `WINDOW_TAIL_FRAMES = 56` (`:140`) |
| Pipeline gates | `src/orchestrator/audio-pipeline.ts` | `NO_SPEECH_DROP = 0.6` (`:27`), `REPEAT_MEMORY = 5` (`:30`) |
| Downlink chunk | `src/ipc/audio.ts` | `AUDIO_DOWNLINK_TYPE = 0x01` (`:6`), `MAX_AUDIO_CHUNK = 32 × 1024` (`:7`) |
| Reassembled cap | `src/ipc/protocol.ts` | `MAX_AUDIO_BYTES = 64 × 1024` (`:30`), `MAX_MESSAGE_BYTES = 1 MiB` (`:22`), `MAX_PREHEADER_BYTES = 2 × MAX_MESSAGE_BYTES` (`:24`) |
| Playback | `apps/desktop/src/audio/playback.ts` | `PLAYBACK_QUEUE_CAP = 32` (`:54`), `MAX_COALESCE_TICKS = 2` (`:78`), `PLAYBACK_GAIN = 0.9` (`:305`), `PLAYBACK_START_LEAD_S = 0.03` (`:314`) |
| STT | `src/voice/stt.ts` | `SAMPLE_RATE = 16_000` (`:7`), `BYTES_PER_SAMPLE = 2` (`:8`), `CHUNK_MS = 5000` (`:9`), `OVERLAP_MS = 500` (`:10`), `STT_TIMEOUT_MS = 15_000` (`:135`) |

**The barge-in generation counter.** `AudioPipeline` carries `generation` (`audio-pipeline.ts:73`),
bumped by every `reset()`/`cancel()`, captured on `pushChunk` entry and re-checked after each await
(`:62-72`). Without it a `pushChunk` already parked on `transcribe` or `think` would carry on and dispatch
a turn belonging to the utterance the user just interrupted.

**Two anchor defects found:**
- `src/voice/ingest.ts:68` cites the renderer's gate as `apps/desktop/src/audio/vad.ts:20`. The constant is
  at **`:22`**. Off by two.
- The ingest header (`ingest.ts:29-45`) measures that the backpressure watermark **cannot fire on the live
  path**: transient ceiling `(160_000 − 1) + 65_536 = 225_535` B, which is 36,609 B short of
  `PAUSE_BYTES = 262_144`. I did not re-run that burst probe; I report it as a code-stated measurement.

### 4.7 `src/runtime/laya/` — the quarantined subsystem, PROVEN inert

**7 modules. Not one is reachable from a production entrypoint.**

| Module | Class | Note |
|---|---|---|
| `index.ts` | **DEAD** | the only DEAD module in the entire tree. **Zero importers**, not even a test |
| `laya-engine.ts` | TEST-ONLY | statically imports `onnxruntime-node` |
| `loader.ts` | TEST-ONLY | the safe façade |
| `constants.ts` | TEST-ONLY | heads + operating length |
| `tokenizer.ts` | TEST-ONLY | byte-level BPE |
| `telemetry.ts` | TEST-ONLY | telemetry row shaping |
| `types.ts` | TEST-ONLY | `LayaDecision` |

**The four heads** — `constants.ts:17`:

```ts
export const LAYA_HEADS = ['should_speak', 'is_destructive', 'barge_in', 'stuck_in_loop'] as const;
```

with `LAYA_OPERATING_LENGTH = 32` (`:15`). The comment at `:10-14` labels the 32 figure
**UNVERIFIED** — "not re-measured here".

**The loader's dynamic-import seam** — `loader.ts` reaches the engine only through `import()`:

```
src/runtime/laya/loader.ts:18   import('./runtime/vad.js')      // the ONNX-free dependency
src/runtime/laya/loader.ts:94   import('./laya-engine.js')      // the seam
```

and `index.ts:11` re-exports it as `import('./runtime/laya/loader.js')`.

**Proof that nothing in production constructs the engine.** Two independent checks:

1. **Call-site search across the whole tree** (`src`, `apps/desktop/src`, `scripts`; production *and*
   tests) for `loadLayaAdvisory`, `new LayaEngine`, `LayaEngine(`:
   **ZERO occurrences.** The only textual references to `loadLayaAdvisory` are its own definition
   (`loader.ts:76`) and the re-export line (`index.ts:19`) — and `index.ts` itself has no importer.
2. **The wire frame is hardcoded false.** `src/ipc/ui-server.ts:551` is a literal `layaReady: false`, in a
   block (`:543-550`) that records it *used* to be a hardcoded `true`. The test
   `src/ipc/ui-server.test.ts:144` asserts `expect(hello.layaReady).toBe(false)`.

**The models do exist on this machine**, though gitignored (`.gitignore:40` → `models/*.onnx`):

| File | Bytes |
|---|---|
| `models/laya-m7-int8.onnx` | 308,050,615 (293.8 MiB — the code's "294 MB") |
| `models/laya-m7.onnx` | 1,228,429,195 (1.14 GiB) |
| `models/silero-vad.onnx` | 2,243,022 |

So the reason the seam is not installed is not a missing file — it is that loading 294 MB on every daemon
start would change no behaviour. That is a decision, and `ui-server.ts:546` states it as one.

**The genuine dynamic-import case my scan had to get right** is `src/daemon.ts:1055`:

```ts
vadLoad = import('./runtime/vad.js')
  .then((m) => m.SileroVad.load(cfg.vad.modelPath, { threshold: cfg.vad.threshold }))
```

`daemon.ts:46` records why it is not static: `runtime/vad.js` pulls `onnxruntime-node`, which the Windows
sidecar does not bundle. **A static-only scan would have reported `src/runtime/vad.ts` as DEAD. It is
LIVE**, and `src/runtime/vad-gate.ts:4` holds a second dynamic edge to it. I followed dynamic imports, so
that false positive does not appear in my table.

---

## 5. Constants tables

### 5.1 Ports, paths, transport

| Constant | Value | `path:line` |
|---|---|---|
| `SERVE_PORT` | 4096 | `src/ipc/protocol.ts:10` |
| `UI_WS_PORT` | `4096 + 1` (= 4097) | `src/ipc/protocol.ts:6` |
| `UI_WS_PATH` | `'/v1/ui'` | `src/ipc/protocol.ts:8` |
| `UI_SUBPROTOCOL` | `'voice-ui.v1'` | `src/ipc/protocol.ts:8` (also `apps/desktop/src/bridge/ws.ts:6`) |
| `IPC_TOKEN_ENV` | `'VOICE_RUNTIME_IPC_TOKEN'` | `src/ipc/protocol.ts:9` |
| `UI_WS_URL` (renderer) | `'ws://127.0.0.1:4097/v1/ui'` | `apps/desktop/src/bridge/ws.ts:5` |
| `CONTROL_PORT` (E2E stub) | 4197 | `apps/desktop/e2e/stub-daemon.mjs:57` |
| `SERVE_PORT` (live script) | 4096 | `scripts/live_console_test.ts:20` |
| `BRIDGE_PORT` (live script) | 4097 | `scripts/live_console_test.ts:21` |
| `CONTRACT_VERSION` | `'3.1.0'` | `scripts/live_console_test.ts:22` |
| `UI_CONTRACT_VERSION` | `'3.1.0'` | `src/diag/bundle.ts:77` |
| `OPENCODE_PORT` | 4096 | `main.rs:44` |
| `DAEMON_PORT` | 4097 | `main.rs:45` |
| `VAULT_PATH` | `'vault/keyring.dat'` | `src/cli.ts:27` |
| `RUNTIME_DIR_NAME` | `'.opencode-voice-runtime'` | `src/cli/serve.ts:37` |
| `DAEMON_OWNER_FILE` | `'daemon.owner'` | `src/daemon.ts:161` |
| `DAEMON_OWNER_VERSION` | 1 | `src/daemon.ts:159`, `main.rs:1002` |
| `DAEMON_OWNER_KEY_ENV` | `'VOXAURA_OWNER_KEY'` | `src/daemon.ts:163`, `main.rs:1028` |
| `OWNER_SETTLE` | 1500 ms | `main.rs:1004` |
| `TELEMETRY_FILE` | `'voice-runtime.jsonl'` | `src/diag/bundle.ts:60` |
| `LAYA_MODEL_PATH_DEFAULT` | `'models/laya-m7-int8.onnx'` | `src/runtime/laya/loader.ts:59` |
| `SNAPSHOT_VERSION` | 1 | `src/tasks/store.ts:30` |
| `BUNDLE_SCHEMA_VERSION` | 1 | `src/diag/bundle.ts:49` |

### 5.2 Byte caps, frame limits, queue bounds

| Constant | Value | `path:line` |
|---|---|---|
| `MAX_MESSAGE_BYTES` | 1 MiB (per-MESSAGE cumulative) | `src/ipc/protocol.ts:22` |
| `MAX_PREHEADER_BYTES` | 2 MiB | `src/ipc/protocol.ts:24` |
| `MAX_AUDIO_BYTES` | 64 KiB (on the reassembled payload) | `src/ipc/protocol.ts:30` |
| `MAX_AUDIO_CHUNK` | 32 KiB | `src/ipc/audio.ts:7` |
| `AUDIO_FRAME_BYTES` | 3200 | `src/ipc/protocol.ts:28` |
| `MAX_CONNECTIONS` | 8 | `src/ipc/protocol.ts:19` |
| `RESUME_BUFFER_CAP` | 256 (frames) | `src/ipc/protocol.ts:20` |
| `RESUME_BUFFER_MAX_BYTES` | 64 KiB | `src/ipc/ui-server.ts:57` |
| `MAX_OUTPUT_TEXT_BYTES` | 32 KiB | `src/ipc/protocol.ts:751` |
| `OUTPUT_MAX_COMMAND_CHARS` / `_ID_CHARS` | 512 / 128 | `src/ipc/protocol.ts:753,755`; `ws.ts:176,177` |
| `INVENTORY_MAX_SESSIONS` | 200 | `src/ipc/protocol.ts:569` |
| `WINDOW_BYTES` | 160 000 | `src/voice/ingest.ts:6` |
| `MAX_BUFFERED_BYTES` | 960 000 | `src/voice/ingest.ts:8` |
| `PAUSE_BYTES` / `RESUME_BYTES` | 262 144 / 32 768 | `src/voice/ingest.ts:47,48` |
| `PLAYBACK_QUEUE_CAP` | 32 | `apps/desktop/src/audio/playback.ts:54` |
| `MAX_TASK_CARDS` | 24 | `apps/desktop/src/matrix/task-state.ts:198` |
| `MAX_TERMINAL_LINES` / `MAX_LINE_CHARS` | 500 / 8192 | `apps/desktop/src/components/terminal/TerminalDrawer.tsx:154,157` |
| `MAX_CONCURRENCY` / `MAX_PENDING` / `MAX_HISTORY` | 2 / 8 / 64 | `src/tasks/engine.ts:46,59,66` |
| `TASK_RECORDS_CAP` / `TASK_MAX_DEPTH` | 64 / 8 | `src/orchestrator/task-queue.ts:133,126` |
| `DELIVERY_CAP` | 4 | `src/orchestrator/delivery.ts:117` |
| `MAX_PARKED` | 8 | `src/orchestrator/command-router.ts:404` |
| `ROTATION_LIMIT` | 10 | `src/voice/keyring.ts:9` |
| `MENTION_MAX_FILES` / `_MAX_TOKENS` | 20 / 60 | `src/orchestrator/mentions.ts:23,25` |
| `SLASH_MAX_ARGS` | 200 | `src/orchestrator/slash.ts:37` |
| `MAX_PROMPT_CHARS` | 2000 | `src/orchestrator/prompt-optimizer.ts:24` |
| `MAX_CHARS` (narration) | 240 | `src/orchestrator/narrator.ts:108` |
| `MAX_SENTENCE_CHARS` | 400 | `src/voice/tts.ts:34` |
| `SPEECH_CACHE_MAX_ENTRY_BYTES` | 2 MiB | `src/voice/tts.ts:487` |
| `LAYA_OPERATING_LENGTH` | 32 | `src/runtime/laya/constants.ts:15` |
| `MAX_DEPTH` / `MAX_NODES` (redaction) | 8 / 1000 | `src/common/logger.ts:103,104` |
| `MAX_LOG_LINES` / `MAX_LINE_CHARS` / `MAX_TELEMETRY_ROWS` | 200 / 2000 / 50 | `src/diag/bundle.ts:71,72,73` |
| `BENTO_BASE_WIDTH_PX` / `_HEIGHT_PX` | 440 / 600 | `apps/desktop/src/components/bento/layoutBudget.ts:43,46` |
| `WIDTH` / `HEIGHT` (wave canvas) | 320 / 90 | `apps/desktop/src/components/waveform/SiriWaveCanvas.tsx:56,57` |
| `RAW_BOUND` | 4000 | `src/cli/turn.ts:116` |
| `ASKABLE_WORDS` | 20 | `src/cli/intents.ts:184` |

### 5.3 Timeouts, TTLs, budgets

| Constant | Value (ms) | `path:line` |
|---|---|---|
| `PING_INTERVAL_MS` / `MISSED_PINGS_LIMIT` | 5000 / 3 | `src/ipc/protocol.ts:11,12` |
| `ACK_TIMEOUT_MS` | 5000 | `apps/desktop/src/bridge/ws.ts:10` |
| `RECONNECT_BASE_MS` / `_JITTER_MS` / `_CAP_MS` | 50 / 30 / 2500 | `apps/desktop/src/bridge/ws.ts:7,8,9` |
| `PERMISSION_TTL_MS` | 30 000 | `src/orchestrator/permission.ts:105` |
| `GATE_TTL_MS` | = `PERMISSION_TTL_MS` | `src/cli/turn.ts:441` |
| `CONFIRMATION_TTL_MS` | 60 000 | `src/orchestrator/command-router.ts:397` |
| `DELIVERY_TTL_MS` | 30 000 | `src/orchestrator/delivery.ts:123` |
| `PLAN_DEADLINE_MS` | 30 000 | `src/orchestrator/task-queue.ts:123` |
| intake budget / re-ask | 10 000 / 3 000 | `coordinator.ts:537` / `:611` |
| plan budget ×2 | 25 000 | `coordinator.ts:679` / `:697` |
| `OPTIMIZER_TIMEOUT_MS` | 8000 | `src/daemon.ts:410` |
| `NARRATOR_TIMEOUT_MS` | 12 000 | `src/daemon.ts:735` |
| `SHELL_TASK_TIMEOUT_MS` | = `DEFAULT_TASK_TIMEOUT_MS` (900 000) | `src/daemon/shell-tasks.ts:64` |
| `DEFAULT_TASK_TIMEOUT_MS` / `MIN` / `MAX` | 900 000 / 1 000 / 14 400 000 | `src/tasks/engine.ts:79,72,69` |
| `BRAIN_GOLDEN_MS` / `BRAIN_CEILING_MS` | 2000 / 5000 | `src/voice/brain.ts:8,9` |
| `STT_TIMEOUT_MS` | 15 000 | `src/voice/stt.ts:135` |
| `FISH_TIMEOUT_MS` | 20 000 | `src/voice/tts.ts:479` |
| `TTS_FIRST_CHUNK_BUDGET_MS` | 800 | `src/voice/tts.ts:32` |
| `PLAYBACK_RETENTION_MS` | 900 000 | `src/voice/tts.ts:490` |
| `VAD_GATE_TIMEOUT_MS` | 2000 | `src/runtime/vad-gate.ts:45` |
| `SERVE_HEALTH_INTERVAL_MS` | 5000 | `src/runtime/serve-health.ts:41` |
| `SERVE_HEALTH_PROBE_TIMEOUT_MS` | 2000 | `src/runtime/serve-health.ts:48` |
| `SERVE_HEALTH_WATCHDOG_GRACE_MS` | 500 | `src/runtime/serve-health.ts:63` |
| `SERVE_HEALTH_BACKOFF_MS` / `_MAX_MS` | 1000 / 30 000 | `src/runtime/serve-health.ts:118,121` |
| `SERVE_HEALTH_FAILURE_THRESHOLD` / `_RECOVERY_THRESHOLD` | 2 / 2 | `src/runtime/serve-health.ts:92,115` |
| `SERVE_HEALTH_MAX_RECONNECT_ATTEMPTS` | 6 | `src/runtime/serve-health.ts:137` |
| `TOPUP_ADVISORY_DAYS` / `DAY_MS` | 7 / 86 400 000 | `src/voice/tts-credit.ts:23,39` |
| `IN_FLIGHT_RETRIES` / `RETRY_DELAY_MS` | 3 / 400 | `apps/desktop/src/settings/services.ts:23,24` |
| `MAX_SPOKEN_ASK_WORDS` | 20 (words) | `src/orchestrator/permission.ts:131` |
| calibration phases | 3000 + 5000 + 2000 | `CalibrationWizard.tsx:49-52` |
| `SECRET_BYTES` | 32 | `main.rs:576` |
| `KEY_ENTROPY_FLOOR_BYTES` | 16 | `src/diag/bundle.ts:69` |
| `BASELINE` (oxlint) | 8 | `scripts/lint-baseline.mjs:13` |

### 5.4 Token budgets and model slugs

| Constant | Value | `path:line` |
|---|---|---|
| `INTAKE_MODEL` | `dots-studio/dots-3-note-preview:free` | `src/orchestrator/coordinator.ts:31` |
| `COORDINATOR_MODEL` | `thinkingmachines/inkling:free` | `src/orchestrator/coordinator.ts:32` |
| `NARRATOR_MODEL` | `thinkingmachines/inkling:free` | `src/orchestrator/narrator.ts:52` |
| `BRAIN_OPENROUTER_MODEL` | `thinkingmachines/inkling:free` | `src/voice/brain.ts:177` |
| `TTS_MODEL` | `s2.1-pro-free` | `src/voice/tts.ts:31` |
| `OPENROUTER_USER_AGENT` | `opencode/1.0 (Voxaura)` | `src/voice/brain.ts:23` |
| `OPENROUTER_CHAT_URL` | `https://openrouter.ai/api/v1/chat/completions` | `src/voice/brain.ts:179` |
| `VAD_MODEL_URL` | huggingface silero-vad | `src/runtime/vad.ts:11` |
| intake maxTokens / temp | 200 / 0.2 | `coordinator.ts:537` |
| plan maxTokens / temp | 300 / 0.2 | `coordinator.ts:681` |
| `DEFAULT_SHELL_AGENT` | `'build'` | `src/runtime/client.ts:288` |
| `LAYA_HEADS` | 4 heads | `src/runtime/laya/constants.ts:17` |

**All four model slugs are `:free`.** The agentic `User-Agent` at `brain.ts:23` is load-bearing per the
module header at `coordinator.ts:24-28`, which records that Inkling answers HTTP 403 without one.

---

## 6. Test-suite composition (148 test files, counted from `describe`/`test`/`it` call sites)

| Area | Files |
|---|---|
| `apps/desktop/e2e/*.spec.ts` (Playwright, 18 specs) | 18 |
| `apps/desktop/src/**/*.test.*` (Vitest + happy-dom) | 44 |
| `src/**/*.test.ts` (Vitest + node), excluding `src/cli/` | 81 |
| `src/cli/*.test.ts` (untracked, concurrent agent) | 3 |
| **Total** | **148** |

Aggregate call-site counts across all test files: **388 `describe` blocks, 1835 `test`/`it` blocks.**

Largest three by test count: `src/diag/bundle.test.ts` (73 tests / 13 describe, 51,164 B),
`apps/desktop/src/components/terminal/TerminalDrawer.test.tsx` (59 / 9, 38,625 B),
`src/voice/tts.test.ts` (47 / 9, 24,440 B).

Root runner scope is `vitest.config.ts`: `include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'bench/**/*.bench.ts']`.
The desktop runner is `apps/desktop/vitest.config.ts`. `vitest.config.ts` also carries a 27-line comment
explaining why coverage thresholds are **absent by decision** rather than by omission.

---

## 7. Tauri command surface — measured, and it is smaller than expected

`main.rs:3259` registers `tauri::generate_handler![ipc_token, ensure_all_services, restrict_vault_file]` —
**three** commands. Definitions at `main.rs:1184`, `:1594`, `:906`.

| Command | Registered | Invoked from the renderer | Renderer call site |
|---|---|---|---|
| `ipc_token` | yes | **yes** | `apps/desktop/src/settings/ipc-token.ts:22` |
| `ensure_all_services` | yes | **yes** | `apps/desktop/src/settings/services.ts:44` |
| `restrict_vault_file` | yes | **yes** | `apps/desktop/src/settings/vault-dacl.ts:55` |
| `shutdown_all_services` | **ABSENT** | no | — |

**`shutdown_all_services` has ZERO occurrences in the entire tree** — verified by a whole-tree search of
`main.rs`, every `apps/desktop/src` and `src` TypeScript file, and `scripts/`. It is not a
registered-but-uninvoked command; **it does not exist.** Any claim that it is "registered but dead" is false
against this tree.

**But `restrict_vault_file` IS the live defect.** The TS wrapper exists and works; what is missing is a
**caller**. `restrictVaultFile` has exactly one importer — `apps/desktop/src/settings/vault-dacl.test.ts:2).
No production component imports it, and the key-save path is the WS command `saveApiKeys`
(`apps/desktop/src/bridge/ws.ts:252`), which does not re-lock the vault afterwards. So the DACL applied at
vault resolve is undone by the first save's temp+rename, and nothing restores it. Verified, not inferred.

**Security primitives in `main.rs`, verified in code:**
- `getrandom::fill` at `main.rs:596` inside `secure_random_bytes`/`generate_secret`; `main.rs:2609`
  asserts `generate_secret` calls the CSPRNG. `main.rs:580-591` records that the generator this replaced
  was an xorshift64* seeded by `nanos ^ pid`, and `main.rs:2488` is a guard that fails if it returns.
- `restrict_to_owner` at `main.rs:662` (Windows, `SetNamedSecurityInfoW` with
  `PROTECTED_DACL_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION`,
  `:699,:803`) and `main.rs:819` (`#[cfg(not(windows))]`, Unix equivalent using `0o600`).
- `main.rs:23` and `:635` state that `fs::set_permissions(0o600)` is a **silent no-op for ACLs on
  Windows** (it is `SetFileAttributes`); `main.rs:2748` asserts the vault path must not use it.
- Three **cfg-gated duplicate definitions** exist and are not defects: `opencode_pids` (`:257` /
  `:273`), `restrict_to_owner` (`:662` / `:819`), `log_line` (`:547` / `:569`).

---

## 8. Where the code contradicts the briefing

| # | Briefing claim | Measured truth |
|---|---|---|
| 1 | 279 project source files; `src` 157, `apps` 110, `scripts` 10, `ml` 1 | **306** code files; `src` 168, `apps` 109, `scripts` 10, `ml` **19**. `ml` is wrong by 18 |
| 2 | "12,338 `.py` files exist and ALL are inside `.venv`" | 12,339 exist; **22 are outside** `.venv`. 18 are project code (all `ml/`); 4 are `.hf_cache`/`node_modules` |
| 3 | The gate invariant is in the contextual permission gate (`permission.ts`) | `permission.ts` contains **0** `kind: 'proceed'` and **0** `deps.dispatch(`. Both live in `coordinator.ts` (`:438`, `:737`) |
| 4 | `kind: 'proceed'` must occur **exactly once** | Naive textual count is **2** (`:372` type member + `:438` value). It is 1 only when anchored to `return {`. The repo already uses the anchored form at `command-tiers.test.ts:631` and encodes both in `src/cli/turn.ts:331,345` |
| 5 | `deps.dispatch(` must occur **exactly once** | **Confirmed: 1** in `coordinator.ts` (`:737`). A second `this.deps.dispatch(` exists at `audio-pipeline.ts:186` on a *different* `deps` object |
| 6 | `src/runtime/laya/` is a quarantined subsystem | **Confirmed and stronger:** 7 modules, 0 production-reachable. `index.ts` is the tree's **only DEAD module** (zero importers, tests included). `loadLayaAdvisory` has **zero call sites tree-wide** |
| 7 | The scan must not repeat the static-only false positive on a late-loaded module | **Confirmed avoided.** `src/runtime/vad.ts` is **LIVE** via `daemon.ts:1055 import('./runtime/vad.js')`. A second dynamic edge exists at `vad-gate.ts:4` |
| 8 | `src/cli/` and `src/tasks/` are recent | `src/tasks/` is tracked and stable. `src/cli/` is **untracked and actively mutating**: 5 → 8 → 11 files during this audit, and `src/cli.ts` went from clean to `+14 lines` modified |

---

## 9. Defects and drift found in passing (code-verified)

1. **`scripts/live_console_test.ts` cannot resolve its import.** `:10` imports
   `../dist/orchestrator/index.js`; `src/orchestrator/index.ts` does not exist. Masked today by a stale
   `dist/` holding 7 orphaned modules (`index`, `dispatch`, `events`, `laya-advisor`, `ledger`,
   `orchestrator`, `queue`). A clean rebuild exposes it.
2. **A code comment states the opposite of what its code does.** `coordinator.ts:509-511` claims the intake
   flags are "load-bearing: primary 500 + fallback 200-garbage must report `intake-failed`". `:550` resets
   `intakeTransportFailed = false` on an unparseable body, producing exactly the `intake-invalid` outcome
   the comment says is prevented.
3. **`restrict_vault_file` is invocable but never invoked in production** (§7). `restrictVaultFile`'s only
   importer is its own test.
4. **Anchor drift**: `src/voice/ingest.ts:68` cites `apps/desktop/src/audio/vad.ts:20`; the constant is at
   `:22`.
5. **`shutdown_all_services` is described as a registered-but-dead command. It does not exist** (§7).
6. **`src/knowledge/build.ts` is unreadable by a naive UTF-8/binary heuristic** (valid UTF-8, no BOM,
   round-trips cleanly — the RTL Arabic defeats the sniff). It is a tooling hazard, not a code defect.
7. **Three `ml/` inputs sit outside the TS graph entirely**, so no gate typechecks or lints them.

---

## 10. Reproduction

Every number above is reproducible from `%LOCALAPPDATA%\Temp\opencode\`. **No script was written into the
repository**, and no source file was modified.

| Script | Produces |
|---|---|
| `recensus.mjs` | `census-rows.json` — the 400-file census |
| `reach3.mjs` | `graph2.json` — 287 modules, 565 resolved edges, 1 unresolved, 3 non-module targets |
| `classify.mjs` | `reach.json` — LIVE / LIVE+TEST / TEST-ONLY / DEAD / TEST-FILE + reverse edges |
| `mkmanifest.mjs` | `manifest.json` — per-file bytes, exports, import counts, classification |
| `consts.mjs` / `consts2.mjs` | 382 named constants, 275 non-test |
| `routes.mjs` | the 20 serve-client route call sites + verification markers |
| `invariant.mjs` | the four invariant counts (§4.2) |
| `testpurp.mjs` / `pypurp.mjs` | test purposes from `describe`/`test` names; Python purposes from docstrings/`def`s |
| `kcount.mjs` | the **executed** knowledge corpus report (§4.5) |

Commands for the headline claims:

```powershell
# census
Get-ChildItem -Path src,apps,scripts,ml -Recurse -File | Where-Object { $_.FullName -notmatch 'node_modules|\\.venv\\|\\dist\\|\\target\\' }
# python reality
(Get-ChildItem -Recurse -Filter *.py -File | Measure-Object).Count          # 12339
(Get-ChildItem -Recurse -Filter *.py -File -Path .venv | Measure-Object).Count  # 12317
git ls-files '*.py' | Measure-Object                                          # 18
# the unresolved import
Test-Path src/orchestrator/index.ts        # False
# no production Laya consumer
Select-String -Path src\**\*.ts -Pattern 'loadLayaAdvisory|new LayaEngine' # no matches
# three Tauri commands, not four
Select-String -Path apps/desktop/src-tauri/src/main.rs -Pattern '#\[tauri::command\]'
Select-String -Path src\**\*.ts -Pattern 'shutdown_all_services'            # no matches
# the hardcoded false
Select-String -Path src/ipc/ui-server.ts -Pattern 'layaReady: false'         # ui-server.ts:551
```
