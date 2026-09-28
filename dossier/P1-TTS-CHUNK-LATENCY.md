# P1 item 4 — TTS first-chunk latency: negative result, no change made

**Question.** Fish advertises ~90 ms time-to-first-audio. We measure ~1,157 ms
on `synthesizeStream`. Hypothesis: `chunk_length: 300` in `fishRequestBody`
(the documented maximum) delays the first cut.

**Method.** Swept `chunk_length` and `min_chunk_length` against the live API
with everything else held at the production setting, on both a short greeting
and a multi-clause sentence, since split behaviour only shows with more than one
clause.

## CORRECTION (2026-09-28) — superseded by `dossier/FISH-AUDIO-COMPLIANCE-AUDIT.md`

Two claims below are wrong. Both were re-checked against the official
`fish-audio-api` skill and by re-measuring against the live API.

**1. The `chunk_length: 50` row was invalid.** The documented range is
`100-300`. A request at 50 is malformed, so that row measured a rejected
request, not a slow one. It was then used to argue "the effect is smaller than
the noise" — a conclusion drawn from a set containing a bad sample.

Re-measured inside the valid range:

| `chunk_length` | first chunk | whole |
|---|---|---|
| 100 | 1,065 ms | 1,078 ms |
| 200 | 1,259 ms | 1,336 ms |
| 300 (shipped) | 1,405 ms | 1,437 ms |

So there *is* a real effect — 100 is ~24 % faster to first chunk than 300. The
conclusion that `chunk_length` was not worth changing still stands, but for a
different reason than originally given, and the original table should not be
used.

**2. "buffered" was the wrong word.** The official spec states that `POST /v1/tts`
returns "streaming audio bytes (`Transfer-Encoding: chunked`)". The code was
already streaming; the ~90 ms figure belongs to the WebSocket endpoint
`/v1/tts/live`, not to a buffering choice in this code. That part of the
conclusion was right for the wrong reason.

**What the audit then found, which this note missed entirely:** the `latency`
parameter was never swept. It is the dominant lever, and it is one string.

| `latency` | first chunk |
|---|---|
| `balanced` | 426–556 ms |
| `normal` (shipped) | 1,405–1,432 ms |
| `low` | 443–1,376 ms (high variance) |

That is a reproducible ~3× improvement available today without touching the
architecture. Full analysis, compliance table and recommendations in
`dossier/FISH-AUDIO-COMPLIANCE-AUDIT.md`.

**No change has been made to `src/voice/tts.ts`.** This is an audit deliverable
awaiting review.

---

## Results

`chunk_length`, short text (`"مرحبا، كيف حالك اليوم؟"`):

| chunk_length | first chunk | chunks | total |
|---|---|---|---|
| 50 | request failed | — | — |
| 100 | 2,051 ms | 34 | 45,974 B |
| 200 | 1,864 ms | 14 | 45,974 B |
| 300 | 1,648 ms | 13 | 49,736 B |

`chunk_length`, long text (multi-clause):

| chunk_length | first chunk | chunks | total |
|---|---|---|---|
| 100 | 3,717 ms | 19 | 127,058 B |
| 200 | 3,613 ms | 15 | 132,492 B |
| 300 | 4,048 ms | 14 | 141,269 B |

`min_chunk_length` sweep at `chunk_length: 300`, short text:

| min_chunk_length | first chunk |
|---|---|
| 10 | 1,407 ms |
| 20 | 1,682 ms |
| 50 | 1,591 ms |
| 100 | 1,594 ms |

## Conclusion: the hypothesis is not supported, and nothing was changed

There is no monotonic relationship in either direction — 300 is the *fastest*
on short text and the *slowest* on long text. The spread within a single
configuration across separate sweeps (1,407–2,051 ms for short text) is larger
than the spread between configurations.

**The effect is smaller than the measurement noise on a free tier that documents
no latency guarantee.** Changing `chunk_length` to any of these values would be
tuning against noise, and would make the code look measured when it is not.

## Where the latency probably actually is

The ~90 ms figure is most likely quoted for Fish's **WebSocket streaming
endpoint**, not the REST endpoint. The REST call buffers a response and cuts it
to chunks afterwards, so first-byte latency reflects synthesis of the first
chunk plus HTTP transfer, not a streaming server pushing audio.

That is an **architecture change, not a tuning change**: a second transport
alongside `FishHttpTransport`. It is recorded as a candidate for a future phase
and deliberately not started here.

## What is left unchanged

`chunk_length: 300`, `min_chunk_length: 50` — the documented defaults. The
existing comment on `chunk_length` (line 239) already records that it was raised
from 200 deliberately; that reasoning still holds and this data neither
contradicts it nor supports changing it further.
