# 28 — Owner Guide: Daily CLI, Voice Toggling, Diagnostics, Updates & Disaster Recovery

> **Canonical status:** Design/immunity/owner batch. Operator manual — the final
> canonical file (28/28). Read `14-RUNBOOK.md` for incidents, `27` for credentials.

## 28.1 — Daily CLI Commands (normative reference)

| Command | Effect |
|---------|--------|
| `opencode-voice start` / `stop` / `restart` | Daemon lifecycle (single-owner enforced, `13` §13.3) |
| `opencode-voice status` | One line per session (`21` §21.5) + vault/relay health |
| `opencode-voice sessions` | Session list with state, outcome, briefing count |
| `opencode-voice prompt <session> "<text>"` | Manual follow-up (provenance `cli`) |
| `opencode-voice approve <id>` / `deny <id>` | Resolve approval queue by hand |
| `opencode-voice repeat [session]` | Re-play last briefing from cache/log |
| `opencode-voice voice <male\|female>` | Voice toggle (next utterance boundary, `18` §18.4) |
| `opencode-voice skills sync --repo <path>` | Force catalog ingestion pass (`17` §17.3) |
| `opencode-voice showcase` | Regenerate `docs/showcase.html` (`22`) |
| `opencode-voice diag --out diag.zip` | Redacted diagnostics bundle (`14` §14.4) |
| `opencode-voice doctor` | Pre-flight audit: keys (names only), devices, port, versions |
| `opencode-voice pair` / `pair revoke` | Mobile pairing code / token revocation (`19`) |
| `opencode-voice vault set\|add\|remove <pool>` | Credential lifecycle (`27` §27.1) |

## 28.2 — Voice Configuration Toggling

- **Voice:** `opencode-voice voice female` switches narrator at the next utterance
  boundary; persisted in config; survives restarts.
- **Capture mode:** config `capture: push-to-talk | wake-word`; wake-word sensitivity
  low/medium/high. Open-mic continuous capture is not offered (privacy posture, `02` §2.2).
- **Verbosity:** `briefings: bluf | full` — `full` extends change clauses to 5 and
  permits one log excerpt; default `bluf` (≤ 45 s).
- **Quiet hours:** `quiet: 22:00-07:00` mutes T1 speech (ledger + mobile digest only);
  T2 approvals still ping once, then honor the window.

## 28.3 — Diagnostic Scripts

1. `doctor` (pre-flight, §28.1) — run after every install, update, or device change.
2. `diag` bundle (§28.1) — attach to every incident note; never raw logs.
3. Latency spot-check: `opencode-voice bench --quick` runs 20 samples per subsystem
   against current providers and compares to budgets (`11` §11.3); over-budget lines
   print with tuning hints (key pressure? network? model?).
4. Ledger inspect: `opencode-voice ledger --tail 50 --session <id>` prints secretSafe
   rows for archaeology without vault access.

## 28.4 — Updating Procedures

1. `npm update -g opencode-voice-runtime` (or replace binary).
2. `opencode-voice doctor` — must pass before start.
3. `opencode-voice start` — contract probe runs automatically; `CONTRACT_DRIFT`
   warnings are informational unless paired with errors (then see R-D, `14` §14.3).
4. Verify: one voice round-trip ("status check") + `sessions` matches pre-update list.
5. Record update in ledger (automatic `update` admin row with versions).

## 28.5 — Disaster Recovery (normative)

| Disaster | Recovery | Data loss bound |
|----------|----------|-----------------|
| Daemon host dies | Reinstall → restore `<dataDir>` backup (ledger + snapshot + vault is machine-bound: re-`vault set` on new OS identity) → start → auto-reconcile | ≤ 1 event (`10` §10.2) |
| Vault unrecoverable | Re-`vault set` all pools from provider dashboards; sessions/ledger intact | Zero session state; keys re-entered |
| Ledger disk corrupt | Snapshot `.bak` → ledger-only rebuild; missing tail reconciled vs `serve` | Tail since last good snapshot, reconciled |
| Total data loss | Fresh `init`; sessions re-created by voice; providers untouched | Local history only — no provider-side state ever depended upon |
| Key compromise | R-C (`14` §14.3): rotate at provider → `vault` refresh → audit I-1–I-5 | Revoked key's remaining quota only |

**Backup rule:** `<dataDir>/ledger/` + `snapshot.json` copied daily to operator backup
(vault excluded — it is machine-bound by design; re-entry is the restore path).
Test the restore yearly: the recovery you never rehearse is the one that fails.

---

*End of `28-OWNER-GUIDE.md`. The 28-file canonical suite is complete.*
