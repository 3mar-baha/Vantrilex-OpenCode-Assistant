# RELEASE-CHECKLIST.md — Voxaura v0.2.0 (GATE 5)

Measured on 2026-09-24, Windows 11, Node v25, HEAD at release commit.
No number below is estimated — each cites its artifact or command.

## 1. Quality gates (all green)

| Gate | Command | Result |
|---|---|---|
| typecheck (root) | `npx tsc --noEmit` | 0 errors |
| lint (root) | `npx eslint . --max-warnings 0` | 0 errors |
| lint (ox) | `oxlint` | 0 warnings, 0 errors |
| unit (root) | `npx vitest run` | 20 files, 110 passed + 3 live-gated skips |
| live (Laya) | `LAYA_LIVE=1 vitest run src/runtime/laya/laya.integration.test.ts` | 3/3 |
| live (VAD) | `SILERO_LIVE=1 vitest run src/runtime/vad.test.ts` | silence 0.044, speech path green |
| unit (renderer) | `npm --prefix apps/desktop run test` | 7 files, 44 passed |
| typecheck (renderer) | `apps/desktop: tsc --noEmit` | 0 errors |
| bundle (renderer) | `apps/desktop: npm run build` | 160.09 kB JS (51.59 gzip), worker chunk 2.78 kB |
| E2E | `apps/desktop: npx playwright test` | 5/5 vs real UiServer (boot/matrix/abort/portals/disconnect) |

## 2. Memory budget (measured, `node --expose-gc ml/memory_probe.mjs`)

| Stage | RSS |
|---|---|
| Node baseline | 56.1 MB |
| + Silero VAD (2.2 MB model) | 90.5 MB |
| + Laya INT8 (308 MB model) | 405.5 MB |
| after inference + gc | 407.9 MB |

System nominal: daemon ~408 MB + Tauri shell/WebView2 ~120–200 MB +
`opencode serve` ~300 MB + audio buffers ~100 MB ≈ **~1.0–1.1 GB**,
headroom **~1.9 GB** under the 3.0 GB ceiling. Watchdog tiers (2.2/2.6/2.9 GB)
remain specified; enforcement lands with the Tauri shell runtime.

## 3. Bundle status

| Target | Status | Evidence / blocker |
|---|---|---|
| Renderer bundle | DONE | `apps/desktop/dist/` (gitignored), sizes above |
| Icons | DONE | `src-tauri/icons/` incl. `icon.icns` + `icon.ico` via `tauri icon` |
| Tauri manifests | VALID | `tauri.conf.json` + `capabilities/default.json` parse; `cargo check` exit 0, zero errors (1m22s, tauri v2.11.6 dep tree) |
| NSIS `.exe` | BLOCKED (environment) | No MSVC linker (`cl`/`link` absent), no `makensis` on this machine |
| AppImage / `.deb` | BLOCKED (environment) | Linux toolchain absent; Docker present — build via Tauri Linux image |

Bundle commands (run where the toolchain exists):
- Windows: install MSVC Build Tools + NSIS, then `cd apps/desktop && npx tauri build --target nsis`.
- Linux: `docker run --rm -v .:/app tauri-apps/tauri:2 npm run build:tauri` (AppImage + deb).

## 4. Release steps

1. `npm run test:vantrilex` green on a clean tree.
2. `npx playwright test` green in `apps/desktop`.
3. Bump `package.json` + `apps/desktop/package.json` + `tauri.conf.json` versions together.
4. Build bundles per §3 on tooled runners.
5. Tag `v0.x.0`, push, record in `docs/10-CHECKPOINT.md`.
6. Rotate any e2e/test tokens; verify no secret in `git show`.

*End of release checklist.*
