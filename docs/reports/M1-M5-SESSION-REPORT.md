# M1–M5 — Session Report

**Project:** Voxaura (opencode-voice-runtime) · **Window:** 2026-09-29
**Plan:** `docs/IMPLEMENTATION_ROADMAP.md` · **Baseline:** `b3f793b` · **Head:** `e866fee`
**Scale:** 48 commits · 75 files · +14,599 / −272 lines

---

## 0. The directive this session ran under, and what it cost

The owner was asleep and authorised autonomous completion and shutdown: *"لا
بلغني لأني سوف أكون نائم. أصلح الأمر بلوب وتخذ القرار الأقرب لهدف
المشروع، وضع ملاحظة أنك فعلت كذا في التقرير. والإغلاق يكون بعد انتهاء كل
شيء حرفياً."*

**Every judgement call below was therefore made without owner input.** The
ones a present owner might reasonably have made differently:

1. **A security fix landed after the item that found it was already
   committed.** M5's probes exposed a live redaction leak in the SHARED
   redactor (`0b11ba9`) and a half-redaction in the bundle (`0cd54a0`). Both
   were outside any item's write-set. I fixed them because shipping a public-ticket
   artifact with a known leak is indefensible — but it does mean two files the
   roadmap never named changed behaviour for existing call sites.
2. **A test was deleted rather than repaired.** M5's `[REDACTION-REFUSED]`
   demonstrations were asserting a redaction bug as though it were behaviour.
   I rewrote them rather than reverting the fix, on the view that a test pinning
   a bug is worse than no test.
3. **A guard was removed.** `hasResidualMaterial`'s fourth check guarded a fixed
   defect and fired on clean input. I removed it. A guard that cries wolf is
   worse than none — but it is still a guard, and removing one is a judgement.
4. **A gate script was changed.** `lint-baseline.mjs` counted oxlint's summary
   sentence, which the pinned binary does not print by default, so the gate exited
   2 on a tree whose warning count had not moved. It now counts diagnostic lines.
   This is the one change that touches how the gate measures rather than what it
   measures, and it deserves a reviewer's eye.
5. **An environment change mid-session was not escalated** — the session's cwd
   moved to a separate side checkout 40 commits behind. I continued in
   `O:\opencode-Vantrilex` and recorded why in the report rather than stopping.

---

## 1. Gate — the headline

| Stage | Result |
|---|---|
| `npm run test:vantrilex` | **EXIT 0** |
| root vitest | **905 passed, 0 skipped**, 66 files |
| desktop vitest | **265 passed**, 31 files |
| Playwright E2E | **33 passed**, 18 specs |
| `cargo test` | **52 passed**, 0 failures |
| `oxlint` | 8 warnings / baseline 8 — **OK** |
| `npm run docs:verify` | **EXIT 0** (31/31 claims) |
| `docs:verify --self-test` | **EXIT 0** |

Baseline at `b3f793b` was root 705 · desktop 156 · E2E 22. The counts rose;
**nothing was deleted to make a number fall**, except the dead `Crest.tsx` in M1
where the fall was legitimate and recorded.

---

## 2. What each milestone actually delivered

### M1 — the audit's Triad A (12 commits)
A.3 Fish 429 no longer burns a good key · A.4 OpenRouter 402 is one attempt, not
three · A.5 the credit clock is hoisted out of the per-save rebuild · A.6 key
material zeroed per ring on stop/rebuild/narration · A.2 the vault DACL is
re-locked after every save, with a receipt · A.1 the unreachable Tauri command
**deleted** rather than wired.

### M2 — the voice loop (12 commits)
TTS drains per chunk · speech-only barge-in (`stopSpeech` splits from `abort`, so
barging no longer kills the turn) · intake and planning split into an async
owner-FIFO queue · completion separated from delivery with a `playbackStarted`
handshake · outcome-claiming acks dropped instead of spoken · Fish WebSocket
transport with a hand-rolled zero-dep msgpack codec.

### M3 — defensive limits (14 commits)
B.1 pre-header cap + B.6 opening-fragment charge · B.5 redaction at every
free-text frame sink · B.2 bounded resume window + `resume-gap` · B.4 the speech
gate extracted and time-boxed · B.3 backpressure watermarks with a `flow` frame
and a `hello` resync.

### M4 — the voice-first surface (10 commits)
C.1 the DACL receipt, including the `Err` arm · C.3 a credit banner that cannot be
dismissed while voice is dead · C.5 task cards from `inventory` · C.6 a
calibration wizard that measures and advises · C.7 Latin-echo detection.

### M5 — `doctor --bundle` (6 commits)
A diagnostic artifact designed to be pasted into a public ticket, with its
redaction oracle, its live `docsVerify`, and an authenticated 4097 probe.

---

## 3. The defects this session found, which the roadmap did not list

| Defect | Severity | Where |
|---|---|---|
| A JSON value with an escaped quote was redacted only up to the escape; **the tail shipped** | high | `common/logger.ts` — the notice sink, so any provider error |
| A value containing `]` was half-redacted; the tail shipped **and the refusal net did not fire** | high | `src/diag/bundle.ts` + `common/logger.ts` |
| The shared redactor's prefix patterns are case-**sensitive**, so `SK-OR-V1-…` passed both the redactor and the scanner | medium | `common/logger.ts` |
| `lint-baseline.mjs` exited 2 on an unchanged tree because the pinned oxlint does not print its summary by default | medium | `scripts/lint-baseline.mjs` |
| The obvious M5 design is a **fork bomb** — `docs:verify` → suite → bundle test → `docs:verify`, ~120 node processes | medium | `src/diag/bundle.ts` |
| `RESUME-REFUSED` arm unreachable after the fixes above; its only live trigger is the 2000-char cap cutting the marker | low | `src/diag/bundle.ts` |

Every one was found by **probing or reading the tree**, never by reading a
roadmap. Every one is now pinned by a test whose guard was break-verified.

---

## 4. The pattern this project keeps hitting, and what it cost

**A test that asserts a bug is worse than no test.** Four times in one session:

1. A.2's E2E drove "unconfirmed warns amber" with a **rejecting** shim — pinning
   the collapsed failure semantics as correct. The reject arm was the one where
   the keyring is *deleted*.
2. M5's three refusal tests demonstrated the arm with the escaped-quote case —
   the very defect I then fixed.
3. `hasResidualMaterial`'s fourth check guarded that same fixed defect and fired
   on `"[REDACTED]"auth`.
4. The C.3 E2E demanded the generic notice strip be **empty**, when the correct
   value was "empty of the credit sentence" — and failed on a legitimate
   `resume-gap` notice.

**A green suite is not evidence a feature ships.** The recurring shape, and each
was caught by measurement rather than by reading:

- B.2b's byte budget and B.2c's `resume-gap` notice both need `broadcast()`,
  which has **zero production callers**. They cannot fire in a shipped build.
- B.3's watermark is 36,609 B out of reach on the live path.
- C.3's `tts-renewal-soon` arm has no production trigger.
- C.5's task cards derive from `inventory` precisely because `event` has none.
- C.6 persists no threshold, and a negative test stops a later contributor from
  adding one without meeting the argument.

**A "pass" that measured nothing.** Three in one session: a `discardPending`
guard that was vacuous until reordered; an unwrapped `emit` that made a
`data-db` assert compare `0 < 0`; and a `shell: true` that let cmd.exe mangle a
`-t` filter so a break-run reported SURVIVED with zero tests executed. All three
were re-run by hand before being believed.

---

## 5. Diagnostic readiness — the honest verdict

`doctor --bundle` exists and is the right shape. Of the five discriminations the
roadmap wanted:

- **CAN** — squatter (authenticated 101 with a forged accept key is reported
  unhealthy), credit (`TTS_CREDIT_402/429` + `daysSinceFirstFault` from the
  jsonl, never a rebuilt monitor), serve-flap (`Ours` ∧ serve unreachable ∧
  0-byte `daemon.log`).
- **PARTIAL** — invalid key (consistent-with, never proof; **cannot name which
  key**; the 16-byte entropy floor yields `fingerprint: null` for short keys).
  **L17 stays open and the bundle does not claim to fix it.**
- **PARTIAL** — version mismatch (marker vs this build, plus the three-way
  refusal; **cannot see a shell↔daemon mismatch**, because nothing local records
  what the shell speaks).

**The spec's own success criterion was unsatisfiable and is recorded as such:**
`containsSecret(bundle) === false` is `true` on a correctly scrubbed bundle,
because the redactor preserves the field label and `[REDACTED]` is itself a legal
value for the assignment pattern. The shipped oracle is material-level
(`hasResidualMaterial`), which asks about material rather than about a pattern
that also matches its own output.

**Still open and named as such:** the invalid-key discrimination, the shell↔daemon
contract comparison, and Arabic-script gibberish detection (which needs
`res.language` from Groq and therefore **one recorded live call** before it is a
measurement rather than a guess).

---

## 6. Owner-only, not finishable by an agent

| Item | Why |
|---|---|
| Key rotation | Needs the plaintext `.env.local` |
| Real-microphone test (SEC-7 / L18) | Needs hardware |
| TTS tier: free vs paid `s2.1-pro` | Explicitly an owner decision |
| One live Fish WebSocket call | Needs a key; burns credit. The hand-rolled msgpack codec has **never spoken to the real endpoint** — stated in the module header |
| `A.7` credit-renewal bug | Cannot fire (no caller for `setRenewalAt`); fires the day one is wired |
| Version `0.7.2` → next | Release flow is owner-driven |

---

## 7. Recommendation

**The plan is complete as written, and the gates are green — but "green" here
means the tests agree with the code, not that the product is verified.** The two
live subsystems with no field evidence are the **Fish WebSocket transport** and
the **Silero VAD path** (whose 2 s timeout is reasoned, not measured, because
the model has never shipped). Both are named in their own module headers, and
both are one live call away from being a measurement.

If one thing is done next, it is that call.
