# Fish Audio Compliance & Optimization Audit — Phase 2

**Date:** 2026-09-28 · **Audited:** `src/voice/tts.ts` at `895bc7f`
**Authority:** official `fish-audio-api` skill, installed at
`.agents/skills/fish-audio-api/SKILL.md` (condensed from
`docs.fish.audio/api-reference/openapi.json` + `asyncapi.yml`).

**Status: INSPECTION ONLY. No change made to `src/voice/tts.ts`.** Every
recommendation below is a proposal for review, per instruction.

---

## 1. Compliance summary

| Official requirement | Our implementation | Verdict |
|---|---|---|
| `Authorization: Bearer <key>` | `fishHeaders()` L: yes | **ALIGNED** |
| `Content-Type: application/json` | yes | **ALIGNED** |
| `model` header, value `s2.1-pro-free` | `model: TTS_MODEL`, `'s2.1-pro-free'` | **ALIGNED** |
| `model` omitted/unrecognised → falls back to paid `s2.1-pro` | pinned + 6 tests guard it | **ALIGNED** |
| `format: wav\|pcm\|mp3\|opus` | `'mp3'` (default) | **ALIGNED** |
| `latency: low\|normal\|balanced` | `'normal'` (default) | **DEVIATES — default, untuned** |
| `chunk_length` int **100–300** | `300` (default, in range) | **ALIGNED** |
| `min_chunk_length` int **0–100** | `50` (default, in range) | **ALIGNED** |
| `temperature` 0–1 | `0.5` (default 0.7) | ALIGNED, deliberate |
| `top_p` 0–1 | `0.7` (default) | **ALIGNED** |
| `repetition_penalty` >1.0 | `1.3` (default 1.2) | ALIGNED, deliberate |
| `condition_on_previous_chunks` | `true` (default) | **ALIGNED** |
| `prosody.normalize_loudness` — S2.1 family | `true` | **ALIGNED** |
| `prosody.speed` 0.5–2 | `0.95` | **ALIGNED** |
| 429 → rate limit | `release(key,false,429)` + throw | **ALIGNED** |
| non-ok → release with real status | `release(key,false,res.status)` | **ALIGNED** (L17) |
| 401/402/404 specific handling | not distinguished | **GAP — see R3** |
| 422 → validation, `loc` in response | not distinguished | **GAP — see R3** |
| WebSocket `/v1/tts/live` | not used | **NOT USED — see R1** |
| `normalize` — "for EN/ZH" | `true`, on Arabic text | **QUESTION — see R5** |

Header handling, tier selection and the whole body contract are compliant. The
deviations are latency-related and diagnostic, not correctness.

---

## 2. Phase 1 recap (Toolchain / F-02)

| | Before | After |
|---|---|---|
| `vitest` root + desktop | `^2.0.0` / `2.1.9` | **`4.1.11`** |
| `vite` root + desktop | undeclared / `5.4.21` | **`^7.1.0`** |
| `oxlint` | declared, never installed | **installed locally, 1.85.0** |
| root `package-lock.json` | **absent** | **148,623 B, committed** |

```
npm ci                  root       exit 0   226 packages, 0 vulnerabilities
npm ci                  desktop    exit 0   182 packages, 0 vulnerabilities
npm run test:vantrilex  no flags   exit 0
  lint:ox               8 warning(s) / 0 error(s), baseline 8, LOCAL binary
  root vitest           509 passed (41 files)
  desktop vitest        153 passed (24 files)
  E2E playwright        18 passed (14 specs)
cargo test              27 passed
tsc                     root 0, desktop 0
```

**Zero regressions across a two-major jump.** Root 509 and desktop 153 are
identical to the vitest 2 baseline, and **no test assertion was modified** — only
harness/config. Confirmed against the official `fish-audio-api` skill that
`s2.1-pro-free` remains a valid `model` header value, so the free tier is intact.

---

## 3. Measurements taken during this audit

`latency` sweep, production values otherwise, short Arabic greeting:

| `latency` | first chunk | chunks | total | whole |
|---|---|---|---|---|
| `low` | 1,376 ms | 35 | 45,138 B | 2,532 ms |
| **`balanced`** | **426 ms** | 16 | 40,123 B | **1,187 ms** |
| `normal` *(shipped)* | 1,432 ms | 11 | 42,630 B | 1,462 ms |

Repeated in a second sweep: `balanced` 556 ms, `low` 443 ms, `normal` 1,405 ms.
So `normal` is *reliably* ~1.4 s and `balanced` is *reliably* ~0.43–0.56 s.
`low` is high-variance (443–1,376 ms) and produced the most chunks and the
slowest completions, so it is not the recommendation despite one fast sample.

`chunk_length` inside the documented 100–300 range:

| `chunk_length` | first chunk | chunks | whole |
|---|---|---|---|
| 100 | 1,065 ms | 10 | 1,078 ms |
| 200 | 1,259 ms | 9 | 1,336 ms |
| 300 *(shipped)* | 1,405 ms | 4 | 1,437 ms |

**Correction to the v0.7.1 note.** That report swept `chunk_length: 50`, which is
**below the documented 100–300 floor** — the request was malformed, not slow. The
data point was invalid and the conclusion ("effect smaller than noise") was drawn
from a set containing a bad sample. Re-run in range, there *is* a real but modest
effect: 100 is ~24 % faster to first chunk than 300. The conclusion that tuning
was unwarranted still holds on the valid data, but for a different reason.

---

## 4. Prioritized recommendations

### R1 — Move to WebSocket `/v1/tts/live` · **HIGH · architectural**

`POST /v1/tts` does stream (`Transfer-Encoding: chunked`), so the current code is
not "buffered" — that claim in the v0.7.1 note was imprecise. But the ~90 ms TTFA
the vendor advertises is a property of the WebSocket endpoint, and the REST path
cannot reach it: our best measured first chunk is 426 ms even with optimal
settings.

The protocol is small and well-specified: MessagePack frames, `start` → `text`* →
`stop` (note the literal is **`stop`, not `close`**), server replies
`audio`* then exactly one `finish`. The decisive feature for a voice assistant is
the **`flush` event** — "forces the server to synthesize buffered text immediately
(use for turn-taking / low-latency flushes)". That maps directly onto barge-in.

Cost: a second transport, a MessagePack codec (`@msgpack/msgpack`), and a
persistent connection with reconnection policy. **Not a patch — a project.**
Estimated payoff: first audio well under 200 ms, and barge-in that actually
interrupts mid-sentence.

### R2 — Set `latency: 'balanced'` · **HIGH · one line, ~3× faster**

Measured 426–556 ms vs 1,405–1,432 ms first chunk. One string change, reversible,
and it improves perceived responsiveness today while R1 is built.

`balanced` is the documented middle setting ("Quality vs latency"). It produced
fewer, larger chunks than `normal` (16 vs 11 at first sample, but 5 vs 4 at
chunk_length 100) and a faster completion, so quality cost looks acceptable for a
spoken reply. **Needs an A/B listen before shipping** — the numbers argue for it,
but intelligibility of Arabic is not measurable from chunk counts.

### R3 — Distinguish 401 / 402 / 422 / 429 in `tts.ts` · **MEDIUM · diagnostics**

Today every non-ok status becomes `TTS failed: HTTP ${status}` with
`release(key,false,status)`. Only 429 is named. Consequences:

- **402** surfaces as an opaque failure. This is exactly the diagnosis that cost
  hours earlier: 402 means out of credit, and the message does not say so.
- **422** is a validation error whose response is an *array* of `{loc,msg}`. We
  discard it, so a bad parameter looks identical to a network fault.
- **401/403** do rotate the key (L17 handles it); 402/422/404 do not, correctly,
  but the user cannot tell a dead key from an exhausted balance.

Recommendation: map status → a stable `ErrorCode` (`TTS_AUTH`,
`TTS_NO_CREDIT`, `TTS_VALIDATION`, `TTS_RATE_LIMITED`) and surface
`secretSafeMessage`. Cheap, and it converts a class of silent failures into
actionable ones.

### R4 — Do **NOT** add a `/wallet/self/api-credit` preflight · **REJECTED, with evidence**

The skill documents `GET /wallet/self/api-credit?check_free_credit=true`, and a
credit preflight looks like the obvious fix for the 402 problem. **It is a trap,
and I measured it:**

```
?check_free_credit=false  http=200  has_free_credit=null
?check_free_credit=true   http=200  has_free_credit=false
```

`has_free_credit` is **false while `s2.1-pro-free` synthesis succeeds normally.**
The wallet field describes a different credit pool than the promotional free
*model*. A preflight gate built on it would refuse to speak on a perfectly
capable account — converting a working feature into a dead one and reporting it as
"out of credit". Recorded specifically so nobody implements this later.

### R5 — Confirm `normalize: true` is correct for Arabic · **LOW · verify**

The skill documents `normalize` as "Normalize numbers/etc. for **EN/ZH**". We send
`true` (the default) on Arabic text. Probably harmless — it is the default — but
it is the one field whose documented purpose does not match our language, and
Arabic numerals and date forms are exactly the sort of thing a normalizer could
mangle. One A/B on a number-bearing Arabic sentence would settle it.

### R6 — Consider `[bracket]` emotion tags for narration · **LOW · quality**

The skill documents that S2-Pro accepts free-form `[bracket]` natural-language
tags (e.g. `[slightly sarcastic, rising tone]`) in `text`, with no separate
parameter. Our narrator produces flat, factual Arabic. A small style tag per
outcome could raise perceived quality at zero latency cost — but it also risks
the model reading the tag aloud, so it needs a listen before adoption.

### R7 — Pin the free tier with an explicit expiry check · **LOW**

`s2.1-pro-free` is documented as running **through 2026-11-30**. Nothing in the
code encodes that. A dated comment (as with the narration ceiling) and a `doctor`
line would stop the expiry being discovered the way the 402 was.

---

## 5. Suggested order

1. **R2** — one line, measured 3× gain, reversible. Listen, then ship.
2. **R3** — small, converts silent failures into actionable ones.
3. **R5**, **R7** — cheap verifications and documentation.
4. **R1** — scope it as its own project; it is the only item that changes the
   architecture of the audio path.
5. **R6** — quality, after the latency work settles.

Explicitly not recommended: a credit preflight (R4), and any change to the model
header, which is correct, pinned and test-guarded.
