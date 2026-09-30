# SECTION 02 — TOOLCHAIN, RUNTIME & DEPENDENCY TOPOLOGY
# SECTION 08 — HARDWARE, OS & SYSTEM-LEVEL INTEGRATIONS

> **Provenance.** Every number, path and line below was read out of the physical tree on
> **2026-09-30T14:49:06** at `HEAD=9f41c96` (`git rev-parse --short HEAD`), `git rev-list --count HEAD` = **371**,
> `git ls-files | Measure-Object -Line` = **643**. No file under `docs/`, and not `README.md`,
> `README.ar.md`, `CHANGELOG.md`, `AGENTS.md`, `CONTRIBUTING.md`, was opened. Code comments are
> quoted only where they are the *subject* of an observation (e.g. a comment that contradicts its
> own code), never used as evidence for a claim.

> **CONCURRENT-MUTATION WARNING — read before trusting any count here.**
> Another session was actively writing to this worktree while this audit ran. Proof, in order:
> 1. First census (`Get-ChildItem -Recurse -File -Include *.ts,*.tsx,*.mjs,*.rs` over `src`) at
>    ~14:30 returned `src/cli/` containing **4** files (`intents.ts` 13099 B, `report.ts` 2018 B,
>    `serve.ts` 11168 B, `turn.ts` 18026 B).
> 2. At 14:48:54 the same directory listed **8** files, four of them newer than the first read:
>    `bridge.ts` 14398 B (14:45:03), `commands.ts` 1545 B (14:46:16), `headless.ts` 12736 B (14:48:20),
>    `reason.ts` 19458 B (14:48:05), and `turn.ts` had **grown** from 18026 B to 18087 B.
> 3. `git status --short` moved from `?? docs/HEADLESS-BRIDGE-VERIFY.md` / `?? src/cli/` to
>    additionally showing ` M src/cli.ts`.
> Every on-disk count below is therefore a **point-in-time snapshot**, and any figure the reader
> re-derives later may legitimately differ. The tracked-file and `HEAD` figures are stable; the
> untracked ones are not.

---

## 0. Ground-truth census (measured, not briefed)

| Measure | Value | How measured |
|---|---|---|
| Git-tracked files, all extensions | **643** | `git ls-files \| Measure-Object -Line` |
| Commits reachable from HEAD | **371** | `git rev-list --count HEAD` |
| Git-tracked `.ts/.tsx/.rs/.mjs` | **319** | `git ls-files \| Where-Object { $_ -match '\.(ts\|tsx\|rs\|mjs)$' }` |
| …of which `src/` | **155** | same, `-like 'src/*'` |
| …of which `apps/` | **110** | same, `-like 'apps/*'` |
| …of which `scripts/` | **10** | same |
| …of which `ml/` | **1** | same |
| …of which root `vitest.config.ts` | **1** | same |
| …of which `.opencode/_archive/dead-code-phase1/` (quarantined dead code) | **42** | same — **all 42** are in that one directory |
| On-disk `.ts/.tsx/.rs/.mjs` under `src,apps,scripts,ml`, excluding `node_modules`,`target`,`dist` | **284** | `Get-ChildItem -Recurse -File -Path src,apps,scripts,ml -Include *.ts,*.tsx,*.rs,*.mjs \| Where-Object { $_.FullName -notmatch '\\(node_modules\|target\|dist)\\' }` |
| On-disk breakdown of that 284 | `src`=**163**, `apps`=**110**, `scripts`=**10**, `ml`=**1** | same, grouped on first path segment |
| Plus root | `vitest.config.ts`=**1** | `Get-Item vitest.config.ts` |
| `src/` breakdown (tracked, 2nd segment) | `orchestrator`=31, `voice`=25, `runtime`=24, `knowledge`=18, `ipc`=11, `tasks`=10, *(src root)*=8, `policy`=7, `common`=6, `telemetry`=4, `launcher`=3, `daemon`=3, `diag`=3, `memory`=2 | `git ls-files` grouped |
| `apps/` breakdown (tracked) | `desktop/src`=83, `desktop/e2e`=20, `desktop/src-tauri`=2, `vite.config.ts`=1, `vitest.config.ts`=1, `tailwind.config.ts`=1, `desktop/scripts`=1, `playwright.config.ts`=1 | `git ls-files` grouped |
| `src/desktop/` | **empty directory** — 0 files, 0 git-tracked | `Get-ChildItem -Recurse src\desktop` → no output; `git ls-files -- 'src/desktop/*'` → 0 |

`src/desktop/` exists on disk and is empty. A naive `Get-ChildItem -Recurse src` + path-split
groups `apps\desktop\src\*` under a `desktop` key, which inflates the apparent `src` count by 83.
That is a measurement trap, recorded here so the next auditor does not fall into it.

### 0.1 Language manifests that DO NOT EXIST

```
PS> foreach ($f in 'go.mod','pyproject.toml','Cargo.toml','setup.py','requirements.txt') { ... }
ABSENT  go.mod
ABSENT  pyproject.toml
ABSENT  Cargo.toml
ABSENT  setup.py
ABSENT  requirements.txt
```

There is **no Go** and **no root Rust crate**. The only Rust manifest in the repository is
`apps/desktop/src-tauri/Cargo.toml` (verified by `Get-ChildItem -Recurse -Filter Cargo.toml |
Where-Object { $_.FullName -notmatch '\\(node_modules|target)\\' }`, which returns exactly that
one path). There is **no root `pyproject.toml`**, yet 18 git-tracked `.py` files exist under `ml/`
(§2.8).

### 0.2 The Rust surface is exactly one source file

| File | Bytes | Lines |
|---|---|---|
| `apps/desktop/src-tauri/src/main.rs` | **143,826** | **3,289** |
| `apps/desktop/src-tauri/build.rs` | present | (git-tracked, `apps/desktop/src-tauri`=2) |

`Get-ChildItem -Recurse -Filter *.rs -Path apps` returns 19 paths, of which **17 are generated
build-script output** under `apps/desktop/src-tauri/target/{debug,release}/build/*/out/*.rs`
(`selectors-*`, `serde_core-*`, `serde-*`, `thiserror-*`, `web_atoms-*`). Only `build.rs` and
`src/main.rs` are source. `main.rs` is the single densest file in the repository and holds both
the Job-Object code and the DACL code (§8.4, §8.5).

### 0.3 The `.py` census — the claim that Python is only a virtualenv is FALSE

```
PS> $py = Get-ChildItem -Recurse -File -Filter *.py
total .py on disk: 12339
outside .venv: 22
PS> git ls-files -- '*.py'     # → 18 paths, all under ml/
```

12,339 `.py` files exist; **12,317** are inside `.venv/` (a virtualenv, correctly ignored) and
**22 are not**. Of those 22:

| Location | Count | Git-tracked? |
|---|---|---|
| `ml/*.py` (top level) | 15 | **yes** — `bench_onnx`, `diagnose_shortcut`, `eval_adversarial`, `eval_onnx`, `export_onnx`, `finalize_l2`, `gen_tokenizer_golden`, `head_metrics`, `latency_compare`, `laya_hub`, `negation_probe`, `score_probe`, `stress_battery`, `train_laya`, `verify_g1`, `verify_g2` |
| `ml/data/*.py` | 2 | **yes** — `generate_synth.py`, `harvest_joda.py` |
| `.hf_cache/hub/…/Jordanian-Dialect-Instruct-QA.py` + `.hf_cache/modules/**/__init__.py` | 3 | no (cache, gitignored) |
| `node_modules/flatted/python/flatted.py` | 1 | no (vendored) |

So: **18 of the 22 are first-class tracked project source**, and `pyrightconfig.json` names `ml`
as its only `include` root. A Python ML/export/eval subsystem exists and is version-controlled.
The `12338`-figure claim also differs by one from the measured `12339`, and the
"every one is inside `.venv`" claim is false.

---

## 2. SECTION 02 — TOOLCHAIN, RUNTIME & DEPENDENCY TOPOLOGY

### 2.1 Declared dependencies (`package.json:36-48`)

Root manifest is `"name": "opencode-voice-runtime"`, `"version": "0.8.2"`, `"type": "module"`,
`"engines": { "node": ">=22.0.0" }` (`package.json:50-52`).

```json
"dependencies":    { "groq-sdk": "^0.9.0", "lru-cache": "^11.0.0",
                     "onnxruntime-node": "1.30.0", "zod": "^3.23.0" }
"devDependencies": { "@types/node": "^22.0.0", "eslint": "^9.0.0", "typescript": "^5.5.0",
                     "typescript-eslint": "^8.70.0", "vitest": "4.1.11",
                     "oxlint": "1.85.0", "vite": "^7.1.0" }
```

### 2.2 Resolved versions on disk — the ranges are not what is installed

Read from `node_modules/<pkg>/package.json` `version` fields via `ConvertFrom-Json`, not from
the range strings.

| Package | Declared | **Resolved on disk** | Drift from declared range |
|---|---|---|---|
| `groq-sdk` | `^0.9.0` | **0.9.1** | within range |
| `lru-cache` | `^11.0.0` | **11.5.3** | within range, +5 minors |
| `onnxruntime-node` | `1.30.0` (exact) | **1.30.0** | none — the only exact runtime pin |
| `zod` | `^3.23.0` | **3.25.76** | within range, +2 minors |
| `@types/node` | `^22.0.0` | **22.20.4** | within range |
| `eslint` | `^9.0.0` | **9.39.5** | within range |
| `typescript` | `^5.5.0` | **5.9.3** | **+4 minors over the stated floor** |
| `typescript-eslint` | `^8.70.0` | **8.70.1** | within range |
| `vitest` | `4.1.11` (exact) | **4.1.11** | none |
| `oxlint` | `1.85.0` (exact) | **1.85.0** | none |
| `vite` | `^7.1.0` | **7.3.6** | within range, +2 minors |

All eleven root packages are physically present. `Test-Path 'node_modules\.bin\oxlint.cmd'` → `True`.
`node_modules\.bin` also contains `esbuild`, `rollup`, `acorn`, `semver`, `nanoid`, `pino`,
`js-yaml`, `node-gyp-build-optional-packages`, `download-msgpackr-prebuilds`,
`why-is-node-running` — i.e. **transitive and/or orphaned binaries that no current manifest
declares** (`pino` in particular is not in any current `package.json`; see §2.4).

Desktop sub-project (`apps/desktop/package.json`) is a **separate manifest with its own
lockfile**; its packages are **not** installed at the root (`Test-Path node_modules\react` → `False`):

| Package | Resolved in `apps/desktop/node_modules` |
|---|---|
| `react` / `react-dom` | 18.3.1 / 18.3.1 (exact) |
| `tailwindcss` | 3.4.19 (exact) |
| `@vitejs/plugin-react` | 4.7.0 (exact) |
| `vite` | 7.3.6 |
| `vitest` | 4.1.11 |
| `typescript` | 5.9.3 |
| `@tauri-apps/api` | 2.11.1 (exact) |
| `@tauri-apps/cli` | 2.11.5 (exact) |
| `@playwright/test` | 1.63.0 |
| `autoprefixer` / `postcss` | 10.6.1 / 8.5.28 |
| `happy-dom` | 20.14.5 |
| `zod` | **NOT INSTALLED** — confirmed no renderer-side zod; the WS frame schemas are duplicated, not imported (§2.3) |

### 2.3 Why each dependency exists — found by grepping actual `import`/`require` sites

Method: `Select-String` over `src`, `apps`, `scripts`, `ml` (excluding `node_modules`,`target`,`dist`)
for `^\s*(import|export)\s.*from\s+'<pkg>'`, `require\('<pkg>'\)`, `import\('<pkg>'\)`, and
`from 'vitest/config' | from '@vitejs/plugin-react' | from 'react' | from 'react-dom'`.
**158 total import statements**; 151 of them are the literal line
`import { describe, expect, test } from 'vitest';` in test files.

#### Runtime dependencies

| Dep | Import count | Exact sites (`path:line`) | Verdict |
|---|---|---|---|
| **`groq-sdk`** | **1** | `src/voice/stt.ts:1` — `import Groq from 'groq-sdk';` → `private readonly client: Groq` (`stt.ts:87`), `new Groq({ apiKey })` (`stt.ts:90`) | **load-bearing.** Sole STT client. Exactly one importer. |
| **`lru-cache`** | **1** | `src/voice/cache.ts:4` — `import { LRUCache } from 'lru-cache';` → `private readonly lru: LRUCache<string, AudioCacheEntry>` (`cache.ts:48`), `new LRUCache(...)` (`cache.ts:54`) | **load-bearing.** Sole audio-blob LRU. Exactly one importer. |
| **`zod`** | **7** | `src/common/config.ts:1`, `src/diag/bundle.ts:7`, `src/ipc/protocol.ts:1`, `src/orchestrator/coordinator.ts:1`, `src/orchestrator/permission.ts:1`, `src/telemetry/writer.ts:2`, `src/voice/brain.ts:1` | **load-bearing.** The WS-4097 frame boundary, the OpenRouter response shape, the LLM plan shape, the diagnostic-bundle shape, telemetry redaction list and the config schema all parse through it. All seven are production files; **zero** test-only importers. |
| **`onnxruntime-node`** | **4** (2 static prod, 1 static test, 1 dynamic ML) | `src/runtime/vad.ts:2` `import * as ort from 'onnxruntime-node';`; `src/runtime/laya/laya-engine.ts:1` `import * as ort from 'onnxruntime-node';`; `src/runtime/laya/laya.test.ts:2` `import { Tensor } from 'onnxruntime-node';`; `ml/memory_probe.mjs:11` `const ort = await import('onnxruntime-node');` | **load-bearing but CONDITIONALLY, and NOT shipped.** See the two findings below. |

**`onnxruntime-node` finding A — the only production path is a late dynamic import.**
`src/daemon.ts:1055` is the single `import(` in the daemon:
```ts
vadLoad = import('./runtime/vad.js')
  .then((m) => m.SileroVad.load(cfg.vad.modelPath, { threshold: cfg.vad.threshold }))
  .catch(() => null);
```
`src/runtime/vad.ts:2` then statically pulls the native package. A grep for importers of
`runtime/laya/loader` across all **non-test** `.ts`/`.mjs` returns **zero** code hits — the only
three matches are inside prose (`src/runtime/laya/index.ts:6`, `src/runtime/laya/index.ts:11`,
`src/runtime/laya/loader.ts:26`). So `laya-engine.ts`'s static `onnxruntime-node` import is
reachable **only from `laya.test.ts` and `laya.integration.test.ts`**.

**`onnxruntime-node` finding B — the native binding is declared at the root but omitted from the
installer.** `scripts/provision-sidecar.mjs:57-61` writes the sidecar manifest as:
```js
dependencies: { 'groq-sdk': '^0.9.0', 'lru-cache': '^11.0.0', 'zod': '^3.23.0' },
```
`onnxruntime-node` is **absent** from that list, and `apps/desktop/src-tauri/tauri.conf.json`
`bundle.resources` is exactly `["sidecar/**/*"]` — so no `models/*.onnx` rides in the bundle
either. An installed build therefore cannot resolve the dynamic import at `daemon.ts:1055`; the
`.catch(() => null)` at `daemon.ts:1057` absorbs it and `makeVadGate(loadVad, isLoudWindow)`
(`daemon.ts:1062`) degrades to the RMS gate. The failure is silent by construction.

#### Dev dependencies

| Dep | Import count | Exact sites | Verdict |
|---|---|---|---|
| **`vitest`** | **~152** | one `from 'vitest'` per `*.test.ts(x)` (e.g. `src/ipc/protocol.test.ts:1`, `src/policy/claim-matcher.test.ts:1`, `apps/desktop/src/App.test.tsx:3`) **plus** `apps/desktop/vitest.config.ts:1` `import { defineConfig } from 'vitest/config';` | **load-bearing, test-only.** Every one of the ~151 file-local imports is inside a `*.test.ts`; the only non-test importer is the desktop vitest config. |
| **`vite`** | **3** | `apps/desktop/vite.config.ts:2` `import { defineConfig } from 'vite';`; `apps/desktop/vitest.config.ts:1` (via `vitest/config`, which re-exports Vite's `defineConfig`); `scripts/packaging-preflight.mjs:42` `pathExists(join(desktop,'node_modules','vite'))` | **load-bearing, build-tool-only.** No `src/` or `apps/desktop/src/` file imports `vite`; it is a dev-server/bundler + a preflight existence probe. |
| **`typescript`** | **0** | none | **not importable by design.** Invoked as a CLI: `package.json:17` `"build": "tsc -p tsconfig.json"`, `:18` `"typecheck": "tsc --noEmit"`, `:19` `"typecheck:tests": "tsc -p tsconfig.tests.json"`. Zero import sites is the correct shape, not a defect. |
| **`eslint`** | **0** | none | **not importable by design.** Invoked as a CLI: `package.json:24` `"lint": "eslint . --max-warnings 0"`. Its only *load* is `eslint.config.js:1` `import tseslint from 'typescript-eslint';`. |
| **`typescript-eslint`** | **0 in `src`/`apps`/`scripts`** — but **1 in the lint config** | `eslint.config.js:1` `import tseslint from 'typescript-eslint';`, then `:4` `...tseslint.configs.recommended` and `:14` `files: ['**/*.test.ts']` with `'@typescript-eslint/no-explicit-any': 'off'` | **load-bearing.** The entire ESLint rule set is this one package. It supplies the parser, the plugin, and the flat-config presets. Zero source-file imports is expected. |
| **`@types/node`** | **0** | none | **load-bearing, ambient-only.** Reaches the compiler through `tsconfig.json:17` `"types": ["node"]` and `apps/desktop/tsconfig.json` (which sets `"types": ["vite/client"]` and therefore does **not** get Node globals). Not being imported anywhere is correct: it is a global type package. |
| **`oxlint`** | **0** | none | **load-bearing, but only reachable by a resolution fallback.** Invoked as a CLI. `package.json:25` is `"lint:ox": "node scripts/lint-baseline.mjs"`; the script resolves `join(ROOT,'node_modules','.bin', win32?'oxlint.cmd':'oxlint')` at `scripts/lint-baseline.mjs:41`, and **refuses to run** if that file is absent unless `VOXAURA_ALLOW_GLOBAL_OXLINT=1` is set (`lint-baseline.mjs:43`, `:47-59`). `apps/desktop/package.json` declares a *second* `oxlint: "1.85.0"` and a *bare* `"lint:ox": "oxlint"` with no such guard. |

**Verdict summary: nothing is unused.** All 4 runtime and all 8 dev dependencies have a
demonstrable consumer. The three with zero import sites (`typescript`, `eslint`, `@types/node`
— plus `typescript-eslint` and `oxlint` outside the lint config) are CLI/ambient consumers, and
each is traced to the exact line that consumes it. Two genuine classification findings survive:
`onnxruntime-node` is **load-bearing only behind a `catch`-swallowed dynamic import that the
installer cannot satisfy**, and `vite`'s only source-adjacent mention is a preflight existence
probe rather than an import.

### 2.4 Orphaned binaries in `node_modules/.bin` — the dual-lockfile residue, measured

`node_modules\.bin` contains `pino`, `download-msgpackr-prebuilds`, `msgpackr`-related shims and
`node-gyp-build-optional-packages*`. None of `pino`, `eventsource`, `msgpackr` or
`@opencode/client` appears in the current `package.json`. They are the physical residue of the
dependency set that `pnpm-lock.yaml` still describes (§2.5). The install-state marker confirms it:
`node_modules\.package-lock.json` is present (100,171 B) and `node_modules\.modules.yaml` is
**ABSENT** — npm wrote this tree, pnpm did not.

### 2.5 The dual lockfile — npm is authoritative, and the proof is four independent signals

Three lock-ish files coexist at the root: `package-lock.json` (134,330 B),
`pnpm-lock.yaml` (81,619 B), `pnpm-workspace.yaml` (100 B), plus a fifth
`apps/desktop/package-lock.json` and `skills-lock.json` (707 B, a skill-content hash registry,
not a package lock).

| Signal | `package-lock.json` | `pnpm-lock.yaml` |
|---|---|---|
| mtime on disk | **2026-09-30 06:08:57** | 2026-09-22 10:03:10 |
| last commit touching it | `5c42bed` **2026-09-30** `release: v0.8.0 — the audit's findings, closed` | `443e1bc` 2026-09-22 `chore(m7): restore test toolchain lockfile, fix harvest root` |
| format | `lockfileVersion: 3` (npm) | `lockfileVersion: '9.0'`, `settings.autoInstallPeers: true` (pnpm) |
| root dep block vs `package.json` | **byte-identical** for all 11 entries; `node -e` diff over `{...dependencies,...devDependencies}` prints **0** missing and **0** extra and **0** range disagreements | **12 importer entries, 3 of which are not in `package.json` and 2 of `package.json`'s are missing** |
| npm install-state marker | `node_modules/.package-lock.json` **PRESENT** (100,171 B); `apps/desktop/node_modules/.package-lock.json` **PRESENT** (92,078 B) | `node_modules/.modules.yaml` **ABSENT**; `apps/desktop/node_modules/.modules.yaml` **ABSENT** |

**The drift, itemised** (parsed with `node -e` over the `importers:` block of the YAML):

- In `pnpm-lock.yaml`'s root importer but **not** in `package.json`: `@opencode/client ^2.0.0`
  (resolved `2.0.11(effect@4.0.0-rc.112)`), `eventsource ^3.0.0` (3.0.7), `pino`.
- In `package.json` but **absent from** `pnpm-lock.yaml`: `oxlint 1.85.0`, `vite ^7.1.0`.
- The 9 shared entries agree on specifier.

**Verdict: `package-lock.json` is authoritative; `pnpm-lock.yaml` is a stale orphan describing a
superseded dependency graph, and `pnpm-workspace.yaml` is the residue of the pnpm invocation that
produced it.** Four independent confirmations: (1) the root blocks agree exactly with
`package.json` and pnpm's do not; (2) npm's install-state marker exists and pnpm's does not; (3)
`package-lock.json` is 8 days newer in both mtime and commit order; (4) every script in
`package.json` is `npm`-shaped — `npm --prefix apps/desktop run test`, `npm run build --prefix ../..`,
`npm i -D`, and `scripts/provision-sidecar.mjs:65` runs
`execFileSync('npm', ['install','--omit=dev','--ignore-scripts','--no-audit','--no-fund'], {shell:true})`
against its own generated manifest. **No `pnpm` invocation exists anywhere in the repository.**

**What the orphan would cause.** Running `pnpm install` would (a) *remove* `oxlint` and `vite`
from the resolved graph, breaking `npm run lint:ox` — which then hits the deliberate hard-stop at
`scripts/lint-baseline.mjs:47-59` and refuses to silently degrade to a global binary; and
(b) *re-add* `@opencode/client`, `eventsource` and `pino` to `node_modules`, resurrecting the
shipped-payload class of defect that `scripts/provision-sidecar.mjs:49-56` documents: the
sidecar manifest is written by hand and `npm install`-ed independently, so a package returned to
the root graph would be reinstalled inside the installer. `pino`'s shim is still sitting in
`node_modules\.bin` right now (§2.4), which is direct evidence this has already happened once.

**One residual drift inside the authoritative lock:** `package-lock.json:3` records
`"version": "0.8.0"` while `package.json:3` is `"0.8.2"`. Every *dependency* field is current;
only the self-version is stale. `node_modules/.package-lock.json` is a separate 100,171 B
install-state file and is not a third lockfile.

### 2.6 Compiler flags of record

**Root daemon** — `tsconfig.json`, 557 B, verbatim `compilerOptions`:
`target: ES2023` · `module: NodeNext` · `moduleResolution: NodeNext` · `strict: true` ·
`noUncheckedIndexedAccess: true` · `exactOptionalPropertyTypes: true` · `noImplicitReturns: true` ·
`noFallthroughCasesInSwitch: true` · `forceConsistentCasingInFileNames: true` · `skipLibCheck: true` ·
`declaration: true` · `sourceMap: true` · `outDir: "dist"` · `rootDir: "src"` · `types: ["node"]`;
`include: ["src/**/*.ts"]`; `exclude: ["node_modules", "dist", "**/*.test.ts"]`.

`NodeNext` + `"type": "module"` is what forces `.js` specifiers on relative imports in `.ts`
source; it is a hard constraint on every module in `src/`.

**The `exclude` consequence — a structural fact, not a style note.**
`tsconfig.json:20` excludes `"**/*.test.ts"`. Three consequences follow, and all three are
observable in the tree:

1. **`npm run build` (`tsc -p tsconfig.json`) never sees a test file.** With `rootDir: "src"`
   and `outDir: "dist"`, no test reaches `dist/`.
2. **The tests are typechecked by a different, opt-in invocation.** `package.json:19`
   `"typecheck:tests": "tsc -p tsconfig.tests.json"`, and `tsconfig.tests.json` (151 B) is
   `{"extends":"./tsconfig.json","compilerOptions":{"noEmit":true},"include":["src/**/*.ts"],
   "exclude":["node_modules","dist"]}` — i.e. it *re-drops* the test exclusion, so it typechecks
   the full `src/**/*.ts` surface including every `*.test.ts`, with `noEmit` so nothing is
   written. It is a separate stage of `test:vantrilex`, not part of `build`.
3. **`include` reaches untracked files.** `src/cli.ts:25` does
   `import { HEADLESS_USAGE_SUFFIX, isHeadlessCommand } from './cli/commands.js';` and
   `src/cli/commands.ts` exists — but it is **untracked**, as is the whole `src/cli/` directory
   (8 files, §0). A clean `git clone` of `9f41c96` therefore has a `src/cli.ts` that references a
   `./cli/commands.js` that does not exist in the committed tree. `tsconfig.tests.json` will
   typecheck that dangling specifier on any checkout that does not also carry the untracked
   directory. Verified: `Test-Path 'src\cli\commands.ts'` → `True`; `git status --short` → `?? src/cli/`.

**Desktop renderer** — `apps/desktop/tsconfig.json` (1 config, no `tsconfig.tests.json` there):
`target: ES2022` · `module: ESNext` · `moduleResolution: Bundler` · `jsx: react-jsx` ·
`strict: true` · `noUncheckedIndexedAccess: true` · `exactOptionalPropertyTypes: true` ·
`noImplicitReturns: true` · `noFallthroughCasesInSwitch: true` · `skipLibCheck: true` ·
**`noEmit: true`** · `types: ["vite/client"]`; `include: ["src","vite.config.ts","tailwind.config.ts"]`.
Differences from the daemon worth naming: no `declaration`, no `sourceMap`, no `rootDir`/`outDir`,
`ES2022` not `ES2023`, `Bundler` resolution not `NodeNext`, and **`types: ["vite/client"]` rather
than `["node"]`** — the renderer has no Node globals by construction, which is why the WS frame
schemas cannot be imported across the boundary and are re-declared on the client
(`apps/desktop/src/bridge/ws.ts:113`, `apps/desktop/src/components/terminal/TerminalDrawer.tsx:172`,
`apps/desktop/src/serve-health-signal.ts:74`).

**Rust** — `apps/desktop/src-tauri/Cargo.toml`: `edition = "2021"`, `tauri = { version = "2", features = [] }`,
`serde` (`derive`), `serde_json = "1"`, `getrandom = "0.3"`, and a
`[target.'cfg(windows)'.dependencies]` block with `windows-sys = "0.61"` and features
`Win32_Foundation`, `Win32_Security`, `Win32_Security_Authorization`, `Win32_System_JobObjects`,
`Win32_System_Threading`. `[features] default = ["custom-protocol"]`.

### 2.7 Lint, test and typecheck configuration surface

**`vitest.config.ts` (root), 1,657 B.** `test.include` is exactly
`['src/**/*.test.ts', 'test/**/*.test.ts', 'bench/**/*.bench.ts']`. There is **no `exclude`
key and no `coverage` key at all** — verified with `node -e "Object.keys(...)"`-style inspection
of the config object: the only `test` children are `include` and the absent defaults. Consequences:
`test/` and `bench/` are globbed but **neither directory exists on disk** (`Get-ChildItem test`,
`Get-ChildItem bench` → no such directory), so those two globs currently match nothing.
`apps/desktop/**` is outside the root `include`, which is why `test:desktop` is a separate
`npm --prefix apps/desktop run test` stage.

**Coverage thresholds: ABSENT.** `vitest.config.ts` carries a 24-line comment block (lines 3-26)
explaining that `coverage.thresholds: { lines: 80 }` was removed because nothing ever set
`coverage.enabled`, and recording the three steps required before a real floor may be reinstated.
`@vitest/coverage-v8` is **not installed** — verified by `Test-Path 'node_modules\@vitest\coverage-v8\package.json'`
→ `False`. No npm script passes `--coverage` (read from `package.json:16-38`). The floor is
genuinely absent, and the comment is accurate about why.

**`apps/desktop/vitest.config.ts`.** `plugins: [react()]`,
`test.include: ['src/**/*.test.{ts,tsx}']`, `test.environment: 'happy-dom'`. No thresholds.

**`eslint.config.js`, 536 B.** `import tseslint from 'typescript-eslint';` then
`tseslint.config({ ignores: [...] }, ...tseslint.configs.recommended, { files:['**/*.test.ts'],
rules:{'@typescript-eslint/no-explicit-any':'off'} })`. Ignores: `dist/**`,
`apps/desktop/dist/**`, `apps/desktop/src-tauri/sidecar/**`, `node_modules/**`,
`apps/desktop/node_modules/**`, `coverage/**`, `.venv/**`, `**/target/**`.
**Type-aware linting is off** — there is no `languageOptions.parserOptions.project` and no
`strictTypeChecked` preset anywhere in the 536-byte file (grep for
`project|parserOptions|strictTypeChecked` → 0 matches). Rules are syntax-only; anything requiring
the type checker is `tsc`'s job, and the two stages are independent (`package.json:31`).
Note also that `**/target/**` in the ignore list is a Rust artifact path and `.venv/**` a Python
one: the ESLint ignore list is doing cross-language work, which is a symptom of five toolchains
in one root.

**`.oxlintrc.json`, 355 B.** Exactly three keys — verified by
`node -e "Object.keys(require('./.oxlintrc.json')).join(',')"` → `$schema,plugins,ignorePatterns`.
`plugins: ["typescript","react"]`. **No `rules` and no `categories` key**, so oxlint runs its
default rule set. `$schema` points at `./node_modules/oxlint/configuration_schema.json`, so the
config is only loadable when oxlint is installed. Ignore patterns: `node_modules/**`, `dist/**`,
`.venv/**`, `models/**`, `.hf_cache/**`, `ml/checkpoints/**`, `coverage/**`,
`apps/desktop/dist/**`, `apps/desktop/src-tauri/sidecar/**`, `**/target/**`.

**The oxlint baseline is pinned in a sibling file, not in the config.**
`scripts/lint-baseline.mjs:13` `const BASELINE = 8;` and
`scripts/lint-baseline.json` contains the single character sequence `8` (1 B). The script
executes `oxlint` via `execFileSync('cmd', ['/c', target], …)` on Windows
(`lint-baseline.mjs:74-75`), counts diagnostics by parsing `path:line:col` prefixes rather than
by exit code (`lint-baseline.mjs:82-105`), prints
`oxlint: N warning(s), M error(s); baseline 8` (`lint-baseline.mjs:115`), and prints an advisory
not-ex enforced message at `:124`. **Errors are not gated; only the warning count is compared to
a file-recorded integer.**

**`pyrightconfig.json`, 220 B.** `venvPath: "."`, `venv: ".venv"`, `include: ["ml"]`,
`exclude: [".venv","node_modules","models",".hf_cache","dist","ml/checkpoints"]`,
`typeCheckingMode: "basic"`, `reportMissingModuleSource: "none"`. This is the only manifest
naming the Python subsystem (§0.3), and it is a typechecker config, not a build or dependency
manifest — which is why there is no `pyproject.toml` and no declared Python dependencies at all.

### 2.8 `.gitignore` denylist (810 B) — parsed, grouped by intent

| Group | Entries |
|---|---|
| Dependencies / build output | `node_modules/`, `dist/`, `build/`, `target/`, `coverage/`, `test-results/`, `apps/desktop/src-tauri/gen/` |
| OS noise | `*.log`, `.DS_Store`, `Thumbs.db` |
| **Secrets** | `.env`, `.env.*`, `!.env.example`, `*.local`, `*.pem`, `*.key`, `vault/keyring.dat`, `vault/machine.key`, `*.bak`, `*-wal`, `*-shm`, `credentials/`, `*-credentials.json`, `diag*.zip` |
| Regenerable caches | `.cache/`, `audio-cache/`, `artifacts/` |
| ML heavy | `.venv/`, `models/*.onnx`, `ml/checkpoints/`, `ml/data/joda_raw/`, `.hf_cache/`, `__pycache__/`, `*.pyc` |
| Editor | `.vscode/*` + `!.vscode/extensions.json`, `.idea/` |
| Generated installer payload | `apps/desktop/src-tauri/sidecar/` |

Three entries carry real weight for §8:
`*.key` + `vault/machine.key` is the only thing keeping the vault key out of git;
`models/*.onnx` is why `git ls-files -- '*.onnx'` returns **0** rows even though
`models/silero-vad.onnx` (2,243,022 B), `models/laya-m7-int8.onnx` (308,050,615 B) and
`models/laya-m7.onnx` (1,228,429,195 B) are all present on this machine; and
`apps/desktop/src-tauri/sidecar/` is why `scripts/provision-sidecar.mjs` must be re-run after any
change under `src/`.

**Two tracked-file leaks against this denylist, measured:**
- `.env.local` is present on disk (392 B) and **not** matched by `.env` (which requires an exact
  name) — but it *is* matched by `*.local`. Confirmed untracked: it does not appear in
  `git ls-files` and does not appear in `git status --short`, so the rule is holding.
- `.venv/`, `.hf_cache/`, `artifacts/`, `audio-cache/`, `dist/`, `test-results/` all exist on disk
  and none appear in `git status --short`.

### 2.9 `.env.example` vs `.env.local` — **key names only, no values**

`.env.example` (465 B, tracked) declares **15** keys:
`OPENCODE_SERVER_PASSWORD`, `GROQ_API_KEYS`, `FISH_AUDIO_KEYS`, `OPENCODE_PORT`,
`OPENCODE_HOSTNAME`, `VOICE_DEFAULT`, `BRAIN_GOLDEN_MS`, `BRAIN_CEILING_MS`, `TTS_CACHE_SIZE`,
`LOG_LEVEL`, `CAPTURE_MODE`, `BRIEFINGS`, `QUIET_HOURS`, `MUTE_ON_CALL`, `MIC_DEFAULT`.

`.env.local` (392 B, untracked) declares **3** keys:
`GROQ_API_KEYS`, `FISH_AUDIO_KEYS`, **`OPENROUTER_API_KEYS`**.

Extracted with a regex that captures only the name and discards everything after `=`; no value
was read, printed or stored. The file contains 2 comment lines and no blank or unparsed lines.

**Two findings.**

1. **`OPENROUTER_API_KEYS` is undocumented in the example.** It is the only key `.env.local` holds
   that `.env.example` does not list, and it is a key the code reads —
   `src/cli.ts:125` `const openrouterCount = (process.env['OPENROUTER_API_KEYS'] ?? '').split(',')…`
   — and `src/voice/vault.ts:12` declares `KEY_POOLS = ['groq','fish','openrouter']`. The three
   example keys that *are* documented match `src/cli.ts:123-125`; the fourth key the code cares
   about is not in the template, so an operator following `.env.example` produces a vault that
   cannot authenticate the brain.
2. **11 of the 15 example keys are read nowhere.** Grepping `process.env[` across `src`, `apps`,
   `scripts` returns reads for only `GROQ_API_KEYS`, `FISH_AUDIO_KEYS`, `OPENROUTER_API_KEYS`,
   `OPENCODE_SERVER_PASSWORD`, `VOICE_IPC_PORT`, `VOXAURA_MACHINE_KEY`, `VOXAURA_TASK_QUEUE`,
   `VAD_MODEL_PATH`, `TTS_TRANSPORT`, `VOICE_RUNTIME_IPC_TOKEN`, `VOXAURA_OWNER_KEY`. The
   remaining example keys — `OPENCODE_PORT`, `OPENCODE_HOSTNAME`, `VOICE_DEFAULT`,
   `BRAIN_GOLDEN_MS`, `BRAIN_CEILING_MS`, `TTS_CACHE_SIZE`, `LOG_LEVEL`, `CAPTURE_MODE`,
   `BRIEFINGS`, `QUIET_HOURS`, `MUTE_ON_CALL`, `MIC_DEFAULT` — have **no** `process.env` read
   site in the tree. Note `OPENCODE_PORT` and `OPENCODE_HOSTNAME` are nevertheless hardcoded as
   `main.rs:44` `const OPENCODE_PORT: u16 = 4096;` and `main.rs:1434`
   `.args(["serve","--port",&OPENCODE_PORT.to_string(),"--hostname","127.0.0.1"])` — the port is
   a Rust constant, not an env var, so the documented knob is inert.

### 2.10 `.mcp.json` (2,201 B) and `opencode.json` (2,588 B)

Both are **this repository's own agent-harness configuration**, not product configuration — no
file under `src/` or `apps/desktop/src/` reads either.

`.mcp.json` declares six MCP servers, all `command: "npx"` with `-y`: `context7`
(`@upstash/context7-mcp`), `memory` (`@modelcontextprotocol/server-memory`), `filesystem`
(`@modelcontextprotocol/server-filesystem` with the **absolute** arg `O:/opencode-Vantrilex`),
`sequential-thinking`, `typescript-lsp` (`typescript-language-server --stdio`), and
`openrouter` (`openrouter-mcp`). It also carries a `harvestNotes` block with
`"registry": "O:/Claude Code/vantrilex/vantrilex-registry/VANTRILEX_CATALOG.md"` — a second
absolute path outside the repo — and counters (`provisionedSkills: 16`, `provisionedAgents: 7`,
`provisionedHooks: 4`, `provisionedPlugins: 5`). The absolute paths make the file
machine-specific: it cannot work on any checkout at a different path.

`opencode.json` sets `"model": "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"` and registers
three free OpenRouter model slugs. Its six MCP servers are all wrapped in
`["cmd","/c","npx","-y",…]` — a Windows-only command shape, hardcoded, with no platform branch.
It configures three LSPs (typescript via `typescript-language-server`, python via
`npx -y -p pyright pyright-langserver --stdio`, rust via bare `rust-analyzer`) and a `watcher.ignore`
list. The `model` field is the dev-session model for whoever edits this repo; it is unrelated to
the runtime model selection, which lives in TypeScript (§8.9).

### 2.11 `scripts/` inventory — 11 entries, intent derived from what the code does

`Get-ChildItem scripts -File` → 11 files. 10 are `.mjs`, 1 is `.ts` (`live_console_test.ts`), plus
`lint-baseline.json` (the 1-byte baseline integer). Note that `git ls-files` counts **10**
source-extension files here: `live_console_test.ts` is counted in the 10 and `lint-baseline.json`
is not a source extension.

| File | Bytes | What it actually does (from its code, not its name) |
|---|---|---|
| `docs-verify.mjs` | 35,146 | Reads `AGENTS.md` (`:472`) and `package.json` (`:475`) and the source tree; computes ~10 derived figures via functions `reachability()` (`:47`), `testReachability()` (`:167`), `personaRefCounts()` (`:241`), `earconFacts()` (`:263`), `knowledgeImportFacts()` (`:287`), `citedAnchors()` (`:346`), `countRustTests()` (`:154`), `countE2ETests()` (`:213`); runs the real test suites via `spawnSync('npx', ['vitest','run','--reporter=json',…])` (`:131-133`) and compares against the numbers *parsed out of the markdown*; emits pass/fail/UNVERIFIED per claim (`:34-38`). The `unverified` status exists as a first-class outcome, not a warning. |
| `docs-verify-self-test.mjs` | 3,321 | A separate module exporting `selfTestCitedAnchors(ROOT, citedAnchors)` (`:23`) that asserts the anchor-checker itself is not vacuous, by reading `AGENTS.md` and locating the first `import ` and first `//` line of `src/daemon.ts` (`:24-29`). Split out because a vitest test that shells out to `docs-verify.mjs` re-enters the whole suite. |
| `release-verify.mjs` | 12,838 | Seven ordered stages, declared as `const STAGES = ['gate','preflight','build','install','boot','assert','cleanup']` (`:48`), bisected by `--stage=` (`:46`) and skippable by `--skip-gate` (`:112`). Locates NSIS at two hardcoded paths (`:37-39`); reads `RUNTIME = join(process.env.USERPROFILE, '.opencode-voice-runtime')` (`:55`) and `installDir = join(process.env.LOCALAPPDATA,'Voxaura')` (`:108`); launches the installed exe detached (`:219` `spawn(exe, [], {detached:true, stdio:'ignore'})`); polls with `spawnSync('powershell.exe', …)` (`:76`) and always reaps. |
| `test-blindspots.mjs` | 5,947 | Walks `src` from `ROOT` (`:28`, `walk()` at `:30`) building a module graph and reporting which production modules no test file reaches. Prints a measurement; per its own header (`:4-6`) coverage thresholds are inert and this is a substitute instrument. |
| `lint-baseline.mjs` | 6,573 | Resolves `node_modules/.bin/oxlint[.cmd]` (`:41`), hard-refuses a global binary unless `VOXAURA_ALLOW_GLOBAL_OXLINT=1` (`:43`, `:47-59`), runs it through `cmd /c` on Windows (`:74-75`), counts warning lines by parsing diagnostics (`:82-105`), and compares against `BASELINE = 8` (`:13`) and `scripts/lint-baseline.json`. |
| `provision-sidecar.mjs` | 3,350 | Requires `dist/cli.js` to exist (`:24-27`), `rmSync`+recreates `apps/desktop/src-tauri/sidecar` (`:30-31`), copies `process.execPath` to `node.exe` (`:34-35`), copies `dist/` (`:39`), **writes its own `package.json` with a hardcoded 3-dependency manifest and `version: '0.8.2'`** (`:44-63`), runs `npm install --omit=dev --ignore-scripts` in that directory (`:65-69`), then shells out to `powershell` twice to print the payload listing and its total size (`:72-78`). This is the installer-payload builder and it is **not** driven by the root manifest. |
| `packaging-preflight.mjs` | 3,106 | Read-only readiness matrix (`// Packaging preflight … Read-only: reports a readiness matrix; does not build.` `:1-2`). Probes for `node`,`npm`,`rustc`,`cargo` via `where.exe` (`:10-17,31-34`), for an MSVC linker as `which('cl') ?? which('link')` (`:35-36`), for `makensis` on PATH or at `C:\Program Files (x86)\NSIS\makensis.exe` (`:37-38`), then 10 filesystem predicates (`:41-56`) and prints `N/rows.length checks pass` (`:67`). |
| `key-report.mjs` | 3,232 | Imports the **compiled** vault (`import { FileVault, decryptPool } from '../dist/voice/vault.js'`, `:13`) and emits, per provider in `['groq','fish','openrouter']` (`:16`), a byte length and a truncated SHA-256 fingerprint (`:18-20`) plus a storage-source line — never a value. Also parses `.env.local` (`:22-31`) for presence. Requires `npm run build` to have run. |
| `generate-whiteboard-assets.mjs` | 25,882 | Writes image files. `writeFileSync` from `node:fs` (`:5`) with a hardcoded colour palette object (`:10-12`), resolving the repo root from `import.meta.url` (`:9`). Contains a literal label list including `['TypeScript', '5.5 strict']` (`:321`) — a hardcoded string that says `5.5` while the resolved compiler is **5.9.3** (§2.2). |
| `live_console_test.ts` | 16,589 | A manual live-provider harness. `spawn`s the CLI (`:79`), resolves a binary from `process.env['OPENCODE_BIN']` else `join(process.env['APPDATA'], 'ai.opencode.desktop','cli')` (`:28-29`), reaps with `spawn('taskkill', ['/PID',…,'/T','/F'])` (`:110`), probes audio with `spawn('ffprobe', …)` (`:333`) and opens the result with
`spawn('powershell', ['-NoProfile','-Command', "Start-Process '<out>'"])` (`:344`). Not referenced by any `package.json` script — verified: no `live_console_test` string appears in `package.json:16-38`. |
| `lint-baseline.json` | 1 | The integer `8`. Consumed by `lint-baseline.mjs:16`. |

---

## 8. SECTION 08 — HARDWARE, OS & SYSTEM-LEVEL INTEGRATIONS

### 8.1 Native bindings — the complete set

**Exactly one first-party native binding is in use, and it is not loadable from an installed build.**

`onnxruntime-node@1.30.0` (`node_modules/onnxruntime-node/package.json`), `main: dist/index.js`,
`os: ["win32","darwin","linux"]`, deps `adm-zip ^0.6.0`, `global-agent ^4.1.3`,
`onnxruntime-common 1.30.0`, `postinstall: "node ./script/install"`.

The `.node` loader is `node_modules/onnxruntime-node/dist/binding.js`, whose entire resolution is
one line:

```js
exports.binding = require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`);
```

So the loaded binary on this host is
**`node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node` — 298,848 bytes
(0.285 MB), platform `win32`, arch `x64`, ABI `napi-v6`.** All five shipped bindings:

| Path (under `bin/napi-v6/`) | Bytes | MB |
|---|---|---|
| `win32/x64/onnxruntime_binding.node` | **298,848** | 0.285 |
| `win32/arm64/onnxruntime_binding.node` | 422,200 | 0.403 |
| `linux/x64/onnxruntime_binding.node` | 389,488 | 0.371 |
| `linux/arm64/onnxruntime_binding.node` | 394,648 | 0.376 |
| `darwin/arm64/onnxruntime_binding.node` | 266,840 | 0.254 |

Companion runtime libraries (the `.node` files are thin N-API shims; the engines are these):
`win32/x64/onnxruntime.dll` 28,754,232 B (27.4 MB), `win32/x64/DirectML.dll` 18,527,584 B,
`win32/x64/dxcompiler.dll` 17,986,360 B, `win32/x64/dxil.dll` 1,508,664 B;
`linux/x64/libonnxruntime.so.1` 45,828,512 B; `darwin/arm64/libonnxruntime.1.30.0.dylib`
44,589,928 B. **No `darwin/x64` build exists.** The win32/x64 payload alone is ~66 MB.

**Reachability, stated precisely.** The two static `import * as ort from 'onnxruntime-node'`
sites are `src/runtime/vad.ts:2` and `src/runtime/laya/laya-engine.ts:1`. Only the first is
reachable from a production entrypoint, and only through a *dynamic* edge:
`src/daemon.ts:1055` `vadLoad = import('./runtime/vad.js')`, whose `.catch(() => null)` at
`:1057` converts any resolution failure into `null`, which `makeVadGate(loadVad, isLoudWindow)`
at `daemon.ts:1062` treats as "use the RMS energy gate". Grepping all **non-test** `.ts`/`.mjs`
for `laya/loader` or `runtime/laya/index` returns zero code edges. The second static site is
therefore test-only.

**The binding is absent from the shipped payload** — see §2.3 finding B:
`scripts/provision-sidecar.mjs:57-61` omits it, `tauri.conf.json` `bundle.resources` is
`["sidecar/**/*"]`, and `models/*.onnx` is gitignored (§2.8). The on-disk models exist here
(`silero-vad.onnx` 2,243,022 B; `laya-m7-int8.onnx` 308,050,615 B; `laya-m7.onnx`
1,228,429,195 B) but `git ls-files -- '*.onnx'` = **0 rows**.

**No other native binding is used.** ABSENT — verified by
`Get-ChildItem -Recurse -File -Filter *.node node_modules\onnxruntime-node` (the only `.node`
files in the dependency graph are the five above) and by the fact that `src/policy/sidecar-safety.test.ts:45`
and `src/policy/laya-sidecar-safety.test.ts:28` both declare
`const NATIVE = new Set(['onnxruntime-node','better-sqlite3','node-gyp-build']);` — of those three,
only `onnxruntime-node` is present in any `package.json`; `better-sqlite3` and `node-gyp-build`
are **ABSENT** (verified: neither appears in `package.json:36-48` or in either lockfile's root
block). The `msgpackr` / `node-gyp-build-optional-packages` shims in `node_modules/.bin` (§2.4) are
residue, not load-bearing.

### 8.2 Every child-process spawn in the tree

`apps/desktop/src-tauri/src/main.rs` (production):
| Line | Shape |
|---|---|
| `main.rs:28` | `use std::process::{Child, Command, Stdio};` |
| `main.rs:258-259` | `Command::new("tasklist")` … `/FI … /NH /FO CSV` — enumerate `opencode-cli.exe` PIDs |
| `main.rs:314` | `cmd.spawn()` inside `spawn_and_wait_for_port`; on bind timeout `child.kill()` at `:321` |
| `main.rs:1144-1145` | `Command::new("tasklist")` — `process_alive(pid)` probe |
| `main.rs:1433-1447` | `Command::new(&bin)` + `.args(["serve","--port","4096","--hostname","127.0.0.1"])`, `.stdin(Stdio::null())`, stdout→`opencode.log`/stderr→`opencode-stdout.log`, `.env("OPENCODE_SERVER_PASSWORD", …)`. Spawned at `:1449` via `spawn_and_wait_for_port(…, Duration::from_secs(20))` |
| `main.rs:1529-1541` | `Command::new(&node)` — the daemon. `.stdin(Stdio::null())`, `.env("OPENCODE_SERVER_PASSWORD")`, `.env("VOICE_RUNTIME_IPC_TOKEN")`, `.env("VOXAURA_OWNER_KEY")`, `.env("VOXAURA_MACHINE_KEY")`, `.env("VOXAURA_VAULT_DIR", resolve_vault_dir(Some(&entry)))`, stdout/stderr→`daemon.log`/`daemon-stdout.log` |
| `main.rs:1697, 1735, 1751, 1779, 1964, 2062, 2083, 2217, 2239` | `Command::new("cmd")` — **all nine are inside `#[cfg(test)] mod tests`**, spawning a trivial `cmd` child to exercise the supervisor. Not production. |
| `main.rs:2254` | `Command::new("definitely-not-a-real-binary-9f3a")` — test-only, asserts the spawn-failure path reports rather than panics |
| `main.rs:2820` | `std::process::Command::new("icacls")` — **test helper** `icacls_reset(path)`, used to stage a pre-fix inheritable ACL |
| `main.rs:507` | `child.kill()` in `Supervisor::reap()` — kills and waits every tracked child |

`src/` (production):
| Line | Shape |
|---|---|
| `src/diag/bundle.ts:1` | `import { spawnSync } from 'node:child_process';` |
| `src/diag/bundle.ts:1056` | `spawnSync(process.execPath, [script, '--json'], { encoding:'utf8', timeout: 180_000, windowsHide: true })` — re-runs `scripts/docs-verify.mjs` as a child. Guarded by `existsSync(script)` at `:1041`, which degrades to `status:'skipped', informational:true` when the script is not in the payload |
| `src/voice/win-acl.ts:1` | `import { execFileSync } from 'node:child_process';` |
| `src/voice/win-acl.ts:71` | `execFileSync('icacls', ['/?'], { stdio:'ignore', windowsHide:true })` — inside `icaclsAvailable()`, which is documented at `:67` as "Exposed for the diagnostic below; not part of the product path." The only `icacls` invocation in production TypeScript, and it is a **help-text probe** (`/?`), not a permission change |
| `src/tasks/types.ts:147` | states the engine never imports `node:child_process` — the task executor is injected |

`scripts/`:
| Line | Shape |
|---|---|
| `scripts/docs-verify.mjs:133` | `spawnSync('npx', ['vitest','run','--reporter=json',…], { shell:true, maxBuffer: 64*1024*1024 })` |
| `scripts/lint-baseline.mjs:74-75` | `execFileSync('cmd', ['/c', target], …)` on win32, else `execFileSync(target, [])` |
| `scripts/packaging-preflight.mjs:12` | `execFileSync('where.exe', [cmd], …)` |
| `scripts/provision-sidecar.mjs:65` | `execFileSync('npm', ['install','--omit=dev','--ignore-scripts','--no-audit','--no-fund'], {cwd: sidecar, shell:true})` |
| `scripts/provision-sidecar.mjs:72, 76` | `execFileSync('powershell', ['-NoProfile','-Command', …])` — two reporting calls |
| `scripts/release-verify.mjs:61` | `spawnSync(cmd, cmdArgs, { shell:true, maxBuffer: 64*1024*1024, … })` — generic runner |
| `scripts/release-verify.mjs:76` | `spawnSync('powershell.exe', […])` — the port poller |
| `scripts/release-verify.mjs:219` | `spawn(exe, [], { detached:true, stdio:'ignore' })` — launches the installed app |
| `scripts/live_console_test.ts:79, 110, 333, 344` | `spawn(cli)`, `spawn('taskkill', ['/PID',…,'/T','/F'])`, `spawn('ffprobe', …)`, `spawn('powershell', […])` |

**Not a process spawn, despite the name:** `apps/desktop/src/settings/open-settings.ts:17`
`async function spawn({label,title,query})` is a local helper that either constructs a Tauri
`WebviewWindow` (`:20-36`, via a dynamic `import('@tauri-apps/api/webviewWindow')`) or calls
`window.open` (`:39`). It creates **no** OS process. A grep for `child_process` in that file
returns 0 matches.

### 8.3 Filesystem path resolution — every one, with its controlling variable

| Resolved path | Controlled by | Code |
|---|---|---|
| **Runtime state dir** `%USERPROFILE%\.opencode-voice-runtime\` | `VOICE_RUNTIME_DIR` override, else `USERPROFILE`, else `HOME` | `main.rs:514-528` — `runtime_dir()`; `:519` `env::var_os("VOICE_RUNTIME_DIR")`, `:524` `env::var_os("USERPROFILE").or_else(|| env::var_os("HOME"))`, `:526` `path.push(".opencode-voice-runtime")` |
| `…\ipc.token` | derived | `main.rs:571-573` `token_path()` |
| `…\serve.pass` | derived | via `ensure_serve_password()` `main.rs:956` |
| `…\owner.key` | `VOXAURA_OWNER_KEY` (hex, supplied by the supervisor) else file | `main.rs:1027-1028` `ensure_owner_key()`, `:1028` `env::var("VOXAURA_OWNER_KEY")`, `:1006` `owner_file_path()` |
| `…\daemon.owner` (marker) | derived | `main.rs:1006-1024` region; replaced in place, never renamed (`:1025`) |
| `…\machine.key` | `VOXAURA_MACHINE_KEY` (hex → 32 B) | `main.rs:856` `ensure_machine_key()`; on the Node side `src/voice/vault.ts:46` reads `process.env['VOXAURA_MACHINE_KEY']`, `:49` requires `byteLength === 32` or throws `VAULT_CORRUPT`, and `:60` falls back to `join(homedir(), '.opencode-voice-runtime', 'machine.key')` — i.e. the **Node fallback hardcodes the same path and ignores `VOICE_RUNTIME_DIR`**, so a test that sets `VOICE_RUNTIME_DIR` redirects the Rust side but not this one |
| `…\supervisor.log` | derived | `main.rs:547-561` `log_line()`, `:550` `dir.join("supervisor.log")`; **compiled out under `cfg(test)`** (`:546`, with the no-op twin at `:568-569`) |
| `…\opencode.log` / `opencode-stdout.log` | derived | `main.rs:1440-1445` via `open_child_stdout/stderr(&dir, "opencode")` (`:208-213`), which append via `open_append` (`:201`) |
| `…\daemon.log` / `daemon-stdout.log` | derived | `main.rs:1549-1557`, same helpers, stem `"daemon"` |
| **Vault root** | `VOXAURA_VAULT_DIR` → ancestor `vault/` → `%LOCALAPPDATA%\Voxaura\vault` | `main.rs:1313-1386` `resolve_vault_dir()`: `:1314` `env::var("VOXAURA_VAULT_DIR")`; `:1321-1331` walk ancestors for a `vault` dir; `:1332` `env::var_os("LOCALAPPDATA")` with `.or_else(runtime_dir)` then `.unwrap_or(PathBuf::from("."))`; `:1336` `base.join("Voxaura").join("vault")`; `:1340` `create_dir_all`; `:1342-1356` first-run seed by `fs::copy` of an ancestor `vault/keyring.dat`, never overwriting; `:1373-1377` `restrict_to_owner(&keyring)` with a `log_line` WARN on failure rather than a hard error |
| Memory-graph root (Node) | `VOXAURA_VAULT_DIR` else `<cwd>/vault` | `src/memory/vault.ts:19-27` `resolveVaultRoot()`; `:23` reads `env['VOXAURA_VAULT_DIR']`. Called at `src/cli.ts:261` for the operator commands only |
| **Daemon entrypoint** | `VOXAURA_DAEMON_PATH` → `resource_dir/sidecar/dist/cli.js` → `<ancestor>/dist/cli.js` | `main.rs:1263-1294`: `:1264` `env::var("VOXAURA_DAEMON_PATH")`; `:1271` bundled; `:1276-1292` walk `current_dir` then every ancestor of `current_exe()` |
| **Node binary** | `VOXAURA_NODE_BIN` → `resource_dir/sidecar/node.exe` → `"node"` on PATH | `main.rs:1389-1402` `resolve_node_bin()` |
| **opencode binary** | `VOXAURA_OPENCODE_BIN` | `main.rs:1216-1217` `resolve_opencode_bin()`, `:1217` `env::var("VOXAURA_OPENCODE_BIN")` |
| **IPC bearer** | `VOICE_RUNTIME_IPC_TOKEN` else generated file | `main.rs:927` `env::var("VOICE_RUNTIME_IPC_TOKEN")` in `ensure_ipc_token()`; injected into the daemon at `:1534` |
| **serve password** | `OPENCODE_SERVER_PASSWORD` else generated file | `main.rs:957` `env::var("OPENCODE_SERVER_PASSWORD")`; injected into both children (`:1447`, `:1533`) |
| **Windows `\\?\` stripping** | — | `main.rs:1299-1305` `plain_path()` strips `\\?\UNC\` → `\\` and `\\?\` → ``, applied at `:1398` before handing a path to the Node child. Necessary because Rust's `resource_dir` returns extended-length paths that Node's resolver rejects |
| **Temp dir** | `std::env::temp_dir()` (`%TEMP%`) | `main.rs:1647-1656` `temp_dir(tag)` — **inside `#[cfg(test)] mod tests`** (`:1645` `use super::*;`), building `%TEMP%\voxaura-phase2-{tag}-{pid}-{nanos}`. Also `main.rs:2356`, `:2838` (`%TEMP%\voxaura-mkey-test`), `:2897` (`%TEMP%\voxaura-mkey-bad`) — all test-only. **No production temp path exists** |
| Audio blob cache | injected `cfg.dir` | `src/voice/cache.ts:81` `mkdir(this.cfg.dir, {recursive:true})`, `:83` `join(this.cfg.dir, `${key}.mp3`)` — caller-supplied, no env var of its own |
| `release-verify` install dir | `%LOCALAPPDATA%\Voxaura` | `scripts/release-verify.mjs:108` |
| `release-verify` runtime dir | `%USERPROFILE%\.opencode-voice-runtime` | `scripts/release-verify.mjs:55` |
| `live_console_test` fallback CLI | `%APPDATA%\ai.opencode.desktop\cli` | `scripts/live_console_test.ts:29` |

### 8.4 Windows API inventory in `main.rs` — searched by syscall name

Every Windows-specific call, by line. The `windows-sys = "0.61"` import surface is declared at
`Cargo.toml:33-39`; the four features that actually appear in code are
`Win32_Foundation`, `Win32_Security`, `Win32_Security_Authorization`,
`Win32_System_JobObjects` (`Win32_System_Threading` is declared and used only in the test at
`:3136`).

**Job Objects — `main.rs:34-130` (the `KillOnCloseJob` type) and `main.rs:380-512` (the supervisor).**

| Line | Call / symbol |
|---|---|
| `main.rs:35` | `use std::os::windows::io::AsRawHandle;` (cfg-gated) |
| `main.rs:37` | `use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};` |
| `main.rs:39-42` | `use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};` |
| `main.rs:52` | `struct KillOnCloseJob(HANDLE);` — `#[cfg(windows)]`; handles are deliberately **not** RAII-wrapped and never closed, so the job outlives every child and process teardown is the kill trigger (`:47-50`) |
| `main.rs:55, 57` | `unsafe impl Send` / `unsafe impl Sync` for `KillOnCloseJob` |
| `main.rs:63` | **`CreateJobObjectW(std::ptr::null(), std::ptr::null())`** — `None` on null handle (`:64-66`) |
| `main.rs:67-68` | `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` zeroed; `info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;` |
| `main.rs:69-74` | **`SetInformationJobObject(job, JobObjectExtendedLimitInformation, …, size_of::<…>() as u32)`** — on `ok == 0`, `CloseHandle(job)` at `:76` and `None` |
| `main.rs:85-89` | `adopt(&self, child) -> bool` → `AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) != 0` (`:88`). Returns a BOOL the caller must act on (`:83-84`, `adoption_action` at `:143`) |
| `main.rs:394` | `Supervisor::job() -> Option<&KillOnCloseJob>` |
| `main.rs:403` | `Supervisor::own(&self, child: Child) -> bool` |
| `main.rs:435` | `Supervisor::own_with_adoption(&self, child, outcome) -> bool` |
| `main.rs:474` | `Supervisor::with_unavailable_job() -> Self` — the test-only "job creation failed" state |
| `main.rs:504-511` | `Supervisor::reap()` — `child.kill()` (`:507`) then `child.wait()` (`:508`) for every tracked child |
| `main.rs:1627` | the user-facing string `"ensure_all_services: CreateJobObjectW failed — {} child(ren) were unsupervisable and every future child will be too"` |

**ACL / DACL — `main.rs:633-855` (`restrict_to_owner`, dual-platform) plus the token/CSPRNG path
at `main.rs:575-631`.**

| Line | Call / symbol |
|---|---|
| `main.rs:576` | `const SECRET_BYTES: usize = 32;` |
| `main.rs:594-598` | `secure_random_bytes<const N>() -> Result<[u8;N], String>` → `getrandom::fill(&mut buf)` (`:596`), `.map_err(\|e\| format!("csprng: {e}"))` (`:596`). **No fallback path** — a failure is an `Err`, never a weaker generator |
| `main.rs:601-604` | `generate_secret()` → 32 bytes hex-encoded (64 chars) |
| `main.rs:619-631` | `write_protected_secret(path, secret, label)`: `fs::write` (`:620`) **then** `restrict_to_owner` (`:623`), and on ACL failure `fs::remove_file(path)` (`:627`) and propagate — fail-closed, because the next launch's `read_to_string` fast path would otherwise adopt the weak file as permanent (`:624-626`) |
| `main.rs:661-818` | **`#[cfg(windows)] fn restrict_to_owner(path) -> Result<(), String>`** |
| `main.rs:663` | `use std::os::windows::ffi::OsStrExt;` (for `OsStr::encode_wide`) |
| `main.rs:664` | `use windows_sys::Win32::Foundation::{GetLastError, LocalFree, GENERIC_ALL};` |
| `main.rs:665-668` | `use windows_sys::Win32::Security::Authorization::{SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, SE_FILE_OBJECT, SET_ACCESS, TRUSTEE_W, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_IS_WELL_KNOWN_GROUP};` |
| `main.rs:669-672` | `use windows_sys::Win32::Security::{CreateWellKnownSid, DACL_SECURITY_INFORMATION, GetFileSecurityW, WinLocalSystemSid, NO_INHERITANCE, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, …}` |
| `main.rs:705, 724` | `GetLastError()` — owner-size query and owner read |
| `main.rs:742-749` | **`CreateWellKnownSid(WinLocalSystemSid, …)`** → `Err("acl: CreateWellKnownSid failed ({GetLastError()})")` on failure |
| `main.rs:789-796` | **`SetEntriesInAclW(…)`** — called with a **NULL `oldacl`** so the DACL is built only from the named trustees; `Err("acl: SetEntriesInAclW failed ({code})")` at `:796` |
| `main.rs:800-811` | **`SetNamedSecurityInfoW(…, DACL_SECURITY_INFORMATION \| PROTECTED_DACL_SECURITY_INFORMATION, …)`** — the `PROTECTED_DACL_SECURITY_INFORMATION` flag is the load-bearing bit: it sets `SE_DACL_PROTECTED` and blocks inheritance from the parent. `LocalFree(acl as _)` at `:809`, then `Err("acl: SetNamedSecurityInfoW failed ({code})")` at `:811` |
| `main.rs:819-855` | **`#[cfg(not(windows))] fn restrict_to_owner(path)`** → `fs::set_permissions(path, fs::Permissions::from_mode(0o600))` (`:821`), the POSIX equivalent |
| `main.rs:907-925` | `restrict_vault_file() -> Result<bool, String>` — the Tauri command that re-applies the DACL to `keyring.dat` |
| `main.rs:3095` | test helper `wide(p) -> Vec<u16>` (UTF-16 path for the raw Win32 calls) |
| `main.rs:3100-3101` | test helper `last_error() -> u32` → `GetLastError()` |
| `main.rs:3111-3127` | test helper `well_known_system_sid()` → `CreateWellKnownSid(WinLocalSystemSid, …)` (`:3116`) |
| `main.rs:3133-3163` | test helper `process_user_sid()` → `OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)` (`:3140`), then `GetTokenInformation(token, TokenUser, null, 0, &mut needed)` (`:3145`) to size, then the real `GetTokenInformation` (`:3154`), `CloseHandle(token)` (`:3161`), returning `(*(buf.as_ptr() as *const TOKEN_USER)).User.Sid` (`:3163`) |
| `main.rs:2772-2806` | test helper `dacl_is_protected(path) -> bool` — uses `GetFileSecurityW` to read back `SE_DACL_PROTECTED` |
| `main.rs:2819-2831` | test helper `icacls_reset(path)` → `Command::new("icacls")` (`:2820`), to stage a pre-fix inheritable ACL |

**Three Windows APIs that are ABSENT** — the searches and their empty results:

1. **`CreateProcessW` / `CreateProcessA` — ABSENT.** Verified by
   `Select-String -Path 'apps\desktop\src-tauri\src\main.rs' -Pattern 'CreateProcess'` →
   `0 matches for 'CreateProcess' in main.rs`. Process creation goes through
   `std::process::Command`, which calls `CreateProcessW` inside the standard library, not
   explicitly.
2. **Named pipes — ABSENT.** Verified by
   `Select-String -Path '…main.rs' -Pattern 'NamedPipe|CreatePipe|\\\\.\\pipe'` → `0 matches`.
   All supervisor↔daemon and shell↔daemon communication is TCP/WebSocket on loopback, never a
   pipe.
3. **`SHGetKnownFolderPath` / `GetUserNameW` / `KnownFolder` — ABSENT.** Verified by
   `Select-String -Path '…main.rs' -Pattern 'SHGetKnownFolderPath|GetUserNameW|KnownFolder'` →
   `0 matches`. The only known-folder resolution is Tauri-mediated:
   `main.rs:1518` `app.path().resource_dir().ok()`. The `%LOCALAPPDATA%` path at `main.rs:1332`
   is read straight out of the environment with no API call.

**`process_alive` is implemented by shelling out, not by an API** — `main.rs:1144-1145`
`Command::new("tasklist")`, and `main.rs:258-259` likewise, with a CSV parse. The reason is
recorded in the tree at `main.rs:1139` (`tasklist` by PID, no extra crate). `main.rs:1944-1960`
documents that `tasklist /FI "PID eq 0" /NH /FO CSV` reports **System Idle Process as pid 0**,
which is why `main.rs:1123-1125` `if parsed.pid == 0 { return DaemonHolder::Foreign { reason: "daemon.owner names pid 0" } }`
inside `holder_from_probe` (`main.rs:1083-1135`) treats pid 0 as foreign before `process_alive` is
ever consulted. The ordering inside `holder_from_probe` is itself the identity contract: port
open (`:1089`) → marker present (`:1092`) → marker parses (`:1098`) → version matches (`:1106`)
→ **owner key matches (`:1117`)** → pid non-zero (`:1123`) → pid alive (`:1126`) → `Ours`
(`:1134`). Anything short of all seven is `Foreign` with a named reason, never an adoption.

### 8.5 Tauri commands, `setup()` and the exit path

**Exactly three commands are registered** — `main.rs:3259-3263`:
`tauri::generate_handler![ ipc_token, ensure_all_services, restrict_vault_file ]`
(backed by `main.rs:1185` `ipc_token`, `main.rs:1595` `ensure_all_services`, `main.rs:907`
`restrict_vault_file`). No fourth command is registered. `main.rs:3258` `.manage(Supervisor::default())`
installs the single managed state.

**`setup()` — `main.rs:3264-3280`.** Calls `ensure_ipc_token()` **synchronously** at `:3269`
(so the file exists before the webview loads, `:3265-3268`), logs and continues on error
(`:3270-3271`), then moves bring-up off the UI thread: `std::thread::spawn(move || { let _ =
ensure_all_services(handle); })` at `main.rs:3276-3278`.

**Exit / teardown — `main.rs:3284-3288`:**
```rust
app.run(|app_handle, event| {
    if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
        app_handle.state::<Supervisor>().reap();
    }
});
```
So teardown is triggered by exactly two Tauri run events, `ExitRequested` and `Exit`, and the
handler's entire body is `Supervisor::reap()` (`main.rs:504-511`). There is **no** `SIGINT` or
`SIGTERM` handler in Rust — verified by grepping `main.rs` for
`SIGINT|SIGTERM|SIGBREAK|ctrl_c|on_window_event|onCloseRequested` → no hits. The Rust process
relies on the Job Object for force-kill (`KILL_ON_JOB_CLOSE`) and on Tauri run events for
graceful teardown.

**The signal handlers live on the Node side instead:**
`src/cli.ts:235-239`
```ts
await new Promise<void>((resolve) => {
  const stop = (): void => resolve();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
});
```
followed by `await daemon.stop();` at `src/cli.ts:240` and `return 0;` at `:241`. This is the
**only** signal registration in the entire repository: grepping
`SIGINT|SIGTERM|SIGBREAK` across `src`, `apps`, `scripts` returns exactly those two lines plus
nothing else. Four other `process.on(...)` calls exist and are unrelated —
`src/runtime/vad-gate.test.ts:89`, `:185`, `src/tasks/timeout.test.ts:192` and
`apps/desktop/src/audio/playback-f01.test.ts:21` all register `unhandledRejection` in tests.

**No `process.on('exit')` handler exists.** ABSENT — verified by the same grep: `\.on\('exit'`
matches only `scripts/live_console_test.ts:338` `probe.on('exit', …)`, which is an
`ffprobe` child process, not a Node exit hook. The implication is concrete: the Node daemon's
teardown is reached by SIGINT/SIGTERM only, so a `SIGKILL` or a Task Manager stop of `node.exe`
runs no cleanup, and the kernel-side backstop is the Job Object that only the Rust supervisor holds.

### 8.6 Ports and loopback binding

Two constants, both `u16`, both hardcoded in Rust — `main.rs:44` `const OPENCODE_PORT: u16 = 4096;`
and `main.rs:45` `const DAEMON_PORT: u16 = 4097;`. They are not env-configurable
(§2.9 finding 2: `OPENCODE_PORT` and `OPENCODE_HOSTNAME` appear in `.env.example` but are read
nowhere). `main.rs:1434` passes `--port 4096 --hostname 127.0.0.1` to `opencode serve`.
`main.rs:1198` `port_open(port)` and `main.rs:1203` `wait_for_port(port, budget)` are the probes.

On the desktop side, `apps/desktop/vite.config.ts` sets `server: { port: 1420, strictPort: true }`
and `tauri.conf.json` `build.devUrl` is `http://localhost:1420`. The webview is bound to the
daemon by `connect-src 'self' ws://127.0.0.1:4097` inside the `tauri.conf.json` CSP string.

### 8.7 Windowing, packaging and platform assumptions

`tauri.conf.json`: `productName "Voxaura"`, `version "0.8.2"`, `identifier "com.voxaura.app"`;
`bundle.targets: ["nsis","appimage"]`; `bundle.resources: ["sidecar/**/*"]`; five icon files
including `icons/icon.icns` (a macOS icon, inert on a Windows-first build).
The single window is `440×600`, `resizable: true`, `minWidth 440`, `minHeight 600`,
**`maximizable: false`**, `decorations: false`, `transparent: true`, `shadow: true`.
`app.security.csp` is a single string:
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:4097; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`.

**Renderer build flags** — `apps/desktop/vite.config.ts`: `plugins: [react()]`,
`clearScreen: false`, `envPrefix: 'VOICE_'` (which is what exposes `VOICE_RUNTIME_IPC_TOKEN` to
the bundle), `server.port 1420` + `strictPort: true`, `build.target: 'es2022'`.

**Hardcoded Windows assumptions, enumerated.** Every one is a literal in source, not a
platform branch:
- `scripts/provision-sidecar.mjs:35` copies `process.execPath` to a file named **`node.exe`**.
- `scripts/provision-sidecar.mjs:72, 76` and `scripts/live_console_test.ts:344` invoke
  **`powershell`** by name.
- `scripts/packaging-preflight.mjs:12` invokes **`where.exe`**; `:37-38` probes
  **`C:\Program Files (x86)\NSIS\makensis.exe`**.
- `scripts/release-verify.mjs:37-39` hardcodes two NSIS paths; `:76` uses **`powershell.exe`**.
- `scripts/lint-baseline.mjs:41, 74` branches on `process.platform === 'win32'` for
  `oxlint.cmd` and `cmd /c`.
- `scripts/live_console_test.ts:110` uses **`taskkill /PID … /T /F`**.
- `opencode.json` wraps all six MCP servers and two of three LSPs in **`["cmd","/c","npx",…]`**.
- `.mcp.json` embeds the absolute path `O:/opencode-Vantrilex` in two places.
- `tauri.conf.json` `bundle.targets` leads with `nsis`.

The `#[cfg(windows)]` / `#[cfg(not(windows))]` split in `main.rs` is the *only* genuine
cross-platform abstraction, and it exists for exactly two subsystems: the Job Object
(`main.rs:51`, `:59`, `:34`) and `restrict_to_owner` (`main.rs:661` / `main.rs:819`).

### 8.8 Audio capture/playback device integration (renderer side)

No native binding and no OS audio API: the renderer uses browser primitives only.
`apps/desktop/src/audio/*` and the WebAudio pipeline imply 16 kHz capture, an `AudioWorklet`
with a `ScriptProcessor` fallback, and FIFO playback. The desktop tests run under
`happy-dom` (`apps/desktop/vitest.config.ts` `environment: 'happy-dom'`), so **no desktop test
touches a real audio device** — the device surface is unverified by the gate. This is stated
from the config and test-environment selection, not from any comment.

### 8.9 Where the model/provider configuration actually lives

Stated here because it is a system-level integration and because it is where a config file could
plausibly be expected to be load-bearing and is not. `opencode.json` (§2.10) is the *editor's*
model setting. The runtime model constants are TypeScript source: `src/voice/stt.ts:1-5`
(`groq-sdk`, Groq Whisper), `src/voice/brain.ts:1` (`zod` at the boundary). Verified: no file
under `src/` or `apps/desktop/src/` reads `opencode.json` or `.mcp.json`.

---

## DISAGREEMENTS WITH THE BRIEFING NOTE (file wins, note loses)

| # | Briefing claim | Physical file says | Evidence |
|---|---|---|---|
| 1 | `go.mod`, `pyproject.toml`, root `Cargo.toml` do not exist | **CONFIRMED** | `Test-Path` on all five: all `ABSENT`. The single Rust manifest is `apps/desktop/src-tauri/Cargo.toml`. |
| 2 | `main.rs` is a single 143,826-byte file | **CONFIRMED, plus a line count** | `Get-Item` = 143,826 B; `Get-Content … \| Measure-Object -Line` = **3,289 lines**. |
| 3 | 12,338 `.py` files, **every one inside `.venv`** | **BOTH NUMBERS WRONG** | **12,339** on disk, **22** outside `.venv`, of which **18 are git-tracked project source** under `ml/`. A raw `find -name '*.py'` would suggest a large Python subsystem — and it is **real**, not virtualenv noise. `pyrightconfig.json` includes `["ml"]`. |
| 4 | 279 project source files: `src` 157, `apps` 110, `scripts` 10, `ml` 1, `vitest.config.ts` 1 | **COUNT WRONG, one SUB-COUNT WRONG** | Tracked `.ts/.tsx/.rs/.mjs` = **319**, not 279. `src` = **155** tracked (not 157); 163 on disk (155 + 8 untracked `src/cli/`). The missing 40 are the **42 tracked source files under `.opencode/_archive/dead-code-phase1/`** — all 42 sit in that single quarantine directory. (Counting *all* extensions under `.opencode/`, not just the four source ones, the directory holds 45 files in `_archive/dead-code-phase1/` and 32 in `_archive/catalog-stubs/`, plus `skills/`, `plugins/` and `agents/` assets.) The note's other per-directory figures are right: `apps` 110 ✓, `scripts` 10 ✓, `ml` 1 ✓, `vitest.config.ts` 1 ✓. |
| 5 | 643 tracked files, HEAD `9f41c96`, 371 commits | **CONFIRMED** | `git ls-files \| Measure-Object -Line` = 643; `git rev-parse --short HEAD` = `9f41c96`; `git rev-list --count HEAD` = 371. |
| 6 | Runtime deps `groq-sdk ^0.9.0`, `lru-cache ^11.0.0`, `onnxruntime-node 1.30.0`, `zod ^3.23.0`; dev `@types/node ^22`, `eslint ^9`, `typescript ^5.5`, `typescript-eslint ^8.70`, `vitest 4.1.11`, `oxlint 1.85.0`, `vite ^7.1` | **CONFIRMED as declared ranges** | `package.json:36-48` matches exactly. But the **resolved** versions are `typescript 5.9.3` (four minors above the stated `^5.5` floor) and `vite 7.3.6`, `zod 3.25.76`, `lru-cache 11.5.3`, `eslint 9.39.5` (§2.2) — the ranges are not what is installed. |
| 7 | Both lockfiles exist and disagree in age | **CONFIRMED, and stronger than stated** | `package-lock.json` 134,330 B (2026-09-30, `5c42bed`) vs `pnpm-lock.yaml` 81,619 B (2026-09-22, `443e1bc`). npm is authoritative — four independent proofs in §2.5. The pnpm lock is not merely older, it describes a **different graph**: it has `@opencode/client`, `eventsource`, `pino` (none in `package.json`) and lacks `oxlint`, `vite`. |
| 8 | `tsconfig.json` `include: ["src/**/*.ts"]`, `exclude: [… "**/*.test.ts"]`, `module=NodeNext`, `target=ES2023`, strict incl. `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | **CONFIRMED verbatim** | `tsconfig.json:1-21`. Consequences of the `exclude` are stated in §2.6, including that `src/cli.ts:25` imports a **non-existent-in-git** `./cli/commands.js`. |
| 9 | "Four registered Tauri commands" incl. `shutdown_all_services` | **CONTRADICTED — only three** | `main.rs:3259-3263` `generate_handler![ipc_token, ensure_all_services, restrict_vault_file]`. `shutdown_all_services` is not a function in `main.rs` (the full `fn` listing at `main.rs:3256` upward contains no such symbol). |
| 10 | "11 lockfile-relevant `.node` binary … find its `.node` binary, its platform/arch, and its size" | **CONFIRMED and specified** | `win32/x64/onnxruntime_binding.node`, **298,848 B**, resolved at load time by `binding.js`'s single templated `require`. Five bindings total; no `darwin/x64`. |
| 11 | Implied that `zod` is shared with the renderer | **CONTRADICTED** | `apps/desktop/node_modules\zod` is **NOT INSTALLED**; `apps/desktop/tsconfig.json` sets `types: ["vite/client"]` and the renderer re-declares the frame shapes rather than importing `src/ipc/protocol.ts` (`ws.ts:113`, `TerminalDrawer.tsx:172`, `serve-health-signal.ts:74`). |
| 12 | Implied a single-package-manager repo | **CONTRADICTED** | Two package manifests with two lockfiles: root `package.json`/`package-lock.json` **and** `apps/desktop/package.json`/`apps/desktop/package-lock.json` (92,078 B install state, separate `node_modules`). `react`, `tailwindcss`, `@tauri-apps/*` are absent from the root. |

## ABSENCES, each with the exact command that proved it

| Absent thing | Command run | Result |
|---|---|---|
| `go.mod` | `Test-Path go.mod` | `ABSENT` |
| `pyproject.toml` | `Test-Path pyproject.toml` | `ABSENT` |
| root `Cargo.toml` | `Test-Path Cargo.toml` | `ABSENT` |
| `setup.py` / `requirements.txt` | `Test-Path` each | `ABSENT` |
| `CreateProcessW` in Rust | `Select-String -Path '…main.rs' -Pattern 'CreateProcess'` | `0 matches for 'CreateProcess' in main.rs` |
| Named pipes | `Select-String -Path '…main.rs' -Pattern 'NamedPipe\|CreatePipe\|\\\\.\\pipe'` | `0 matches` |
| `SHGetKnownFolderPath` / `GetUserNameW` | `Select-String -Path '…main.rs' -Pattern 'SHGetKnownFolderPath\|GetUserNameW\|KnownFolder'` | `0 matches` |
| `process.on('exit')` in the daemon | `Select-String` over `src`,`apps`,`scripts` for `SIGINT\|SIGTERM\|SIGBREAK\|\.on\('exit'` | only `src/cli.ts:237-238` (SIGINT/SIGTERM) and `scripts/live_console_test.ts:338` (a child-process `exit` event) |
| root `node_modules\react` | `Test-Path node_modules\react\package.json` | `NOT-INSTALLED` |
| `apps/desktop/node_modules\zod` | `Test-Path apps\desktop\node_modules\zod\package.json` | `NOT-INSTALLED` |
| `@vitest/coverage-v8` | `Test-Path node_modules\@vitest\coverage-v8\package.json` | `NOT-INSTALLED` |
| `node_modules\.modules.yaml` (pnpm install state) | `Test-Path 'node_modules\.modules.yaml'` | `ABSENT` |
| `src/desktop/` contents | `Get-ChildItem -Recurse src\desktop` | empty; `git ls-files -- 'src/desktop/*'` = 0 |
| `test/` and `bench/` directories | referenced by `vitest.config.ts` `include`; `Get-ChildItem test`, `Get-ChildItem bench` | neither exists — 2 of 3 root globs match nothing |
| git-tracked ONNX models | `git ls-files -- '*.onnx' \| Measure-Object -Line` | `0` |
| ESLint type-aware rules | `Select-String` on `eslint.config.js` for `project\|parserOptions\|strictTypeChecked` | `0 matches` |
| `.oxlintrc.json` rule config | `node -e "Object.keys(require('./.oxlintrc.json')).join(',')"` | `$schema,plugins,ignorePatterns` — no `rules`, no `categories` |
| `pnpm` invoked anywhere | every `package.json` script + `provision-sidecar.mjs:65` | `npm` only; `0` pnpm invocations |
| docs opened by this audit | — | **NONE**: no file under `docs/`, and not `README.md`, `README.ar.md`, `CHANGELOG.md`, `AGENTS.md`, `CONTRIBUTING.md`. `dossier/PROJECT_MASTER_DOSSIER.md` (74,552 B) was **not read**. The seven other files in `dossier/` were likewise not read. |
