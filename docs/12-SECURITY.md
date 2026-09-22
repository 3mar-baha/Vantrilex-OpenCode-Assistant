# 12 — Security: DPAPI Vault, Zero-Plaintext Invariants, Env Sanitization & Boundaries

> **Canonical status:** Governance. Security truth. Implements FR-8 + NFR-6 (see `01`).
> Rotation mechanics: `20-KEYRING.md` · Credential ops: `27-CREDENTIALS.md`.

## 12.1 — Threat Model (scoped)

| Asset | Adversary | Out of scope |
|-------|-----------|--------------|
| Groq + Fish API keys at rest/in-log/in-dump | Local malware, shoulder-surfing logs, accidental `git push` of secrets | Nation-state with kernel access; physical device theft without OS login |
| `OPENCODE_SERVER_PASSWORD` in process list/logs | `ps` snoopers, log aggregators | Network attacker — mitigated by localhost-only bind + Bearer |
| Microphone stream | Always-on surveillance perception | Mitigated by push-to-talk/wake-word gating (`02` §2.2) |
| Relay approval channel | Token replay, MITM | Mitigated by challenge-response + TLS + short-lived tokens (`19`) |

## 12.2 — DPAPI Vault Implementation (normative)

1. **Encryption:** key pools are serialized (`PoolSecrets`, `05` §5.5) and encrypted
   with the OS data-protection API — Windows DPAPI via `safeStorage` (Electron) or
   the documented fallback chain (`node-data-protection` → OS keychain entry).
   Ciphertext + nonce + checksum persist as `VaultBlob`; the data-protection key
   never leaves OS custody.
2. **In-memory handling:** decrypted material lives in a `Buffer` that is `fill(0)`ed
   immediately after key extraction for dispatch. Key strings are never assigned to
   long-lived variables, never interpolated into log arguments, never placed in
   error objects. Heap snapshots therefore contain at most transient fragments.
3. **File posture:** vault file `0600` (POSIX) / current-user-only ACL (Windows),
   parent directory not world-readable. Checksum verified before decrypt; mismatch →
   `VAULT_CORRUPT`, pool refused, operator error (E-11). No plaintext fallback exists.
4. **CI posture:** tests use an encrypted *fixture* vault whose DPAPI scope is the CI
   machine identity; fixture keys are sandbox/revoked credentials (`27`).

## 12.3 — Zero-Plaintext Invariants (normative, all must hold)

- **I-1 (disk):** no file in the repo or data dir (excluding the vault blob itself,
  which is ciphertext) matches `sk-…`, `gsk_…`, fish key patterns, or the server
  password. Enforced by pre-commit grep + CI secret-scan.
- **I-2 (logs/ledger):** `common/logger` redacts on write — Bearer values, key
  substrings (>8-char matches against active key hashes), and `password=` pairs
  become `[REDACTED]`. Ledger writer throws on secret-pattern match (fail-closed, `10` §10.3).
- **I-3 (memory dumps):** crash reports strip env (`OPENCODE_SERVER_PASSWORD`,
  `*_KEYS`) before write; minidump annotation allowlist excludes secret fields.
- **I-4 (process list):** password passed via child `env` only — never `argv`
  (`26-AGENT-LAUNCHER.md`). Verified: `ps` output grep finds no secret.
- **I-5 (errors):** only `secretSafeMessage` (`05` §5.7) reaches logs/ledger/UI;
  raw provider bodies (which may echo keys) are dropped after code extraction.

## 12.4 — Environment Variable Sanitization (normative)

1. **Allowlist:** only the keys in `03` §3.6 are read; everything else ignored.
2. **Precedence:** vault pool > env pool > unset (refuse feature with clear error).
   Env-supplied keys are migrated into the vault on first boot with operator consent,
   then the operator is instructed to unset them.
3. **Startup audit:** boot logs list *which* required vars are set (names only, never
   values/lengths) and the vault-vs-env source per pool.

## 12.5 — Network & Content Boundaries

- **Bind:** `127.0.0.1` only; startup asserts the resolved address is loopback and
  refuses to boot on wildcard bind (NFR-6).
- **Egress allowlist:** Groq (`api.groq.com`), Fish Audio (`api.fish.audio`), relay
  host (`19`), plus package registries at install time. Unexpected egress in tests
  fails the suite (mock-only rule, `11` §11.2).
- **No inbound ports:** the daemon opens none; mobile pairing is outbound-only (`19`).
- **Content policy:** brain output validated against schema before speech (`06` §6.5);
  TTS input length-capped (oversize → summarized, never truncated mid-word silently).

## 12.6 — Audit Procedures

Quarterly (or on any incident): run secret-scan over repo + data dir, review vault
file ACLs, rotate all pools (`27`), verify I-1–I-5 with the evidence commands in
`27-CREDENTIALS.md`, and record the audit in the checkpoint ledger (`10`).

---

*End of `12-SECURITY.md`. Next: `13-DEPLOYMENT.md`.*
