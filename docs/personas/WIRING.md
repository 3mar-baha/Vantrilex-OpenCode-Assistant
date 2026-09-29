# Persona wiring — shipped

> **The styling seam is implemented** (`27ee556` + this change). The **RAG half
> of this plan is not** — see §6. This document records what shipped, and
> deliberately keeps the original proposal text so the reasoning behind the
> shipped shape is auditable against the reasoning behind the alternative.
>
> **Status of the observable claim (re-resolved 2026-09-29, baseline `6be0363`):**
> the two system prompts provably differ (5 break-tested guards, §4), **and** a
> live Inkling probe over the real `narrate() → openRouterChat` path has now
> been made — 6/6 calls produced audio-ready Arabic with per-persona tone
> markers 3/3 each (Kareem `يا غالي`/`هسا بنرتبها`, Nour `تمام بس للتأكيد`),
> p50 3,932 ms / 4,294 ms. Recorded in `docs/SPRINT_3_PLAN.md` §2.7 (Wave 3)
> and `docs/PROJECT_MASTER_DOSSIER.md` §5.3. The honest limit stands:
> within-persona pairs also differed 3/3 at temperature 0.8, so this proves
> **non-interchangeable output, not statistical causation** — a stronger claim
> needs ≥10 samples per arm on owner-approved quota. The probe is **session
> history** (no tree artifact; `docs:verify` cannot re-derive it), while the
> **retrieval half is still undone** — no chunk is retrieved, ranked or
> interpolated into any prompt (§6). Read the two halves separately: styling
> ships and has been heard once; RAG does not ship.

---

## 1. The finding (as of `2e8ab1b`, before wiring)

`PersonaId` is `'kareem' | 'nour'`, and the type is honoured in eleven places
across the protocol, the router, the daemon, and the renderer. But **no persona
ever reached a system prompt.**

| Persona-dependent | Persona-independent |
|---|---|
| `daemon.ts` — `VOICE_IDS[activePersona === 'nour' ? 'female-toggle' : 'male-default']` | `NARRATOR_SYSTEM` — one hardcoded Arabic prompt |
| ~~`earcons.ts` — `kareem-done` 659.25→987.77 Hz vs `nour-done` 987.77→1318.5 Hz~~ | `COORDINATOR_SYSTEM` — one hardcoded English prompt |
| `App.tsx` — `SPEAKER_PALETTE[waveSpeaker]` wave colour | `PROMPT_SYSTEM` — one hardcoded Arabic prompt |
| `daemon.ts` — `speechGate` snapshot per utterance (L10) | `AMMANI_SYSTEM_PROMPT` — one hardcoded golden prompt |

`narrator.ts` contained **zero** occurrences of `persona`, `voiceId`, or `PersonaId`.

**So selecting Nour vs Kareem changed the voice, the completion tone, and the
wave colour — and nothing about what either of them says.** Two people
delivering identical words.

This was the same class of defect the v0.7.0 cycle found with `mentions.ts`:
documented as a feature, unreachable in behaviour.

> **Correction to the row struck through above.** `earcons.ts` was **deleted** in
> the Wave 1 dead-code removal, and its per-persona pitch was **not**
> reimplemented — nothing in the tree still contains `659.25`, `987.77` or
> `1318.5`. So the persona-dependent surface is **three** items, not four, and
> the completion tone is no longer persona-differentiated. Line numbers have also
> drifted: the `voiceId` read is at `daemon.ts:790` and the palette at
> `App.tsx:611`. Cited here rather than silently dropped, because a document that
> quietly prunes its own evidence is how the five original falsities in `AGENTS.md`
> survived.

---

## 2. Proposed integration point

**One seam, not three.** The natural place is `narrator.ts`, because the narrated
line is the only persona-visible output: it is what is spoken, it is already
persona-adjacent via the `voiceId` chosen a few lines away, and it is bounded to
one short sentence, so a per-persona instruction cannot leak into planning.

### 2.1 Make the narrator persona-parameterised

```ts
// narrator.ts
export interface PersonaVoice {
  readonly id: PersonaId;
  /** Prepended to NARRATOR_SYSTEM. Empty string = current behaviour. */
  readonly directive: string;
}

export async function narrate(
  ctx: NarrationContext,
  chat: NarratorChat,
  model: string,
  maxWords = 20,
  persona?: PersonaVoice,          // <-- additive, optional
): Promise<string | null> {
  const system = `${persona?.directive ?? ''}\n${NARRATOR_SYSTEM.replace('{max}', String(maxWords))}`;
  ...
}
```

Every existing call site keeps working unchanged, because the parameter is
optional. **The 20-word cap, the JSON-only contract, the no-template ban, and the
no-repeat rule all stay in `NARRATOR_SYSTEM`** — they are safety constraints, not
style, and a persona directive must never be able to relax them.

### 2.2 Source the directives from the dossiers

The two `directive` strings are the Arabic "who am I" paragraphs from
`nour.agent.md` §1 and `kareem.agent.md` §1, extracted into a small module:

```
src/orchestrator/personas.ts
  export const PERSONA_DIRECTIVES: Record<PersonaId, string>
```

Keeping them in TypeScript rather than parsing the Markdown means the runtime
cannot silently break if a dossier is reworded for humans.

> **As shipped, the module path changed** — the directives live on
> `PersonaProfile.directive` in the **existing** `src/knowledge/personas.ts`, and
> `PERSONA_DIRECTIVES` is a derived `satisfies Record<PersonaId, string>` view of
> it. Two reasons this beat the proposal:
>
> 1. **The proposed path is a collision.** `src/orchestrator/personas.ts` is the
>    same basename as `src/knowledge/personas.ts`, which already holds
>    `PersonaId`, `toneMarkers` and the shield lexicon. A second `personas.ts`
>    one directory up makes every import ambiguous to a reader and to tooling,
>    for zero benefit.
> 2. **The registry already existed.** The profile interface was there, already
>    carrying per-persona Arabic style data, already sourced from the dossiers.
>    A new module would have been a second source of truth for the same fact —
>    the exact defect this project keeps finding.
>
> `daemon.ts` imports from `src/knowledge/personas.js` **directly, not the
> barrel**: the barrel re-exports the BM25 retriever and the 43-chunk corpus, and
> the daemon should not pull a search index into its import graph to obtain one
> style string. A guard pins that.

### 2.3 Pass the active persona at the one call site

`daemon.ts` already holds `activePersona` and already reads it for `voiceId`. The
narrator call becomes:

```ts
await narrate(ctx, chat, NARRATOR_MODEL, 20, PERSONA_DIRECTIVES[activePersona]);
```

> **As shipped, the parameter is a `{ id, directive }` object, not a bare
> string.** The `id` rides along so a log line or a telemetry frame can name which
> persona spoke — otherwise the redaction sink has nothing to attribute. The
> `NarratorPersona` interface is exported from `narrator.ts`, which takes the
> `PersonaId` **type** only and never looks a directive up. That keeps the
> dependency pointing one way: the narrator generates text, the registry holds
> data, and the caller joins them. A guard asserts `narrator.ts` imports nothing
> from `knowledge/`.

### 2.4 Deliberately *not* proposed

- **Not** per-persona `COORDINATOR_SYSTEM`. Planning quality should not vary with
  the user's mood preference, and a persona that "prefers" certain plans is a
  correctness hazard.
- **Not** per-persona `PROMPT_SYSTEM`. The optimizer is a mechanical rewrite; a
  persona directive there would degrade its output for no benefit.
- **Not** MessagePack or voice-cloning. Out of scope entirely.

---

## 3. Contract to preserve

These are the existing guarantees the wiring must not weaken. They are already
pinned by tests, and the wiring should add to them rather than relax them.

| Guarantee | Where it lives today |
|---|---|
| `model` is an HTTP **header**, never a body field | `fishHeaders()` + 6 tests |
| `s2.1-pro-free` is the free tier | `TTS_MODEL` + tests |
| One Arabic sentence, ≤20 words, ≤240 chars | `NARRATOR_SYSTEM`, `MAX_CHARS` |
| JSON-only output, no prose outside it | `BrainOutputSchema` strict |
| No canned confirmations | explicit ban in `NARRATOR_SYSTEM` |
| 402 does not rotate the key | `withKey` / `httpStatusOf` |
| Optimizer failure falls back to the user's own words | `optimizePrompt` |
| Persona change never echoes | daemon equality guard, L22 |

---

## 4. Test plan — as shipped, and the one item that did not hold

Each guard was verified by breaking it before being accepted. **Six break tests
were run; five caught the break and one did not**, and the one that failed is the
most valuable line in this document.

1. **`NARRATOR_SYSTEM` is passed to the model intact`** — the directive is
   **prepended**, never substituted. Breaking it (`system = persona.directive`,
   dropping the base prompt) failed **3** tests.
2. **The 20-word cap survives a persona.** No directive can reach `maxWords` or
   `MAX_CHARS`, and the cap is still asserted present in the prompt.
3. **The no-template ban survives.** The `تم تنفيذ الأمر بنجاح` prohibition is
   still in the system string under a persona.
4. **Omitting the persona is byte-identical to the pre-wiring output** — the seam
   is additive, proven against `NARRATOR_SYSTEM.replace('{max}','20')` exactly.
   Breaking the persona to be accepted-and-ignored failed **2** tests.
5. **Both personas produce different system strings.** Making the two directives
   identical (simulating a copy-paste) failed **2** tests.
6. **Unknown persona ids cannot reach the narrator** — `satisfies
   Record<PersonaId, string>` makes a new persona without a directive a compile
   error, not a silent `undefined` at runtime.

### 4.1 The gap that break-testing exposed

Item 5 of the **original** plan read: *"Both personas are reachable from
`daemon.ts`, and selecting one actually changes the system string handed to the
narrator. Verified by spying on the chat function."*

**That was not enough, and the suite was green for a reason that should not have
been possible.** The spy sat in tests that called `narrate()` directly, so they
proved the *seam* works while nothing proved the *daemon uses it*. Deleting the
persona argument from the `narrate()` call in `daemon.ts` entirely — the precise
"documented as shipped while unreachable" failure — left **9 of 9 tests passing.**

Two consequences, both now permanent:

1. **`narratorChat` became an injectable `DaemonOptions` field.** It was the last
   hardcoded external call in `startDaemon` while every other network client in
   this codebase is already injected, and that asymmetry is exactly what made the
   most important integration untestable. Production builds the real OpenRouter
   chat; a test injects a spy.
2. **`src/daemon-persona-wiring.test.ts` is a separate file** from
   `narrator-persona.test.ts`, with a header saying why. A future reader who
   merges them deletes the only test that would catch the unwired case.

Re-running the breaks after that: deleting the daemon's persona argument now
fails **1** test; switching the import to the knowledge barrel fails **1**;
making the narrator look up the registry itself fails **1**. Each confirmed by
an anchor check that aborts if the injection silently missed — two break tests
here have passed before for precisely that reason.

Three of these guards are **structural**: they read `daemon.ts` and `narrator.ts`
as text. That is a deliberate and honestly labelled trade — the runtime path
needs a live `serve` plus a provider key, so a source assertion is the strongest
available check. It is weaker than a behavioural assertion; keep it rather than
replacing it with a comment.

---

## 5. Open question for review — RESOLVED

**Should the directive be Arabic-only, or bilingual?** → **Arabic-only.**

The dossiers are bilingual because humans maintain them. But the narrator speaks
one Arabic sentence aloud. An English directive in a system prompt whose output
is `{"reply_ar": "..."}` is a token cost and a consistency risk for no audible
benefit.

Shipped as recommended, with the English rationale left in this file and the
dossiers for the human reader. A guard asserts each directive is >90% Arabic
letters, so the choice cannot drift back into an English prompt by accident.

---

## 6. What is still NOT done (re-resolved 2026-09-29, baseline `6be0363`)

Recorded so this file is not read as "personas fully wired". Each bullet states
what was measured, where the evidence lives, and what would close it.

- **The RAG half of the plan is untouched — the retrieval seam does not exist
  in production.** No chunk is retrieved, ranked or interpolated into any
  prompt. Verified by import search at baseline: `src/knowledge/` has exactly
  **2** production importers — the `knowledge` CLI subcommand (via the barrel
  `knowledge/index.js`, `cli.ts:17`) and `daemon.ts` for the **persona registry
  only** (`PERSONA_DIRECTIVES` deep from `./knowledge/personas.js`,
  `daemon.ts:22`); exactly **1** barrel importer (the CLI). The daemon never
  pulls the BM25 retriever (`retriever.ts:30-31`, K1=1.2 B=0.75) or the
  43-chunk corpus (`build.ts:23-29`: 8 arch + 11 caps + 8 cmd + 8 fail + 8 lex,
  plus 16 stylistic selected by `when`, never retrieved) into its import graph
  to obtain one style string — pinned by `daemon-persona-wiring.test.ts`. The
  `docs/personas/WIRING.md` plan for the *retrieval* half (Tier-1 injection at
  narration time) remains the reviewed but unwired design. Retrieval speed is a
  solved non-problem (hand-rolled zero-dep BM25; `normalizeArabic`
  `normalize.ts:23-45` with the digit-preserving class
  `[\u064B-\u065F\u066A\u066D-\u0672]`, guarded by `normalize.test.ts:72-80`
  after the old `U+064B-U+0672` class swallowed Arabic-Indic digits
  `U+0660-U+0669`). **The real gap is corpus coverage**: queries like
  `إيش سويت` return nothing because the fact is absent from
  `capabilities.ts`, not because scoring failed. Closing this means: (a) corpus
  content work (facts the assistant actually needs), (b) a retrieval call on
  the narration path with a measured latency budget, (c) a guard that the
  injected chunk cannot delete the 20-word cap / JSON-only contract /
  no-canned-confirmation ban — the same prepend-never-substitute shape as §2.1.
- **The two personas have been heard side by side exactly once — treat it as
  session history, not as a re-derivable fact.** The Wave 3 live Inkling probe
  (2026-09-29, `docs/SPRINT_3_PLAN.md` §2.7) ran 6 calls over the real
  `narrate()` path: 6/6 audio-ready Arabic, persona tone markers 6/6 (Kareem
  3/3, Nour 3/3), p50 3,932 ms (Kareem) / 4,294 ms (Nour). Within-persona pairs
  also differed 3/3 at temperature 0.8 — so the measurement proves the two
  prompts produce **non-interchangeable** output, not statistical causation. No
  bench artifact exists in the tree (`docs:verify` re-derives nothing here;
  `docs/PROJECT_MASTER_DOSSIER.md` §5.3 labels it PROSE-ONLY honestly). Do not
  record "Nour and Kareem sound different" as done; record "one 6-call probe
  on 2026-09-29 heard non-interchangeable output; a ≥10/arm probe on
  owner-approved quota is still open". The corpus must be updated from a future
  measurement, not from this document — no Tier-1 chunk asserts the personas
  differ, and none should until the larger sample exists.
- **The earcon pitch is gone, not fixed.** `earcons.ts` was deleted in the Wave
  1 dead-code sweep; per-persona audio differentiation does not exist in the
  shipped product. Tree holds **0** files matching `earcon*` and **0**
  occurrences of the old pitch constants `659.25` / `987.77` / `1318.5`
  (`docs:verify` re-derives both, so re-adding an earcon under a new name
  cannot pass unnoticed). The persona-dependent surface is **three** items, not
  four: narration directive (`personas.ts:38-54` Kareem, `:56-72` Nour),
  TTS voice id (`male-default` / `female-toggle`, `brands.ts:22-24`, via
  `PERSONA_VOICE` `brands.ts:12-15`, snapshotted per utterance
  `daemon.ts:794-796`), wave colour (`#16A34A/#EAB308` vs `#9333EA/#EC4899`,
  `SiriWaveCanvas.tsx:20-24`; `user` `#2563EB/#EAB308`). §1's struck-through
  earcon row stays struck through as evidence, not pruned.
- **No Tier-1 chunk asserts that the personas differ.** The corpus is the source
  of truth and a chunk once claimed they speak differently without evidence.
  If the larger live measurement above is made, the corpus should be updated
  from the measurement — not from this document.

---

## 7. Exact current wiring (re-verified at baseline `6be0363`)

Every anchor below was read from the tree at the baseline commit, not carried
from prose. If a line number drifts, re-derive it — do not arithmetically
adjust it (the TTS interceptor shifted six `daemon.ts` anchors once, and only
the behavioural self-test caught it).

| # | Fact | Anchor |
|---|---|---|
| 1 | `PersonaId = 'kareem' \| 'nour'` | `src/common/brands.ts:10` |
| 2 | `PERSONA_VOICE` maps kareem to `male-default`, nour to `female-toggle` | `brands.ts:12-15` |
| 3 | Fish voice id prefixes `5b90451e` (male) / `88c0375e` (female) | `brands.ts:22-24` (prefixes only; never full key material) |
| 4 | `PersonaProfile` with `id,nameAr,label,role,toneMarkers,shieldLexicon,directive` | `src/knowledge/personas.ts:12-36` |
| 5 | Kareem directive (Arabic-only, 5 sentences) | `personas.ts:47-53`; markers `personas.ts:45` |
| 6 | Nour directive (Arabic-only, 5 sentences) | `personas.ts:65-71`; markers `personas.ts:63` |
| 7 | `PERSONA_DIRECTIVES satisfies Record<PersonaId,string>` — a missing persona is a compile error | `personas.ts:79-82` |
| 8 | Shield: first-person reply must contain persona lexicon, vacuously true without `أنا` | `personas.ts:91-94` |
| 9 | `narrate(ctx, chat, model, maxWords=20, persona?)` — persona optional, additive | `src/orchestrator/narrator.ts:123-129` |
| 10 | Prepend, never substitute; `undefined` gives base only | `narrator.ts:136-139` (+ intent comment `:130-135`) |
| 11 | `NarratorPersona{id, directive}` — narrator takes the string, never the `PersonaId` lookup | `narrator.ts:28-32` |
| 12 | `NARRATOR_MODEL = thinkingmachines/inkling:free` | `narrator.ts:52` |
| 13 | `NARRATOR_SYSTEM` 9-line AR peer-engineer prompt, `{max}` placeholder, canned-ban, never-repeat, JSON-only reply | `narrator.ts:84-94` |
| 14 | `MAX_CHARS=240`, `maxWords=20`, 120 maxTokens, temp 0.8, 12 s daemon wrapper timeout | `narrator.ts:108,127`; `daemon.ts:327,341-350` (12 s raised from 8 s on 3x5010 ms measurements) |
| 15 | Daemon imports directives deep, never the barrel | `daemon.ts:22` (`./knowledge/personas.js`); barrel `knowledge/index.js` imported only by `cli.ts:17` |
| 16 | Daemon call site passes id plus directive | `daemon.ts:376-392` |
| 17 | TTS voice snapshotted per utterance from `activePersona` | `daemon.ts:794-796` |
| 18 | Wave colour per speaker | `SiriWaveCanvas.tsx:20-24`; consumed `App.tsx:611` |
| 19 | Persona ref counts (lines mentioning a persona, `docs:verify`-derived) | `narrator.ts` **11**, `coordinator.ts` **0**, `prompt-optimizer.ts` **0**, `brain.ts` **0**; sole interpolation `'{max}'` |
| 20 | Dialect lock: Ammani / White Jordanian, EN tech terms preserved; newsreader MSA + Beiruti banned | `brain.ts:105-109`, `personas.ts:8-11` |

Deliberately *not* wired (design, not omission — §2.4): no per-persona
`COORDINATOR_SYSTEM` (planning quality must not vary with mood preference), no
per-persona optimizer prompt (mechanical rewrite; a directive there degrades
output for no benefit), no MessagePack / voice-cloning.

## 8. How to re-measure (so the next probe is evidence, not anecdote)

1. **Burn quota deliberately.** The probe needs owner approval: 6 calls cost
   p50 ~4 s each of free-tier Inkling; a 10/arm causal probe costs ~20 calls.
   Record the date, model slug, temperature (0.8 last time), and the exact
   `narrate()` wrapper args alongside the outputs.
2. **Use the real path.** Call `narrate()` with `openRouterChat` behind it —
   never a parallel harness that bypasses the prepend logic. The control is
   explicit: same event, both directives, plus a no-persona arm (`undefined`
   gives base only, byte-identical to pre-wiring output per §4 item 4).
3. **Score tone markers, not vibes.** Kareem must carry `يا غالي`/`هسا بنرتبها`
   family; Nour must carry `تمام بس للتأكيد` family. The 2026-09-29 probe hit
   3/3 per arm. Also score the safety invariants per output: max 20 words,
   max 240 chars, valid JSON reply, no canned success line.
4. **Do not claim causation from non-interchangeability.** Within-persona
   divergence at temp 0.8 is expected; the probe proves the prompts are not
   interchangeable, not that the directive *caused* a specific phrase. A causal
   claim needs the larger sample with a pre-registered marker list.
5. **File the corpus update from the measurement.** If the 10/arm probe
   lands, add or amend a Tier-1 chunk citing the probe date + sample size —
   never cite this WIRING doc as the source.

## 9. What "retrieval half done" would actually mean

Not "the retriever is fast" (it is) and not "the corpus exists" (it does: 43
shared + 16 stylistic, one index, no per-persona index, `SharedChunk` with no
`persona` member by type `types.ts:57` + runtime `assertSharedChunks`
`types.ts:76-80`). Done means all three simultaneously: (a) a daemon-side
retrieval call on the narration path (`normalizeArabic` at index AND query
time, or Arabic recall silently goes to zero — minisearch-class libs ship no
Arabic handling); (b) a measured latency row showing narration p50 still
within budget with retrieval inline; (c) a prepend-shaped guard proving the
injected chunk is context, never a replacement for `NARRATOR_SYSTEM`. Until
all three land with tests, §6 bullet 1 stays open no matter how many chunks
are added.
