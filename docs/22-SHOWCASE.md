# 22 — Showcase: Automated Project Showcase Generation, Visual Tokens & Dashboard Metrics

> **Canonical status:** Design/immunity/owner batch. Showcase truth.
> Audio tokens: `21` · Ledger source: `10` · Cache stats: `05` §5.4.

## 22.1 — Purpose and Artifact (normative)

`opencode-voice showcase` generates a self-contained `docs/showcase.html` (no build
step, no CDN — inline CSS/SVG only so it renders offline and from `file://`) that
presents project health to operators and stakeholders: milestone progress, latency
posture, cache efficiency, and suite completion. Regeneration is deterministic from
repo state — the same commit always yields the same showcase modulo timestamps.

## 22.2 — Generation Spec (normative)

1. **Inputs:** `git log` range, docs file inventory (28 canonical files + byte sizes),
   latest `LatencyReport`s (`11` §11.3), `AudioCacheStats` snapshot, checkpoint ledger
   (`10` §10.4), release version.
2. **Pipeline:** collect → validate (missing input renders as `n/a`, never fabricated)
   → render inline template → write atomically (temp + rename) → ledger-record the
   generation (commit hash + input digests).
3. **Freshness contract:** the showcase header shows generation time + source commit;
   a showcase older than the latest commit displays a `stale` badge. CI regenerates
   on every `main` push.

## 22.3 — Visual Tokens (normative)

| Token | Value | Use |
|-------|-------|-----|
| `--ink` `#101418` / `--paper` `#f7f5f0` | dark-on-warm | body |
| `--green` `#1a7f4b` / `--amber` `#b7791f` / `--red` `#b3362b` | status hues | session/outcome states (mirrors CLI `21` §21.5) |
| `--mono` `ui-monospace, Consolas, monospace` | code face | hashes, paths, metrics |
| Radius `10px`, single-column max `880px` | layout | readability, no framework |

No external fonts, no trackers, no scripts beyond an optional `<details>`-driven
progress disclosure (pure HTML).

## 22.4 — Progress Dashboard Metrics (normative sections)

1. **Suite completion:** `n/28` canonical files with per-batch bars (Batch 1–4).
2. **Milestone tracker:** M1–M6 (`08`) with current position + exit-criteria checklist state.
3. **Latency posture:** latest p50/p99 vs budgets (STT 500 ms, brain 2.0 s/5.0 s,
   TTS first-chunk 800 ms, cache-hit 50 ms) with pass/fail chips.
4. **Cache efficiency:** hit ratio, top-10 repeated phrases (digests, never verbatim
   secrets-adjacent text), eviction count.
5. **Reliability:** terminal events delivered vs replays, reconnect count, rotation
   rollovers with reasons.
6. **Activity:** commit sparkline (last 30 commits, one concern each per Gate 5).

---

*End of `22-SHOWCASE.md`. Next: `23-STRESS-TESTING.md`.*
