# P1 item 4 — TTS first-chunk latency: negative result, no change made

**Question.** Fish advertises ~90 ms time-to-first-audio. We measure ~1,157 ms
on `synthesizeStream`. Hypothesis: `chunk_length: 300` in `fishRequestBody`
(the documented maximum) delays the first cut.

**Method.** Swept `chunk_length` and `min_chunk_length` against the live API
with everything else held at the production setting, on both a short greeting
and a multi-clause sentence, since split behaviour only shows with more than one
clause.

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
