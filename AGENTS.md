# AGENTS.md — Voxaura (opencode-voice-runtime)

Windows-first Tauri v2 desktop companion + Node daemon that drives OpenCode v2 (`opencode serve`) via voice.
**Trust code, not prose.** `dossier/PROJECT_MASTER_DOSSIER.md` is a code-first audit; `docs/01–28` are a frozen, partly-wrong spec set.

## Layout (who owns what)

| Path | Owner / entrypoint |
|---|---|
| `src/` | Node daemon. ESM, `NodeNext`, compiles to `dist/`. Real entry: `src/cli.ts` (`doctor｜vault bootstrap｜live｜serve`). Composition root: `src/daemon.ts`. |
| `src/ipc/` | Zero-dependency RFC 6455 server + frozen WS-4097 frame schemas (`voice-ui.v1`, path `/v1/ui`). |
| `src/orchestrator/` | Command router (FR-12), the intake→plan→narrate coordinator chain, audio pipeline, inventory. **Two models serve three roles**: Dots3 takes intake, Inkling plans *and* narrates. |
| `src/voice/` | Vault/keyring/STT/TTS/brain. |
| `src/knowledge/` | Tier-1 shared ground truth + Tier-2/3 styling. Arabic `normalizeArabic`/`normalizeToken`, dependency-free BM25, Tier-D guard. `SharedChunk` has **no persona member** by type. Entry: `node dist/cli.js knowledge ["<query>"]`. |
| `apps/desktop/src/` | React 18 + Vite + Tailwind renderer (Arabic, RTL). `src/App.tsx` is the HUD. |
| `apps/desktop/src-tauri/src/main.rs` | Rust process supervisor: Job Object, token/serve-pass provisioning, spawns serve + daemon. |
| `apps/desktop/e2e/` | Playwright specs driven against `e2e/stub-daemon.mjs` (**a fake control plane**, not the real daemon). |
| `scripts/provision-sidecar.mjs` | Builds the bundled `node.exe` + `dist/` + pruned deps payload for the installer. |
| `dossier/`, `docs/10-CHECKPOINT.md` | Audit + gate ledger. `assets/` = hand-drawn SVG diagrams. |

## Commands

```bash
npm install && npm run build          # tsc -> dist/ (daemon)
npm run test:vantrilex                # typecheck -> typecheck:tests -> eslint -> oxlint -> vitest(root) -> vitest(desktop) -> e2e
node dist/cli.js live                 # REAL provider round-trip (needs vault keys; burns quota)
node dist/cli.js doctor               # env presence (never values) + serve health

cd apps/desktop
npm run dev                           # tauri dev (window)
npm run dev:web                       # vite only, :1420, for E2E
npm run test:e2e                      # rebuilds root dist, then Playwright
npm run build:tauri                   # production NSIS + AppImage
```

Single tests / focused runs:
```bash
npx vitest run src/ipc/ui-server.test.ts          # one file
npx vitest run -t 'FR-12'                         # one name
cd apps/desktop && npx vitest run src/audio/vad.test.ts
cd apps/desktop && npx playwright test e2e/bargein.spec.ts
```

**Windows only:** `cargo` needs the MSVC env, and `packaging-preflight.mjs` will report the linker "missing" unless you load it:
```powershell
cmd /c '"C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" -no_logo >nul 2>&1 && cargo check --no-default-features'
cmd /c '"...VsDevCmd.bat" -no_logo >nul 2>&1 && npm run build:tauri'
```
NSIS (`makensis`) must be installed. Silent install: `Voxaura_<v>_x64-setup.exe /S`.

## Gates & their blind spots

- `test:vantrilex` is **typecheck → typecheck:tests → eslint → oxlint → root vitest → desktop vitest → `npm run test:e2e`**. E2E **is** part of it (`package.json`). An earlier version of this file claimed otherwise and was wrong. It needs ports 4096/4097/4197 free, so it fails with `EADDRINUSE` if an installed build is running.
- Current counts (keep these moving up, never down): root **682 passed + 0 skipped** (56 files) · desktop **142** (24 files) · `cargo test` **48** · E2E **18** across 14 specs. `npm run test:vantrilex` exits 0 on all of these. Measured 2026-09-29. The count moved 491 → 498 *while 70 tests were deleted*, 525 → 568 when `src/knowledge/` landed, 572 → 573 when 62 latent test type errors were cleared, 655 → 657 in the M0 cleanup, 657 → 670 when persona wiring landed, then 670 → 682 when `docs:verify` gained the narrative claims and a guard on its own claim set. Desktop fell 153 → 141 when 3 dead components were deleted *with their tests* — a legitimate fall, and the only kind worth accepting. A falling count is not automatically a regression — check `git log` before "fixing" it.
- **`npm run docs:verify` re-derives every number in this section and exits 1 on any mismatch.** It contains no expected values: documented figures are parsed out of the markdown, derived figures come from the tree, live test runs and `package.json`. It is how the five falsities in this file were found, and it catches a stale count the moment you change the code rather than weeks later. **Fix the document, not the script.** It also covers the **narrative** claims, which is where the falsities actually were: persona reference counts per system-prompt file, the absence of `earcon*` files and the old pitch constants, the `knowledge/` production-importer and barrel split, and whether every `file.ts:NNN` anchor cited here still resolves. Two rules keep that honest: **UNVERIFIED is now an error, not a warning** — deleting a figure used to turn its check into a no-op that still exited 0, which is coverage that reads as present while being absent — and `src/policy/docs-verify-coverage.test.ts` pins the claim set itself, since a script can be edited and nothing else would notice.
- **`npm run test:blindspots` answers "where is the testing blind?" without a coverage provider.** Measured 2026-09-29: **55 of 58** shipping modules are reached by at least one test (**94.8%** module-level reachability) — this is **not** line coverage and cannot be, because `@vitest/coverage-v8` is not installed and no gate passes `--coverage`. It walks imports transitively from each test file, exactly as `docs:verify` walks from the entrypoints. The 3 modules no test reaches are `cli.ts` (247 lines), `common/index.ts` (8) and `knowledge/index.ts` (37) — and one further module (`src/runtime/laya/index.ts`) ships to nothing and is tested by nothing, which is the already-accounted Laya set. **A percentage is the wrong instrument for this question and a module list is the right one:** adding an isolated untested module *raised* the figure to 94.9%, because the numerator and denominator both grew. **`cli.ts` is reported separately and is the one that matters** — nothing imports it, it is executed as a process, and its argv dispatch decides what the program does, so no walk-based method can flag it. E2E does not cover it either: E2E drives `stub-daemon.mjs`, not the real `cli.js`. It exits 0 deliberately — it is a measurement, not a gate. Wire it into one only with a recorded decision about what the number means.
- **Coverage thresholds remain deliberately unset.** `vitest.config.ts` used to declare `thresholds: { lines: 80 }` while nothing set `coverage.enabled`, so it read like a floor and guaranteed nothing. Do not reinstate a number before one has been measured; the comment in that file records the exact steps.
- `cargo check --no-default-features` and `cargo build --release` are separate. **`main.rs` token generation is covered by no gate stage, which is exactly how a real CSPRNG defect survived**: `ipc.token` and `serve.pass` were built from an xorshift64\* seeded `nanos ^ pid`. Now `getrandom` (`main.rs:471`), and permissions are a real Windows **owner-only protected DACL** via `SetEntriesInAclW`/`SetNamedSecurityInfoW` — `fs::set_permissions(0o600)` is a **silent no-op** on Windows (it is `SetFileAttributes`, toggles only `READONLY`, returns `Ok`, changes no ACL). The load-bearing flag is `PROTECTED_DACL_SECURITY_INFORMATION`, which blocks parent inheritance.
- Almost all network clients are **injected mocks**. E2E drives `stub-daemon.mjs` (real `UiServer` + router, fake control port `:4197`, no providers/vault). Only `node dist/cli.js live` and `scripts/live_console_test.ts` touch real APIs — neither is in the gate, so **green CI does not mean the live loop works**. v0.6.0 is the proof: every gate green, daemon could not boot.
- Desktop unit tests run in `happy-dom`; root in node.
- **Test files were typechecked by nothing until v0.7.2.** Root `tsconfig.json` sets `exclude: ["**/*.test.ts"]` and Vitest transpiles without checking types, so all 53 root test files compiled under *no* type checker. That hid **62 real type errors across 9 files** (20 × `TS2554` in `narrator.test.ts` — tests calling `narrate()` one argument short — 19 × `TS18047` in `opencode-bridge.test.ts`, plus `brain`, `tts`, `command-router`, `client`, `stt`, `audio-pipeline-reset`, `fr12-route`). `npm run typecheck:tests` (`tsconfig.tests.json`) now runs in the gate and is at **0**. Two things to carry forward: the errors were **layered**, because a wrong-arity call fails `TS2554` and stops checking later arguments, so fixing arity revealed `errorDetail: undefined` violating `exactOptionalPropertyTypes`; and `exactOptionalPropertyTypes` errors in *tests* are the same class as in production — do not "fix" them by excluding test files again.
- **Coverage config is dead.** `vitest.config.ts` declares
  `thresholds: { lines: 80 }` but nothing sets `coverage.enabled`, no manifest
  passes `--coverage`, and there is no CI. The threshold has never executed and
  reads like a floor.
- `test:e2e` rebuilds root `dist/` first, and needs 4096/4097/4197 free — stop the installed app or it fails with `EADDRINUSE`.

## Runtime topology (non-obvious)

Four fixed ports: **4096** OpenCode serve, **4097** WS-4097 UI bridge, **1420** Vite dev, **4197** E2E stub control.
Cold launch: `main.rs` writes `~/.opencode-voice-runtime/ipc.token` in `setup()` **before the webview loads**, spawns serve (if 4096 cold), then `node sidecar/dist/cli.js serve`; both children go into a `KILL_ON_JOB_CLOSE` Job Object.
The WS bearer travels as an **extra subprotocol token** (`[voice-ui.v1, <token>]`) because browsers cannot set upgrade headers. Shell reads the token via the `ipc_token` Tauri command — it is never baked into the bundle.
Runtime state lives in `~/.opencode-voice-runtime/`: `ipc.token`, `serve.pass`, `machine.key`, `supervisor.log`, `daemon.log` + `daemon-stdout.log`, `opencode.log` + `opencode-stdout.log`, and `voice-runtime.jsonl` (telemetry, written by the daemon). Child logs are **append-only** — a restart must not erase the previous failure.

## Models — all free tier, and three things that break silently

Routing table (every slug is `:free`; the 100%-free constraint is a product decision, not an accident):

| Role | Constant | Slug |
|---|---|---|
| Conversational intake | `INTAKE_MODEL` (`src/orchestrator/coordinator.ts`) | `dots-studio/dots-3-note-preview:free` |
| Coordinator / planner | `COORDINATOR_MODEL` (same file) | `thinkingmachines/inkling:free` |
| Narrator (spoken confirmations) | `NARRATOR_MODEL` (`src/orchestrator/narrator.ts`) | `thinkingmachines/inkling:free` |
| Brain / `cli live` | `BRAIN_OPENROUTER_MODEL` (`src/voice/brain.ts`) | `thinkingmachines/inkling:free` |

**Three non-obvious requirements — every one was found by a live call, not by reading docs:**

1. **`User-Agent: opencode/1.0 (Voxaura)` is mandatory** (`OPENROUTER_USER_AGENT`, `src/voice/brain.ts`). Inkling answers **HTTP 403 "only available on agentic harnesses"** without an agentic UA. The allowlist is an `opencode/<version>` prefix (any version, suffixes OK); `claude-cli/`, `codex-cli/`, `cursor/` also pass. Bare `voxaura/`, `aider/`, `continue/` and browser UAs all 403. Node's default fetch sends no such UA, so **without this header every plan/narration call fails 403.**
2. **`reasoning: {effort:'none'}` is required for inkling.** Without it the model spends the token budget reasoning and returns `finish=length` with `content: null` — measured 0/5 narration before the fix, 5/5 after.
3. **The `json_schema` is load-bearing, not decorative.** Inkling prompt-only answers with raw tool-call syntax (`<|message_model|>shell<|content_invoke_tool_json|>…`) — 0/5. With strict schema: 5/5. Never relax a `response_format` to "help" a model; that reintroduces audio garbage.

Measured free-tier latency (same day, same key): intake p50 **901 ms** · inkling plan p50 **1,950 ms** / max 3,987 · narration p50 **2,615 ms** / max 5,463 · STT 726 ms · TTS 3,196+1,267 ms. Free tiers are slow and lossy — re-measure, don't assume.

## Dead code — reachability is measured, and `src/` is NOT currently at 0%

Resolve every relative import transitively from `src/daemon.ts` and `src/cli.ts`:

```
LIVE production modules : 51
DEAD production modules : 7   (all of src/runtime/laya/*)
live source lines       : 8705
```

**The 7 are `src/runtime/laya/*`, and they are dead by decision, not by accident.** The Laya dynamic-import seam is deliberately *not* installed in `daemon.ts`, because `models/laya-m7-int8.onnx` is **294 MB** and `layaLoad` has zero consumers — wiring it would load a 294 MB model on every daemon start to change nothing. `ui-server.ts` therefore reports `layaReady: false`, because a frame that asserts a feature is live when it is not is the exact defect class this project keeps hunting. An earlier revision of this file claimed **0 dead**; that went false when Laya was restored, and it is why the number is re-derived here rather than carried.

**No ONNX ships at all, including VAD.** `tauri.conf.json` bundles only the sidecar and `models/*.onnx` is gitignored, so installed builds have always used the RMS energy fallback at `daemon.ts:509` — Silero has never actually run in a shipped build.

**The reachability scan MUST follow dynamic imports too.** A static-only scan
(`from './x.js'`) reports `src/runtime/vad.ts` as dead code. It is not: `daemon.ts:338`
loads it with `import('./runtime/vad.js')` on purpose, because it pulls
`onnxruntime-node` and a static import would make that missing native package
fatal in the sidecar. `src/policy/sidecar-safety.test.ts` enforces exactly that
form. Resolve every quoted relative specifier, not just `from` clauses, or the
metric will cry wolf on the one module that is deliberately loaded late.

Three modules that were in that dead set while `CHANGELOG.md` and
`docs/10-CHECKPOINT.md` claimed they shipped are now wired in `daemon.ts` `think()`:
`slash.ts`, `mentions.ts`, `prompt-optimizer.ts`. The other 28 were **moved, not
deleted**, to `.opencode/_archive/dead-code-phase1/` — 44 files including their tests and
fixtures. Quarantine rather than deletion was a deliberate call: the Laya ONNX heads and the
RAG/guidance layer are real work a later phase may want to wire properly. `vitest.config.ts`
includes only `src/**/*.test.ts`, so the archive is outside both the runner and `tsc`.

**Re-derive reachability before trusting any document that claims a feature is wired** —
including this one. The generalisable lesson is the one that was missed twice: a green suite
plus a confident changelog is not evidence that a feature ships. `mentions.ts`, `slash.ts`
and `prompt-optimizer.ts` had passing tests and zero importers at the same time.

Also historical, still useful: `docs/19-MOBILE-PAIRING.md` (no relay/QR/approval code exists —
the only trace is a `'mobile'` union member in `runtime/client.ts`) and
`docs/26-AGENT-LAUNCHER.md` (its `src/launcher/` ownership claim is false) both carry
supersession banners. `opencode.json` is **this repo's own dev-session config**, not product
config. iOS/Android icon sets under `src-tauri/icons/` are inert scaffold. `pnpm-lock.yaml` is
vestigial; npm is the real package manager.

## Personas and knowledge — what actually reaches the user

**The two personas' narration PROMPTS now differ; whether their OUTPUT does is unverified.** `narrate()` takes an optional `persona` and **prepends** its Arabic directive to `NARRATOR_SYSTEM` — prepend, never substitute, so a directive cannot delete the 20-word cap, the JSON-only contract or the no-canned-confirmation ban. Persona reference counts in the four system-prompt files — counted as *lines mentioning a persona*, and re-derived by `docs:verify` — are now `narrator.ts` **11**, `coordinator.ts` **0**, `prompt-optimizer.ts` **0**, `brain.ts` **0**; the only interpolation outside that is `'{max}'` → word count. Directives are Arabic-only and live on `PersonaProfile.directive` in `src/knowledge/personas.ts`; the narrator receives the **string**, never the `PersonaId`, so rewording a dossier for a human reader cannot silently change what is spoken. Dialect is locked **Ammani / White Jordanian** with English technical terms preserved; `brain.ts:108` bans newsreader MSA and Beirusi. **Do not claim the two assistants audibly differ yet** — the differing system strings are proven by a spy on the chat seam, but that the model *responds* differently needs a live Inkling call, which was not made because it burns free-tier quota. A Tier-1 chunk once asserted they speak differently and the corpus is supposed to be the source of truth, so the same error is now live in the other direction.

The other persona effects are the TTS voice id (`daemon.ts:790`) and the wave colour (`App.tsx:611`). The per-persona **earcon pitch is gone** — `earcons.ts` was deleted in the Wave 1 dead-code removal and nothing reimplemented it, so the persona-dependent surface is three items, not four. The tree holds **0** files matching `earcon*` and **0** occurrences of the old pitch constants `659.25` / `987.77` / `1318.5`; `docs:verify` re-derives both, so re-adding an earcon under a new name cannot pass unnoticed.

**`src/knowledge/` is typechecked, linted, tested and reachable — and half-connected.** It now has **2** production importers: the `knowledge` CLI subcommand, and `daemon.ts` for `PERSONA_DIRECTIVES`. Of those, exactly **1** imports the barrel (`knowledge/index.js`) — the CLI. The daemon's import is the **persona registry only**, taken from `src/knowledge/personas.js` directly, so the daemon does not pull the BM25 retriever and the 43-chunk corpus into its import graph to obtain one style string. `docs:verify` re-derives both counts, so a future edit that routes the daemon through the barrel fails here rather than shipping a search index on the daemon's startup path. **The RAG layer is still not on the narration path** — no chunk is retrieved, ranked or interpolated into any prompt, and `docs/personas/WIRING.md` is the reviewed plan for the *retrieval* half, which remains undone. Retrieval p99 is **0.0128 ms against a 10 ms budget** (780× headroom), measured against minisearch, which lost 3.1× on speed with identical recall — so "optimise the retriever" is a solved non-problem. The real gap is **corpus coverage**: queries like `إيش سويت` return nothing because the fact is not in `capabilities.ts`, not because scoring failed.

## Vault — the single credential source

`vault/keyring.dat` (AES-256-GCM, `machine.key` in `~/.opencode-voice-runtime/`) is gitignored. Keys enter only via the API-keys window → `saveApiKeys`.
Path resolution differs by launch: repo runs use the repo `vault/`; an **installed** build resolves to `%LOCALAPPDATA%\Voxaura\vault` (created + seeded on first run). A keyless daemon keeps the control plane up, drops audio, and emits a `voice-disabled-no-keys` notice — voice stays dead until keys are saved (which now rebuilds the pipeline live).
Never print/log/commit key material; `doctor` reports counts only. To rotate a key by hand, call `writeKeyPools` from a script (the same encrypted merge path `saveApiKeys` uses) and **verify by SHA-256 fingerprint only** — never echo the value. A key that is *present but invalid* looks identical to a healthy one until the first utterance (L17 is open): a 401/403 advances the key and surfaces nothing. When STT/TTS/brain suddenly fails, check key validity before anything else.

## Conventions that will bite

- `exactOptionalPropertyTypes: true` in **both** tsconfigs — `{x?: T}` cannot be assigned `undefined`; build the object conditionally.
- `noUncheckedIndexedAccess: true` — `arr[i]` is `T | undefined`.
- ESM/NodeNext: relative imports in `src/` **must** use the `.js` extension even though you edit `.ts`.
- `*.test.ts` is excluded from the root tsc build; desktop has `noEmit`.
- Renderer: Arabic/RTL (`dir="rtl"` on the surface root), `index.html` is `lang="en"` (known inconsistency), scrollbars are globally hidden, and the window **auto-sizes to content** (`useAutoSize` measures `scrollHeight`) — any non-absolutely-positioned growing element resizes the OS window.
- `apps/desktop/src-tauri/sidecar/` is a **generated build artifact** (gitignored, excluded from eslint); regenerate with `node scripts/provision-sidecar.mjs` after changing `src/`.
- Add WS frames **additively** — `hello/inventory/agents/event/ack/error` plus `voice`/`notice`/`context` are contract; old shells ignore unknown types.
- Tests: keep scratch/verification scripts in `%LOCALAPPDATA%\Temp\opencode\`, never in the repo.

## Release flow (do not improvise)

1. Bump the version in **all** of: `package.json`, `apps/desktop/package.json`, `apps/desktop/package-lock.json` (root `packages[""].version`), `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `scripts/provision-sidecar.mjs`, plus `README.md`/`README.ar.md`/`docs/00-PROJECT-GUIDE.md`/`assets/hero-banner.svg` and the CHANGELOG. **Do the edits in Node with an exact-occurrence assertion per file** — a PowerShell array literal once flattened and string-replaced across eight files, silently turning `badge`→`aadge`. The 0.6.1 bump also *missed* the guide, the hero banner and the lock file; an unasserted `replace` is how that happens.
2. `npm run build` (root) → `node scripts/provision-sidecar.mjs` → `npm run build:tauri`.
3. Verify `src-tauri/target/release/bundle/nsis/Voxaura_<v>_x64-setup.exe`; compute SHA-256; record it in README + `docs/10-CHECKPOINT.md`.
4. Stop the running `voxaura.exe` (and any `Voxaura\sidecar\node.exe`) before installing or before E2E — it holds 4096/4097 and the Playwright stub cannot bind.
5. Commit → tag → push `main` + tag → `gh release create <tag> <setup.exe> --notes-file <tmp md>`. **Commit before tagging**: `gh release create` auto-creates the tag at whatever HEAD is *at that moment*, so creating the release and then committing leaves the tag pointing at the pre-fix commit. Verify with `git rev-list -n 1 <tag>` against `git rev-parse HEAD`.
6. **Only an installed build proves anything.** After building, `Voxaura_<v>_x64-setup.exe /S`, launch it, and confirm 4096+4097 bound with `daemon.log` at 0 bytes. v0.6.0 passed every gate and could not start at all.

## Gotchas that cost real time

- **Pipelines in this shell lie about exit codes.** `npm run x 2>&1 | Select-Object ...` returns 1 even on success. Check `$LASTEXITCODE` *unpiped*, or redirect to a log file and read it.
- Background long builds: use `background: true`, then wait for the completion notification — do not poll.
- `git commit -F <file>` takes a **file path**, not a message; `-m` takes the message. Passing a multi-line string to `-F` makes git read it as a filename and fail. Commit messages are PowerShell-parsed: **non-ASCII quotes (`“”`) or embedded Arabic break `git commit -m`** — write the message to a temp file and use `-F`.
- **A commit message written by PowerShell 5.1 carries a UTF-8 BOM, and it silently breaks Conventional Commits.** `Out-File -Encoding utf8` and `Set-Content -Encoding utf8` both emit U+FEFF first; `git commit -F` copies it verbatim into the message. The type then parses as `﻿fix`, not `fix`, so `^(feat|fix|docs|…)` matches nothing and `conventional-changelog`/semantic-release skip the commit **without an error**. Measured on this repo: **13 of 299** commits, the most recent 13 before `3ce0f7a` — including `1f2e51e fix(security): redact provider errors at the notice sink`. `git log` renders it as a stray `﻿` before the type, which reads like a terminal artifact and is not one. **Write commit-message files with the file-write tool, or `-Encoding utf8NoBOM` on PS 7 / `[IO.File]::WriteAllText`, and check with `node -e` for `charCodeAt(0) === 0xFEFF`.** History is deliberately **not** rewritten: all 13 are on `origin/main` and their SHAs are cited in this file and in commit messages, so a fix would cost more than it buys. New commits must be clean.
- The GitHub remote is **private** (`3mar-baha/Vantrilex-OpenCode-Assistant`), default branch `main`; there is no `master`. `git log origin/main..main` shows unpushed work — the installed app tracks the last *release*, not local HEAD.
- **Free OpenRouter models are lossy, not just 429.** Inkling is a reasoning model: without `effort:'none'` it returns `content: null`. Nemotron measured 3/12 success at p50 4,831 ms. A malformed single field used to void an entire reply — the narrator and intake both coerce/validate now, so a schema deviation costs a degraded line, not silence. Always measure before blaming your own code.
- **STT pins `language: 'ar'`.** Feeding it English audio yields Arabic gibberish *by design* — that is not a Whisper bug and not a key problem. To test Arabic STT you need real (or TTS-synthesised) Arabic audio.
- **A binary WS frame over `MAX_AUDIO_BYTES` (64 KiB) is rejected** with an `error` frame and never reaches the pipeline — silently, if you aren't collecting `error` frames. The window is 160,000 bytes, so send it in ≤32 KiB chunks like the renderer does.
- The Windows **taskbar icon is cached** by Explorer keyed on the exe path. Replacing icons does nothing until you stop `explorer.exe`, delete `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db`, and restart it (`ie4uinit.exe -show` is not sufficient).
- Rust resolves `resource_dir` with a `\\?\` prefix; Node's resolver rejects it — the supervisor strips it before handing paths to the child.
- A helper that both **prints and returns** in PowerShell captures its diagnostic *strings* as the return value. That silently produced a gate reporting "30/30 ORPHAN" from a number it never measured. Separate `Write-Host` from `return`.
- **Verify a guard test by breaking the guard.** Disabling the fix and confirming the test fails is the only way to know it isn't vacuous. Several tests here were vacuous until checked. Two were worse — they **pinned bugs as features**: `capture-permission.test.ts` asserts an idempotency guard that makes every mic-recovery path a silent no-op, and a `ws.test.ts` case *named* "resumes seq" asserted that **no** resume param was sent. A test whose name contradicts its assertion is a smell worth reading for.
- **A test can be vacuous because your injection silently no-opped.** Twice now, a break-the-guard passed only because the anchor string didn't exist in the file. Always print a confirmation line that the injection landed before trusting a green break.
- **`scripts/provision-sidecar.mjs` writes its OWN manifest** (and runs its own `npm install`), so **removing a dependency from root `package.json` does not remove it from the installer**. That is how `pino` and `eventsource` kept shipping after being deleted at the root. Change both places, then verify eradication rather than assuming it: `node -e` over the lock, and `npm ls` for extraneous.
- **`ui.notice()` is the redaction sink and it is the only channel a user can see.** `daemon.ts` interpolates raw provider `err.message` into notices; redaction lives in `UiServer.notice()`, not at those call sites, so a new call site cannot leak. Do not "helpfully" move redaction outward to the callers.
- **The shell needs `?lastSeq=` on the FIRST connect, not just reconnects.** `lastSeq` is initialised to `-1` as a "never connected" sentinel; keying the query param off `>= 0` omits it on connect #1, the server's `lastSeqOf` then returns `NaN`, and `ui-server.ts` skips the entire replay block. Measured cost: a cold launch sat with an empty session list and agent selector for 25+ s. Floor the value with `Math.max(0, …)` and keep the sentinel.
- **`normalizeArabic` must not be widened by a dash range.** The class was `U+064B-U+0672`, which swallows the Arabic-Indic digits `U+0660-U+0669`; `المنفذ ٤٠٩٦ مشغول` lost its port number before it was ever scored. Classes are `\u`-escaped so the gaps *are* the comment. Also: minisearch and most JS search libs ship **no** Arabic orthographic handling at all, so a normalizer must be passed in at both index and query time or Arabic recall silently goes to zero.

## Conventions for changes

- Atomic Conventional Commits, author `3mar-baha <omarbaha224@gmail.com>`, on `main`. No CI workflows exist — the gates are manual.
- Update `docs/10-CHECKPOINT.md` with real measured numbers for any behavior change.
- Do not "fix" live failures by editing docs; reproduce against the running process first.
