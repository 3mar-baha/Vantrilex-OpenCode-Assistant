# v0.8.0 Roadmap

Deferred or rejected items from the v0.7.2 audit cycle, with the reasoning
preserved so a future change has to argue with the reason rather than rediscover
it.

---

## EPIC: WebSocket TTS via `/v1/tts/live` — target v0.8.0

**Status:** approved as a roadmap epic, NOT started.
**Audit:** `dossier/FISH-AUDIO-COMPLIANCE-AUDIT.md` §R1.

### Why

Fish advertises ~90 ms time-to-first-audio. That figure is a property of the
WebSocket endpoint, not of the REST path — `POST /v1/tts` streams chunked audio
too, and the best first-chunk measured over it, with every parameter already
tuned, is **426 ms**.

The protocol is small and fully specified in the official `fish-audio-api` skill:

- MessagePack binary frames, both directions.
- Client: `start` (once) → `text`* → optional `flush` → `stop`.
  **The literal close event is `stop`, not `close`.**
- Server: `audio`* → exactly one `finish` with `reason: "stop" | "error"`.
- Connection headers: `Authorization` and `model` (same values as REST).

### The feature that actually matters here

The **`flush` event**: "forces the server to synthesize buffered text immediately
(use for turn-taking / low-latency flushes)". That maps directly onto barge-in,
which today is bounded by REST round-trips. It is the reason this is an epic and
not a config tweak.

### Scope

- A second transport alongside `FishHttpTransport` — not a replacement, so the
  REST path stays as the fallback.
- A MessagePack codec dependency (`@msgpack/msgpack`).
- A persistent connection with an explicit reconnection policy; a `finish` with
  `reason: "error"` must reconnect rather than retry on the same socket.
- `s2.1-pro-free` must remain valid on the WebSocket path — the skill lists it as
  an accepted `model` value there, but that is unverified and is the first thing
  to check before anything else.

### Explicitly out of scope

Per v0.7.2 decision: **not** a `GET /wallet/self/api-credit` preflight. See below.

---

## Rejected: `/wallet/self/api-credit` credit preflight

**Status:** REJECTED with measurement. Do not implement.

It looks like the obvious fix for the 402 problem and it is a trap. Measured
against the live API:

```
GET /wallet/self/api-credit?check_free_credit=false  http=200  has_free_credit=null
GET /wallet/self/api-credit?check_free_credit=true   http=200  has_free_credit=false
```

`has_free_credit` is **false while `s2.1-pro-free` synthesis succeeds normally**.
The wallet field describes a different credit pool than the promotional free
*model*. A preflight gate built on it would refuse to speak on a capable account,
converting a working feature into a dead one and reporting it as "out of credit".

402 handling is instead done in `fishErrorMessage()`, which names the balance as
the cause and explicitly says the key is fine.

---

## Still open

| Item | Status |
|---|---|
| Fish free tier expires **2026-11-30** | hard deadline; promotion, not a bug. Documented on `TTS_MODEL` |
| SEC-7 / L18 packaged mic grant | blocked on hardware with a microphone |
| 44 quarantined modules (~1,639 lines) | needs a wire/delete decision |
| CI | none exists; every gate is manual |
| L18-only PARTIAL in the L1–L24 ledger | gated on SEC-7 |
