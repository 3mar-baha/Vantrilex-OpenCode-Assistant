# Knowledge Architecture — Audit & Design Proposal

**Status: PROPOSAL. No code modified.** Authored against `da40aa5`.
**Principle: Information Parity, Stylistic Divergence.**

---

## Phase 1 — Current state

### There is no retrieval in the shipped product

A sweep of `src/` and `apps/desktop/src/` for `rag|retriev|embed|knowledge|glossary|
lexicon|searchIndex|minisearch` returns **no retrieval implementation**. Every hit
is incidental — the word "fragments" in a comment, "acknowledgement" in an
acknowledgement gate.

What actually feeds the assistant's knowledge:

| Surface | What it is | Persona-scoped? |
|---|---|---|
| `NARRATOR_SYSTEM` (`narrator.ts:68`) | 9 hardcoded Arabic lines | **No** |
| `COORDINATOR_SYSTEM` (`coordinator.ts:92`) | 3 hardcoded English lines | **No** |
| `PROMPT_SYSTEM` (`prompt-optimizer.ts:66`) | 6 hardcoded Arabic lines | **No** |
| `AMMANI_SYSTEM_PROMPT` (`brain.ts:105`) | 11 hardcoded lines, BLUF-first | **No** |
| `VAULT_NOTES` (`memory/vault.ts:8`) | 6 **filenames** only — scaffolds an Obsidian vault, contains no content | **No** |

So today the assistant's entire world is **four hardcoded prompt constants**. There
is no shared factual corpus, no Arabic lexicon, and no retrieval at all.

`brain.ts:6` says *"Phrasing is synthesized by the model under the RAG-grounded
system prompt"* — that comment describes an intent, not a system. Nothing grounds it.

### The design you are asking for already exists — quarantined

`.opencode/_archive/dead-code-phase1/src/guidance/rag/` contains a working
retrieval layer built in the previous cycle and quarantined in v0.7.0 for having
zero importers:

| File | Content |
|---|---|
| `retriever.ts` (2.5 KB) | `InMemoryRetriever` — dependency-free BM25, `K1=1.2 B=0.75`, top-K |
| `normalize.ts` (0.9 KB) | `normalizeArabic` — NFKC, strip tashkeel/tatweel, unify alef `آأإٱ→ا` and yeh `ى→ي`. Idempotent. |
| `personas.ts` (1.8 KB) | `KAREEM` / `NOUR` profiles: `role`, `toneMarkers`, `shieldLexicon` |
| `guard.ts` (1.6 KB) | `screenText` — blocklist screening over normalized text |
| `corpora.manifest.json` | 5 corpora, **all `status: "pending-ingest"`, `sha256: null`** |

**`retriever.ts:8` already declares the exact scope enum this brief specifies:**

```ts
export type RagPersonaScope = 'shared' | 'kareem' | 'nour';
```

Tier 1 / Tier 2 / Tier 3 was designed, typed, and implemented. It shipped with
empty corpora, which is why it was dead: the manifest note says *"the pipeline
refuses to build prompts from an empty manifest."* The mechanism worked; the
content never arrived.

---

## Phase 3 — The deferred integration is now unblocked

`retriever.ts:3` records the reason it is hand-rolled:

> *"The approved minisearch integration is deferred: the root npm tree cannot
> accept new packages (full-tree re-resolution times out on native rebuilds), so
> retrieval ships as ~70 lines of dependency-free BM25 with the identical top-K
> contract."*

**That blocker is gone.** The v0.7.2 toolchain work fixed exactly this class of
failure: `package-lock.json` now exists, `npm ci` exits 0, and the root tree
accepts new packages. The comment already names the swap-in point — *"replace
`InMemoryRetriever` with a minisearch index behind this interface when the
toolchain allows installs."*

### Viable patterns, evaluated against your constraints

| Pattern | Fit | Verdict |
|---|---|---|
| **`minisearch`** (lucaong/minisearch, ~30k+★) | Pure JS/TS, sub-10ms on 10k docs, in-process, ~30 KB gzipped. Already the team's approved choice. | **Recommended.** The interface already exists to receive it. |
| **BM25 in-process (current)** | Zero dependencies, ~70 lines, fully deterministic, trivially auditable. | **Keep as the reference implementation and as the test oracle.** It is the thing minisearch is diffed against. |
| **SQLite FTS5** | Sub-ms, but pulls a native binding into a sidecar that already had one blow up (v0.6.0, `onnxruntime-node`). | **Rejected.** Re-introduces a native-module packaging risk we already paid for. |
| **`sqlite-vec` / any vector DB** | Needs native ext + an embedding model in-process. | **Rejected.** Multi-MB model in a 100 MB sidecar, for a corpus that is ~200 short chunks. |

**Three reference repositories** worth citing, in priority order:
1. **`lucaong/minisearch`** — the retrieval engine itself; tokenizes, indexes, scores in-process. Its `prefix`/`fuzzy` options map onto Arabic orthographic variants better than BM25 on raw tokens.
2. **The quarantined `guidance/rag/`** — the in-repo reference implementation, with 7 passing tests (`retriever.test.ts`, `normalize.test.ts`, `personas.test.ts`). Not a GitHub reference, but the *contract* every engine must satisfy.
3. **`dair-ai/Prompt-Engineering-Guide`** — already in the corpora manifest; useful as prompt-pattern source material, not as runtime code.

**Explicitly ruled out**, per your constraints: `langchain`/`llamaindex` (multi-MB, wrong shape), Chroma/Pinecone/Qdrant-server (hosted or Docker), `@xenova/transformers` (downloads a model at runtime), and any external embedding API.

---

## Phase 2 — The 3-tier architecture

### Tier 1 — Shared Ground Truth · **no persona field at all**

This is the load-bearing design decision, and it is what makes Information Parity
**structurally guaranteed rather than merely intended**:

> **Tier 1 chunks do not carry a `persona` field.** They are not filterable by
> persona, therefore they *cannot* diverge. Asymmetry becomes unrepresentable
> rather than merely forbidden by convention.

The quarantined `RagPersonaScope` union is the right shape but the wrong guarantee:
a `shared` scope is a *label* someone could misuse. Making Tier 1 a separate type
with no persona member removes the possibility.

```
knowledge/
  shared/
    architecture.ts      ports 4096/4097, daemon lifecycle, Job Object, bring-up
    capabilities.ts      tools each surface actually has, with measured bounds
    commands.ts          /compact /new /help, @mentions, the destructive-verb list
    lexicon.ts           Arabic technical lexicon
    failures.ts          the error taxonomy and the remedy for each
```

**Lexicon — the العربية technical terms.** Kept as a lookup table, not prose:

| Arabic | Technical token | Note |
|---|---|---|
| البناء | build | |
| الاختبارات | tests | |
| الإيداع / الفرع | commit / branch | never transliterated in speech |
| الوسيط | middleware | |
| الاعتماديات | dependencies | |
| النافذة | context window | the 1,048,576-token gauge |
| الحزمة | package | |
| النشر | deploy | **destructive — always confirm** |
| شجرة العمل | worktree | |
| صفحة | window (UI) | distinct from نافذة |

The rule already in force: *code, paths, logs, error codes, sessions, and commands
stay in technical English inside the Arabic sentence.* The lexicon exists to stop
the model inventing an Arabic transliteration of them.

### Tier 2 / Tier 3 — Stylistic layers, facts excluded

```
knowledge/personas/nour/     fewshots.ts   clarification probes
knowledge/personas/kareem/   fewshots.ts   action-first assertions
```

**Both are byte-identical in scope: they may only contain *how to say something*.
Neither may contain a fact, a number, a capability, or a lexicon entry.** A fact in
a stylistic file is a parity bug.

The mechanical enforcement, and it is the important part:

```ts
// A stylistic chunk is not permitted to carry facts. Enforced by type, not review.
interface StylisticExample { readonly say: string; readonly when: string; }
//   - no `fact`, no `value`, no `capability` field exists to put one in
```

Plus a **parity test** that fails if the count of shared chunks ever differs
between personas, or if any shared chunk's text changes without a version bump.

### What is deliberately NOT tiered

`COORDINATOR_SYSTEM` and `PROMPT_SYSTEM` stay un-tiered, for the reason given in
`WIRING.md`: a persona that "prefers" certain plans is a correctness hazard, and
the optimizer is a mechanical rewrite where style only degrades output.

---

## Phase 4 — File layout & recommendation

```
knowledge/
  types.ts               SharedChunk (no persona) · StylisticExample (no facts)
  shared/
    architecture.ts  capabilities.ts  commands.ts  lexicon.ts  failures.ts
  personas/
    nour/fewshots.ts
    kareem/fewshots.ts
  build.ts               chunks -> normalized -> index; fills corpora.manifest.json
  retrieve.ts            Retriever interface; BM25 impl + minisearch impl
```

### Recommendation

1. **Restore `guidance/rag/` from quarantine** rather than rewriting it. It has the
   scope enum, the Arabic normalizer, the guard, and 7 passing tests. It needs
   content, not new code.
2. **Keep the hand-rolled BM25 as the oracle.** Implement `minisearch` behind the
   same `Retriever` interface and diff the two over the real corpus. If they
   disagree on any top-K ordering, the BM25 is the answer.
3. **Delete the 5 external corpora from the manifest.** JODA, UD MADAR,
   CAMeL-Lab and XL-Sum are large external corpora that would dominate the index
   and bloat the sidecar, for knowledge that has nothing to do with this project.
   Tier 1 is ~200 hand-written short chunks. The manifest is a build artefact —
   rewriting it is honest, not destructive.
4. **Fix a dialect conflict before ingesting personas.** The quarantined
   `personas.ts` gives Kareem Levantine tone markers (`يا غالي`, `هسا بنرتب`), but
   the live `AMMANI_SYSTEM_PROMPT` bans *"MSA newsreader prose, **Beiruti
   slang**, or foreign dialects."* Levantine is broader than Beirusi, so these are
   not strictly contradictory — but they are in tension, and a reviewer should
   settle which register ships before any corpus is built. **This is the one
   blocking question.**
5. **Version the manifest honestly.** Every entry is `sha256: null`. Once Tier 1
   lands, the digests become the parity guarantee's physical anchor.

### Test plan (per the project rule: every guard verified by disabling it)

- Parity: shared chunk set is byte-identical for both personas; injecting a fact
  into a stylistic file fails to typecheck.
- Normalizer: idempotent; `آ`/`أ`/`إ`/`ا` all collapse; tashkeel stripped; `ى`→`ي`.
- Retrieval: BM25 and minisearch agree on top-K over the real corpus.
- Lexicon: every listed term appears in exactly one form; no Arabic transliteration
  of a code identifier.
- Manifest: refuses to build from an empty or digest-less manifest — the guard
  that already exists and was never exercised.

---

## Open questions for the reviewer

1. **Register** — MSA per the live narrator prompt, or the Levantine markers from
   the quarantined personas? Blocking for ingestion.
2. **Scope of Tier 1** — project knowledge only (ports, capabilities, failures,
   lexicon), or also general Arabic developer idiom? The quarantined manifest
   assumed the latter; this proposal assumes the former and says so.
3. **minisearch now, or after the corpus lands?** The swap-in is cheap once the
   contract is tested, but it is a second engine to maintain.
