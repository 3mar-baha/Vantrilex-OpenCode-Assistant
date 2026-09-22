# 21 — Design System: Audio Identity, Speech Pacing, Earcons, Tone & CLI Typography

> **Canonical status:** Design/immunity/owner batch. Audio-identity truth.
> UX base: `02` · Voice pipeline: `18` · Showcase tokens: `22`.

## 21.1 — Audio Design Identity

The product sounds like a calm Ammani colleague looking over your shoulder — never a
newsreader, never a robot, never a servant. Three identity pillars:

1. **Dialect-first:** authentic Ammani Jordanian Arabic for all narrative speech
   (lexicon, particles, rhythm). MSA appears nowhere in spoken output.
2. **Bilingual by design:** technical English spans keep source pronunciation —
   the voice code-switches the way Omar actually speaks at a whiteboard.
3. **Brief by contract:** ≤ 45 spoken seconds per briefing; silence is preferred over
   filler. The ledger holds detail; audio carries meaning.

## 21.2 — Speech Pacing (normative)

| Context | Rate | Pauses |
|---------|------|--------|
| BLUF lead (outcome + identity) | Deliberate, −5% vs baseline | 300 ms after the lead — the listener must register win/lose first |
| Change clauses (≤ 3) | Baseline | 200 ms between clauses |
| Technical spans (paths, errors) | −10%, spelled clearly | 150 ms before/after each span |
| Approval requests (T2) | Deliberate | 400 ms before the action verb; full stop after options |
| Error briefings | Slow, −10% | Never rushed — urgency comes from the earcon, not speed |

Baseline rate is calibrated per voice at release (`08` M5 tuning log) and stored in
config — never hardcoded in `tts.ts`.

## 21.3 — Acoustic Earcons (normative set)

| Earcon | Shape | Meaning | Preempts speech? |
|--------|-------|---------|------------------|
| `complete-green` | Two rising soft tones | Session finished successfully | No — opens the briefing |
| `complete-red` | Low double-tap | Session failed | No — opens the briefing |
| `attention` | Single bright ping | T2 approval incoming, T1 queued behind | Yes — at utterance boundary only (`02` §2.3.2) |
| `capture-on` | Faint click | Microphone live | N/A (capture state) |
| `capture-off` | Faint double-click | Microphone closed | N/A |

Earcons are synthesized once, cached as LRU-exempt reserved clips (outside the 50
budget — they are infrastructure, not content), and replayed locally with zero
provider calls. Volume: −12 dB under speech, ducking active speech by 6 dB when
preemption occurs.

## 21.4 — Conversational Tone Boundaries (normative)

The brain **does**: confirm plainly, admit uncertainty ("not sure — here's what the
log says"), offer exactly one next step, and stay silent when there is nothing worth
saying (T0 events never speak). The brain **never does**: flattery, apologies longer
than one clause, unsolicited lectures, MSA formalities, English narrative prose, or
reading more than 3 file paths aloud (offer the list instead: "want the full list?").

## 21.5 — CLI Status Typography (normative, implements `02` §2.5)

- One in-place status line per session:
  `● payments-refactor · running · 3m12s · last: tests green`.
- Symbols: `●` running, `◆` approval-waiting (amber), `✔` complete (green),
  `✘` error (red) — color never the sole carrier.
- Full-screen redraws forbidden during unattended runs; width clamps at 100 cols
  with head-truncation of paths (`…/retry.ts`).
- Log lines are secretSafe-only (`12` I-2) with ISO timestamps and session prefix.

---

*End of `21-DESIGN-SYSTEM.md`. Next: `22-SHOWCASE.md`.*
