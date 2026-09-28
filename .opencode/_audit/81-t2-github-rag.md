# Track 2 — External RAG / Indexing candidates for Voxaura

**Author:** research swarm Track 2. **Status:** PURE RESEARCH — no code modified, nothing committed.
**Observation date for every star count / version / size below: 2026-09-28.**
**Host used for measurements:** Windows, `node v25.0.0`, scratch dir `%LOCALAPPDATA%\Temp\opencode\t2-retriever-bench`.

## Method and honesty rules applied

Every row below was fetched, not recalled:

- Existence, stars, license, archive status, last push → `api.github.com/repos/{owner}/{repo}` and `api.github.com/repos/{owner}/{repo}/commits?per_page=1`.
- Install name, latest version, `dependencies`, `optionalDependencies`, `scripts`, `unpackedSize`, `fileCount` → `registry.npmjs.org/{name}`.
- Minzipped size → `bundlephobia.com/api/size` (gzip + minified + `dependencyCount`).
- Per-file sizes for WASM/grammar payloads → `data.jsdelivr.com/v1/packages/npm/{pkg}@{ver}`.
- Ranking/latency claims → actually executed against Voxaura's own compiled `dist/knowledge/` corpus with `minisearch@7.2.0` and `flexsearch@0.8.212` installed into a temp dir, and compared against `InMemoryRetriever` from `dist/knowledge/retriever.js`.

Anything I could not fetch is in **COULD NOT VERIFY** at the end, with what I tried. There are two such entries; both are listed as 404s from the API, not guessed at.

## The bar to beat — measured, on this machine, today

Before any candidate can be recommended it has to beat this. Measured by running the shipped compiled retriever over the real Tier-1 corpus (`ARCHITECTURE_CHUNKS + CAPABILITIES_CHUNKS + COMMAND_CHUNKS + FAILURE_CHUNKS + LEXICON_CHUNKS`):

| Metric | Measured |
|---|---|
| Tier-1 chunk count | **43** (not "~200" — the brief overestimated by 5x) |
| Corpus size | 10,715 chars / **12,761 UTF-8 bytes** |
| Index build (cold) | 3.7 – 5.9 ms |
| Search p50 | **0.0042 ms** (4.2 microseconds) |
| Search p95 | 0.0102 ms |
| Search p99 | **0.0128 ms** |
| Search p99.9 | 0.119 ms |
| Search max (50k iterations) | 0.462 ms |
| Process RSS with index resident | 61 MB (whole Node process, not just the retriever) |
| Latency as % of the 10 ms budget (p99) | **0.128 %** |

**This is the single most important number in the report.** The retrieval target is met with ~780x headroom. There is no latency problem. Anything proposed for latency reasons is proposing to solve a problem that does not exist.

Two of my ten labelled spot-check queries return zero hits (`إيش سويت`, `٤٠٩٦` alone). Both are **corpus coverage gaps, not retrieval failures** — the chunks simply do not exist yet. That is a `capabilities.ts` writing task, not a search-algorithm task, and no library in this report fixes it.

---

## AREA A — AST-aware code indexing via tree-sitter

| Name | URL (fetched) | Stars (2026-09-28) | License | Zero-deps | Native | Footprint | Verdict |
|---|---|---|---|---|---|---|---|
| tree-sitter (core) | https://github.com/tree-sitter/tree-sitter | 27,070 | MIT | Y | **Y** (Rust) | n/a (core lib) | see note |
| tree-sitter-typescript | https://github.com/tree-sitter/tree-sitter-typescript | 532 | MIT | N | **Y** | npm `tree-sitter-typescript@0.23.2` = **37,934 KB unpacked** | REJECT |
| tree-sitter-rust | https://github.com/tree-sitter/tree-sitter-rust | 532 | MIT | N | **Y** | npm `tree-sitter-rust@0.24.0` = **14,696 KB unpacked** | REJECT |
| node-tree-sitter (Node bindings) | https://github.com/tree-sitter/node-tree-sitter (via npm `tree-sitter`) | — | MIT | N | **Y** | `tree-sitter@0.25.1` = 4,350 KB unpacked, deps `node-addon-api` + `node-gyp-build`, `install: node-gyp-build` | REJECT |
| **web-tree-sitter** (WASM bindings) | https://github.com/tree-sitter/tree-sitter | 27,070 (same repo) | MIT | **Y** (`dependencies: {}`) | N (WASM) | `@0.27.0`: runtime `web-tree-sitter.wasm` = **204.7 KB**; whole pkg 4,571 KB but 90 % is `.map` + `/debug/` | **Only viable one** |
| TS grammar (WASM) | prebuilt via `@vscode/tree-sitter-wasm@0.3.1` (MIT) | 56 (microsoft/vscode-tree-sitter-wasm) | MIT | Y | N | `tree-sitter-typescript.wasm` = **1,380.7 KB** (`tree-sitter-wasms@0.1.13`: 2,287.8 KB) | — |
| Rust grammar (WASM) | same | — | MIT | Y | N | `tree-sitter-rust.wasm` = **1,087.5 KB** (`tree-sitter-wasms`: 799.6 KB) | — |
| ast-grep (`@ast-grep/napi`) | https://github.com/ast-grep/ast-grep | 16,065 | MIT | N | **Y** | `@0.45.3` 357 KB + `@ast-grep/napi-win32-x64-msvc@0.45.3` = **6.9 MB** | REJECT |
| `drom/wasm-tree-sitter` | https://github.com/drom/wasm-tree-sitter | **1** | MIT | Y | N | superseded by `web-tree-sitter` | REJECT |
| `wasm-lsp/tree-sitter-wasm` | https://github.com/wasm-lsp/tree-sitter-wasm | 41 | NOASSERTION | Y | N | only `wast` + `wat` grammars, no TS/Rust, last push 2023 | REJECT |
| `cursorless-dev/tree-sitter-wasms` | https://github.com/cursorless-dev/tree-sitter-wasms | **2** | Unlicense | Y | N | this is what `tree-sitter-wasms@0.1.13` (49.4 MB, 37 grammars) publishes | REJECT |
| `stereobooster/tree-sitter-wasm` | https://github.com/stereobooster/tree-sitter-wasm | **4** | none | Y | N | last push 2018 | REJECT |

### Findings

**Native or WASM, and does WASM dodge the v0.6.0 failure class?** Yes, cleanly. The native chain is `tree-sitter@0.25.1` → `node-gyp-build` (`install: node-gyp-build`) → a compiled `.node` per platform, with the two grammar packages adding a further **37.9 MB + 14.7 MB**. That is the *exact* shape of the v0.6.0 onnxruntime-node failure: a static import of a package that must compile or download a binary at install time. The repo's `src/policy/sidecar-safety.test.ts` exists precisely to prevent that class.

`web-tree-sitter@0.27.0` is genuinely clean: `dependencies: {}`, `optionalDependencies: {}`, no `install`/`postinstall` script, pure ESM + one `.wasm`. It would not break the sidecar.

**Grammar payload.** There is no official single-grammar WASM package; the WASMs come from third-party prebuilders (`@vscode/tree-sitter-wasm` at 56 stars, `tree-sitter-wasms` at 2 stars, or you build them yourself with emscripten, which needs a Rust toolchain). The realistic floor for TS + Rust is roughly **1.9 MB of unoptimized WASM** (1,380.7 + 1,087.5 KB from `@vscode`) or **3.1 MB** from `tree-sitter-wasms`. Release-mode emscripten builds are typically 30–40 % smaller, so ~1.2–2.0 MB is the optimistic figure. Both prebuilder packages are low-star and unofficial — I would not ship the *whole* package to get two grammars.

**Is there a zero-dependency option?** `web-tree-sitter` itself, yes. The *grammars*, no — they are separate binary artifacts from untrusted build pipelines, and that is the real supply-chain cost, not the megabytes.

### Honest verdict on need

**An AST index is not needed, and adding one would be a bad recommendation.** The reasons, in order of weight:

1. **Scope mismatch.** Voxaura's corpus is not code. `SharedChunk` is 43 hand-authored Arabic/English prose facts about capabilities, ports, failures and a lexicon. `src/knowledge/retriever.ts` indexes `chunk.text`. A TypeScript/Rust AST index has no document to attach to — the corpus contains zero `.ts` source.
2. **No corpus.** Even if indexing the repo, `src/` is 8,056 live lines total. A line-level regex grep is instant and needs no parser.
3. **The recall problem that actually exists is orthographic, not structural.** The measured miss `٤٠٩٦` returns 0 hits because the digits are not co-located — an AST cannot fix that; a chunk-authoring fix will.
4. `typescript@^5.5.0` is *already* a devDependency of this repo and is the only genuinely zero-native-dependency TS parser available. It cannot parse Rust, and moving it to a runtime dependency is ~8 MB for a use case that does not exist.

---

## AREA B — Zero-dependency local retrieval

| Name | URL (fetched) | Stars (2026-09-28) | License | Zero-deps | Native | Minzipped (gzip / minified) | Footprint (unpacked) | Latency p50 @ 43 chunks (measured) | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **MiniSearch** | https://github.com/lucaong/minisearch | 6,150 | MIT | **Y** (empirically: 0 transitive) | N | **5.7 KB / 17.3 KB** | 807 KB (37 files) | **0.0131 ms** (3.1x SLOWER than house BM25) | DEFER |
| **FlexSearch** | https://github.com/nextapps-de/flexsearch | 13,802 | Apache-2.0 | **Y** (empirically: 0 transitive) | N | 16.4 KB / 48.6 KB | 2,280 KB (248 files) | 0.0103 ms (2.5x slower) | **REJECT** |
| **Orama** | https://github.com/oramasearch/orama | 10,566 | Apache-2.0 (`LICENSE.md`, confirmed by fetch) | **Y** | N | 23.8 KB / 75.2 KB | 2,141 KB **+ `@orama/stemmers` 3,462 KB** | not measured — see below | REJECT |
| lunr.js | https://github.com/olivernn/lunr.js | 9,203 | MIT | Y | N | — | 953 KB | not measured | REJECT |
| **lunr-languages** (`lunr.ar.js`) | https://github.com/MihaiValentin/lunr-languages | **458** | **MPL-1.1** | Y | N | `lunr.ar.min.js` **16.7 KB** (raw 24 KB) | 1,366 KB (75 langs) | n/a | REJECT |
| fuse.js | https://github.com/krisk/Fuse | 20,491 | Apache-2.0 | Y | N | — | 407 KB | not measured | REJECT |
| wink-nlp | https://github.com/winkjs/wink-nlp | — | MIT | Y | N | — | 640 KB | not measured | REJECT |

### Arabic orthographic normalization — the decisive question, verified in source not docs

I did not trust READMEs. I read the tokenizers.

- **MiniSearch 7.2.0** (`src/MiniSearch.ts`): default tokenizer is literally `text.split(/[\n\r\p{Z}\p{P}]+/u)` (line 2260-2263); default `processTerm` is `term => term.toLowerCase()` (line 2179). Grepping the whole 78,750-char file for `[؀-ۿ]` returns **zero hits** — not one Arabic character anywhere in the source. Confirmed: no Arabic handling.
- **FlexSearch 0.8.212**: README lists "Arabic" under "Supported Charsets". I checked what that means: `src/charset.js` exports only `Exact`, `Default/Normalize`, five Latin variants and `CJK` — there is no Arabic charset. `src/charset/normalize.js` is a literal **empty options object with `normalize` commented out**. The README's "Arabic" means "the generic tokenizer does not choke on Arabic codepoints", not "orthographic normalization". Confirmed: no Arabic handling, and the claim is misleading.
- **Orama 3.1.18**: genuinely has Arabic. `packages/orama/src/components/tokenizer/index.ts` dispatches on `language`, and `packages/stemmers/lib/ar.js` is the Snowball Arabic stemmer (Kazem Taghva et al. 2005). **But** `ar.js` is not in the `@orama/orama` tarball — it lives in `@orama/stemmers`, a **separate 3,462 KB package**, so "zero-deps" becomes "zero-deps if you do not want Arabic".
- **lunr-languages 1.22.0** is the *only* library found that ships real Arabic orthographic handling. `lunr.ar.js` pipeline is `['cleanWord','removeDiacritics','cleanAlef','removeStopWords','normalizeHamzaAndAlef','removeStartWaw','removePre432','removeEndTaa','wordCheck']`. It is a real answer — and it is **wrong for Voxaura in three specific, checked ways**:
  1. `cleanAlef` uses `new RegExp("[\u0622\u0623\u0625\u0671\u0649]")` with **no `/g` flag** — `String.replace` with a non-global regex removes only the **first** occurrence. A token with two alef variants leaves one behind.
  2. It folds **U+0649 alef maksura → ا (alef)**. `normalize.ts` folds it **→ ي (yeh)**, which is the correct Levantine/Ammani unification (`على` → `علي`, where the yeh is pronominal). lunr would merge `علا` and `على` into one token — the wrong direction.
  3. It carries a **hardcoded ~500-word Arabic stopword list** applied inside the stemmer with no opt-out on this code path. That list contains `في`, `من`, `على`, `كيف`, `ماذا`, `ما`, `هذا`. For a **voice** assistant whose queries are Arabic, silently deleting interrogative particles is a recall bug by construction.
  Plus it does not strip tatweel (U+0640), and `removeDiacritics` stops at U+065B (so U+0670 superscript alef survives).
  License is **MPL-1.1**, not MIT/Apache.

### Measured head-to-head, real corpus, real Arabic

Same 43 chunks, same queries, same machine:

```
--- 9 labelled Arabic+English queries, top-3 recall ---
house BM25                      8/9
MiniSearch (defaults, unwired)  8/9      <- on CLEAN corpus text only
MiniSearch (processTerm+tokenize wired) 8/9

--- 5 ARABIC ORTHOGRAPHIC VARIANT queries (the shape STT actually emits) ---
house BM25                      3/5
MiniSearch (wired correctly)    3/5      <- IDENTICAL to house BM25
MiniSearch (defaults)           0/5      <- total failure

example: "اَلْمِنْفَذ"  (tashkeel)
  house BM25   -> [arch-ports, lex-runtime, fail-ports-busy]
  MiniSearch   -> []              (default tokenizer emits the token WITH harakat intact)
```

**This is the finding that decides Area B.** Wiring MiniSearch correctly with `normalizeToken` + `tokenize` makes it *exactly as good* as the hand-rolled BM25 on Arabic — 3/5 vs 3/5, same hit sets — and **3.1x slower**. You pay 5.7 KB of dependency, a maintenance surface, and an Arabic correctness risk that buys you nothing measurable. The only reason MiniSearch looked viable is that its *defaults* happen to work on clean corpus text; the moment the query carries harakat (which STT always emits) it collapses to 0/5, and the only fix is the wiring that also removes its speed advantage.

### Latency and scale — where MiniSearch would actually win

```
                       43 chunks (today)        21,500 chunks (corpus x500)
house BM25            p50 0.0042 ms            p50 5.4495 ms   index build  751.9 ms
MiniSearch            p50 0.0131 ms            p50 2.7225 ms   index build 1473.9 ms
FlexSearch            p50 0.0103 ms            not measured
```
MiniSearch overtakes the hand-rolled BM25 somewhere between 43 and 21,500 chunks. **Voxaura is ~500x below the scale at which the swap starts paying.** Also note MiniSearch is *slower to build* at both scales (1,474 ms vs 752 ms at 21.5k).

### Maintenance state (fetched 2026-09-28)

- **MiniSearch**: last commit `v7.2.0`, **2025-09-16**. Twelve months stale. npm `latest` == that commit.
- **FlexSearch**: last commit on `main` **2026-05-29, "fix command injection vulnerability"**; `main`'s `package.json` says **0.8.215**; npm `latest` is **0.8.212 from 2025-09-06**. **`npm install flexsearch` today installs a build three patch releases behind a published command-injection fix.** That alone disqualifies it from a shipped desktop app.
- **Orama**: repo pushed 2026-07-03, but npm `latest` 3.1.18 was published **2025-12-19** and was last *modified* 2026-07-27. Nine months of drift.
- **lunr-languages**: `olivernn/lunr-languages` has **8 stars** and last pushed **2019**; npm now points at the fork `MihaiValentin/lunr-languages` (458 stars, actively maintained, pushed 2026-09-15). The package works; the lineage is confusing and the license is MPL-1.1.

---

## AREA C — Embedded vector / semantic cache

| Name | URL (fetched) | Stars (2026-09-28) | License | Zero-deps | **Native** | Footprint | Latency | Verdict |
|---|---|---|---|---|---|---|---|---|
| **LanceDB (embedded, Node)** | https://github.com/lancedb/lancedb | 11,549 | Apache-2.0 | N | **Y — napi, Rust** | `@lancedb/lancedb@0.39.0` 1.4 MB + `@lancedb/lancedb-win32-x64-msvc@0.39.0` = **301.9 MB** + peer `apache-arrow@21.2.0` = 5.5 MB / **1,108 files** + deps `reflect-metadata`, `@opentelemetry/api` | not measured | **REJECT — 3x the entire 100 MB sidecar** |
| **sqlite-vec** | https://github.com/asg017/sqlite-vec | 8,143 | Apache-2.0 (repo) / `MIT OR Apache` (npm) | shim Y, ext N | **Y — C extension** | `sqlite-vec@0.1.9` shim = **4 KB** (5 files); `sqlite-vec-windows-x64@0.1.9` = **0.3 MB** native `.dll` | not measured | REJECT (scale), DEFER (mechanism) |
| `@huggingface/transformers` | https://github.com/huggingface/transformers.js | 16,329 | Apache-2.0 | N | **Y** | `@4.3.0` 9.4 MB; deps `sharp`, `onnxruntime-web`, **`onnxruntime-node`**, `@huggingface/jinja`, `@huggingface/tokenizers` | n/a | REJECT |
| `onnxruntime-node` (the actual blocker) | — | — | MIT | N | **Y** | `1.30.0` = **287.1 MB unpacked**, has a `postinstall` script | n/a | REJECT |
| `fastembed` | https://github.com/qdrant/fastembed | 3,223 | MIT | N | **Y** | `3.0.0`; deps `progress`, `@huggingface/hub`, **`onnxruntime-node`**, `@anush008/tokenizers` | n/a | REJECT |
| `@orama/plugin-embeddings` | https://github.com/oramasearch/orama | (10,566 parent) | Apache-2.0 | N | N (TF.js) | 4,234 KB; dep `@tensorflow-models/universal-sentence-encoder@^1.3.3` | n/a | REJECT |
| `node-sqlite3-wasm` | — | — | MIT | **Y** | N | `0.8.60` 1,301 KB | n/a | mechanism, not a vector DB |
| `@sqlite.org/sqlite-wasm` | https://github.com/sqlite/sqlite-wasm | 10,555 | Apache-2.0 | **Y** | N | `3.53.4-build1` 2,954 KB | n/a | mechanism, not a vector DB |

### Is it native? (the v0.6.0 question)

Both vector stores are native, in two different flavours:

- **LanceDB is a Rust napi binary.** `@lancedb/lancedb-win32-x64-msvc@0.39.0` unpacks to **301.9 MB**. The sidecar is ~100 MB total. This single optional dependency is three times the entire shipping budget, before `apache-arrow`'s 1,108 files. Not close.
- **sqlite-vec is a C extension** with prebuilt per-platform binaries (`sqlite-vec-windows-x64` = 0.3 MB). Small, but still a `.dll` loaded via `loadExtension`, and it is `pre-v1` by the author's own README banner ("*sqlite-vec is a pre-v1, so expect breaking changes!*").

Worth recording: `node:sqlite` **is** available and on Node 25 exposes **both** `loadExtension` and `enableLoadExtension` (I instantiated a `DatabaseSync(':memory:')` and checked). So the sqlite-vec mechanism is not blocked. But note the sidecar copies `process.execPath` from whatever Node ran `provision-sidecar.mjs` (`scripts/provision-sidecar.mjs:34`) while `package.json` declares `engines: {node: ">=22.0.0"}` — the bundled `node.exe` version is **not pinned**, so any `node:sqlite`-based design inherits builder-machine Node drift.

### On-disk / in-memory footprint at our scale

Trivially small, and this is not the argument against it:
- 43 vectors × 768 dims × 4 bytes (float32) = **132 KB**. At 500 × 1536 × 4 = **3.0 MB**.
- 43 × 128-dim int8 = **5.5 KB**.

### The real killer: you cannot get vectors offline without the module that already broke v0.6.0

Every offline embedding path I checked — `@huggingface/transformers`, `fastembed`, `@orama/plugin-embeddings` — routes through `onnxruntime-node` (287.1 MB, native, `postinstall`). Voxaura **already** has `onnxruntime-node` as a runtime dependency, and `AGENTS.md` records that `daemon.ts:338` loads it with a *dynamic* `import('./runtime/vad.js')` **specifically so a missing native package is not fatal**. That is a deliberate architectural decision, enforced by `src/policy/sidecar-safety.test.ts`.

Adding a semantic cache would invert it: the ONNX runtime would have to load **on the retrieval path**, meaning a missing or mismatched native binary turns knowledge retrieval — and therefore voice — into a hard failure. That is the v0.6.0 failure class, reintroduced through the front door.

### Does a vector DB beat BM25 at 200–500 vectors?

**No, and this is not close.** A flat brute-force cosine over 43–500 float32 vectors is a single BLAS-free dot product per vector — microseconds, and it would beat the current 4.2 µs by at most that amount. What a vector DB buys is ANN indexes, persistence, metadata filtering, and hybrid BM25+vector fusion. Voxaura needs none of those at 43 chunks, has a **hard** offline constraint, has a **hard** 100 MB sidecar budget, and has a measured p99 of **0.0128 ms against a 10 ms budget**.

The honest summary: the case for embeddings here is *recall on paraphrase* — a user phrasing a fact differently than the chunk author did. That is a real problem. But the measured data shows it is **not yet a retrieval problem**: of 10 spot-check queries, the misses were corpus gaps, not scoring misses. Fix the corpus first; the algorithm is not the bottleneck.

---

## COULD NOT VERIFY

1. **`tree-sitter/tree-sitter-wasms`** — I assumed this existed as the official prebuilt-WASM repo. `GET api.github.com/repos/tree-sitter/tree-sitter-wasms` → **404 Not Found**. GitHub search for `tree-sitter wasm in:name` surfaced no such official repo; the prebuilders are `microsoft/vscode-tree-sitter-wasm` (56★), `wasm-lsp/tree-sitter-wasm` (41★), `Menci/tree-sitter-wasm-prebuilt` (21★), `cursorless-dev/tree-sitter-wasms` (2★), `drom/wasm-tree-sitter` (1★). **Conclusion: there is no official, well-starred prebuilt-WASM grammar distribution.** That is itself a finding — it makes the WASM path a third-party-binary dependency, which is a supply-chain cost the repo does not currently have anywhere.
2. **`ai-sap/orama`** — `GET api.github.com/repos/ai-sap/orama` → **404**. The package is now `oramasearch/orama`. I verified that via `search/repositories?q=orama+in:name` and then fetched the repo directly. Not a real repo, just my stale recollection.
3. Also 404 and therefore excluded: `node-lancedb` (renamed to `@lancedb/lancedb`), `@lancedb/lancedb-wasm`, `waiss/sqlite-vec`, `napi-rs/sqlite-vec`, `@tree-sitter-grammars/tree-sitter-wasms`, `@ast-grep/napi-wasm`, `stemnlp`, `kaciras/fuse.js` (correct org is `krisk/Fuse`), `minisearch/minisearch` (correct is `lucaong/minisearch`).
4. **`@orama/orama` license** — GitHub API reports `NOASSERTION` because the file is `LICENSE.md`, not `LICENSE`. I fetched `https://raw.githubusercontent.com/oramasearch/orama/main/LICENSE.md` and read "Licensed under the Apache License, Version 2.0". **Apache-2.0 confirmed by direct fetch.** npm `package.json` also says `Apache-2.0`.
5. **`sqlite-vec` license discrepancy** — GitHub API says `Apache-2.0`; npm `package.json` says `MIT OR Apache`. `raw.githubusercontent.com/asg017/sqlite-vec/main/LICENSE.md` → 404. **UNVERIFIED which is authoritative**; the package is dual-licensed either way, so it is permissive, but I could not read the file.
6. **wasm-lsp `tree-sitter-wasm` license** — `NOASSERTION`, `LICENSE` not read. Not material; repo is 41★, last pushed 2023, and ships no TS/Rust grammar.
7. **Orama latency** — not measured. Not worth measuring: `@orama/orama` alone is 75.2 KB minified (4.5x MiniSearch) and its Arabic support requires a further 3,462 KB package, and its embedding plugin pulls TensorFlow.js. The verdict does not depend on the number.
8. **lunr.js / fuse.js / wink-nlp latency** — not measured. All three are either superseded (`lunr@2.3.9`, last npm publish **2020-08-19**, six years stale; `olivernn/lunr.js` last push 2024-07-31) or solve a different problem (fuse.js is fuzzy string similarity, not ranked lexical retrieval, and its 20,491 stars are for an autocomplete use case Voxaura does not have).

---

## ADOPT / DEFER / REJECT — one line each

**AREA A**

- `web-tree-sitter` + TS/Rust grammar WASMs — **DEFER, indefinitely.** The only technically clean option (zero-dep, no native risk), but it solves nothing: the 43-chunk corpus contains no code, and the repo is 8,056 live lines that grep covers instantly.
- `tree-sitter` / `tree-sitter-typescript` / `tree-sitter-rust` (native npm) — **REJECT.** 52.6 MB unpacked, `node-gyp-build` install hook: the exact v0.6.0 failure class, for a capability that is not needed.
- `@ast-grep/napi` — **REJECT.** 6.9 MB native `.node` per platform, and it is a *rewriting* tool; there is nothing in Voxaura to rewrite.
- `tree-sitter-wasms` / `@vscode/tree-sitter-wasm` — **REJECT as a dependency.** 49.4 MB / 21.1 MB bundles from 2★ and 56★ third parties. If grammars are ever needed, compile them in-tree with emscripten and commit the two `.wasm` files.

**AREA B**

- MiniSearch 7.2.0 — **DEFER, with a trigger.** Best-behaved candidate (MIT, truly 0 deps, 5.7 KB gzipped, the swap-in point already named in `retriever.ts`), but measured **3.1x slower** than the house BM25 at 43 chunks and **identical** Arabic recall once correctly wired. Revisit only when the corpus passes ~5,000 chunks.
- FlexSearch 0.8.212 — **REJECT.** Not a ranked lexical engine (no IDF, no TF saturation; measured `EADDRINUSE` → `cap-tts`, `مفتاح API` → `fail-credit`), returns no scores so `SharedHit.score` would have to be fabricated, and npm `latest` is three patch releases behind a published command-injection fix.
- Orama 3.1.18 — **REJECT.** 4.5x MiniSearch's size, its Arabic support is a *separate* 3.4 MB package, its embedding plugin pulls TensorFlow.js, and its npm release is nine months behind `main`.
- lunr-languages `lunr.ar.js` — **REJECT, and this is the instructive one.** The only library that actually does Arabic orthographic normalization — and it disagrees with the audited `normalize.ts` on alef-maksura direction, drops all but the first alef variant, and deletes ~500 Arabic stopwords including `كيف` and `في` from voice queries. `normalize.ts` is better than the off-the-shelf answer and should stay.
- lunr.js / fuse.js / wink-nlp — **REJECT.** Six-year-stale upstream, wrong problem (fuzzy autocomplete), or an NLP pipeline this project has no use for.

**AREA C**

- LanceDB embedded — **REJECT, hardest no in this report.** `@lancedb/lancedb-win32-x64-msvc` alone is **301.9 MB** versus a ~100 MB sidecar, plus `apache-arrow`'s 1,108 files.
- sqlite-vec — **REJECT at this scale, DEFER the mechanism.** 0.3 MB native C extension is tolerable and `node:sqlite` exposes `loadExtension`; but it is `pre-v1` by its author's own banner and it stores vectors we have no offline way to produce.
- `@huggingface/transformers` / `fastembed` — **REJECT.** Both route through `onnxruntime-node` (287.1 MB, native, `postinstall`), which would move the module that `daemon.ts:338` deliberately lazy-loads onto the critical retrieval path and re-create the v0.6.0 failure class.
- Any vector DB — **REJECT as a latency play.** There is no latency problem: p99 is 0.0128 ms against a 10 ms budget, 780x of headroom.

---

## What Voxaura should actually do

**Nothing. Ship the retriever that already exists.** That is the defensible answer, and the measurements support it without hedging.

1. **Keep `InMemoryRetriever` and `normalize.ts` exactly as they are.** `normalize.ts` is not merely adequate, it is *better* than every off-the-shelf Arabic option surveyed — including the one library that ships Arabic support. Do not swap it out.
2. **Do not add an AST indexer.** There is no code in the corpus. This is not a "later" — it is a "never, unless the product changes to index source code", which is not a planned change.
3. **Do not add a vector DB or an embedding model.** They cost 300 MB and re-arm the v0.6.0 failure mode, to solve a problem that 4.2-microsecond retrieval does not have.
4. **Delete the `minisearch swap-in point` comment block from `retriever.ts:24-29`, or replace it with the measured finding.** It currently reads as a standing TODO implying minisearch is a pending improvement. It is not: as of 2026-09-28 it is measurably **3.1x slower and no better on Arabic**. Leaving it there invites a future agent to "finish" it. If the comment is kept, it must carry the number: *"43 chunks, 2026-09-28: MiniSearch 7.2.0 p50 0.0131 ms vs house 0.0042 ms; Arabic recall identical (3/5) once processTerm is wired; MiniSearch wins only above ~5,000 chunks (verified crossover between 43 and 21,500)."*
5. **The one genuinely actionable finding is not an algorithm — it is corpus coverage.** Measured misses: `إيش سويت` → 0 hits, `٤٠٩٦` alone → 0 hits. Both are absent facts in `src/knowledge/shared/`, not ranking failures. Adding the missing `capabilities.ts` chunks is worth more than every library in this report combined, costs zero bytes of dependency, and is directly testable with the harness that already exists.
6. **If a retrieval regression ever does appear, add the measurement harness before the library.** The script used here (`%LOCALAPPDATA%\Temp\opencode\t2-retriever-bench`, ~40 lines, installs nothing into the repo) is the whole decision procedure, and it is cheap enough to re-run whenever the corpus grows. Write it down in `docs/10-CHECKPOINT.md` with today's numbers, so the next person has a baseline instead of a hunch.
7. **One durable takeaway for the repo's own conventions:** every alternative surveyed is either slower, unranked, licence-incompatible, or native. The zero-dependency, hand-rolled, audit-documented `src/knowledge/` is not a compromise the project is stuck with — it is currently the best option in its class, and the audit trail in `normalize.ts` is the reason.

### One correction to the brief's own premise

The brief said "minisearch ships no Arabic handling, so `normalizeArabic` must be passed in via `processTerm` at BOTH index and query time". **That library fact is correct and I verified it** (zero Arabic characters in the 78,750-char source; default tokenizer is a plain `\p{P}` split). **But on today's corpus it makes no measured difference without wiring**, because the 43 chunks are authored without tashkeel — MiniSearch's defaults score 8/9 on the clean set. The wiring only matters for *queries*, and STT emits harakat on every Arabic utterance: on tashkeel-laden queries MiniSearch's defaults score **0/5** and the correctly-wired build scores **3/5 — identical to the hand-rolled BM25**. So the lesson is not "minisearch needs Arabic wiring"; it is "**the wiring is the whole product**, and it already exists in `normalize.ts`." Swapping the search engine would mean re-deriving, in a dependency, the exact thing the repo already got right and then had to audit for a Unicode range bug that silently deleted Arabic-Indic digits from queries.
