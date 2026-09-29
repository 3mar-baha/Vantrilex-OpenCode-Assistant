# Persona wiring — shipped

> **The styling seam is implemented** (`27ee556` + this change). The **RAG half
> of this plan is not** — see §6. This document records what shipped, and
> deliberately keeps the original proposal text so the reasoning behind the
> shipped shape is auditable against the reasoning behind the alternative.
>
> **Status of the observable claim:** the two system prompts now provably
> differ. That the *model responds* differently is **unverified** — that needs a
> live Inkling call, which was not made because it burns free-tier quota. Treat
> "Nour and Kareem now sound different" as an open experiment, not a fact.

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

## 6. What is still NOT done

Recorded so this file is not read as "personas fully wired":

- **The RAG half of the plan is untouched.** No chunk is retrieved, ranked or
  interpolated into any prompt. `src/knowledge/` is now a production importer of
  `daemon.ts` for the **persona registry only**; the retriever, the BM25 index
  and the 43-chunk corpus still reach production solely through the `knowledge`
  CLI subcommand. Retrieval is fast enough not to be the problem (p99 0.0128 ms
  against a 10 ms budget) — **corpus coverage is**, and that is a content task.
- **Nobody has heard the two personas side by side.** The system strings provably
  differ; that Inkling produces audibly different replies for the same event is
  an unmeasured hypothesis. It is one live call and it burns free-tier quota, so
  it needs an explicit decision rather than a silent one. **Do not record it as
  done.**
- **The earcon pitch is gone, not fixed.** `earcons.ts` was deleted in the Wave 1
  dead-code sweep; per-persona audio differentiation does not exist in the
  shipped product.
- **No Tier-1 chunk asserts that the personas differ.** The corpus is the source
  of truth and a chunk once claimed they speak differently. If the live
  measurement in the second bullet above is made, the corpus should be updated
  from the measurement — not from this document.
