# Track 3 — Jev (TypeSafe) vs. LAYA

**VERDICT: EXISTS.** Verified against primary sources on 2026-09-28.
The Jev ecosystem is real, documented, published to three package registries, and
independently analysed in a peer-listed arXiv preprint. Nothing below is inferred.

The brief's three named constructs map as follows: `Choice` and `Score` are **real and
documented**; `Noul` is **real and documented** (the brief's "Choice, Score and Noul" is
correct). One claim in the brief needs correcting: `awesome-jev` and `fast-jev-opencode`
are real, but **`jev-gateway` is a third-party project, not a TypeSafe artefact**, and
**`jev-voice` does not exist on npm** under that name.

---

## (a) Search log

Every query run, with result. Failures recorded as failures.

| # | Query / target | Method | Result |
|---|---|---|---|
| 1 | `"Jev" TypeSafe System 1 decision model ecosystem` | websearch | 10 results. typesafe.ai, huggingface blog, openrouter model page, dev.to, substack, LinkedIn, arXiv 2609.30216, emergent.sh, medium, GitHub `cobanov/awesome-jev` |
| 2 | `"jev-gateway" OR "awesome-jev" OR "fast-jev-opencode" github` | websearch | 10 results; `vinilana/jev-gateway`, 6 distinct `awesome-jev` repos, jevlist.ai, npm.io |
| 3 | `"fast-jev-opencode" OR "jev-voice" OR "Ollaya" opencode jev` | websearch | 9 results; surfaced `jev-voice-browser`, `ollaya.dev`, jevlist.ai |
| 4 | `ollaya laya:en decision model heads "should_speak" OR "barge_in" OR "is_destructive"` | websearch | **HTTP 503 — query failed. Not retried.** |
| 5 | `https://typesafe.ai/` | fetch | **200.** Vendor homepage, published `Sep 27, 2026` |
| 6 | `https://typesafe.ai/blog/introducing-system-one-models-and-jev` | fetch | **200.** Launch post, dated `Sep 15, 2026` |
| 7 | `https://docs.typesafe.ai/introduction` | fetch | **200.** Primitives table |
| 8 | `https://docs.typesafe.ai/primitives/choice` | fetch | **200.** Full request/response shape |
| 9 | `https://docs.typesafe.ai/primitives/noul` | fetch | **200.** Full request/response shape |
| 10 | `https://docs.typesafe.ai/llms.txt` | fetch | **200.** 100+ doc pages enumerated |
| 11 | `https://api.typesafe.ai/docs` | fetch | **empty body.** Redirects to the Mintlify site at `docs.typesafe.ai`; OpenAPI spec not served at this path |
| 12 | `https://openrouter.ai/typesafe/jev-1.13` | fetch | **404.** The model id is listed in the `jev-gateway` README and in third-party sources, but the OpenRouter model page did not render. Model id **not** independently confirmed on OpenRouter |
| 13 | `https://raw.githubusercontent.com/vinilana/jev-gateway/main/README.md` | fetch | **200.** Full README |
| 14 | `https://raw.githubusercontent.com/roshan-shaik-ml/fast-jev-opencode/main/README.md` | fetch | **200.** Full README |
| 15 | `https://raw.githubusercontent.com/ollaya-dev/ollaya/main/README.md` | fetch | **200.** Full README |
| 16 | `https://arxiv.org/html/2609.30216v1` | fetch | **200.** "Jev in the Wild", arXiv:2609.30216v1 [cs.SE], 24 Sep 2026 |
| 17 | `https://huggingface.co/convaiinnovations/laya/raw/main/README.md` | fetch | **200.** Full model card (see §e) |
| 18 | `https://api.github.com/repos/vinilana/jev-gateway` | REST | **200** — 241 stars, 33 forks, created 2026-09-18, MIT, not archived |
| 19 | `https://api.github.com/repos/vinilana/fast-jev-opencode` | REST | **404** — vinilana does not own it. Owner is `roshan-shaik-ml` (verified separately) |
| 20 | `https://api.github.com/repos/vinilana/jev-voice` | REST | **404** |
| 21 | `https://api.github.com/search/repositories?q=jev-voice` | REST | **200** — 95 repos. Top hit `moritzkremb/jev-voice-browser` (360★) |
| 22 | `https://api.github.com/search/repositories?q=ollaya` | REST | **200** — 13 repos. Top hit `ollaya-dev/ollaya` |
| 23 | `https://api.github.com/repos/ollaya-dev/ollaya` | REST | **200** — 830★, 39 forks, Apache-2.0, created 2026-09-23 |
| 24 | `https://api.github.com/repos/NandhaKishorM/laya` | REST | **200** — 27,505★, 2,400 forks, Apache-2.0, created 2026-09-18 |
| 25 | `https://api.github.com/repos/typesafe-ai/system-one-adapter-python` | REST | **200** — 335★, MIT, created 2026-08-08 |
| 26 | `https://api.github.com/repos/moritzkremb/jev-voice-browser` | REST | **200** — 360★, MIT, created 2026-09-17 |
| 27 | `https://registry.npmjs.org/jev-gateway` | REST | **200** — `latest: 0.5.0` |
| 28 | `https://registry.npmjs.org/fast-jev-opencode` | REST | **200** — `latest: 0.4.3` |
| 29 | `https://registry.npmjs.org/jev-voice` | REST | **404** — `{"error":"Not found"}` |
| 30 | `https://registry.npmjs.org/jev` | REST | **200 — but `latest: 0.0.0`, `main: index.js`.** An unrelated stub, not a TypeSafe SDK |
| 31 | `https://registry.npmjs.org/fast-jev-opencode/latest` | REST | **406** Not Acceptable (registry rejects the bare `/latest` alias without the right Accept). Covered by #28 |
| 32 | `https://pypi.org/pypi/jev/json` | REST | **200.** Description: "`@jev.fn` turns a Python function definition into a query against Jev, TypeSafe's System One model" |
| 33 | `https://crates.io/api/v1/crates/jev` | REST | **200.** `jev` 0.1.0, 147 downloads, created 2026-09-17 |
| 34 | `https://crates.io/api/v1/crates/jev/0.1.0` | REST | **200.** published_by `porky11` (Fabio Krapohl), `MIT OR Apache-2.0`, feature `async` |
| 35 | `https://crates.io/api/v1/crates/jev-gateway` | REST | **404** — `crate 'jev-gateway' does not exist` |
| 36 | `https://ollaya.dev/api/models` | fetch | **404** (HTML 404 page) |
| 37 | `https://ollaya.dev/api/v1/models/laya` | fetch | **404** |
| 38 | `https://registry.ollaya.dev/index.json` | fetch | **DNS `ENOTFOUND`** — host does not resolve |
| 39 | `https://huggingface.co/api/models?author=ollaya-dev` | REST | **200.** `ollaya-dev/laya` exists, `base_model:convaiinnovations/laya`, `license:apache-2.0`, created 2026-09-24 |

**Queries I deliberately did not run:** any query whose only source would be a content-farm
post (`huggingface.co/blog/...`, `tiktok.com`, `instagram.com`, `youtube.com`, `substack`).
Several appeared in results. None is cited below as evidence.

**Unverified claims encountered and NOT adopted:**
- `heyjunpenn/awesome-jev` search snippet claims `jev-gateway` is "☆ 181". GitHub API says **241**. Not used.
- A YouTube result claims "600+ System 1 AI Integration Projects". The arXiv paper says **2,170**. Not used.
- The 193.6×/444.6× speed and cost figures on typesafe.ai are **vendor self-reported**, from
  a workflow eval against GPT-6 Astra / Fable 5.1 on evals.typesafe.ai. Recorded as a vendor
  claim, not adopted as fact.

---

## (b) VERDICT

**EXISTS.** Real vendor, real model, real API, real registries, real third-party ecosystem,
real independent analysis.

The brief is accurate on substance and wrong on two names. Corrections:

1. **`jev-gateway` is not a TypeSafe project.** Its own README: *"Independent project, not
   affiliated with or endorsed by TypeSafe. 'Jev' is TypeSafe's model and this gateway is a
   client of its public API."* Owner `vinilana`, 241★, MIT.
2. **`jev-voice` does not exist on npm** (404). The nearest real artefact is
   `moritzkremb/jev-voice-browser` (360★) — *"Control a real browser by voice. Jev (TypeSafe
   System One) decides intent + target in ~300 ms per spoken word; Playwright…"* The brief's
   name appears to be a truncation of this.
3. **`fast-jev-opencode` is real** but young: 0 stars, created 2026-09-26, last push
   2026-09-27, npm `0.4.3`. It supports OpenCode v1 **and** v2.
4. **`awesome-jev` is not one curated list — it is at least six competing ones**
   (`cobanov`, `yibie`, `heyjunpenn`, `Amal-David`, `fatwang2`, `AppitStudio`). Treat any
   single "awesome-jev" as an unattributed fork, not a canonical index.

---

## (c) Primary sources

### Vendor
| Source | URL |
|---|---|
| TypeSafe AI homepage | https://typesafe.ai/ |
| Launch post, "Introducing System One Models & Jev", **Sep 15 2026** | https://typesafe.ai/blog/introducing-system-one-models-and-jev |
| Docs root | https://docs.typesafe.ai/ |
| HTTP endpoint | `POST https://api.typesafe.ai/v1/systemone` |
| Console | https://console.typesafe.ai/ |
| Third-party review of the public API | https://typesafe-ai.github.io/system-one-adapter-python/ · repo `typesafe-ai/system-one-adapter-python` (335★, MIT) |

> "Today, we are opening early access… Our first public model is **Jev**… Think of Jev as a
> frontier-intelligence function call: unstructured state in, typed probabilistic decisions
> out." — https://typesafe.ai/blog/introducing-system-one-models-and-jev

> "System One models are built to make fast, structured decisions that software can use
> directly… You get typed values and probability distributions that your code can branch on,
> sort by, and route with." — https://docs.typesafe.ai/introduction

### Independent analysis
`In Jev in the Wild: A Data-Driven Analysis of the Jev Model's Functionality, Applications and Ecosystem`
— Guoming Ling (Sun Yat-sen), Muen Xue (Sun Yat-sen), Zijian Ye (CUHK).
**arXiv:2609.30216v1 [cs.SE], 24 Sep 2026** — https://arxiv.org/html/2609.30216v1

> "Jev is a fast, low-cost decision model that answers natural-language questions with choices,
> binary judgments, and scores… 2,170 publicly available Jev projects collected from GitHub as
> of September 22, 2026."

> "Jev was adopted rapidly after its release on September 15, 2026. Of the 2,170 repositories
> in our dataset, 1,865 were created in the following week… these new repositories gained
> 43,750 stars."

> "Choice appears in 81.0% of projects, Noul in 72.2%, and Score in 45.4%… 36.8% use all three."

Interface mix, verbatim from the paper: **Choice 81.0% · Noul 72.2% · Score 45.4%**.
Decision purposes: attribute judgment 77% · scoring/ranking 52% · action selection 31%.
Attribution note: the paper's own verification and annotation were done by a
"GPT-6 Luna Max agent" — a vendor model, disclosed by the authors.

### Registries
| Registry | Name | Verified | Note |
|---|---|---|---|
| npm | `jev-gateway` | 200, `0.5.0` | third-party, MIT |
| npm | `fast-jev-opencode` | 200, `0.4.3` | OpenCode v1+v2 plugin |
| npm | `jev` | 200, `0.0.0` | **unrelated stub.** Not TypeSafe |
| npm | `jev-voice` | **404** | does not exist |
| PyPI | `jev` | 200 | `@jev.fn` decorator → Jev query |
| crates.io | `jev` | 200, `0.1.0` | `porky11`, MIT OR Apache-2.0, 147 dl |
| crates.io | `jev-gateway` | **404** | does not exist |
| GitHub | `vinilana/jev-gateway` | 200, 241★, MIT | 2026-09-18 |
| GitHub | `roshan-shaik-ml/fast-jev-opencode` | 200, 0★, MIT | 2026-09-26 |
| GitHub | `ollaya-dev/ollaya` | 200, 830★, Apache-2.0 | 2026-09-23 |
| GitHub | `NandhaKishorM/laya` | 200, 27,505★, Apache-2.0 | 2026-09-18 |
| GitHub | `moritzkremb/jev-voice-browser` | 200, 360★, MIT | 2026-09-17 |

### The actual API surface

Endpoint: `POST https://api.typesafe.ai/v1/systemone`.

**Request** — three top-level fields, verbatim from https://docs.typesafe.ai/primitives/choice:

```json
{
  "state": "My running shoes arrived in the wrong size. Can I swap them for a size 10?",
  "model": "jev-latest",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "returns": "Exchanges, wrong or damaged items",
        "shipping": "Delivery status, delays, lost packages",
        "billing": "Charges, invoices, payment problems"
      }
    }
  }
}
```

**Response** — verbatim from the same page:

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "department": {
      "type": "choice",
      "choice": "returns",
      "confidence": 1.0,
      "probabilities": { "shipping": 0.0, "returns": 1.0, "billing": 0.0 }
    }
  },
  "usage": { "input_tokens": 328, "output_tokens": 34 }
}
```

**The three primitives**, from https://docs.typesafe.ai/introduction:

| Primitive | Request fields | Returns |
|---|---|---|
| `Choice` | `type`, `instructions`, `criteria` (map: option name → description) | `choice`, `probabilities` (sums to 1), `confidence` |
| `Score` | `type`, `instructions`, `criteria` (ordered levels) | `score`, `probabilities`, `confidence` |
| `Noul` | `type`, `instructions`, optional `criteria` (`{true, false}`) | `noul` — a single 0–1 float |

**`Noul` has no `confidence` field.** Verbatim, https://docs.typesafe.ai/primitives/noul:

> "There is no separate `confidence` value for a Noul, unlike a Choice or a Score. A Noul's
> probability distribution has only two outcomes, yes and no, so the single `noul` value
> describes it completely."

`Noul` response, verbatim:
```json
{ "model": "jev-1.13.0", "answers": { "is_human_escalation": { "type": "noul", "noul": 0.99 } } }
```

Documented limits and properties:
- **Parallel, not sequential.** "Every *question* is evaluated in parallel and in isolation
  against the same *state* in one go. Adding questions barely changes the response time."
- **Cardinality.** "A Choice question accepts up to 255 options."
- **Text only, 32k window, English-strongest.** From `jev-gateway` README: "Jev reads text only
  and has a 32k-token window… It is most accurate in English."
- **Latency.** "End-to-end response time is 70ms-500ms."
- **Cost.** "Input tokens: $0.042 / MTok ($42 per billion tokens). Output tokens: FREE."
- **Question ids are not sent to the model.** "You choose the question id… The model never
  sees the question id."
- **Known defects are published.** `docs.typesafe.ai/model-jaggedness/jev-1.13.md` exists
  ("Jev isn't perfect. Here are some jagged edges we are aware of with jev-1.13"). **I did
  not fetch this page and make no claim about its contents.**

Providers, from the `jev-gateway` README table: TypeSafe (`TYPESAFE_API_KEY`, `jev-latest`),
OpenRouter (`OPENROUTER_API_KEY`, `typesafe/jev-1.13`), Vercel AI Gateway (`AI_GATEWAY_API_KEY`,
`typesafe-ai/jev`), OpenCode Zen (`OPENCODE_API_KEY`, `jev-1.13-free` / `jev-1.13`).
All four are the same wire format. The OpenRouter model *page* 404'd for me (#12); the id is
asserted by the gateway README and not independently confirmed.

---

## (d) Verified LAYA head inventory

Read from source in `O:\opencode-Vantrilex`. No assumptions.

### Files
| File | Lines | Role |
|---|---|---|
| `src/runtime/laya/constants.ts` | 18 | head list + operating length. Dependency-free by design |
| `src/runtime/laya/types.ts` | 22 | `LayaDecision`. Dependency-free by design |
| `src/runtime/laya/tokenizer.ts` | 143 | SentencePiece-BPE, hand-implemented |
| `src/runtime/laya/laya-engine.ts` | 116 | the ONNX engine. **statically imports `onnxruntime-node`** |
| `src/runtime/laya/loader.ts` | 135 | the one sanctioned door; `await import('./laya-engine.js')` at :94 |
| `src/runtime/laya/telemetry.ts` | 95 | the LAYA producer for the diagnostics bus |
| `src/runtime/laya/index.ts` | — | barrel, **not** daemon-safe |

### The head set — exactly four, all binary

`src/runtime/laya/constants.ts:17`
```ts
export const LAYA_HEADS = ['should_speak', 'is_destructive', 'barge_in', 'stuck_in_loop'] as const;
export type LayaHead = (typeof LAYA_HEADS)[number];
```

Pinned by test at `src/runtime/laya/laya.test.ts:75`:
```ts
expect(LAYA_HEADS).toEqual(['should_speak', 'is_destructive', 'barge_in', 'stuck_in_loop']);
```

The M7 L3 attribution is in the file header, `constants.ts:1`: `// Laya System-1 constants — M7 L3.`

### Operating length

`src/runtime/laya/constants.ts:15`
```ts
export const LAYA_OPERATING_LENGTH = 32;
```

The file's own justification (`constants.ts:10-14`) carries an honesty flag worth preserving:
> "Operating length 32 tokens: the corpus p99 is 32 (max 35) and masked mean pooling makes
> logits invariant to pad length… **UNVERIFIED: not re-measured here**; the only live number
> for this file comes from the archived integration test."

Pinned at `laya.test.ts:76`: `expect(LAYA_OPERATING_LENGTH).toBe(32);`

### Input shape

`LayaEngine.decide(text: string)` — `laya-engine.ts:87`. One bare string in. The tokenizer
(`tokenizer.ts:70-79`) prepends BOS, appends EOS, truncates to `maxLength`, and pads with
`pad = 0` while zeroing `attentionMask`. Tensors are built at `laya-engine.ts:102-103` as
`int64`, shape `[1, this.maxLength]`, with a `maxLength` of 32 by default.

### Output shape

`src/runtime/laya/types.ts:17-22`
```ts
export interface LayaDecision {
  readonly scores: Record<LayaHead, number>;
  /** Wall-clock cost of this decision, tokenizer included. */
  readonly elapsedMs: number;
  readonly at: string;
}
```

So: **four sigmoid scores + a latency + an ISO timestamp.** No confidence, no probability
distribution, no class label, no per-head threshold.

Per-head extraction, `laya-engine.ts:105-110`:
```ts
const scores = {} as Record<LayaHead, number>;
for (const head of LAYA_HEADS) {
  const tensor = outputs[`logit_${head}`];
  const raw = tensor === undefined ? 0 : Number((tensor.data as Float32Array | number[])[0] ?? 0);
  scores[head] = sigmoid(raw);
}
```

**A missing output tensor scores 0.0, silently.** This is called out as a real hazard at
`loader.ts:117-122` and `telemetry.ts:46-51`:
> "A graph with no `logit_*` output scores 0.0 everywhere (laya-engine.ts:97-99), which
> downstream reads as 'confidently not destructive' — a silent contract drift, so DEGRADED, not OK."

That is a **destructive-safety-relevant** failure mode: absent model ⇒ `is_destructive: 0.0`.

### The seam is NOT installed — verified, not assumed

`grep 'laya|LAYA|loadLaya' src/daemon.ts` → **no matches found**. Zero references.

And the code says so in its own words, `src/ipc/ui-server.ts:381-389`:
> "HONEST BY DEFAULT. This used to be a hardcoded `true`, which told every shell that Laya
> System-1 was ready while the daemon never loaded it: the dynamic-import seam is deliberately
> NOT installed (laya-m7-int8.onnx is 294 MB and layaLoad has zero consumers, so wiring it
> would cost a model load per daemon start for no behaviour change)."

`ui-server.ts:389`: `layaReady: false,` — hardcoded. The protocol field exists at
`src/ipc/protocol.ts:309` (`layaReady: z.boolean()`), and `src/ipc/ui-server.test.ts:144`
asserts it is `false`.

**One nuance the AGENTS.md does not state:** the weights *are* on disk in the working tree.

```
models/laya-m7-int8.onnx    308,050,615 bytes   (294 MiB — matches the comment)
models/laya-m7.onnx       1,228,429,195 bytes
models/silero-vad.onnx       2,243,022 bytes
```
`onnxruntime-node` is a declared dependency at `1.30.0`.

So the reason the seam is not installed is **not** a missing model or a missing native
package. It is the stated reason: a 294 MB load per daemon start for zero consumers, and
`layaReady` deliberately reporting the truth until the seam is installed *and verified*.

The two-layer safety design is real and is not mine to restate — `loader.ts:8-33` and
`laya-engine.ts:12-24` document it, and `src/policy/laya-sidecar-safety.test.ts` +
`src/policy/sidecar-safety.test.ts` enforce it. `loader.ts` holds **no** specifier-bearing
edge to `laya-engine.js`, not even an erased `import type` — which is why `LayaDecision`
lives in `types.ts` (`types.ts:5-15`).

Telemetry, verified: `emitLayaTelemetry(sink, facts)` at `telemetry.ts:88` swallows every
throw (`:92-94`) and returns on a null sink (`:90`). The row carries **no text field, ever**
(`telemetry.ts:12-16`). A load failure reports `errorCode: 'CONFIG_INVALID'`, not a borrowed
`BRAIN_FAILED` (`telemetry.ts:56-66`).

---

## (e) Integration notes — Jev and LAYA

Only because Jev is real. Two sections: the mapping, and a **name collision that will
mislead a future integrator**.

### Does Choice/Score/Noul map onto four binary heads?

**Only `Noul` maps, and only partially.** The mismatch is structural, not cosmetic.

| | Jev `Noul` | Jev `Choice` / `Score` | LAYA head |
|---|---|---|---|
| Output | 1 float, 0–1 | label + full distribution + `confidence` | 1 sigmoid float, 0–1 |
| Calibration | vendor-trained, ECE claimed calibrated | distribution sums to 1 | **untrained-by-us; no calibration, no ECE, no temperature fitting** |
| Question set | per-request, natural language | per-request, natural language | **frozen at compile time in `constants.ts:17`** |
| Cardinality | 2 | up to 255 | exactly 4 |
| Latency | 70–500 ms (hosted) | 70–500 ms | in-process, p50 25.8 ms claimed for 32 tokens |
| Cost | $0.042/MTok in, output free | same | $0, local CPU ONNX |

`should_speak`, `is_destructive`, `barge_in`, `stuck_in_loop` are all yes/no, so each would
express as a `Noul`:

```json
{ "questions": {
    "should_speak":  { "type": "noul", "instructions": "Should Voxaura speak this turn?" },
    "is_destructive":{ "type": "noul", "instructions": "Does this request perform a destructive action?" },
    "barge_in":     { "type": "noul", "instructions": "Does this input interrupt Voxaura mid-utterance?" },
    "stuck_in_loop":{ "type": "noul", "instructions": "Is the agent repeating a stalled loop?" }
} }
```

**Four real reasons this is a bad trade for Voxaura specifically:**

1. **Latency is backwards.** LAYA is claimed at p50 **25.8 ms** in-process
   (`constants.ts:12-13`, itself marked UNVERIFIED). Jev is **70–500 ms** round-trip over
   the network. Voxaura's barge-in path is the one place where 70–500 ms is disqualifying:
   barge-in is *by definition* the sub-second-interrupt case. A cloud Jev call in the barge-in
   path is slower than the interruption it is supposed to detect.
2. **The whole Jev call is one network round-trip with a fixed price.** $0.042/MTok in,
   output free. Voxaura's decision is ~32 tokens of state; a real barge-in utterance in
   Arabic is a few hundred tokens. This is a per-utterance cost added to a loop that is
   otherwise free-tier-by-design, and AGENTS.md records that free tiers are already
   "slow and lossy."
3. **Jev has a published failure mode that collides with the use case.** The
   `convaiinnovations/laya` model card, issue #156, on a competing RLCD-trained checkpoint:
   "`noul` can follow its option labels instead of the state… returning a confident 'no' for
   clearly positive input." A confident wrong "no" on `barge_in` is a dropped interruption.
   AGENTS.md already records the analogous lesson from Inkling: free OpenRouter models are
   *lossy*, not merely rate-limited.
4. **It would be slower, costlier, and less reliable than a model already in the repo.**
   The honest framing is that this is a **regression**, not an integration.

**Where Jev would actually be defensible:** the `intake` step. `COORDINATOR_MODEL` /
`INTAKE_MODEL` currently spend **p50 1,950 ms** (plan) and **901 ms** (intake) on every
utterance (AGENTS.md). A Jev `Choice` over the intake intent would be far faster — but
`Choice` is not among LAYA's heads, so this is a *replacement* for the intake model, not an
adapter for LAYA, and it would need a TypeSafe key in the vault plus a network dependency in
the one loop AGENTS.md says must never silently degrade.

**Verdict on the mapping:** LAYA's four heads are a *frozen, specialised, local* contract.
Jev is a *general, per-request, hosted* contract. `Noul` is the only shape that crosses
cleanly, and it crosses into something strictly slower. There is no head-set mapping that
improves Voxaura as it stands.

### NAME COLLISION — read this before anyone writes "laya" in a doc

There is a public, unrelated, very popular model **also called Laya**:

- `NandhaKishorM/laya` — **27,505 stars**, 2,400 forks, Apache-2.0, created 2026-09-18.
  HF `convaiinnovations/laya`. Self-described: *"Multilingual, non-autoregressive System 1
  decision model."* Served by Ollaya at `ollaya-dev/ollaya` (830★) behind a
  `POST /v1/systemone` endpoint it calls **"wire-identical to TypeSafe."**

Its own comparison table places it against Jev:
> "typed-decisions, 2,000 decisions | 0.727 | **0.766**… p50 latency, 1 question | 236–276 ms
> | **32.8 ms** | 7.8× faster… Weights | closed API | **Apache 2.0** | Open weights, on-premise capable"

**This is NOT Voxaura's LAYA.** Voxaura's LAYA is a purpose-fine-tuned 4-head voice model at
a 32-token operating length; theirs is a 421M ModernBERT-large general decision model with a
422M-parameter per-option marker head and 512/8192-token context. They share only a name and
a lineage idea (both descend from TypeSafe's RLCD framing).

Practical consequences:
- Do not cite `NandhaKishorM/laya` benchmarks as evidence about `src/runtime/laya/`. They are
  measurements of a different checkpoint.
- Do not "upgrade" Voxaura's LAYA to Ollaya's `laya` on the strength of 0.766-vs-0.727. The
  2,000-decision typed-decisions benchmark measures email/security/customer-service triage.
  It contains no `should_speak` / `barge_in` task, and the author states plainly that the
  base checkpoint is *"near chance… 0.362 here… The 0.766 belongs to the checkpoint fine-tuned
  on that benchmark's own training split."*
- If a future phase ever wants a real decision model here, `convaiinnovations/laya`'s own
  **fine-tuning notebook** is the relevant artefact, and the base-vs-fine-tuned delta
  (0.362 → 0.766) is the honest prior for what a Voxaura-specific fine-tune would yield.
- The name collision is also a live hazard for `dossier/` prose. Any future document that
  says "Laya" without a checkpoint hash and `file:line` is ambiguous.

### What is genuinely reusable

Two third-party pieces, both verified, neither requiring a model change:

1. **`typesafe-ai/system-one-adapter-python`** (335★, MIT, `typesafe-ai` = the vendor).
   *"Drop-in TypeSafeClient replacement backed by LLM APIs."* This is the officially
   supported way to get typed decisions out of an ordinary LLM. It is the correct tool for
   **evaluating whether a Jev-style contract helps Voxaura at all** before paying for the
   hosted model — the `jev-gateway` README uses it as its LLM baseline, and TypeSafe's own
   blog cites it.
2. **`jev-gateway`'s confidence-gating pattern.** Verbatim from its README — the idea, not
   the code, is portable and cheap:
   > "`passthrough` | Low confidence, the two checks disagree, Jev failed, there are no tools,
   > or the caller already chose | Forwarded byte for byte."

   Voxaura's LAYA already implements the same property in a different shape: `loader.ts:124-132`
   fails open to `null` and the caller speaks. If the seam is ever installed, the correct
   design is **unchanged** — a head score is advisory, and its absence or failure must not
   be able to silence the voice loop. AGENTS.md's own `is_destructive: 0.0` hazard
   (`telemetry.ts:46-51`) means a low head score must never be able to authorise a
   destructive action either.

---

## Bottom line

Jev is real and well documented. LAYA is real, and its four heads are frozen at
`constants.ts:17` with a 32-token operating length at `constants.ts:15` and an unwired seam
(zero `daemon.ts` references, `layaReady: false` at `ui-server.ts:389`, weights present at
294 MiB).

The two do not integrate. `Noul` is the only crossing primitive and it crosses into a
slower, costlier, network-dependent call for a decision Voxaura already makes in ~26 ms
in-process, on a loop where 70–500 ms is disqualifying. `Choice` and `Score` have no
counterpart in LAYA's fixed 4-binary-head contract at all.

The one thing genuinely worth acting on is the **name collision** with
`NandhaKishorM/laya` (27,505★) — a different checkpoint under an identical name, now
served by an 830★ tool behind a Jev-compatible wire format. That is a documentation hazard
this dossier should preempt.
