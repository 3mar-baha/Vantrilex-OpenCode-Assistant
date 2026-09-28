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
npm run test:vantrilex                # typecheck -> eslint -> oxlint -> vitest(root) -> vitest(desktop)
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

- `test:vantrilex` is **typecheck → eslint → oxlint → root vitest → desktop vitest → `npm run test:e2e`**. E2E **is** part of it (`package.json:24`). An earlier version of this file claimed otherwise and was wrong. It needs ports 4096/4097/4197 free, so it fails with `EADDRINUSE` if an installed build is running.
- Current counts (keep these moving up, never down): root **568 passed + 0 skipped** (46 files) · desktop **153** (24 files) · `cargo test` **27** · E2E **18** across 14 specs. `npm run test:vantrilex` exits 0 on all of these. Measured 2026-09-28; a 7-agent forensic audit independently re-derived the root and desktop numbers from execution and matched them. The root count went 491 → 498 *while 70 tests were deleted* (44 unreachable modules quarantined, 30 seam tests added), then 525 → 568 when `src/knowledge/` landed. A falling count is not automatically a regression — check `git log` before "fixing" it.
- `cargo check --no-default-features` and `cargo build --release` are separate. **No test runner covers `main.rs` token generation**: `ipc.token` and `serve.pass` come from an xorshift64\* seeded with `nanos ^ pid`, not a CSPRNG (`main.rs:460-476`, `:501-517`), and the `fs::write` calls set no restrictive mode (`:478`, `:519`). The daemon's own `randomBytes(32)` (`daemon.ts:746`) is stronger than the supervisor's.
- Almost all network clients are **injected mocks**. E2E drives `stub-daemon.mjs` (real `UiServer` + router, fake control port `:4197`, no providers/vault). Only `node dist/cli.js live` and `scripts/live_console_test.ts` touch real APIs — neither is in the gate, so **green CI does not mean the live loop works**. v0.6.0 is the proof: every gate green, daemon could not boot.
- Desktop unit tests run in `happy-dom`; root in node.
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

## Dead code — `src/` is at 0%, and reachability is measured

**This section replaced a 24.6 % dead-code warning. As of v0.7.0 there is none.**
Resolve every relative import transitively from `src/daemon.ts` and `src/cli.ts`:

```
LIVE production modules : 51
DEAD production modules : 0
live source lines       : 8056
dead source lines       : 0
```

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
- The GitHub remote is **private** (`3mar-baha/Vantrilex-OpenCode-Assistant`), default branch `main`; there is no `master`. `git log origin/main..main` shows unpushed work — the installed app tracks the last *release*, not local HEAD.
- **Free OpenRouter models are lossy, not just 429.** Inkling is a reasoning model: without `effort:'none'` it returns `content: null`. Nemotron measured 3/12 success at p50 4,831 ms. A malformed single field used to void an entire reply — the narrator and intake both coerce/validate now, so a schema deviation costs a degraded line, not silence. Always measure before blaming your own code.
- **STT pins `language: 'ar'`.** Feeding it English audio yields Arabic gibberish *by design* — that is not a Whisper bug and not a key problem. To test Arabic STT you need real (or TTS-synthesised) Arabic audio.
- **A binary WS frame over `MAX_AUDIO_BYTES` (64 KiB) is rejected** with an `error` frame and never reaches the pipeline — silently, if you aren't collecting `error` frames. The window is 160,000 bytes, so send it in ≤32 KiB chunks like the renderer does.
- The Windows **taskbar icon is cached** by Explorer keyed on the exe path. Replacing icons does nothing until you stop `explorer.exe`, delete `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db`, and restart it (`ie4uinit.exe -show` is not sufficient).
- Rust resolves `resource_dir` with a `\\?\` prefix; Node's resolver rejects it — the supervisor strips it before handing paths to the child.
- A helper that both **prints and returns** in PowerShell captures its diagnostic *strings* as the return value. That silently produced a gate reporting "30/30 ORPHAN" from a number it never measured. Separate `Write-Host` from `return`.
- **Verify a guard test by breaking the guard.** Disabling the fix and confirming the test fails is the only way to know it isn't vacuous. Several tests here were vacuous until checked.

## Conventions for changes

- Atomic Conventional Commits, author `3mar-baha <omarbaha224@gmail.com>`, on `main`. No CI workflows exist — the gates are manual.
- Update `docs/10-CHECKPOINT.md` with real measured numbers for any behavior change.
- Do not "fix" live failures by editing docs; reproduce against the running process first.
