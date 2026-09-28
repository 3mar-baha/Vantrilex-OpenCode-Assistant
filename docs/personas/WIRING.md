# Persona wiring — proposal

> **Nothing in this file is implemented.** The dossiers in this directory are
> specifications. This document is the review-before-code plan for connecting
> them, and the evidence for why the connection is currently missing.

---

## 1. The finding

`PersonaId` is `'kareem' | 'nour'`, and the type is honoured in eleven places
across the protocol, the router, the daemon, and the renderer. But **no persona
ever reaches a system prompt.**

Concretely, as of `2e8ab1b`:

| Persona-dependent | Persona-independent |
|---|---|
| `daemon.ts:607` — `VOICE_IDS[activePersona === 'nour' ? 'female-toggle' : 'male-default']` | `NARRATOR_SYSTEM` — one hardcoded Arabic prompt |
| `earcons.ts` — `kareem-done` 659.25→987.77 Hz vs `nour-done` 987.77→1318.5 Hz | `COORDINATOR_SYSTEM` — one hardcoded English prompt |
| `App.tsx:563` — `SPEAKER_PALETTE[waveSpeaker]` wave colour | `PROMPT_SYSTEM` — one hardcoded Arabic prompt |
| `daemon.ts:607` — `speechGate` snapshot per utterance (L10) | `AMMANI_SYSTEM_PROMPT` — one hardcoded golden prompt |

`narrator.ts` contains **zero** occurrences of `persona`, `voiceId`, or `PersonaId`.

**So selecting Nour vs Kareem today changes the voice, the completion tone, and
the wave colour — and nothing about what either of them says.** Two people
delivering identical words.

This is the same class of defect the v0.7.0 cycle found with `mentions.ts`:
documented as a feature, unreachable in behaviour.

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

### 2.3 Pass the active persona at the one call site

`daemon.ts` already holds `activePersona` and already reads it for `voiceId`. The
narrator call becomes:

```ts
await narrate(ctx, chat, NARRATOR_MODEL, 20, PERSONA_DIRECTIVES[activePersona]);
```

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

## 4. Test plan for the wiring, when approved

Each guard verified by disabling the fix, per the project rule.

1. **`NARRATOR_SYSTEM` is passed to the model intact** — a persona directive is
   prepended, never substituted; deleting `NARRATOR_SYSTEM` from the call fails
   the test.
2. **The 20-word cap survives a persona.** A persona directive must not be able to
   raise `maxWords` or `MAX_CHARS`.
3. **The no-template ban survives.** A directive cannot reintroduce
   `تم تنفيذ الأمر بنجاح`.
4. **Omitting the persona is byte-identical to today's output** — proves the change
   is additive and not a behavioural regression.
5. **Both personas are reachable** from `daemon.ts`, and selecting one actually
   changes the system string handed to the narrator. Verified by spying on the
   chat function.
6. **Unknown persona ids cannot reach the narrator** — `Record<PersonaId, string>`
   plus a `satisfies` check, so a typo is a compile error rather than an
   undefined directive at runtime.

---

## 5. Open question for review

**Should the directive be Arabic-only, or bilingual?**

The dossiers are bilingual because humans maintain them. But the narrator
speaks one Arabic sentence aloud. An English directive in a system prompt whose
output is `{"reply_ar": "..."}` is a token cost and a consistency risk for no
audible benefit.

Recommendation: **Arabic directive only** in `personas.ts`, with the English in
the dossier as the rationale for the human reader. That is a one-line change if
the reviewer disagrees, but it is cheaper to decide before writing than after.
