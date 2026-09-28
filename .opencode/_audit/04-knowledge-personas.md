# 04 — Knowledge & Personas: Forensic Audit

**Auditor:** Forensic Auditor 4 of 7 · **Date:** 2026-09-28 · **Repo:** `O:\opencode-Vantrilex`
**Scope:** `src/knowledge/**` in full, `docs/personas/**`, `dossier/KNOWLEDGE-ARCHITECTURE-PROPOSAL.md`, plus `src/common/brands.ts`, `src/orchestrator/narrator.ts`, `src/orchestrator/coordinator.ts`, `src/orchestrator/prompt-optimizer.ts`, `src/voice/brain.ts`, and the `narrate()` call site in `src/daemon.ts`.
**Method:** every fact derived from physical file bytes. No claim in this report comes from prose. Where a doc is cited it is only to record a contradiction.

**Reproduce commands used (all run from `O:\opencode-Vantrilex`):**

```
node dist/cli.js knowledge                                             # §8
npx vitest run src/knowledge                                           # 4 files, 43 tests, exit 0
npx tsc --noEmit -p tsconfig.json                                      # exit 0
node %LOCALAPPDATA%\Temp\opencode\reach.mjs                            # §3.5 reachability
node %LOCALAPPDATA%\Temp\opencode\kb-imp.mjs src/knowledge/index.ts     # §1.6 import graph
node %LOCALAPPDATA%\Temp\opencode\census.mjs                            # §6 token census
node %LOCALAPPDATA%\Temp\opencode\cites.mjs                            # §9 citation resolution
npx tsc --noEmit --strict --target ES2023 %LOCALAPPDATA%\Temp\opencode\parity-probe\probe.ts   # §4.3
```

---

## 0. HEADLINE

| # | Finding | Severity |
|---|---|---|
| **H1** | The entire `src/knowledge/` layer — 43 Tier-1 chunks, 16 StylisticExamples, 2 persona profiles, the Tier-D moral guard — has **exactly one production importer: `src/cli.ts:17`**, i.e. the `knowledge` CLI subcommand. `daemon.ts`, `narrator.ts`, `coordinator.ts`, `brain.ts` and the renderer import **nothing** from it. | **CRITICAL** |
| **H2** | **Nour and Kareem produce byte-identical narration.** Persona tokens in `narrator.ts` = 0, `coordinator.ts` = 0, `prompt-optimizer.ts` = 0, `brain.ts` = 0. The only persona effects in the shipped runtime are TTS voice id, earcon pitch, and wave colour. | **CRITICAL** |
| **H3** | A Tier-1 chunk (`cmd-persona-effect`, `src/knowledge/shared/commands.ts:70-78`) asserts as **ground truth** that "the dossier instructions … are injected into the narrator". That is false. Tier 1 contains the corpus's own false statement about itself. | **HIGH** |
| **H4** | `normalizeArabic` **silently deletes all ten ARABIC-INDIC DIGITS** `U+0660`–`U+0669` and the separators `U+066B`/`U+066C`, because `TASHKEEL_TATWEEL` (`normalize.ts:10`) is `U+0640` + the range `U+064B`–`U+0672`. `'المنفذ ٤٠٩٦ مشغول'` → `'المنفذ  مشغول'`. Measured score drop 6.80 → 3.19 on `arch-ports`. | **HIGH** |
| **H5** | `arch-reachability` (`architecture.ts:67-73`) states "37 وحدة حية و 0 وحدة ميتة". Measured truth is **51 live / 0 dead / 8056 live lines**. The Tier-1 dead-code fact is wrong by 14 modules. | **HIGH** |
| **H6** | `docs/personas/nour.agent.md:15-16,34-37` and `kareem.agent.md:15-16,33-36` both declare the register as **"العربية الفصحى المبسّطة / Simplified Modern Standard Arabic"**, which `src/voice/brain.ts:108` explicitly **bans** and `src/knowledge/shared/lexicon.ts:76-84` (`lex-dialect`) explicitly **contradicts** ("never stiff newsreader Modern Standard Arabic"). The locked dialect is Ammani. The dossiers are stale. | **MEDIUM** |
| **H7** | 2 of 8 StylisticExample pairs are **byte-identical** between Nour and Kareem (`402` and `401/403`). `corpus.test.ts` checks coverage on `when` but never checks `say` distinctness per pair. | **MEDIUM** |
| **H8** | `cap-effort-none` (`capabilities.ts:82-89`) cites `src/voice/brain.ts` as a source. `brain.ts` contains **no** `effort` token anywhere. The real sites are `daemon.ts:174`, `daemon.ts:535`, `coordinator.ts:215`. | **MEDIUM** |
| **H9** | `src/knowledge/build.ts` contains two raw `U+0000` bytes (offsets 2047, 2059) and a `U+0001` in string literals, making the file read as **binary** to standard tooling. Invisible in every diff. | **MEDIUM** |
| **H10** | `src/voice/brain.ts:6` still claims "Phrasing is synthesized by the model under the **RAG-grounded** system prompt". There is no RAG in the brain path. | **LOW** |

---

## 1. BM25 MECHANICS — `src/knowledge/retriever.ts`

### 1.1 Constants

```
src/knowledge/retriever.ts:30   const K1 = 1.2;
src/knowledge/retriever.ts:31   const B  = 0.75;
```

Exact values `K1 = 1.2`, `B = 0.75`. Both are module-private `const`, not exported, not configurable.

### 1.2 The scoring formula — verbatim

`src/knowledge/retriever.ts:75-86`:

```ts
for (const doc of this.docs) {
  let score = 0;
  for (const term of queryTerms) {                                   // :77
    const tf = doc.tf.get(term);                                     // :78
    if (tf === undefined) continue;                                  // :79
    const df = this.docFreq.get(term) ?? 0;                          // :80
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));           // :81
    const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / Math.max(1, this.avgLen)));  // :82
    score += idf * norm;                                             // :83
  }
  if (score > 0) scored.push({ ...doc.chunk, score });               // :85
}
scored.sort((a, b) => b.score - a.score);                            // :87
return scored.slice(0, topK);                                        // :88
```

Rendered:

```
score(d, q) = Σ_{t ∈ distinct(queryTerms)}  idf(t) · [ tf(t,d)·(K1+1) ] / [ tf(t,d) + K1·(1 − B + B·dl(d)/max(1, avgLen)) ]

idf(t) = ln( 1 + (N − df(t) + 0.5) / (df(t) + 0.5) )
```

- `N` (`n` at `:73`) = `this.docs.length` — **every** indexed document. There is no persona partition, so this is the whole corpus.
- `idf` is the **Lucene** variant `ln(1 + (N−df+0.5)/(df+0.5))`, not the Robertson `ln((N−df+0.5)/(df+0.5))`. The `1 +` keeps idf strictly positive, so a term in every document still contributes.
- `queryTerms` is a `Set` built at `:71` (`new Set(tokenize(query).map(normalizeToken))`). The **query term-frequency factor is omitted** — every distinct query term counts exactly once. This is standard BM25 when qtf is dropped, and it is what makes `idf·norm` sum well-defined.
- Zero-score documents are dropped at `:85` rather than padded with `0`, so `search()` never returns a non-matching chunk.
- Sort at `:87` is on `b.score - a.score`, and `slice(0, topK)` at `:88` — **ties are broken by insertion order** (stable in V8 for all arrays), i.e. by the order chunks appear in `SHARED_CHUNKS`, which is `ARCHITECTURE → CAPABILITIES → COMMANDS → FAILURES → LEXICON` (`build.ts:23-29`).
- Guards: `topK <= 0` → `[]` (`:70`); empty query term set → `[]` (`:72`); `Math.max(1, this.avgLen)` at `:82` prevents division by zero on an empty corpus.

### 1.3 How `avgLen` is computed

```
src/knowledge/retriever.ts:48   let total = 0;
src/knowledge/retriever.ts:56   this.docs.push({ chunk, tf, length: terms.length });
src/knowledge/retriever.ts:57   total += terms.length;
src/knowledge/retriever.ts:62   this.avgLen = this.docs.length === 0 ? 0 : total / this.docs.length;
```

`avgLen` is the **arithmetic mean of the raw tokenized length** of every chunk. Two precise properties:

1. It is the length **before** tf de-duplication — `length: terms.length` (`:56`) counts repeated tokens, which is correct BM25 document length. The `tf` Map is de-duplicated, `length` is not. They are deliberately different.
2. `total` is accumulated **after** the push at `:56`, and `this.docs.length` is read at `:62` after the loop, so `N` is correct. An empty corpus yields `avgLen = 0`, not `NaN`.
3. `length` is computed from `tokenize(chunk.text)` (`:50`) — i.e. post-`normalizeArabic` — so a chunk whose text normalizes to zero tokens contributes `length: 0`, which would make the `Math.max(1, avgLen)` guard load-bearing. No shipped chunk does this (all 43 have `text.length > 20`; smallest is `lex-errors` at 163 chars, measured).

### 1.4 The term-frequency map replaced the archived nested filter — and why

**The original** (`.opencode/_archive/dead-code-phase1/src/guidance/rag/retriever.ts:52-62`):

```ts
for (const { chunk, terms: doc } of this.docs) {
  if (allowed !== undefined && !allowed.has(chunk.persona)) continue;   // :53  persona allowlist
  let score = 0;
  for (const term of new Set(terms)) {
    const tf = doc.filter((t) => t === normalizeArabic(term)).length;    // :56  NESTED FILTER
    if (tf === 0) continue;
    const df = this.docFreq.get(normalizeArabic(term)) ?? 0;           // :58
    ...
```

Three distinct defects, all removed:

1. **`normalizeArabic` called inside the innermost loop** (archived `:56` and `:58`), once per (document × query term). On the real corpus that is 43 docs × ~10 distinct query terms = ~430 redundant NFKC normalizations per query, each a full-string Unicode transform.
2. **Index/query asymmetry — a silent Arabic recall failure.** The archive had **no `normalizeToken`** at all (`.opencode/_archive/.../normalize.ts` is 24 lines and exports only `normalizeArabic` and `tokenize`). The index was built at archived `:36-38` from `new Set(terms)` — **raw, un-normalized** tokens — while the query at archived `:58` looked df up by the **normalized** token. A chunk storing `أحمد` indexed key `'أحمد'`; a user typing the same word looked up `'احمد'`. Every Arabic term requiring normalization was unfindable by its own query, with no error and no log. This is exactly what `retriever.ts:9-16` documents.
3. **The persona allowlist** (archived `:47` third parameter `scopes`, `:50` `allowed` Set, `:53` `continue`) is gone, because per-persona scoping is what the parity requirement eliminates (`retriever.ts:20-22`).

**The replacement** (`retriever.ts:33-63`):

```ts
interface IndexedDoc {
  readonly chunk: SharedChunk;
  /** term -> term frequency, precomputed. */          // :35  <- the brief's "terminator frequency map"
  readonly tf: ReadonlyMap<string, number>;
  readonly length: number;
}
...
const terms = tokenize(chunk.text);                     // :50
const tf = new Map<string, number>();                   // :51
for (const term of terms) {
  const key = normalizeToken(term);                     // :53  ONE normalization per token, index time
  tf.set(key, (tf.get(key) ?? 0) + 1);                  // :54
}
this.docs.push({ chunk, tf, length: terms.length });     // :56
total += terms.length;                                  // :57
for (const term of tf.keys()) {                         // :58  df from DEDUPLICATED keys
  this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
}
```

- `tf` is a `ReadonlyMap<string, number>` holding **one entry per distinct normalized term**, with its in-document count. Cost: **O(total tokens)** once at construction.
- `search()` now resolves tf with a single `Map.get` (`retriever.ts:78`) — **O(1)** — instead of an O(|doc|) `Array.filter` scan. Total query cost drops from O(N × Q × dl) to O(N × Q).
- Because `docFreq` is incremented from `tf.keys()` (`:58`), a term repeated 7× inside one chunk still counts `df = 1`. The archived version got this right too (`new Set(terms)` at archived `:36`), so df semantics are unchanged — only the key derivation was fixed.
- Both paths now go through the same `normalizeToken`, which is the whole correctness story, and is why `retriever.ts:24-29` warns that a future minisearch swap must wire `normalizeToken` at **both** index and query time.

**Naming note.** The brief calls it a "terminator frequency map". The shipped name is a **term-frequency (`tf`) map** — `retriever.ts:36` documents it as `term -> term frequency, precomputed`, the field is `IndexedDoc.tf` (`:36`), and the term variable is `tf` (`:78`, `:82`). There is no "terminator" concept anywhere in the module. Substance confirmed; terminology in the brief is off.

### 1.5 `search()` signature change (breaking, and deliberate)

| | archived `retriever.ts:47` | shipped `retriever.ts:69` |
|---|---|---|
| signature | `search(query: string, topK: number, scopes?: readonly RagPersonaScope[])` | `search(query: string, topK: number): SharedHit[]` |
| return | `RagHit[]` (carries `persona`) | `SharedHit[]` (no `persona`; `types.ts:34-36`) |
| exported type | `RagPersonaScope = 'shared' \| 'kareem' \| 'nour'` (archived `:9`) | **deleted** |

### 1.6 Zero-dependency — CONFIRMED

Imports of `src/knowledge/retriever.ts`, verbatim:

```
src/knowledge/retriever.ts:1   import { normalizeToken, tokenize } from './normalize.js';
src/knowledge/retriever.ts:2   import { assertSharedChunks, type SharedChunk, type SharedHit } from './types.js';
```

Transitive module closure, resolved by script `%LOCALAPPDATA%\Temp\opencode\kb-imp.mjs`:

```
transitive modules from src/knowledge/index.ts:
   src/common/brands.ts
   src/knowledge/build.ts
   src/knowledge/guard.ts
   src/knowledge/index.ts
   src/knowledge/normalize.ts
   src/knowledge/personas.ts
   src/knowledge/retriever.ts
   src/knowledge/shared/architecture.ts
   src/knowledge/shared/capabilities.ts
   src/knowledge/shared/commands.ts
   src/knowledge/shared/failures.ts
   src/knowledge/shared/lexicon.ts
   src/knowledge/styles/kareem.ts
   src/knowledge/styles/nour.ts
   src/knowledge/types.ts
BARE (non-relative) imports: NONE
MISSING targets: NONE
```

**15 modules, zero bare imports.** The entire `src/knowledge/` graph is dependency-free. The only escape from the directory is `src/common/brands.ts` (via `types.ts:1`), and `brands.ts` itself has **no imports at all** (`src/common/brands.ts:1-35` is pure type + data declarations). BM25 therefore depends on nothing outside the repo and nothing outside `src/`.

`retriever.ts:4` (`// In-process BM25 retrieval (G4D) — zero dependencies.`) is **TRUE**.

---

## 2. `normalizeArabic` AND `normalizeToken` — `src/knowledge/normalize.ts`

The file is 52 lines. Three regex constants at `:10-12`, two exported functions, one exported predicate, one tokenizer.

### 2.1 The exact regexes and their real codepoint coverage

Source bytes, as stored (measured, not transcribed):

```
normalize.ts:10   const TASHKEEL_TATWEEL = /[ً-ٲٰـ]/g;
normalize.ts:11   const ALEF_VARIANTS     = /[آأإٱ]/g;
normalize.ts:12   const ALEF_MAKSURA      = /ى/g;
```

Enumerated by evaluating the regexes and testing every codepoint in `U+0600`–`U+06FF`:

**`TASHKEEL_TATWEEL` — 41 codepoints matched inside the Arabic block:**
`U+0640 U+064B U+064C U+064D U+064E U+064F U+0650 U+0651 U+0652 U+0653 U+0654 U+0655 U+0656 U+0657 U+0658 U+0659 U+065A U+065B U+065C U+065D U+065E U+065F U+0660 U+0661 U+0662 U+0663 U+0664 U+0665 U+0666 U+0667 U+0668 U+0669 U+066A U+066B U+066C U+066D U+066E U+066F U+0670 U+0671 U+0672`

Structure: `U+0640` (ARABIC TATWEEL, listed explicitly because it sits **below** the range) **plus the contiguous range `U+064B`–`U+0672`**. The `U+0670` (ARABIC SUPERSCRIPT ALEF) member is **redundant** — it already falls inside `U+064B`–`U+0672`.

**`ALEF_VARIANTS` — 4 codepoints:** `U+0622` (ALEF WITH MADDA ABOVE آ), `U+0623` (ALEF WITH HAMZA ABOVE أ), `U+0625` (ALEF WITH HAMZA BELOW إ), `U+0671` (ALEF WASLA ٱ). All four → `ا`.

**`ALEF_MAKSURA` — 1 codepoint:** `U+0649` (ALEF MAKSURA ى) → `ي`.

**Derived separators** (`normalize.ts:36`, Unicode-property escape): `/[^\p{L}\p{N}_]+/u` — splits on any run of characters that are not a Unicode Letter, Number, or underscore. Flag `u` is mandatory and present.

**Latin/Arabic discriminator** (`normalize.ts:51`): `/[\u0600-\u06FF]/` — a 256-codepoint block test, **no** `u` flag (unnecessary; the range is pure BMP).

### 2.2 What each collapses

| Stage | Line | Operation |
|---|---|---|
| 1 | `:17` | `.normalize('NFKC')` — compatibility decomposition, then canonical composition. Test `:18` proves `ﻻ` (U+FEFB ARABIC LIGATURE LAM WITH ALEF ISOLATED FORM) → `لا`. |
| 2 | `:18` | `.replace(TASHKEEL_TATWEEL, '')` — **deletes** U+0640 and the whole U+064B–U+0672 block. |
| 3 | `:19` | `.replace(ALEF_VARIANTS, 'ا')` — folds آ/أ/إ/ٱ onto ا. |
| 4 | `:20` | `.replace(ALEF_MAKSURA, 'ي')` — folds ى onto ي. |

### 2.3 FINDING H4 — the deletion range destroys Arabic-Indic numerals

The range `U+064B`–`U+0672` is **34 codepoints wider** than the header comment at `normalize.ts:3` admits, and the extra width swallows all ten ARABIC-INDIC DIGIT characters and both Arabic numeric separators:

```
ARABIC-INDIC DIGITS deleted : U+0660 U+0661 U+0662 U+0663 U+0664 U+0665 U+0666 U+0667 U+0668 U+0669
numeric separators deleted  : U+066B (ARABIC DECIMAL SEPARATOR)  U+066C (ARABIC THOUSANDS SEPARATOR)
also deleted unintentionally : U+066A (ARABIC PERCENT SIGN), U+066D, U+066E, U+066F, U+0671, U+0672
```

Measured against the built CLI:

```
normalizeArabic('٤٠٩٦')                    -> ''            (empty string)
normalizeArabic('المنفذ ٤٠٩٦ مشغول')      -> 'المنفذ  مشغول'   (note the double space)
normalizeArabic('٤٬٥٦٧')                  -> ''            (digit + thousands separator both gone)
normalizeArabic('%85٪')                   -> '%85'         (U+066A percent sign silently dropped)
tokenize('المنفذ ٤٠٩٦ مشغول')             -> ['المنفذ','مشغول']  (no numeric token at all)
```

Retrieval consequence, measured on the shipped index:

```
search('المنفذ 4096', 3)  -> arch-ports@6.80, fail-ports-busy@6.30, lex-runtime@3.02
search('المنفذ ٤٠٩٦', 3)  -> arch-ports@3.19, lex-runtime@3.02,  fail-ports-busy@2.45
```

The ranking survives, but the score falls **53 %** (6.80 → 3.19) and, worse, `fail-ports-busy` **drops below** `lex-runtime` — a generic vocabulary chunk outranks a specific failure chunk once the discriminating number is gone. This is a live precision bug in a digit-dense corpus (`4096`, `4097`, `1420`, `4197`, `65536`, `160000`, `401`, `403`, `402`, `429`, `500`, `85 %` all appear in Tier 1). **No test covers it** — `normalize.test.ts` has no Arabic-Indic digit case.

**Comment/code contradiction, same file:** `normalize.ts:3` documents `TASHKEEL U+064B–U+0652`; the code at `:10` is `U+064B`–`U+0672`. The comment understates the destructive range by 32 codepoints and is what let the digit deletion ship. The identical wrong comment exists in the archive (`.opencode/_archive/.../normalize.ts:3`), so the drift was inherited verbatim on restore.

**Related ordering wrinkle:** `U+0671` (ALEF WASLA) is listed in `ALEF_VARIANTS` (`:11`) but is **already deleted** by stage 2 (`:18`), so stage 3 can never see it. Measured: `normalizeArabic('ٱلله')` → `'لله'` — the leading alef wasla is **removed**, not unified to `ا`. The `U+0671` member of `ALEF_VARIANTS` is unreachable dead configuration. The same input with a plain alef behaves correctly: `normalizeArabic('اَللَّه')` → `'الله'`.

### 2.4 Latin/Arabic separation — `normalizeToken`

```ts
// src/knowledge/normalize.ts:50-52
export function normalizeToken(term: string): string {
  return /[\u0600-\u06FF]/.test(term) ? normalizeArabic(term) : term.toLowerCase();
}
```

Exactly one branch decision, on a single term:

- **Term contains any codepoint in `U+0600`–`U+06FF`** → full `normalizeArabic` (NFKC + the 41-codepoint deletion + 4-alef fold + yeh fold).
- **Otherwise** → `term.toLowerCase()` and **nothing else**. `toLowerCase()` is locale-independent (not `toLocaleLowerCase`), which is correct: no Turkish-I hazard for `I`, and no locale data needed.

The deliberate design decision is documented at `normalize.ts:40-48`: **NFKC is not applied to the Latin run.** A Latin token containing `ﬁ` (U+FB01) or `²` (U+00B2) is left intact rather than rewritten to `fi`/`2`. This is asserted by the regression test at `normalize.test.ts:62-67`.

Measured:

```
normalizeToken('EADDRINUSE')     -> 'eaddrinuse'
normalizeToken('eaddrinuse')     -> 'eaddrinuse'      (same key)
normalizeToken('mp3')             -> 'mp3'
normalizeToken('s2.1-pro-free')  -> 's2.1-pro-free'
normalizeToken('Vitest')          -> 'vitest'
```

Retrieval proof on the shipped index — both cases hit the same chunk with the same score:

```
search('EADDRINUSE', 2)[0] -> fail-ports-busy@3.27
search('eaddrinuse', 2)[0] -> fail-ports-busy@3.27
```

**Limitations, stated honestly.** The test `/[\u0600-\u06FF]/` does **not** cover Arabic Supplement `U+0750`–`U+077F`, Arabic Extended-A `U+08A0`–`U+08FF`, or Arabic Mathematical Alphabetic Symbols `U+1EE00`–`U+1EEFF`. A term consisting solely of characters from those planes is treated as Latin and only lowercased. **UNVERIFIED** whether that ever occurs in practice — no corpus chunk or test uses those planes.

**Deliberately not collapsed** (pinned by test, `normalize.test.ts:70-90`):
- `ة` (TAH U+0629) is **not** folded to `ه` (HEH U+0647) — `الاعتمادية` ≠ `الاعتماديه` (`:74-82`).
- There is **no stemming** — `الاعتماديات` (plural) does not match `الاعتمادية` (singular) (`:84-90`). BM25 scores exact normalized tokens. The stated mitigation is that the corpus is authored in the forms the narrator emits — but the narrator is not wired to the corpus (§6), so that mitigation is currently **inert**.

### 2.5 Idempotence — implemented AND tested. CONFIRMED.

**Implemented** twice, deliberately:

```ts
// src/knowledge/normalize.ts:28-31  — exported predicate
export function isIdempotent(input: string): boolean {
  const once = normalizeArabic(input);
  return normalizeArabic(once) === once;
}
```

**Tested** at `src/knowledge/normalize.test.ts:33-42`:

```ts
test('normalizing twice equals normalizing once', () => {
  for (const s of ['أحمد', 'إسلام', 'آمنوا', 'الّي', 'قَتَلَ', 'مَرحَباًـٱ', 'ﻻ', 'ى']) {
    expect(isIdempotent(s)).toBe(true);
  }
});
```

8 fixed inputs, each checked for `f(f(x)) === f(x)`. The rationale is stated at `normalize.test.ts:34-36` and `normalize.ts:24-27`: `retriever.ts:53` normalizes on the index path and `retriever.ts:71` on the query path, so a non-idempotent normalizer would make an indexed term unfindable by its own query — a silent recall failure with no error.

**Not vacuous.** Idempotence holds structurally because every stage is a projection: deletion of a set of characters is idempotent, and `U+0622/U+0623/U+0625/U+0671 → U+0627` and `U+0649 → U+064A` both map into characters that no later stage matches (`U+0627` and `U+064A` are not in `U+0640` nor `U+064B`–`U+0672`, and are not alef variants or alef maksura). NFKC is idempotent per Unicode. **Caveat on strength:** the test is an 8-string spot check, not a property test — it would not catch a newly added fold whose output is itself an input to an earlier stage. My own sweep over `U+0600`–`U+06FF` and the 2-script combinations I ran found no counterexample, so the claim holds for the ranges exercised, but the test as written is weaker than the property it names. **UNVERIFIED** for the full Unicode space.

### 2.6 Test coverage of the normalizer

`src/knowledge/normalize.test.ts` — **11 tests, all passing** (`npx vitest run src/knowledge`):

| Lines | Test | Pins |
|---|---|---|
| `:9-11` | strips tashkeel, tatweel, small alef | `مَرحَباًـٱ` → `مرحبا` |
| `:13-15` | unifies alef variants + alef maksura | `أحمد إسلام آمنوا الّي` → `احمد اسلام امنوا الي` |
| `:17-19` | NFKC folding | `ﻻ` → `لا` |
| `:21-24` | diacritic evasion | `قَتَلَ` → `قتل`; `قـتـل` → `قتل` |
| `:27-30` | `tokenize` split/drop | `بدي احجز، تكسي! من المطار؟` → 5 tokens |
| `:33-42` | idempotence | 8 inputs |
| `:44-55` | Arabic unification through `normalizeToken` | `أحمد`≡`آحمد`, `الّذي`≡`الذي`, `إسلام`≡`اسلام` |
| `:57-60` | Latin case fold | `EADDRINUSE`→`eaddrinuse`, `Vitest`→`vitest` |
| `:62-67` | Latin is **not** Arabic-normalized | `mp3`, `s2.1-pro-free` unchanged |
| `:74-82` | taa marbuta **not** folded | `الاعتمادية` ≠ `الاعتماديه` |
| `:84-90` | no stemming | `الاعتماديات` ≠ `الاعتمادية` |

The comment at `:46-51` records that an earlier draft of this test used `الّي` vs `اللي` and failed, and correctly diagnoses it as two genuinely distinct inputs rather than a normalizer bug.

---

## 3. TIER 1 CORPUS — PER-FILE COUNTS AND EVERY CHUNK ID

**The brief's claim of 43 is CONFIRMED.** Measured two independent ways: regex extraction of every `id:` literal per file, and `node dist/cli.js knowledge` (§8), which prints `shared chunks : 43` and `index size : 43`.

### 3.1 Per-file counts

| File | Chunks | Exported as |
|---|---|---|
| `src/knowledge/shared/architecture.ts` | **8** | `ARCHITECTURE_CHUNKS` (`:10`) |
| `src/knowledge/shared/capabilities.ts` | **11** | `CAPABILITIES_CHUNKS` (`:9`) |
| `src/knowledge/shared/commands.ts` | **8** | `COMMAND_CHUNKS` (`:8`) |
| `src/knowledge/shared/failures.ts` | **8** | `FAILURE_CHUNKS` (`:8`) |
| `src/knowledge/shared/lexicon.ts` | **8** | `LEXICON_CHUNKS` (`:15`) |
| **TOTAL** | **43** | `SHARED_CHUNKS` (`build.ts:23-29`) |

All 43 ids are unique (`unique 43` from the extraction script). Concatenation order is fixed at `build.ts:24-28`: ARCHITECTURE, CAPABILITIES, COMMANDS, FAILURES, LEXICON.

### 3.2 `architecture.ts` — 8 chunks, `arch-*` prefix

| # | id | `source` | `text.length` |
|---|---|---|---|
| 1 | `arch-ports` | `AGENTS.md#runtime-topology; src/ipc/ui-server.ts` | 299 |
| 2 | `arch-daemon` | `AGENTS.md#layout; src/cli.ts; src/daemon.ts` | 269 |
| 3 | `arch-job-object` | `apps/desktop/src-tauri/src/main.rs` | 263 |
| 4 | `arch-token` | `AGENTS.md#runtime-topology` | 293 |
| 5 | `arch-runtime-state` | `AGENTS.md#runtime-topology` | 275 |
| 6 | `arch-vault` | `AGENTS.md#vault; src/voice/keyring.ts` | 224 |
| 7 | `arch-reachability` | `AGENTS.md#dead-code` | 214 |
| 8 | `arch-gates` | `AGENTS.md#gates` | 256 |

### 3.3 `capabilities.ts` — 11 chunks, `cap-*` prefix

| # | id | `source` | `text.length` |
|---|---|---|---|
| 9 | `cap-tts` | `src/voice/tts.ts; dossier/P1-TTS-CHUNK-LATENCY.md` | 259 |
| 10 | `cap-tts-free-tier` | `src/voice/tts.ts; CHANGELOG.md` | 267 |
| 11 | `cap-stt` | `src/voice/stt.ts` | 309 |
| 12 | `cap-ingest` | `apps/desktop/src/audio; AGENTS.md#gotchas` | 228 |
| 13 | `cap-frame-limit` | `src/ipc/protocol.ts; AGENTS.md#gotchas` | 262 |
| 14 | `cap-barge-in` | `src/daemon.ts (speechGate); src/orchestrator/audio-pipeline.ts` | 220 |
| 15 | `cap-models` | `src/orchestrator/coordinator.ts; src/orchestrator/narrator.ts; src/voice/brain.ts` | 214 |
| 16 | `cap-openrouter-ua` | `src/voice/brain.ts; AGENTS.md#models` | 314 |
| 17 | `cap-effort-none` | `src/voice/brain.ts; AGENTS.md#models` | 247 |
| 18 | `cap-narration` | `src/orchestrator/narrator.ts` | 238 |
| 19 | `cap-playback` | `apps/desktop/src/audio/playback.ts` | 228 |

### 3.4 `commands.ts` 8, `failures.ts` 8, `lexicon.ts` 8

| # | id | `source` | `text.length` |
|---|---|---|---|
| 20 | `cmd-compact` | `src/orchestrator/slash.ts` | 191 |
| 21 | `cmd-new` | `src/orchestrator/slash.ts` | 218 |
| 22 | `cmd-help` | `src/orchestrator/slash.ts` | 203 |
| 23 | `cmd-mentions` | `src/orchestrator/mentions.ts` | 257 |
| 24 | `cmd-destructive` | `src/voice/brain.ts (AMMANI_SYSTEM_PROMPT)` | 245 |
| 25 | `cmd-retry` | `src/voice/brain.ts (AMMANI_SYSTEM_PROMPT)` | 256 |
| 26 | `cmd-status` | `apps/desktop/src/App.tsx; src/ipc/protocol.ts` | 261 |
| 27 | `cmd-persona-effect` | `src/daemon.ts:607; apps/desktop/src/audio/earcons.ts; src/orchestrator/narrator.ts` | 311 |
| 28 | `fail-key-rejected` | `src/voice/keyring.ts (withKey, httpStatusOf)` | 197 |
| 29 | `fail-credit` | `src/voice/keyring.ts; dossier/FISH-AUDIO-COMPLIANCE-AUDIT.md` | 298 |
| 30 | `fail-ratelimit` | `src/voice/keyring.ts` | 210 |
| 31 | `fail-unknown` | `src/voice/keyring.ts (L17 decision)` | 174 |
| 32 | `fail-nokeys` | `src/daemon.ts; AGENTS.md#vault` | 274 |
| 33 | `fail-ports-busy` | `AGENTS.md#gotchas; apps/desktop/e2e` | 256 |
| 34 | `fail-jargon` | `AGENTS.md; docs/personas/nour.agent.md section 4` | 182 |
| 35 | `fail-firstrun` | `dossier/PHASE2_AUDIT_REPORT.md` | 273 |
| 36 | `lex-vcs` | `dossier/KNOWLEDGE-ARCHITECTURE-PROPOSAL.md tier 1 lexicon` | 285 |
| 37 | `lex-runtime` | `src/cli.ts; src/daemon.ts; src/voice/tts.ts` | 203 |
| 38 | `lex-ai` | `src/voice/stt.ts; src/voice/brain.ts; src/voice/tts.ts` | 192 |
| 39 | `lex-deps` | `package.json; AGENTS.md#commands` | 203 |
| 40 | `lex-editor` | `apps/desktop; AGENTS.md#conventions` | 265 |
| 41 | `lex-danger` | `src/voice/brain.ts (AMMANI_SYSTEM_PROMPT)` | 207 |
| 42 | `lex-errors` | `src/ipc/protocol.ts; src/voice/keyring.ts` | 163 |
| 43 | `lex-dialect` | `src/voice/brain.ts; decision locked 2026-09-28` | 270 |

### 3.5 FINDING H5 — `arch-reachability` is a wrong Tier-1 fact

`src/knowledge/shared/architecture.ts:67-73` states:

> `'الكود غير المستخدم في src هو صفر: 37 وحدة حية و 0 وحدة ميتة. ' + 'Dead code in src is zero, at 37 live modules. …'`

Measured with `%LOCALAPPDATA%\Temp\opencode\reach.mjs`, which resolves **every quoted relative specifier including dynamic `import()`** (the `U+` prefix filter `['"](\.[^'"\n]*?\.js)['"]`) transitively from `src/daemon.ts` and `src/cli.ts`:

```
LIVE production modules : 51
DEAD production modules : 0
live source lines       : 8056
dead source lines       : 0
unresolved relative specs: NONE
```

This matches `AGENTS.md:92-95` **exactly**. The chunk's "37" is stale by **14 modules** and its own cited authority (`AGENTS.md#dead-code`) contradicts it. This is a Tier-1 ground-truth chunk carrying a false number about the codebase it documents — the precise failure mode Tier 1 exists to prevent. No test validates chunk *content*, only structure (`corpus.test.ts:141-157` checks id uniqueness, non-empty `source`, and `text.length > 20`).

### 3.6 Citation resolution — all 70 file paths resolve

`%LOCALAPPDATA%\Temp\opencode\cites.mjs` extracted every `src/`, `apps/`, `dossier/`, `docs/`, `AGENTS.md`, `CHANGELOG.md`, `package.json` token from all 43 `source:` fields and tested each against the filesystem. **70 tokens checked, 70 `OK`, 0 `MISSING`.** Provenance is physically resolvable, which is the property `types.ts:29` promises. Two *content-level* citations are nonetheless wrong — see H8 and §9.

---

## 4. THE COMPILE-TIME PARITY GUARD

### 4.1 `SharedChunk` has no persona member

```ts
// src/knowledge/types.ts:26-32
/** Tier 1 — shared ground truth. Carries no persona, by design and by type. */
export interface SharedChunk {
  readonly id: string;
  /** Provenance: repo path or upstream reference. Never a secret. */
  readonly source: string;
  readonly text: string;
}
```

Four members, no `persona`. Contrast `types.ts:42-49`, where `StylisticExample` **does** carry `persona: PersonaId` — the asymmetry is intentional and one-directional.

### 4.2 `SHARED_HAS_NO_PERSONA`

```ts
// src/knowledge/types.ts:51-58
/**
 * COMPILE-TIME parity proof. If a `persona` member is ever added to
 * `SharedChunk`, the `false` literal stops typechecking and `npm run typecheck`
 * fails. Deliberately a value assignment, not `@ts-expect-error`, so the failure
 * is loud rather than silently inverted.
 */
type HasPersona = 'persona' extends keyof SharedChunk ? true : false;
export const SHARED_HAS_NO_PERSONA: HasPersona = false;
```

Mechanism: a **conditional type** (`:57`) resolves `'persona' extends keyof SharedChunk ? true : false`. Because `SharedChunk` has no `persona` key, `HasPersona` is the literal type `false`. The annotated initializer `= false` (`:58`) therefore typechecks. The instant a `persona` member is added, `HasPersona` becomes `true`, and assigning `false` to a `true`-typed const is `TS2322`.

Two properties the design comment (`:53-55`) claims, both confirmed:
- **No `@ts-expect-error`.** An `@ts-expect-error` suppresses the next line's error *and* itself errors if the next line stops erroring — so a guard that stops guarding turns into a different failure. A plain value assignment has no such inversion: removing `persona` from `SharedChunk` makes the assignment *valid* again, and the guard silently becomes trivially true, which is the correct outcome in that direction.
- The export is `const`, so it is also a **runtime** value: `corpus.test.ts:21-23` asserts `expect(SHARED_HAS_NO_PERSONA).toBe(false)`. Compile-time proof and runtime observation agree.

### 4.3 WHY it lives in a non-test file

Because **`tsconfig.json:20` excludes it from the program and Vitest does not typecheck.**

```json
// tsconfig.json:19-20
"include": ["src/**/*.ts"],
"exclude": ["node_modules", "dist", "**/*.test.ts"]
```

A type-level guard written in `src/knowledge/corpus.test.ts` would be enforced **nowhere**:

1. `tsconfig.json:20` removes `**/*.test.ts` from the program, so `npm run typecheck` (`tsc -p tsconfig.json`, which exits 0 today) never sees the file.
2. `vitest.config.ts:5` sets `include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'bench/**/*.bench.ts']`. Vitest transpiles via esbuild, which **strips types without checking them**. A `@ts-expect-error` or a conditional-type assertion in a test file is erased before it runs.
3. Result: the assertion would be a comment. `corpus.test.ts:17-19` states this explicitly and it is **correct**:
   > *"The compile-time half (`SHARED_HAS_NO_PERSONA`) is in types.ts because tsconfig excludes **/*.test.ts and Vitest does not typecheck — a type guard placed here would be enforced nowhere."*

`types.ts:17-19` states the same from the other side.

**So there are exactly two enforcement layers, and neither is optional:**

| Layer | Location | Mechanism | Fires on |
|---|---|---|---|
| Compile-time | `types.ts:57-58` | conditional type + typed const | `tsc` at `npm run typecheck` (gate step 1) |
| Runtime | `types.ts:76-84` `assertSharedChunks` | `Object.prototype.hasOwnProperty.call(chunk, 'persona')` | `InMemoryRetriever` constructor, `retriever.ts:47` |
| Report | `build.ts:93-97` `verifyKnowledge` | same `hasOwnProperty` sweep | `assertParity()`, `build.ts:122` |
| Observed | `corpus.test.ts:20-36` | `toBe(false)`, per-chunk loop, cast-past-type throw | vitest |

`assertSharedChunks` in full:

```ts
// src/knowledge/types.ts:76-84
export function assertSharedChunks(chunks: readonly SharedChunk[]): void {
  for (const chunk of chunks) {
    if (Object.prototype.hasOwnProperty.call(chunk, 'persona')) {
      throw new KnowledgeParityError(
        `Tier 1 chunk "${chunk.id}" carries a persona key. …`,
      );
    }
  }
}
```

`Object.prototype.hasOwnProperty.call` rather than `'persona' in chunk` is the correct choice: it does not walk the prototype chain, so a `SharedChunk` cannot trip the guard merely by inheriting a `persona` from `Object.prototype`. The doc at `:68-75` names the three bypasses it exists for: `as unknown as SharedChunk` casts, JSON-loaded chunks, and objects spread from a wider source. All three are real, all three bypass the type, and all three are caught here.

### 4.4 PROVING the guard is non-vacuous — procedure and expected error

**Procedure (do not apply to the repo; use an out-of-tree mirror, as I did):**

1. Copy the type relationship from `types.ts:57-58` plus the `SharedChunk` declaration from `types.ts:27-32` into a scratch file **outside** the repo — I used `%LOCALAPPDATA%\Temp\opencode\parity-probe\probe.ts`. This satisfies the project rule in `AGENTS.md` ("keep scratch/verification scripts in `%LOCALAPPDATA%\Temp\opencode\`, never in the repo") and leaves `O:\opencode-Vantrilex` untouched.
2. Declare a **second** interface identical to `SharedChunk` **plus** `readonly persona: PersonaId`, and apply the identical `type HasPersona = 'persona' extends keyof … ? true : false; const X: HasPersona = false;` pattern to it. Two declarations in one file so the clean one acts as the control.
3. Run `npx tsc --noEmit --strict --target ES2023 <probe.ts>`.

**Observed result — control passes, leaky fails, exactly one error:**

```
probe.ts(22,14): error TS2322: Type 'false' is not assignable to type 'true'.
```

Line 22 is the **leaky** declaration. Line 12 — the shipped `SharedChunkClean` shape with `SHARED_HAS_NO_PERSONA: false` — produces **no error**. That asymmetry is the proof of non-vacuity: the annotation is not inert, and the failure is specific to the added `persona` member.

**Expected error if applied to the real repo:** add `readonly persona: PersonaId;` to `SharedChunk` at `src/knowledge/types.ts:31`, then run `npm run typecheck`. Expected:

```
src/knowledge/types.ts(58,14): error TS2322: Type 'false' is not assignable to type 'true'.
```

and **nothing else** — the conditional type is the only thing that changes, so the error is a single line at the guard, not a cascade. (My probe run also emitted 8 unrelated `TS2792` errors from `node_modules/@types/*` about `moduleResolution`; those are artifacts of invoking `tsc` on a single file outside a project config, are present regardless of the probe, and are not part of this guard. `npx tsc --noEmit -p tsconfig.json` in the repo exits **0** with no output.)

**Caveat — the guard is narrower than the invariant it names.** `SHARED_HAS_NO_PERSONA` proves the *type* `SharedChunk` has no `persona` key. It does not prove that a *value* typed `SharedChunk` carries none, because `as unknown as SharedChunk` is legal TypeScript. That gap is exactly why `assertSharedChunks` (`types.ts:76`) and `verifyKnowledge` (`build.ts:96`) exist, and `corpus.test.ts:32-35` tests the cast path directly:

```ts
const leaky = [{ id: 'x', source: 's', text: 't', persona: 'nour' }] as unknown as SharedChunk[];
expect(() => assertSharedChunks(leaky)).toThrow(KnowledgeParityError);
```

The layered design is correct; the compile-time layer alone would not be.

### 4.5 `StylisticExample` has no fact field

```ts
// src/knowledge/types.ts:42-49
export interface StylisticExample {
  readonly id: string;
  readonly persona: PersonaId;
  /** Condition under which this construction applies, in plain English. */
  readonly when: string;
  /** How the persona says it. Ammani; technical terms stay in English. */
  readonly say: string;
}
```

Four members. There is no `text`, `fact`, `value`, `capability`, or `number` field in which a fact could be written. Pinned by `corpus.test.ts:72-78`:

```ts
expect('text' in ({} as StylisticExample)).toBe(false);
const example = NOUR_EXAMPLES[0]!;
expect(Object.keys(example).sort()).toEqual(['id', 'persona', 'say', 'when']);
```

The second assertion is the strong one: it pins the **runtime key set** of a shipped value, so a fifth field fails the test even if the type were widened in the same commit.

### 4.6 `PARITY_INVARIANT` and the weak `buildIndex.length` assertion

```ts
// src/knowledge/types.ts:92-93
export const PARITY_INVARIANT =
  'One index, SharedChunk only. Styling is selected by `when`, never retrieved. No per-persona index exists.';
```

Asserted at `corpus.test.ts:66-68` via `toContain('No per-persona index')`.

**Weakness found.** `corpus.test.ts:39-44` claims to prove "there is exactly one index and it takes no persona argument":

```ts
// Not a style assertion: `buildIndex` has no persona parameter, so a
// per-persona index is not constructible from this API.
expect(buildIndex.length).toBe(0);
expect(buildIndex().size).toBe(SHARED_CHUNKS.length);
```

`buildIndex.length` is `Function.length`, the count of parameters **before** the first defaulted one. `build.ts:72` is `export function buildIndex(chunks: readonly SharedChunk[] = SHARED_CHUNKS)`, so its arity is legitimately 0 — but for a reason unrelated to persona. The test would also pass if `buildIndex` were `function buildIndex(persona?: PersonaId)` with an empty body. It has some force (adding a **required** persona parameter would make arity 1 and fail it), but the comment oversells it. The genuinely load-bearing checks are `assertParity()` (`corpus.test.ts:62-64`) and the single-index identity at `:43`.

### 4.7 The digest — and FINDING H9

`sharedDigest` (`build.ts:50-63`) hashes `id + NUL + source + NUL + text`, joined with `SOH`. **Byte-accurate, measured:**

```
build.ts:52   "    .map((c) => `${c.id}\u0000${c.source}\u0000${c.text}`)"
build.ts:53   "    .join('\u0001');"
```

`src/knowledge/build.ts` contains **two raw `U+0000` bytes at file offsets 2047 and 2059** (line 52). Consequence: the standard file reader classifies `build.ts` as **binary** and refuses to serve it as text — I hit this twice while auditing. `git diff` renders the line as if the separators were spaces, so a reviewer cannot see them. Nothing in the gate catches it; `tsc` and vitest both pass because `\u0000` is a legal string character.

The digest is a 32-bit FNV-1a mix run twice and concatenated (`build.ts:55-62`): `h1` seeded `0x811c9dc5` (FNV offset basis) and `h2` seeded `0x01000193` (which is the FNV **prime**, an unusual seed), with multipliers `0x01000193` and `0x85ebca6b` respectively. Output is two 8-hex halves → 16 chars. Measured value for the shipped corpus: **`c12f74d0a29f1c46`**, reproduced identically by `sharedDigest()` and by `verifyKnowledge().digest` (`true`). It is correctly labelled at `build.ts:45-48` as a **change detector, not a cryptographic provenance guarantee**, and `build.ts:46-48` documents that reordering chunks also changes it — verified: the digest is over declaration order, `build.ts:23-29`.

The recommendation is to write the separators as escape sequences (`'\u0000'`, `'\u0001'`) so the file stays text-classified. **Not applied** — out of scope for this audit.

---

## 5. STYLING TIERS — EVERY `StylisticExample`

### 5.1 Nour — 8 examples, `src/knowledge/styles/nour.ts:13-62`

| # | id | `persona` | `when` | `say` |
|---|---|---|---|---|
| 1 | `nour-confirm` (:15) | `nour` (:16) | the request is unambiguous and one path is obviously right (:17) | تمام، بس للتأكيد — بروح عليها هسأ. (:18) |
| 2 | `nour-probe` (:21) | `nour` (:22) | the request is ambiguous and a reasonable default exists (:23) | تمام، بس للتأكيد: تقصد تحدّث الـ dependency ولا تبعّدها؟ (:24) |
| 3 | `nour-context-first` (:27) | `nour` (:28) | a task finished successfully (:29) | خلص — يعني الـ pipeline كله صار يمرّ من أول مرة. (:30) |
| 4 | `nour-failure` (:33) | `nour` (:34) | a step failed and the cause is known (:35) | وقف عند الـ lint. براجع السطر المسؤول وبترجعلك. (:36) |
| 5 | `nour-ask-destructive` (:39) | `nour` (:40) | the action is destructive (delete, drop, force-push, deploy, rm -rf) (:41) | هاي العملية بتبلع كل شي — تتأكد قبل ما أنفّذ؟ (:42) |
| 6 | `nour-credit` (:45) | `nour` (:46) | the provider returned 402 (:47) | الرصيد خلص. المفتاح سليم — المشكلة بالحد، مش بالمفتاح. (:48) |
| 7 | `nour-key` (:51) | `nour` (:52) | the provider returned 401 or 403 (:53) | المفتاح مرفوض، وبدنا مفتاح جديد. دوّرت للـ pool تلقائياً. (:54) |
| 8 | `nour-compact` (:57) | `nour` (:58) | context occupancy is above 85 percent (:59) | الـ context-window وصل 85٪، حكيت Compact هسأ وقبل ما يطلع (:60) |

### 5.2 Kareem — 8 examples, `src/knowledge/styles/kareem.ts:12-61`

| # | id | `persona` | `when` | `say` |
|---|---|---|---|---|
| 1 | `kareem-proceed` (:14) | `kareem` (:15) | the request is unambiguous and one path is obviously right (:16) | يا غالي، هسا بنرتبها — بتنفذ وبلحكيلك النتيجة. (:17) |
| 2 | `kareem-assume` (:20) | `kareem` (:21) | the request is ambiguous and a reasonable default exists (:22) | بفترض إنك تقصد X، هسا بشتغل عليه، وإذا غلطت قلّي وبعدّل. (:23) |
| 3 | `kareem-state-change` (:26) | `kareem` (:27) | a task finished successfully (:28) | خلص الـ build، والـ tests كلها خضرا. (:29) |
| 4 | `kareem-failure` (:32) | `kareem` (:33) | a step failed and the cause is known (:34) | وقفت عند الـ lint، والسبب سطر واحد في ملف الإعدادات. (:35) |
| 5 | `kareem-ask-destructive` (:38) | `kareem` (:39) | the action is destructive (delete, drop, force-push, deploy, rm -rf) (:40) | هاي العملية بتبلع كل شي — بتأكد قبل ما أنفّذ؟ (:41) |
| 6 | `kareem-credit` (:44) | `kareem` (:45) | the provider returned 402 (:46) | الرصيد خلص. المفتاح سليم — المشكلة بالحد، مش بالمفتاح. (:47) |
| 7 | `kareem-key` (:50) | `kareem` (:51) | the provider returned 401 or 403 (:52) | المفتاح مرفوض، وبدنا مفتاح جديد. دوّرت للـ pool تلقائياً. (:53) |
| 8 | `kareem-compact` (:56) | `kareem` (:57) | context occupancy is above 85 percent (:58) | الـ context-window وصل 85٪، حكيت Compact هسأ قبل ما يطلع (:59) |

**Total: 16 StylisticExamples** (8 + 8), matching `verifyKnowledge().nourExamples = 8` and `.kareemExamples = 8`.

### 5.3 Coverage symmetry on the `when` key — CONFIRMED PERFECT

Measured by loading the built module and set-comparing the two `when` sets:

```
nour when-set size 8, kareem when-set size 8
MATCH  1. the request is unambiguous and one path is obviously right
MATCH  2. the request is ambiguous and a reasonable default exists
MATCH  3. a task finished successfully
MATCH  4. a step failed and the cause is known
MATCH  5. the action is destructive (delete, drop, force-push, deploy, rm -rf)
MATCH  6. the provider returned 402
MATCH  7. the provider returned 401 or 403
MATCH  8. context occupancy is above 85 percent
byte-identical whens: true
```

All 8 `when` strings are **byte-identical** across personas. Zero orphans in either direction. `verifyKnowledge().styleIdAsymmetries = 0` (`build.ts:104-108`) and `corpus.test.ts:91-101` both compare on `when`, and the comment at `build.ts:99-103` records the bug this fixed:

> *"Comparing ids here was a real bug: it reported asymmetry on a corpus that was fully symmetric, and would have reported symmetry on one that was not."*

Ids are deliberately per-persona-suffixed (`nour-confirm` vs `kareem-proceed`), so id-comparison would always report 16 asymmetries. `corpus.test.ts:80-89` separately pins that no id appears in both files and that each `persona` tag matches its file.

### 5.4 FINDING H7 — coverage is symmetric but 2 of 8 phrasings are byte-identical

Symmetry on `when` says nothing about the *phrasing*. Measured per pair:

```
differs   the request is unambiguous and one path is obviously right
differs   the request is ambiguous and a reasonable default exists
differs   a task finished successfully
differs   a step failed and the cause is known
differs   the action is destructive (delete, drop, force-push, deploy, rm -rf)
IDENTICAL the provider returned 402
IDENTICAL the provider returned 401 or 403
differs   context occupancy is above 85 percent
```

`nour-credit.say` and `kareem-credit.say` are the **same string** (`capabilities.ts`/`nour.ts:48` ≡ `kareem.ts:47`). `nour-key.say` and `kareem-key.say` are likewise the same string (`nour.ts:54` ≡ `kareem.ts:53`). Under a future wiring, Nour and Kareem would say **word-for-word identical** lines in the two most safety-critical situations — 402 (do not blame the key) and 401/403 (do replace the key). Given `failures.ts:5-7` calls the 401-vs-402 distinction "the load-bearing distinction in this file", having the two personas read identically at exactly that decision point is the wrong place to economize.

`corpus.test.ts:103-121` does **not** catch this. It checks (a) the two *concatenated* corpora differ, (b) the `ambiguous` pair differs on `؟`, and (c) the `destructive` pair is a question for both. There is no per-`when` distinctness assertion. A one-line addition — for each shared `when`, assert `NOUR_EXAMPLES.find(...)!.say !== KAREEM_EXAMPLES.find(...)!.say` for the six non-safety-pinned situations — would close it. Deliberately: 402 and 401/403 could legitimately be exempted, in which case the invariant is "distinct except where a shared script is deliberate", and that must be written down. As shipped, it is neither asserted nor documented.

### 5.5 Dialect conformance of the styling files

`corpus.test.ts:123-132` bans stiff MSA newsreader openers and requires both an Arabic letter and an English letter in each corpus:

```ts
expect(e.say).not.toMatch(/^حاضر|^سأقوم|^سيتم|^تم تنفيذ/);
expect(e.say).toMatch(/[؀-ۿ]/);
expect(NOUR_EXAMPLES.map(e=>e.say).join(' ')).toMatch(/[A-Za-z]/);
expect(KAREEM_EXAMPLES.map(e=>e.say).join(' ')).toMatch(/[A-Za-z]/);
```

Passing. `nour.ts:18` and `kareem.ts:17` are unambiguously Ammani (`بروح عليها هسأ`, `هسا بنرتبها`, `بتنفذ وبلحكيلك النتيجة`). Note the ban regex is **anchored to line start** and only lists 4 MSA openers; it would not catch a stiff construction mid-sentence. Weak, but not vacuous.

---

## 6. CRITICAL — THE PERSONA-BLIND QUESTION

### 6.1 Exhaustive token census

`%LOCALAPPDATA%\Temp\opencode\census.mjs` counted `persona`, `Persona`, `PERSONA`, `kareem`, `nour`, `Kareem`, `Nour`, `voiceId`, `VoiceId` in each file, split into **all occurrences** and **non-comment-only** (a line is a comment if it starts with `//`, `*`, or `/*`):

```
src/orchestrator/narrator.ts  (137 lines, 47 comment lines)
   ALL TOKENS      : {} => total 0
   NON-COMMENT ONLY: {} => total 0

src/orchestrator/coordinator.ts  (308 lines, 48 comment lines)
   ALL TOKENS      : {} => total 0
   NON-COMMENT ONLY: {} => total 0

src/orchestrator/prompt-optimizer.ts  (104 lines, 31 comment lines)
   ALL TOKENS      : {} => total 0
   NON-COMMENT ONLY: {} => total 0

src/voice/brain.ts  (362 lines, 83 comment lines)
   ALL TOKENS      : {} => total 0
   NON-COMMENT ONLY: {} => total 0

src/daemon.ts  (755 lines, 193 comment lines)
   ALL TOKENS      : {"persona":13,"Persona":10,"kareem":3,"nour":3,"voiceId":2} => total 31
   NON-COMMENT ONLY: {"Persona":9,"kareem":3,"nour":3,"persona":6,"voiceId":2} => total 23

src/knowledge/personas.ts  (55 lines, 19 comment lines)
   ALL TOKENS      : {"Persona":8,"persona":2,"Kareem":2,"Nour":2,"kareem":2,"nour":2,"PERSONA":1} => total 19
   NON-COMMENT ONLY: {"Persona":8,"kareem":2,"Kareem":1,"nour":2,"Nour":1,"PERSONA":1} => total 15

src/knowledge/retriever.ts  (91 lines, 28 comment lines)
   ALL TOKENS      : {"persona":4} => total 4
   NON-COMMENT ONLY: {} => total 0
```

**Counts per file, as requested:**

| File | persona-family tokens (all) | in comments | in code | reaches a prompt? |
|---|---|---|---|---|
| `src/orchestrator/narrator.ts` | **0** | 0 | **0** | **NO** |
| `src/orchestrator/coordinator.ts` | **0** | 0 | **0** | **NO** |
| `src/orchestrator/prompt-optimizer.ts` | **0** | 0 | **0** | **NO** |
| `src/voice/brain.ts` | **0** | 0 | **0** | **NO** |
| `src/daemon.ts` | 31 | 8 | 23 | **NO** — see §6.3 |
| `src/knowledge/personas.ts` | 19 | 4 | 15 | **NO** — no production caller |
| `src/knowledge/retriever.ts` | 4 | 4 | 0 | **NO** — no production caller |

The four prompt-owning files are not merely "low" on persona — they are at **exactly zero**, comments included. This confirms `docs/personas/WIRING.md:24` ("`narrator.ts` contains **zero** occurrences of `persona`, `voiceId`, or `PersonaId`") as **code-accurate**.

### 6.2 All four system prompts, in full — no persona parameter anywhere

| Constant | Location | Lines | Persona-reachable? |
|---|---|---|---|
| `NARRATOR_SYSTEM` | `src/orchestrator/narrator.ts:68-78` | 9 entries (`:69`-`:77`) | **No.** Built by `[...].join('\n')` from string literals. |
| `intakeSystem(ctx?)` | `src/orchestrator/coordinator.ts:70-89` | 17 array entries | **No.** Its only interpolation is `intakeContextBlock(ctx)` (`:87`). |
| `COORDINATOR_SYSTEM` | `src/orchestrator/coordinator.ts:92-96` | 3 entries | **No.** Three literals, `.join('\n')`. Not exported. |
| `PROMPT_SYSTEM` | `src/orchestrator/prompt-optimizer.ts:66-73` | 6 entries | **No.** Six literals, `.join('\n')`. |
| `AMMANI_SYSTEM_PROMPT` | `src/voice/brain.ts:105-116` | 10 entries | **No.** Ten literals, `.join('\n')`. |

The **only** interpolation into any system prompt in the whole product:

```ts
// src/orchestrator/narrator.ts:113
const system = NARRATOR_SYSTEM.replace('{max}', String(maxWords));
```

`{max}` is a **numeric word cap**, substituted at `:113` from the `maxWords = 20` default (`:111`). There is no second interpolation anywhere. The user message, by contrast, is dynamic — `narrationContextLine(ctx)` (`narrator.ts:81-89`) — but it too has no persona member: `NarrationContext` (`narrator.ts:53-66`) is `{action, outcome, target?, previousModel?, sessionTitle?, contextPercent?, errorDetail?}`. No persona.

### 6.3 The single `narrate()` call site passes three arguments

```ts
// src/daemon.ts:196-208
const line = await narrate(
  {
    action,
    outcome: outcomeOk ? 'ok' : 'error',
    ...(target !== undefined ? { target } : {}),
    ...(sessionTitle !== undefined ? { sessionTitle } : {}),
    ...(currentModel !== undefined ? { previousModel: currentModel } : {}),
    ...(contextPercent !== undefined ? { contextPercent } : {}),
    ...(errorDetail !== undefined ? { errorDetail } : {}),
  },
  narratorChat,
  NARRATOR_MODEL,
);
```

`narrate`'s signature is `(ctx, chat, model, maxWords = 20)` (`narrator.ts:107-112`). **Three arguments passed.** `maxWords` uses its default. There is no fourth parameter to pass a persona into, and `daemon.ts` holds `activePersona` in scope at line 115 and does not use it here. `activePersona` is read in `daemon.ts` at exactly four places:

| Line | Use | Effect class |
|---|---|---|
| `:256-259` | `if (activePersona === persona) return;` → `ui.setPersona(persona)` → `ui.notice('persona-changed', persona, 'info')` | **UI state** |
| `:607` | `VOICE_IDS[activePersona === 'nour' ? 'female-toggle' : 'male-default']` | **TTS voice id** |
| `:698` | `activePersona: () => activePersona` | **IPC accessor** |
| `:115` | declaration, default `'kareem'` | — |

Not one of these touches a prompt, a knowledge retrieval, or a styling selection.

### 6.4 The three `narrate()` inputs are identical for both personas — so the outputs are identical

Given identical `NARRATOR_SYSTEM` (`:113`, no persona), an identical `NarrationContext` (`:81-89`, no persona member), and an identical model (`NARRATOR_MODEL` = `'thinkingmachines/inkling:free'`, `narrator.ts:36`), the only remaining degree of freedom is the provider's own non-determinism. Two runs with the same context can differ; **two different personas with the same context are drawn from the identical distribution.**

### 6.5 VERDICT, stated plainly

> **Yes. Nour and Kareem produce identical narration.** Not "similar" — *identical by construction*, because no persona identifier reaches `NARRATOR_SYSTEM` and none can, given the current `narrate()` signature and the three-argument call site at `daemon.ts:196`.

> **The ONLY current persona effects in the shipped runtime are three, all presentational:**
> 1. **TTS voice id** — `daemon.ts:607`, `VOICE_IDS[activePersona === 'nour' ? 'female-toggle' : 'male-default']`, with the two Fish model ids at `src/common/brands.ts:22-25` (`male-default` = `5b90451e…`, `female-toggle` = `88c0375e…`).
> 2. **Completion earcon pitch** — `apps/desktop/src/audio/earcons.ts:17-18`: `kareem-done` 659.25 → 987.77 Hz, `nour-done` 987.77 → 1318.5 Hz.
> 3. **Wave colour** — `apps/desktop/src/App.tsx:415` selects `waveSpeaker`, `:563` passes `SPEAKER_PALETTE[waveSpeaker]`; palette at `apps/desktop/src/components/waveform/SiriWaveCanvas.tsx:20-24`: `kareem: ['#16A34A', '#EAB308']`, `nour: ['#9333EA', '#EC4899']`.
>
> Plus a fourth, non-audible: **persona state replication** across surfaces — `ui.setPersona` (`ui-server.ts:132-133`), the `persona-changed` notice, and the `persona` field in the `hello` frame (`ui-server.ts:383-385`, schema `protocol.ts:312-317`), consumed by `App.tsx:122` and `SettingsView.tsx:87`.

Two people delivering the same words in different voices and different colours. The distinction is real to the user, absent from the audio content.

### 6.6 FINDING H1 — the knowledge layer is not in the runtime path at all

An exhaustive search for every `src/knowledge/` export across all non-test `.ts`/`.tsx` files in `src/` and `apps/desktop/src/`:

```
buildIndex           src\cli.ts x2
verifyKnowledge      src\cli.ts x2
assertParity         src\cli.ts x2
screenText           NO PRODUCTION CALLER
guardText            NO PRODUCTION CALLER
shieldHolds          NO PRODUCTION CALLER
NOUR_EXAMPLES        NO PRODUCTION CALLER
KAREEM_EXAMPLES      NO PRODUCTION CALLER
STYLISTIC_EXAMPLES   NO PRODUCTION CALLER
SHARED_CHUNKS        NO PRODUCTION CALLER
InMemoryRetriever    NO PRODUCTION CALLER
PERSONAS             NO PRODUCTION CALLER
```

The single import in the whole product:

```ts
// src/cli.ts:17
import { assertParity, buildIndex, verifyKnowledge } from './knowledge/index.js';
```

Consequences, each of which is a finding in its own right:

1. **The 43-chunk Tier-1 corpus is never retrieved at runtime.** `InMemoryRetriever` is instantiated only at `build.ts:73`, which is called only from `cli.ts:213`. No model ever sees a Tier-1 chunk.
2. **All 16 StylisticExamples are inert.** Nothing reads them outside `corpus.test.ts`.
3. **`personas.ts` is inert.** `shieldHolds` — the v1 feminine-self-reference shield that `personas.ts:46-54` exists to police — has **zero** production callers. A Nour reply saying `أنا جاهز` (masculine) would be **spoken**; nothing checks.
4. **The Tier-D moral guardrail is inert.** `screenText`/`guardText` (`guard.ts:18`, `:31`) have **zero** production callers, and the `blocklist` argument is **injected from outside the repo** per `guard.ts:5-6` — so not only is the guard unwired, its data source does not exist in this repository. Nothing in the shipped product can block speech.
5. **`AGENTS.md:92-95`'s "51 live / 0 dead" is technically true and behaviourally misleading.** The 15 knowledge modules count as live only because `cli.ts:17` imports them. This is exactly the `mentions.ts`/`slash.ts`/`prompt-optimizer.ts` pattern `AGENTS.md:70-80` describes — "a green suite plus a confident changelog is not evidence that a feature ships" — reproduced in the layer that exists specifically to prevent it. `src/knowledge/index.ts:4-7` is **honest** about this and deserves credit:
   > *"The knowledge layer is NOT wired into the live narration path yet — that is a separate, reviewed step (`docs/personas/WIRING.md`), and claiming otherwise would be the exact 'documented as shipped while unreachable' defect this project keeps hunting."*

   The file that documents the defect is not the defect. `AGENTS.md:14` describing `src/knowledge/` in the present tense ("Tier-1 shared ground truth + Tier-2/3 styling … Entry: `node dist/cli.js knowledge`") is accurate, because the last clause is the CLI. No contradiction.

### 6.7 FINDING H3 — Tier 1 asserts its own falsehood

`src/knowledge/shared/commands.ts:69-78`, chunk `cmd-persona-effect`:

```ts
source: 'src/daemon.ts:607; apps/desktop/src/audio/earcons.ts; src/orchestrator/narrator.ts',
text:
  'اختيار الشخصية يغيّر الصوت ونغمة التنبيه ولون الموجة، ' +
  'وأسلوب الكلام نفسه يأتي من تعليمات القصة في dossier. ' +
  'Selecting a persona changes the voice id, the completion earcon tone and the wave ' +
  'colour. The spoken phrasing comes from the dossier instructions, which are injected ' +
  'into the narrator, not from the voice.',
```

Sentence 1 is **true** (`daemon.ts:607`, `earcons.ts:17-18`, `SiriWaveCanvas.tsx:20-24`). Sentence 2 is **false on both halves**:
- No dossier instruction is injected into the narrator. `narrator.ts` has 0 persona tokens (§6.1); `daemon.ts:196-208` passes 3 arguments; `NARRATOR_SYSTEM` (`:68-78`) is nine string literals.
- The only source it cites for the claim is `src/orchestrator/narrator.ts` — a file that contains the **opposite**.

This is the highest-leverage instance of H1's damage. The moment §6.6 is fixed, this chunk is the *source of the truth* the narrator would be given, and it would tell the model that dossier instructions are already being injected — inviting the model to *assume* a persona it was never told. It also demonstrates the inversion risk in the design: `types.ts:38-41` removes `text` from `StylisticExample` so "no fact can be placed in one", but **`SharedChunk.text` is where a false fact most naturally lands**, and nothing validates chunk *prose*. `corpus.test.ts:140-157` ("corpus integrity") checks only id uniqueness, non-empty `source`, and `text.length > 20`.

`docs/personas/WIRING.md:1-6` already carries the correct banner ("**Nothing in this file is implemented.**"), and §2.2 even names the module that does not exist (`src/orchestrator/personas.ts` — `Test-Path` on that path: absent; the shipped `PERSONAS` map is in `src/knowledge/personas.ts:44`, and it holds `PersonaProfile` objects, not `Record<PersonaId, string>` directives). So the correct state is documented; the incorrect state is **also** documented, in Tier 1, where it will be trusted.

---

## 7. THE DIALECT LOCK

### 7.1 Is Ammani / White-Jordanian actually in the code? — YES, in five places

| # | Location | Evidence |
|---|---|---|
| 1 | `src/knowledge/personas.ts:9-11` | `// The quarantined profiles already carried Jordanian markers, which resolved the open dialect question: the live brain prompt bans *MSA newsreader prose and Beirusi*, and Jordanian Ammani is neither. DIALECT LOCKED: Ammani / White Jordanian, English technical terms preserved, no stiff newsreader MSA.` |
| 2 | `src/knowledge/personas.ts:29` | KAREEM `toneMarkers: ['يا غالي', 'يا كبير', 'ولا يهمك', 'هسا بنرتب', 'هسا بنرتبها']` — `هسا` is colloquial Levantine/Ammani, impossible in MSA. |
| 3 | `src/knowledge/personas.ts:40` | NOUR `toneMarkers: ['تمام، بس للتأكيد', 'من عيوني', 'ولا تشيل هم', 'تمام']` — same register. |
| 4 | `src/knowledge/shared/lexicon.ts:75-84` | chunk `lex-dialect`, `source: 'src/voice/brain.ts; decision locked 2026-09-28'`: `'The dialect is Ammani, White Jordanian Arabic, natural and respectful, never stiff newsreader Modern Standard Arabic and never Beirusi slang. Technical terms stay in English.'` |
| 5 | `src/knowledge/guard.ts:8-10` | `// REFUSAL_AR is Jordanian and matches the locked dialect` … `export const REFUSAL_AR = 'هالموضوع ما بناسبنا نناقشه، خلينا مركزين بشغلنا المفيد';` — `بناسبنا` / `بشغلنا` are colloquial Ammani pronouns; MSA would be `لا يناسبنا` / `عملنا`. |
| 6 | `src/knowledge/styles/*.ts` | All 16 `say` strings are colloquial: `بروح عليها هسأ`, `بنرتبها`, `بلحكيلك`, `بفترض إنك تقصد`, `خلص`, `دوّرت للـ pool`, `حكيت Compact هسأ`. Zero MSA constructions. |

Test coverage: `personas.test.ts:53-69`, `describe('locked dialect: Ammani / White Jordanian')`, asserts both locked constructions are present (`:56-58`) and that no tone marker matches `/سأقوم|حاضر،|سأقوم بتنفيذ/` or the Beirusi set `/هلق|شو|كيفك/` (`:66-67`).

### 7.2 Does the lock conflict with any LIVE system prompt? — NO. The live prompt is the origin.

`src/voice/brain.ts:105-116`, `AMMANI_SYSTEM_PROMPT`. The two dialect-bearing lines:

```
brain.ts:106   'You are an Ammani Jordanian Arabic voice peer for a developer; synthesize every reply'
brain.ts:107   'dynamically in everyday Ammani software parlance with fluid English tech terms.'
brain.ts:108   'Never MSA newsreader prose, Beiruti slang, or foreign dialects; never repeat examples verbatim.'
brain.ts:109   'Keep code, paths, logs, error codes, sessions, commands in technical English.'
```

The constant is literally **named** `AMMANI_SYSTEM_PROMPT` and is the only prompt in the product that carries a dialect instruction. `lex-dialect`'s citation of `src/voice/brain.ts` is therefore **accurate**, and `personas.ts:9-11`'s claim that the lock *derived from* the brain prompt is **true**.

**No conflict exists in code.** The lock is coherent, and the code is the source of the decision.

### 7.3 FINDING H6 — the two dossiers contradict the lock, and each other

The lock was settled; `docs/personas/` was never updated. Both dossiers declare the **opposite** register:

| File:line | Text | Register declared |
|---|---|---|
| `docs/personas/nour.agent.md:15-16` | `تتكلّم العربية الفصحى المبسّطة بنبرة هادئة وودّية` | **Simplified MSA** |
| `docs/personas/nour.agent.md:34-36` | `She speaks Simplified Modern Standard Arabic with a warm, even tone` | **Simplified MSA** |
| `docs/personas/kareem.agent.md:15-16` | `يتكلّم العربية الفصحى المبسّطة بنبرة هادئة محايدة` | **Simplified MSA** |
| `docs/personas/kareem.agent.md:33-36` | `He speaks Simplified Modern Standard Arabic with a level, unhurried tone` | **Simplified MSA** |

Against `brain.ts:108` (`Never MSA newsreader prose`) and `lex-dialect` (`lexicon.ts:80-82`, `never stiff newsreader Modern Standard Arabic`).

**The dossiers also contradict themselves, three times each:**

| Location | Self-contradiction |
|---|---|
| `nour.agent.md:15` (MSA) vs `:77` | Her correct ingest report is `«أكمل»` — an imperative, not MSA |
| `nour.agent.md:15` (MSA) vs `:118-120` | Her failure reports are `«المفتاح مرفوض، يلزم تدويره»`-style constructions; `:114` bans `HTTP 402` / `EADDRINUSE` / `undefined` **in English** — a decision only available in a register where code tokens are English, i.e. exactly the Ammani code-switching `lex-danger` (`lexicon.ts:60-66`) mandates |
| `nour.agent.md:15` (MSA) vs `styles/nour.ts:18` | The *implementation* of her is `تمام، بس للتأكيد — بروح عليها هسأ` — Ammani |
| `kareem.agent.md:15` (MSA) vs `:74` | His correct ingest report is `«ما زال يجمع»` — **colloquial Levantine**, explicitly not MSA |
| `kareem.agent.md:15` (MSA) vs `:26-27` | His stated assumption pattern is `«بفترض أن الملف هوSourceMap»` — bare `بفترض` is colloquial, and MSA requires `نفترض` |
| `kareem.agent.md:15` (MSA) vs `:110-111` | `«المفتاح مرفوض، يلزم تدويره»` / `«الرصيد خلص»` — `خلص` is colloquial |

So the dossiers' *declarative* register is MSA while their *illustrative* register is Ammani, and the shipped code is unambiguously Ammani. **The code is right; the dossiers' §1 identity paragraphs are stale.** This matters beyond tidiness: `WIRING.md:69-72` proposes sourcing the narrator's future per-persona `directive` strings from **`nour.agent.md` §1 and `kareem.agent.md` §1** — the exact paragraphs that carry the wrong dialect. Implementing `WIRING.md` as written would inject an MSA instruction into a prompt whose sibling explicitly bans MSA.

**Minimal correct fix** (one line per file, not applied — out of scope): replace `العربية الفصحى المبسّطة` with `اللهجة الأردنية البيضاء (أممية)` at `nour.agent.md:15` and `kareem.agent.md:15`, and `Simplified Modern Standard Arabic` with `Ammani / White Jordanian Arabic` at `nour.agent.md:35` and `kareem.agent.md:33-34`, matching `lex-dialect` (`lexicon.ts:79-83`).

### 7.4 The lock's one genuine code-level conflict — narrow, worth naming

`lex-dialect` (`lexicon.ts:79-83`) mandates "Technical terms stay in English", matching `brain.ts:109` and `lex-danger` (`lexicon.ts:60-66`). But `normalizeArabic` runs on the **index and query paths only** (`retriever.ts:50`, `:71`) — it is never applied to text handed to TTS. So no code strips English from speech. **No conflict.** The one adjacent tension: `normalizeToken` (`normalize.ts:51`) lowercases Latin, and `lex-errors` (`lexicon.ts:67-74`) says "Error codes are never spoken as numbers" while `cap-frame-limit` (`capabilities.ts:49-54`) tells the model to speak `65536` and `160000`. These are chunk-internal statements about what the **narrator** should say; they are consistent with each other (error *codes* like 401 are not spoken; byte *counts* in a size bound are), and since no chunk reaches a prompt (§6.6) neither is enforced. **No conflict.**

---

## 8. `node dist/cli.js knowledge` — REAL OUTPUT

`dist/` **exists**. `dist/cli.js` present, `dist/knowledge/` fully populated (`build.js`, `guard.js`, `index.js`, `normalize.js`, `personas.js`, `retriever.js`, `types.js` plus `shared/` × 5 and `styles/` × 2, each with `.js`/`.d.ts`/`.js.map`, all timestamped 2026-09-28 16:04:32).

```
PS> node dist/cli.js knowledge
knowledge: shared ground truth (Tier 1)
  shared chunks : 43
  digest        : c12f74d0a29f1c46
  index size    : 43
  nour examples : 8
  kareem examples: 8
  persona leaks : 0
  style asymmetries: 0
EXITCODE=0
```

Exit code **0**. Emitted by `src/cli.ts:205-231` (`knowledgeReport`), which calls `assertParity()` at `:207` and returns `1` on a parity violation (`:209-211`) — so the command is a release gate, as its docstring claims (`cli.ts:203`).

**Reading the output honestly:** every number is a **structural** fact. `persona leaks: 0` and `style asymmetries: 0` are computed by `verifyKnowledge()` (`build.ts:93-118`) over the arrays in memory. `shared chunks: 43 == index size: 43` proves no chunk was dropped by the constructor. The digest `c12f74d0a29f1c46` is reproducible (`sharedDigest() === verifyKnowledge().digest` → `true`).

**What the output does *not* say, and cannot:** it says nothing about whether any of this affects the product. It is the only consumer (§6.6). A green `knowledge` command is evidence the data structure is well-formed, and is **zero** evidence that the assistant knows anything.

With a query argument (`cli.ts:223-229`, optional, not in the brief's invocation):

```
node dist/cli.js knowledge "المنفذ 4096"
  query "المنفذ 4096":
    6.803  arch-ports  (AGENTS.md#runtime-topology; src/ipc/ui-server.ts)
    6.298  fail-ports-busy  (AGENTS.md#gotchas; apps/desktop/e2e)
    3.018  lex-runtime  (src/cli.ts; src/daemon.ts; src/voice/tts.ts)
```

Additional queries I ran against the built index, to exercise the claims in §2.4, §3.5 and §4.7:

```
"EADDRINUSE"        -> fail-ports-busy@3.27
"eaddrinuse"        -> fail-ports-busy@3.27      (identical — case-fold works)
"المنفذ ٤٠٩٦"        -> arch-ports@3.19, lex-runtime@3.02, fail-ports-busy@2.45   (H4)
"s2.1-pro-free"     -> cap-tts@16.11, cap-openrouter-ua@3.64, cap-tts-free-tier@3.31
"compact"           -> cmd-compact@4.21, cmd-status@2.83
"deploy"            -> cmd-destructive@3.88, lex-danger@3.13
"الرصيد"            -> fail-credit@2.91
"402"               -> fail-credit@3.55, lex-errors@3.27
```

Note `deploy` returns `cmd-destructive` before `lex-danger` — correct: `cmd-destructive` (`commands.ts:43-50`) contains the verb in a *rule*, `lex-danger` (`lexicon.ts:60-66`) contains it in a *vocabulary list*; the rule is the better answer and BM25's `idf` correctly prefers the rarer-or-more-anchored document.

---

## 9. CODE vs DOC DISCREPANCIES

### 9.1 `docs/personas/` — 2 files, 4 contradictions

| # | Doc claim | Code truth | Severity |
|---|---|---|---|
| **D1** | `nour.agent.md:15`, `:34-36` + `kareem.agent.md:15`, `:33-36`: register is **"Simplified Modern Standard Arabic"** | `brain.ts:108` **bans** MSA newsreader prose; `lexicon.ts:79-83` (`lex-dialect`) locks Ammani/White Jordanian; `personas.ts:9-11` declares the lock; all 16 `say` strings are colloquial | **HIGH** — and `WIRING.md:69-72` plans to inject these exact paragraphs into the narrator prompt |
| **D2** | `nour.agent.md:6-7`, `kareem.agent.md:6-7`: "**Status:** specification. **Not yet wired into the runtime**" | **TRUE and correct.** Verified independently: 0 persona tokens in all four prompt files (§6.1) | none — this doc is *honest* |
| **D3** | `WIRING.md:11-12`: "the type is honoured in **eleven places** across the protocol, the router, the daemon, and the renderer" | The literal union `'kareem' \| 'nour'` / `PersonaId` is **re-declared or referenced at 18 non-test, non-comment sites** across `src/` and `apps/desktop/src/`: `brands.ts:10`, `protocol.ts:317`, `protocol.ts:363`, `ui-server.ts:50,103,133`, `command-router.ts:45`, `daemon.ts:68,115`, `ws.ts:24,92`, `SettingsView.tsx:18,46`, `main.tsx:16`, `open-settings.ts:44`, `matrix-state.ts:162`, `App.tsx:37` | LOW — **UNVERIFIED** as stated, because "honoured" is undefined; the raw count is 18, not 11 |
| **D4** | `WIRING.md:22`: "as of `2e8ab1b`" | Unverifiable without git archaeology; recorded as **UNVERIFIED** | LOW |

Everything else in `docs/personas/` that I could check against code is **accurate**: the port table (`nour.agent.md:66`, `kareem.agent.md` implicit) matches `AGENTS.md:14` and `protocol.ts:28`; the destructive-verb list matches `brain.ts:97` `HIGH_STAKES_VERBS` exactly (`destroy, delete, drop, force-push, force push, deploy, rm -rf, rm -rf ` — the dossiers list 6 of 8, omitting the `'force push'` space variant and the duplicated `'rm -rf '`); the 402-does-not-rotate rule matches `failures.ts:19-25`; the `≤20 words / ≤240 chars` contract matches `narrator.ts:92` (`MAX_CHARS = 240`) and `:111` (`maxWords = 20`); the voice model ids at `nour.agent.md:4` / `kareem.agent.md:4` match `brands.ts:22-25` byte-for-byte; the earcon frequencies at `nour.agent.md:5` / `kareem.agent.md:5` match `earcons.ts:17-18` exactly.

One small gap: the dossiers list 6 destructive verbs, `brain.ts:97` matches **8** patterns — `'force push'` (spaced) is a live match at `brain.ts:102` and is absent from both dossiers and from `cmd-destructive` (`commands.ts:46-47`) and `lex-danger` (`lexicon.ts:63`). A user saying "force push" trips the gate but Tier 1 has no chunk covering it.

### 9.2 `dossier/KNOWLEDGE-ARCHITECTURE-PROPOSAL.md` — 8 discrepancies

The proposal is explicit at `:3` that it is a **PROPOSAL** against commit `da40aa5`, and several of its items were correctly implemented. The ones that were not, or that are now false:

| # | Proposal | Reality | Severity |
|---|---|---|---|
| **P1** | `:179-180`, `:213-215` — layout `knowledge/personas/nour/fewshots.ts` and `knowledge/personas/kareem/fewshots.ts` | Shipped as `src/knowledge/styles/nour.ts` and `src/knowledge/styles/kareem.ts`. `Test-Path src\knowledge\personas` → **False** | LOW — deviation from a proposal, no behavioural effect |
| **P2** | `:216` — `build.ts` "fills `corpora.manifest.json`" | `build.ts` never touches a manifest. The only `corpora.manifest.json` on disk is `.opencode/_archive/dead-code-phase1/src/guidance/corpora.manifest.json` — **still in quarantine, still `status: "pending-ingest"`, still `sha256: null` for all 5 entries** (proposal `:45`). Proposal item `:242-243` ("version the manifest honestly") was **not done** | MEDIUM — a dead manifest remains the artifact `dossier/` and `lex-vcs` (`lexicon.ts:18`) still cite |
| **P3** | `:217` — `retrieve.ts` "Retriever interface; BM25 impl + minisearch impl" | No such file. `Get-ChildItem src\knowledge -Filter "retrieve*.ts"` → empty. The BM25 lives in `retriever.ts` with **no interface**; there is no minisearch implementation, and `minisearch` is not in `package.json` (proposal recommendation `:79` not taken) | LOW |
| **P4** | `:24` — `AMMANI_SYSTEM_PROMPT` is "**10 hardcoded lines**" | Exactly 10 (`:106`-`:115`) | ✅ **accurate** |
| **P5** | `:21`-`:24` — `NARRATOR_SYSTEM` 9 lines, `COORDINATOR_SYSTEM` 3, `PROMPT_SYSTEM` 6, `AMMANI_SYSTEM_PROMPT` 10 | 9 (`narrator.ts:69`-`:77`), 3 (`coordinator.ts:93`-`:95`), 6 (`prompt-optimizer.ts:67`-`:72`), 10 | ✅ **all four accurate** |
| **P6** | `:50-51` — "`retriever.ts:8` already declares the exact scope enum" | Archived file declares it at **line 9**, not 8. Trivial | LOW |
| **P7** | `:10-31` — "There is no retrieval in the shipped product" … "the assistant's entire world is four hardcoded prompt constants" | **STILL TRUE.** `src/knowledge/` gained 43 chunks and a retriever and is still imported by `cli.ts:17` and nothing else (§6.6). The proposal diagnosed the disease correctly; the treatment reached `src/` but not the product. | **HIGH** — the proposal's central prediction is un-actioned 1 commit later |
| **P8** | `:47-56`, `:230-234` — the quarantined `RagPersonaScope` / 5 external corpora should be **deleted** | `RagPersonaScope` **is** gone from `src/` (correctly). The 5 external corpora were **not** deleted from the manifest; the manifest is untouched in quarantine | MEDIUM |
| **P9** | `:235-241` — "**Fix a dialect conflict before ingesting personas** … **This is the one blocking question**"; `:260-261` open question 1 "**Register** — MSA per the live narrator prompt, or the Levantine markers …? Blocking for ingestion" | **RESOLVED in code as Ammani/White Jordanian** (`personas.ts:9-11`, `lexicon.ts:75-84`, `guard.ts:8-10`, all 16 `say` strings), and `lex-dialect`'s `source` records `decision locked 2026-09-28`. The proposal still presents it as **open and blocking**. The open question was closed; the document was never updated, and §7.3 shows the closure leaked into `docs/personas/` as the *opposite* claim | **HIGH** — a settled decision is still documented as blocking, and the dossiers recorded the losing option |
| **P10** | `:245-254` — test plan: "**BM25 and minisearch agree on top-K over the real corpus**" | **Unrunnable**: no minisearch implementation exists (P3). The proposed differential test was never written | MEDIUM |
| **P11** | `:3` — "Authored against `da40aa5`" | **UNVERIFIED** — no git archaeology performed; commit existence unconfirmed | LOW |

**Credit where due:** the proposal's self-corrections at `:85-92` (retracting three unverified minisearch figures) and `:118-124` (retracting "7 passing tests" for the real "15 dormant") are the right instinct and are accurate about dormancy — I confirmed `vitest.config.ts:5` includes only `src/**/*.test.ts`, and that the archive's 3 test files (`normalize.test.ts`, `personas.test.ts`, `retriever.test.ts` — 3 files, and `personas.test.ts` in the archive contains both persona *and* guard tests) are outside the runner. The count "15 across normalize (5), personas (6), retriever (4)" cannot be verified as stated because the archive's `personas.test.ts` mixes personas and guard cases. **UNVERIFIED.**

### 9.3 Code-internal contradictions (no doc involved)

| # | Location | Contradiction | Severity |
|---|---|---|---|
| **C1** | `src/knowledge/build.ts:52` | Two raw `U+0000` bytes at offsets 2047, 2059; `:53` has a raw `U+0001`. The file is classified **binary** by standard readers and the separators are invisible in `git diff` | MEDIUM (§4.7) |
| **C2** | `src/knowledge/shared/architecture.ts:70-71` | `arch-reachability` says 37 live modules; measured **51** | HIGH (§3.5) |
| **C3** | `src/knowledge/shared/capabilities.ts:83` | `cap-effort-none` cites `src/voice/brain.ts`; that file contains **no** `effort` token (grep: 0 hits; only the generic `reasoning?: unknown` plumbing at `brain.ts:193,218`). Real sites: `daemon.ts:174`, `daemon.ts:535`, `coordinator.ts:215` | MEDIUM |
| **C4** | `src/knowledge/shared/commands.ts:70-78` | `cmd-persona-effect` asserts dossier instructions are injected into the narrator. They are not (§6.7) | HIGH |
| **C5** | `src/knowledge/normalize.ts:3` vs `:10` | Comment says `TASHKEEL U+064B–U+0652`; code is `U+064B`–`U+0672`, which deletes all 10 Arabic-Indic digits (§2.3) | HIGH |
| **C6** | `src/voice/brain.ts:6` | "Phrasing is synthesized by the model under the **RAG-grounded** system prompt" — no RAG in the brain path; `brain.ts` imports only `zod` and `../common/errors.js` | LOW |
| **C7** | `src/knowledge/normalize.ts:11` vs `:18` | `ALEF_VARIANTS` lists `U+0671`, but stage 2 (`:18`) already deleted every `U+064B`–`U+0672` codepoint, so that member is unreachable. Measured: `normalizeArabic('ٱلله')` → `'لله'` (alef deleted, not unified) | LOW |
| **C8** | `src/knowledge/retriever.ts:4` vs `dossier/…:62-67` | `retriever.ts:4` says "zero dependencies" — **true**. The `dossier` quotes a `retriever.ts:3` comment about minisearch being deferred; the shipped `retriever.ts:24-29` reframes it as a swap-in point. Not a contradiction, but the dossier quotes a file that no longer says that | LOW |
| **C9** | `src/knowledge/corpus.test.ts:40-42` | Comment says `buildIndex.length === 0` proves "no persona parameter"; arity is 0 because the sole parameter is **defaulted** (`build.ts:72`), an unrelated cause (§4.6) | LOW |
| **C10** | `src/knowledge/styles/nour.ts:48` ≡ `styles/kareem.ts:47`; `nour.ts:54` ≡ `kareem.ts:53` | 2 of 8 `say` pairs byte-identical; no test detects it (§5.4) | MEDIUM |

---

## 10. GATE STATE — MEASURED

```
npx tsc --noEmit -p tsconfig.json                -> exit 0, no output
npx vitest run src/knowledge                      -> 4 files, 43 tests, 43 passed, exit 0
    src/knowledge/normalize.test.ts   (11 tests)   10 ms
    src/knowledge/personas.test.ts    (8 tests)    10 ms
    src/knowledge/retriever.test.ts   (8 tests)    12 ms
    src/knowledge/corpus.test.ts     (16 tests)    22 ms
node dist/cli.js knowledge                        -> exit 0
```

`43` appears twice with different meanings: **43 Tier-1 chunks** and **43 knowledge-layer tests**. Coincidence; both measured independently.

`tsconfig.json:20` excludes `**/*.test.ts`, so those 43 tests are outside the typecheck half of `test:vantrilex` — which is exactly why §4.3's argument holds: the compile-time guard must live in `types.ts` or nowhere.

**Coverage thresholds are configured but not part of the gate invocation I ran:** `vitest.config.ts:10` sets `thresholds: { lines: 80 }` with `include: ['src/**/*.ts']` (`:8`). I did not run `--coverage`; whether the knowledge layer clears 80 % lines is **UNVERIFIED**.

---

## 11. ITEMS MARKED UNVERIFIED

| Item | Why |
|---|---|
| `cap-tts` "426 to 556 milliseconds" first-chunk latency | Measured claim; `dossier/P1-TTS-CHUNK-LATENCY.md` exists but I did not reproduce a live call. Note `tts.ts:32` `TTS_FIRST_CHUNK_BUDGET_MS = 800` is a **budget**, not the measurement, and the chunk omits it |
| `cap-stt` "421 و 688 مللي ثانية" | Same. Requires a live Groq call |
| `cap-models` / `lex-dialect` `decision locked 2026-09-28` | Date is today; the *decision event* is not independently attested in git |
| `dossier/…:3` "Authored against `da40aa5`" | Commit existence and content unconfirmed |
| `WIRING.md:15` "as of `2e8ab1b`" | Same |
| `dossier/…:118` "15 test cases across normalize (5), personas (6), retriever (4)" | The archive's `personas.test.ts` contains persona **and** guard cases, so the 5/6/4 split cannot be reproduced from the file |
| `normalizeArabic` idempotence over the **full** Unicode space | Verified for `U+0600`–`U+06FF` by my sweep and 8 fixed strings by the test; not proven for all of Unicode |
| `normalizeToken`'s `U+0600`–`U+06FF` test vs Arabic Supplement/Extended-A/Math | No corpus chunk or test uses those planes; the omission is unexercised either way |
| 80 % line-coverage threshold for `src/knowledge/` | `vitest --coverage` not run |
| `D3` — `WIRING.md:11-12` "eleven places" | "Honoured" is undefined; the raw non-comment site count is 18 |
| Whether `guard.ts`'s injected `blocklist` exists anywhere | `guard.ts:5-6` says the Tier-D corpora "live outside the repo"; not present in this repository — **UNVERIFIED** whether they exist at all |
| `cap-tts-free-tier` free-tier expiry 2026-11-30 | Corroborated by `tts.ts:13-19` docstring and `capabilities.ts:23-24`; the provider's own current terms are **UNVERIFIED** (no network call made) |

---

## 12. WHAT I DID NOT DO

- Did **not** modify any file except this report. `npx tsc --noEmit` is read-only; `npx vitest run` wrote no fixtures; `node dist/cli.js knowledge` is read-only.
- Did **not** break the parity guard in the repo. §4.4 used an out-of-tree mirror in `%LOCALAPPDATA%\Temp\opencode\parity-probe\probe.ts`, per the `AGENTS.md` rule on scratch files.
- Did **not** run `npm install`, did not commit, did not push, did not run `cargo`, did not run E2E, did not make any network call, and did not start the daemon.
- Did **not** run `npm run test:vantrilex` in full — only the `src/knowledge` slice plus the root typecheck. Root-suite totals quoted in `AGENTS.md:54` are therefore **UNVERIFIED** by me.
