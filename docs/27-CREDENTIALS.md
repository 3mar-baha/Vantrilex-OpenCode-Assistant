# 27 — Credentials: Key Management Protocols, Test/Prod Separation, Auditing & Segregation

> **Canonical status:** Design/immunity/owner batch. Credential-ops truth.
> Vault mechanics: `12` + `20` · Incident recipe R-C: `14` §14.3.

## 27.1 — Key Management Protocols (normative)

1. **Creation:** keys are created at the provider dashboards (Groq, Fish Audio), never
   by the daemon. Minimum pool posture: 2 keys per pool (rotation needs somewhere to
   roll); recommended 3 (worked proof in `20` §20.4).
2. **Ingestion:** `opencode-voice vault set <groq|fish> --from-prompt` reads via hidden
   prompt → encrypts → persists `VaultBlob` → zeroes input buffer. Keys are never
   passed as CLI args (shell history), never pasted into chat, never stored in `.env`.
3. **Rotation:** scheduled quarterly AND on any incident (R-C), suspicion of exposure,
   or team change. Procedure: create new key at provider → `vault add` → verify
   `doctor` → revoke old key at provider → `vault remove`. The daemon tolerates mixed
   old/new pools mid-procedure (per-key 401 → forced rollover, F-20).
4. **Revocation:** `opencode-voice vault remove <pool> <keyId>` + provider-side revoke
   within the hour; ledger records `revoked` (keyId fingerprint only, never material).

## 27.2 — Test/Production Separation (normative)

| Environment | Keys | Vault | Egress |
|-------------|------|-------|--------|
| Local dev | Operator's personal sandbox keys | Local DPAPI vault | Live providers allowed; spend-capped at provider |
| CI | Revoked-on-sight sandbox keys, DPAPI machine scope | Fixture vault artifact | Mocks only — live egress fails the suite (`12` §12.5) |
| Production | Dedicated paid keys, never shared with dev/CI | Operator-machine DPAPI vault | Live providers |

Cross-contamination (prod key in CI log, dev key in fixture) is an S1 incident:
rotate the exposed key, purge the artifact, record R-C.

## 27.3 — Auditing Procedures (normative, quarterly + on incident)

1. Secret-scan repo + data dir for key patterns (I-1, `12` §12.3) — zero matches required.
2. Verify vault file ACLs (`0600`/current-user-only) and parent-dir posture.
3. `ps` probe: no secret in process list (I-4).
4. Review ledger for `rate-limited` / `auth-failed` rollovers — spikes indicate quota
   posture review (add keys) or a dying key (rotate early).
5. Confirm `diag` bundles from the quarter contain no secret-pattern hits
   (fail-closed bundler, `14` §14.4).
6. Record the audit (date, scope, findings, rotations performed) in the ledger (`10`).

## 27.4 — Environment Segregation

`OPENCODE_SERVER_PASSWORD` is per-machine (never shared across hosts — each install
runs its own `serve` on loopback). Provider pools may be shared across an operator's
machines only via independent `vault set` per machine (keys at rest under different
DPAPI identities). No credential ever transits email, chat, screenshots, or screen-share.

---

*End of `27-CREDENTIALS.md`. Next: `28-OWNER-GUIDE.md` (final canonical file).*
