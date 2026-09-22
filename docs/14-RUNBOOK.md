# 14 — Runbook: Incident Response, Troubleshooting & Recovery Recipes

> **Canonical status:** Governance. Ops truth. Symptom → diagnosis → remedy for every
> edge in `01` §1.6. Immunology catalog: `24-IMMUNOLOGY.md`.

## 14.1 — Incident Severity and First Response

| Sev | Meaning | First action |
|-----|---------|--------------|
| S1 | Voice loop fully down (no STT/brain/TTS) | `opencode-voice doctor`; check provider status; fail to text-prompt mode |
| S2 | Degraded (one provider 429, SSE flapping) | Confirm auto-remediation in logs (rollover/reconnect); no manual key edits |
| S3 | Cosmetic (missed earcon, stale status line) | Note in ledger; fix in next polish pass |

Golden rule: **never paste a live key into chat, logs, or the repo** — rotate, don't
rescue (`27`). Never `push --force`; never delete the ledger to "fix" divergence
(reconcile instead, `10` §10.2).

## 14.2 — Troubleshooting Matrix

| Symptom | Likely cause | Diagnosis | Remedy |
|---------|-------------|-----------|--------|
| Daemon won't boot, port busy | Stale or foreign listener (E-1) | `opencode-voice doctor`; probe `GET /health` | Adopt-if-healthy else auto-escalate (`13` §13.5) |
| SSE disconnects loop | `serve` restarted / network flap (E-2) | Logs: `SSE_DISCONNECTED` + backoff | Automatic reconnect + replay; if > 5 min, restart `serve` via launcher |
| Missing `session:complete` | Reconnect gap (E-4) | Ledger gap flag set | Replay cursor recovers; reconcile `GET /session`; briefing deduped by event id |
| Groq/Fish HTTP 429 | Quota exhausted on active key (E-3/E-7) | Logs: `RATE_LIMITED` + `lastRolloverReason` | Automatic forced rollover + jittered retry (max 3); operator adds keys via `vault set` |
| Brain slow / timeout | Provider latency spike (E-8) | `BRAIN_TIMEOUT` in ledger | Fallback briefing auto-sent; retry once; record in tuning log |
| No mic / mic vanishes | Device unplugged/default changed (E-5) | `doctor` audio section | Text-prompt fallback; re-plug → auto re-detect, one spoken notice |
| Briefing silent | Audio device failure (E-6) | `AUDIO_DEVICE_MISSING` | Re-queue text; visual log fallback; plays on device return |
| Vault unreadable | Corrupt blob / wrong OS user (E-11) | `VAULT_CORRUPT`, checksum line | Restore from OS keychain backup or re-`vault set`; never create plaintext fallback |
| Approval stuck | Mobile offline / token expired | `APPROVAL_EXPIRED` | Safe default already applied (pause); re-request on reconnect (`19`) |
| `ps` shows password | Launcher regression (I-4 violated) | `ps` grep probe | S1 bug: stop, file incident, fix `argv` leak before restart |

## 14.3 — Recovery Recipes

**R-A — Full voice outage (both providers 429):**
1. Confirm logs show `RATE_LIMITED` + exhausted pools (not a code bug).
2. LRU cache keeps repeated phrases playing — announce degraded mode once (no spam).
3. Add fresh keys: `opencode-voice vault set groq --from-prompt` (same for `fish`).
4. `opencode-voice doctor` → resume; record incident + key counts in ledger.

**R-B — Daemon kill -9 mid-session (E-10):**
1. Start daemon; automatic: snapshot load → ledger replay → reconcile → SSE resume.
2. Verify: `opencode-voice sessions` matches pre-crash list within one event.
3. Any duplicate briefing is benign (deduped downstream) — do not purge the ledger.

**R-C — Suspected secret leak (committed key / pasted token):**
1. `git rm --cached` the file if unpushed; if pushed, rotate the key at the provider
   immediately (leak is live the moment it leaves the machine).
2. Replace with vault-backed flow; record incident in ledger; audit I-1–I-5 (`12`).

**R-D — Upstream OpenCode upgrade broke the adapter (E-12):**
1. Confirm `CONTRACT_DRIFT` line with recorded versions.
2. Confine the fix to `runtime/` + `orchestrator/`; voice/brain/keyring untouched (`04` §4.5).
3. Ship adapter patch as its own atomic commits; note migration in `28`.

## 14.4 — Diagnostics Bundle

`opencode-voice diag --out diag.zip` collects: redacted config (names only), ledger
tail (secretSafe), `git log` range, `doctor` output, OS/audio inventory. The bundler
runs the secret-pattern scan before zipping and refuses to include failures
(fail-closed). Operators attach this bundle — never raw logs — to incident notes.

---

*End of `14-RUNBOOK.md`. Batch 2 (files 08–14) complete. Next batch: `15–20`.*
