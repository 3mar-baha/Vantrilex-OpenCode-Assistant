# 23 — Stress Testing: Event Bursts, Packet Drops, Concurrent Voice & Memory Leaks

> **Canonical status:** Design/immunity/owner batch. Chaos truth for NFR-4/5/7 (`01`).
> Harness base: `11` · Recovery: `14` · Backpressure: `25`.

## 23.1 — Stress Suite Overview (normative, `pnpm stress`)

| Suite | Load | Pass criterion |
|-------|------|----------------|
| S-burst | 100k synthetic SSE events in ≤ 60 s via mock serve | Zero dropped terminal events; ledger seq gapless; p99 append < 5 ms |
| S-drop | 15% packet loss + 800 ms jitter on loopback (proxy shim) for 10 min | Reconnect ≤ 5 s each; replay recovers all terminal events; no duplicate briefings |
| S-voice | 20 concurrent voice prompts (mock STT/brain/TTS at budget edge) | All intents dispatched; speech queue serializes with identity prefixes; no overlap |
| S-soak | 12 h mixed workload (sessions + briefings + rotations) | RSS growth ≤ 5% over final 6 h; cache bounded at 50/byte-cap; no handle leaks |
| S-kill | kill -9 at 5 random points mid-session + mid-briefing | Reconstruction within one event each time (`10` §10.2 SLA) |

## 23.2 — 100k Event Burst Protocol

1. Mock serve emits 100,000 envelopes (routine-heavy mix + 50 terminal events seeded
   at random positions) as fast as the loopback allows.
2. Orchestrator must: validate → dedupe → append → route (T0 silent, T1 queued) with
   backpressure shedding *routine* events only (terminal events are never shed — shed
   counter + ledger mark prove what was dropped).
3. Assert: all 50 terminal events briefed exactly once; ledger `seq` contiguous;
   shed count equals routine-only drops; no OOM (RSS ≤ 512 MB, NFR-5).

## 23.3 — Network Packet Drops and Flapping

Loopback proxy shim injects loss/jitter/reorder between daemon and mock serve.
Expected behavior per drop episode: 3 missed heartbeats → reconnect with backoff +
jitter → `Last-Event-ID` replay → gap flag on recovered rows → dedupe suppresses
re-briefing. The suite fails on: any reconnect > 5 s, any lost terminal event, any
duplicate T1 speech job (not just suppressed playback — the enqueue itself).

## 23.4 — Rapid Concurrent Voice Prompts

20 parallel prompts through scripted mocks at budget-edge latencies (STT 450 ms,
brain 1.9 s, TTS first-chunk 750 ms): asserts 20/20 intents dispatched to correct
sessions, keyring counters exact under concurrency (no slot double-spend, `20` §20.3),
speech queue depth handled per collapse policy (`02` §2.3.2, depth > 3 → digest).

## 23.5 — Memory Leak Analysis (normative)

- Soak run samples RSS, heap, handle count, and cache stats every 60 s to CSV.
- Analysis: linear fit over final 6 h; slope > 5% growth fails; heap snapshot diff
  must show no retained `AcquiredKey.material` buffers post-release (I-3, `12`).
- Audio blobs: directory size ≤ `maxBytes` at every sample; eviction `dispose`
  verified by create-then-delete inode accounting.

---

*End of `23-STRESS-TESTING.md`. Next: `24-IMMUNOLOGY.md`.*
