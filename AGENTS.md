# AGENTS.md — Voxaura (opencode-voice-runtime)

Windows-first Tauri v2 desktop companion + Node daemon that drives OpenCode v2 (`opencode serve`) via voice.
**Trust code, not prose.** `dossier/PROJECT_MASTER_DOSSIER.md` is a code-first audit; `docs/01–28` are a frozen, partly-wrong spec set.

## Layout (who owns what)

| Path | Owner / entrypoint |
|---|---|
| `src/` | Node daemon. ESM, `NodeNext`, compiles to `dist/`. Real entry: `src/cli.ts` (`doctor｜vault bootstrap｜live｜serve`). Composition root: `src/daemon.ts`. |
| `src/ipc/` | Zero-dependency RFC 6455 server + frozen WS-4097 frame schemas (`voice-ui.v1`, path `/v1/ui`). |
| `src/orchestrator/` | Command router (FR-12), 3-agent coordinator, audio pipeline, inventory. |
| `src/voice/` | Vault/keyring/STT/TTS/brain. |
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

- `test:vantrilex` is **typecheck → eslint → oxlint → root vitest → desktop vitest**. E2E is **not** part of it.
- `cargo check --no-default-features` and `test:e2e` are separate.
- Almost all network clients are **injected mocks**. E2E drives `stub-daemon.mjs` (real `UiServer` + router, fake control port `:4197`, no providers/vault). Only `node dist/cli.js live` and `scripts/live_console_test.ts` touch real APIs — neither is in the gate, so **green CI does not mean the live loop works**.
- Desktop unit tests run in `happy-dom`; root in node.

## Runtime topology (non-obvious)

Four fixed ports: **4096** OpenCode serve, **4097** WS-4097 UI bridge, **1420** Vite dev, **4197** E2E stub control.
Cold launch: `main.rs` writes `~/.opencode-voice-runtime/ipc.token` in `setup()` **before the webview loads**, spawns serve (if 4096 cold), then `node sidecar/dist/cli.js serve`; both children go into a `KILL_ON_JOB_CLOSE` Job Object.
The WS bearer travels as an **extra subprotocol token** (`[voice-ui.v1, <token>]`) because browsers cannot set upgrade headers. Shell reads the token via the `ipc_token` Tauri command — it is never baked into the bundle.
Runtime state lives in `~/.opencode-voice-runtime/` (`ipc.token`, `serve.pass`, `supervisor.log`, `daemon-stderr.log`).

## Vault — the single credential source

`vault/keyring.dat` (AES-256-GCM, `machine.key` in `~/.opencode-voice-runtime/`) is gitignored. Keys enter only via the API-keys window → `saveApiKeys`.
Path resolution differs by launch: repo runs use the repo `vault/`; an **installed** build resolves to `%LOCALAPPDATA%\Voxaura\vault` (created + seeded on first run). A keyless daemon keeps the control plane up, drops audio, and emits a `voice-disabled-no-keys` notice — voice stays dead until keys are saved (which now rebuilds the pipeline live).
Never print/log/commit key material; `doctor` reports counts only.

## Conventions that will bite

- `exactOptionalPropertyTypes: true` in **both** tsconfigs — `{x?: T}` cannot be assigned `undefined`; build the object conditionally.
- `noUncheckedIndexedAccess: true` — `arr[i]` is `T | undefined`.
- ESM/NodeNext: relative imports in `src/` **must** use the `.js` extension even though you edit `.ts`.
- `*.test.ts` is excluded from the root tsc build; desktop has `noEmit`.
- Renderer: Arabic/RTL (`dir="rtl"` on the surface root), `index.html` is `lang="en"` (known inconsistency), scrollbars are globally hidden, and the window **auto-sizes to content** (`useAutoSize` measures `scrollHeight`) — any non-absolutely-positioned growing element resizes the OS window.
- `apps/desktop/src-tauri/sidecar/` is a **generated build artifact** (gitignored, excluded from eslint); regenerate with `node scripts/provision-sidecar.mjs` after changing `src/`.
- Add WS frames **additively** — `hello/inventory/agents/event/ack/error` plus `voice`/`notice` are contract; old shells ignore unknown types.
- Tests: keep scratch/verification scripts in `%LOCALAPPDATA%\Temp\opencode\`, never in the repo.

## Release flow (do not improvise)

1. Bump `0.5.x` in **all** of: `package.json`, `apps/desktop/package.json`, `apps/desktop/package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `scripts/provision-sidecar.mjs`, plus README/README.ar/`docs/00-PROJECT-GUIDE.md`/`assets/hero-banner.svg` and the CHANGELOG.
2. `npm run build` (root) → `node scripts/provision-sidecar.mjs` → `npm run build:tauri`.
3. Verify `src-tauri/target/release/bundle/nsis/Voxaura_<v>_x64-setup.exe`; compute SHA-256; record it in README + `docs/10-CHECKPOINT.md`.
4. Stop the running `voxaura.exe` (and any `Voxaura\sidecar\node.exe`) before installing or before E2E — it holds 4096/4097 and the Playwright stub cannot bind.
5. Commit → tag → push `main` + tag → `gh release create <tag> <setup.exe> --notes-file <tmp md>`.

## Gotchas that cost real time

- **Pipelines in this shell lie about exit codes.** `npm run x 2>&1 | Select-Object ...` returns 1 even on success. Check `$LASTEXITCODE` *unpiped*, or redirect to a log file and read it.
- Background long builds: use `background: true`, then wait for the completion notification — do not poll.
- Commit messages are PowerShell-parsed: **non-ASCII quotes (e.g. `“”` or embedded Arabic) break `git commit -m`**. Keep commit messages plain ASCII.
- Free OpenRouter models (`dots-3-note-preview:free`, `nemotron-3-ultra-550b-a55b:free`) return **HTTP 429** under load. That is upstream, not a regression — distinguish it from real failures.
- The Windows **taskbar icon is cached** by Explorer keyed on the exe path. Replacing icons does nothing until you stop `explorer.exe`, delete `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db`, and restart it (`ie4uinit.exe -show` is not sufficient).
- Rust resolves `resource_dir` with a `\\?\` prefix; Node's resolver rejects it — the supervisor strips it before handing paths to the child.

## Conventions for changes

- Atomic Conventional Commits, author `3mar-baha <omarbaha224@gmail.com>`, on `main`. No CI workflows exist — the gates are manual.
- Update `docs/10-CHECKPOINT.md` with real measured numbers for any behavior change.
- Do not "fix" live failures by editing docs; reproduce against the running process first.
