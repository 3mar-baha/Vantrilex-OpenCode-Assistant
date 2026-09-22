# 10 — Checkpoint: Deterministic Session Checkpointing, Reconstruction & Ledger Persistence

> **Canonical status:** Governance. State-survival truth. Implements FR-10 (see `01`).
> Types: `05` §5.2–§5.3 · Reconnect: `25` · Gate-5 updates: `16` §16.7.3.

## 10.1 — Checkpoint Protocol (normative)

The daemon maintains an append-only **ledger** (JSONL, one `LedgerRow` per line,
`05` §5.3) plus a periodic **snapshot** (single JSON: all `SessionRecord`s + active
SSE cursor + keyring *counters only, never key material* + speech-queue depth).

1. **Append rule:** every validated SSE envelope appends exactly one ledger row before
   any side effect (briefing enqueue, approval request). Side effects are downstream
   of the append — a crash between append and effect replays the effect, never loses it.
2. **Snapshot rule:** snapshot written every 30 s AND on every terminal event
   (`session:complete`, `session:idle`, approval resolution). Snapshot write is atomic
   (write temp + rename); the previous snapshot is retained as `.bak` until the new
   one checksums clean.
3. **Fsync rule:** ledger appends `fsync` before acknowledging the event internally;
   snapshots `fsync` the directory entry after rename. Durability over throughput —
   event volume is human-scale (tens/minute), never 100k/s sustained (bursts in `23`
   are absorbed by the OS page cache + backpressure in `25`).
4. **Idempotency rule:** `envelope.id` dedupes replays (duplicates append a row marked
   `duplicate: true`, enqueue nothing). Snapshot restore replays only rows with
   `seq` greater than the snapshot's `highSeq`.

## 10.2 — State Reconstruction after Daemon Restart

```mermaid
flowchart TB
    A[Daemon starts] --> B[Load latest snapshot\nverify checksum]
    B -->|corrupt| C[Fall back to .bak\nthen ledger-only rebuild]
    B -->|clean| D[Replay ledger rows\nseq > snapshot.highSeq]
    C --> D
    D --> E[Reconcile vs serve:\nGET /session list]
    E --> F{Divergence?}
    F -->|serve knows more| G[Adopt + provenance=reconciled]
    F -->|ledger knows more| H[Re-emit prompt or mark error]
    F -->|agree| I[Resume SSE from stored cursor]
    G --> I
    H --> I
    I --> J[Re-enqueue unplayed T1 briefings\n(dedupe by session + event id)]
```

**Reconstruction SLA (normative):** post-restart state matches pre-crash state within
one event — i.e., at most one briefing re-enqueued (deduped downstream) and zero
terminal events lost. Verified by the kill -9 chaos test (`23` §23.4, E-10).

## 10.3 — Ledger Persistence Format

- **Path:** `<dataDir>/ledger/YYYY-MM-DD.jsonl` (daily rotation, 30-day retention,
  gzip after rotation). **Snapshot:** `<dataDir>/snapshot.json` + `snapshot.json.bak`.
- **Row encoding:** `LedgerRow` as compact JSON; `secretSafeMessage` strings only —
  the ledger writer rejects any value matching secret patterns (see `12` §12.3) by
  throwing before write (fail-closed, never redact-and-continue silently).
- **Retention & privacy:** transcripts older than the retention window are compacted
  to digests (intent + outcome, no verbatim text) unless the operator opts into full
  retention in config. Compaction is itself ledger-recorded (a `compaction` admin row).

## 10.4 — Execution Ledger — Documentation Suite (living section)

*Gate-5 re-sync target (`16` §16.7.3). Updated per batch.*

| Batch | Files | Commits (hash range) | Verification |
|-------|-------|---------------------|--------------|
| Batch 1 + Gate 1 + `16` | `16`, `01`–`07` (8 files) | `9a81b88` → `73141b8` (9 commits) | 8/8 files; placeholder grep clean; tree clean |
| Batch 2 | `08`–`14` (7 files) | `e8cb30b` → *in progress* | per-file commits; counts verified at batch end |

---

*End of `10-CHECKPOINT.md`. Next: `11-TESTING.md`.*
