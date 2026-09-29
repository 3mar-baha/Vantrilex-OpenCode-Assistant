# 12 — Security: Supervisor Secrets, Vault Cipher, Redaction Sink & Boundaries

> **Canonical status:** Governance. Security truth. Implements FR-8 + NFR-6 (see `01`).
> Rotation mechanics: `20-KEYRING.md` · Credential ops: `27-CREDENTIALS.md`.
> Baseline: `6be0363` — re-verified against `apps/desktop/src-tauri/src/main.rs`,
> `src/voice/vault.ts`, `src/voice/win-acl.ts`, `src/ipc/ui-server.ts`.
>
> **What changed since the DPAPI-era text:** the old §12.2 described AES-256-GCM
> under a machine key plus an *aspirational* Windows DPAPI via Electron
> `safeStorage` (correctly labelled: comment-only at `vault.ts:8-10`, never
> imported, no `node-data-protection` dependency). That framing is retired. At
> `6be0363` the vault secrets are **created in the Rust supervisor, not in
> Node** — `machine.key` (32 raw bytes) and the `keyring.dat` DACL are owned by
> `main.rs`, and the Node daemon only consumes them. This section records the
> current shape.

## 12.1 — Threat Model (scoped)

| Asset | Adversary | Out of scope |
|-------|-----------|--------------|
| Groq + Fish + OpenRouter API keys at rest/in-log/in-dump | Local malware, shoulder-surfing logs, accidental `git push` of secrets | Nation-state with kernel access; physical device theft without OS login |
| `OPENCODE_SERVER_PASSWORD` in process list/logs | `ps` snoopers, log aggregators | Network attacker — mitigated by localhost-only bind + Basic over loopback |
| `ipc.token` / `serve.pass` / `owner.key` / `machine.key` on disk | Sibling-user reads via inherited ACLs | Same as above; mitigated by owner-only protected DACLs (fail-closed) |
| Microphone stream | Always-on surveillance perception | Mitigated by muted-by-default capture + explicit user gesture (`capture.ts`) |
| Relay approval channel | Token replay, MITM | No relay/QR/approval code ships (`docs/19` carries a supersession banner; only a `'mobile'` union member in `runtime/client.ts`) |

## 12.2 — Credential set (all under `runtime_dir()` = `~/.opencode-voice-runtime`, or `VOICE_RUNTIME_DIR` override, `main.rs:514-528`)

| File | Content | DACL | Fail mode |
|---|---|---|---|
| `ipc.token` | 64-char lower hex (`generate_secret`, `main.rs:940-943`; CSPRNG `getrandom`, `main.rs:587`, `secure_random_bytes<const N>()` at `:594`, no fallback) | `write_protected_secret` (`:619-629`): owner+LocalSystem, `PROTECTED_DACL_SECURITY_INFORMATION` (`:662`) blocking parent inheritance | DACL fail → delete + Err (`:623-629`); pre-existing read as-is; asserted `:2482,2488` |
| `serve.pass` | Same shape (`:970-973`) | Same (`:972`) | Same; daemon fail-closed without it (`cli.ts:143-176`) |
| `owner.key` | Same shape (`:1041-1043`) | Same (`:1043`) | Same (non-credential per `:1016-1018`, same treatment) |
| `daemon.owner` | JSON `{v,pid,ownerKey}` (`struct DaemonOwnerFile`, `:1058-1063`; `DAEMON_OWNER_VERSION = 1`, `:1002`; `OWNER_SETTLE 1500 ms`, `:1004`); shell pre-creates EMPTY only if absent (`:1047-1050`) | Same at creation; daemon must overwrite IN PLACE — a rename resets the descriptor (`:1024-1026`) | Identity, not auth (C2 classify `:1083-1135`, `classify_daemon_holder` `:1159-1179`) |
| `machine.key` (**`6be0363`**) | 32 RAW bytes (`fs::write(&key)`, `:881`); hex only for env handoff (`:868,:886`) | `restrict_to_owner` on **create** (`:882-884`) **and adopt** (`:864-866`) | Wrong length → delete + Err (`:873-877`); DACL fail → delete + Err |
| `keyring.dat` (`<vault>/keyring.dat`, AES-256-GCM via `machine.key`) | Encrypted provider pools (Node `FileVault.save` temp + rename, `vault.ts:129-140` — the rename REPLACES the file, which is why the startup DACL needs re-application) | `restrict_to_owner` in `resolve_vault_dir` (`:1373-1376`) + `restrict_vault_file` command (`:907-922`) | NOT fail-closed at resolve (WARN, launch continues — keys already encrypted); command variant deletes on DACL fail |

History that must not repeat: `ipc.token`/`serve.pass` were once derived from
xorshift64* seeded `nanos ^ pid`; now `getrandom` with no fallback path.
`std::fs::set_permissions(0o600)` on Windows is `SetFileAttributes` — toggles
READONLY, returns Ok, changes no ACL (`main.rs:624-629` comment). The
load-bearing flag is `PROTECTED_DACL_SECURITY_INFORMATION`, asserted at
`main.rs:2482,2488` (a `docs:verify` anchor).

## 12.3 — Vault cipher (Node side, `src/voice/vault.ts`)

`machineKey()` (`vault.ts:45`): prefers `VOXAURA_MACHINE_KEY` (hex → 32 B;
wrong length throws `VAULT_CORRUPT` naming the real problem, `:48-57`);
fallback reads/creates `machine.key` with warn-once (`warnedAboutAcl`,
`:25,60-65`) — the fallback is NOT equivalent and says so. `appKey()` =
`scryptSync(machineKey(), 'opencode-voice-runtime:vault:v1', 32)` (`:78`);
pools AES-256-GCM + SHA-256 checksum (`encryptPool :85`, `decryptPool :95` —
checksum mismatch and decrypt failure both `VAULT_CORRUPT`). Verified live at
`6be0363`: env key round-trips encrypt/decrypt 3/3 (same-key OK, foreign-key
`VAULT_CORRUPT`, bad-length rejected).

**The `icacls` measured failure (why Node cannot do this).**
`icacls <file> /inheritance:r /grant:r <user>:(F)` returns "Successfully
processed 1 files" then yields EPERM for the named account — `icacls` grants a
NAME and cannot name the owner SID (implemented, measured, REMOVED;
reproduction rationale lives in `src/voice/win-acl.ts`,
`ownerOnlyAclAvailable()` returns `{supported:false, reason}` on Windows,
`{supported:true}` on POSIX where `mode: 0o600` is already correct). The Rust
`restrict_to_owner` works because `SetNamedSecurityInfoW` with NULL `oldacl`
preserves the owner SID by construction — unreachable from Node without a
native addon, hence the `6be0363` move. **The real fix for the two vault files
is the supervisor owning them** (`write_protected_secret`, fails closed).
Until every path is supervisor-owned, `vault.ts` keeps Unix `mode: 0o600` and
reports the gap instead of pretending to fix it — a helper that locks the
owner out of the key file would strand every saved provider key, strictly
worse than the inherited ACL it claims to remove.

Two shipped-but-inert seams (Triad A.1/A.2 — fix each): `shutdown_all_services`
(`main.rs:1637`, registered `:3268`) has **zero** shell call sites — teardown
is exit-driven only; `restrict_vault_file` (`:907`) has **zero** shell call
sites — the post-save re-lock never fires from the app, so the startup DACL
is undone by the first save until something invokes it. Both are registered
Tauri commands with no callers, not missing code.

## 12.4 — Scrubbing (sink, not call sites)

`UiServer.notice()` (`ui-server.ts:227-231`) applies `redactString(detail)`
then schema-parses — covering the three raw `err.message` interpolations
(`daemon.ts:611` STT, `:765` brain, `:836` TTS-credit-skipped generic). Do NOT
move redaction outward: a new call site cannot leak. `encodeTextFrame` is
imported only inside `ui-server.ts` (single sink file = auditable surface).
Telemetry writer and logger also redact (`writer-redaction.test.ts`,
`cli-doctor-keys.test.ts:56`). `doctor` reports key presence/counts only;
rotation is manual via `writeKeyPools` verified by SHA-256 fingerprint, never
echo. Never print/log/commit key material; file:line references to
secret-handling code are fine.

Coincidence-coverage (currently safe, NOT guaranteed — Triad B.5): `voice()`
(`:233-237`, user's own transcript), `ack` (`:505-511`, router literals),
`event`/`inventory`/`agents` (`:161,177,189`, local OpenCode state) are
unredacted. `ack.detail` is an open `string` (`command-router.ts:12-15`), NOT
a closed union as older prose claimed — the invariant "locally generated,
never provider text" holds by inspection of `dispatch` (`:151-234`) plus the
catch mapping (`:273-275`), but it is convention, not type-enforced. The
`dispatchCommand` catch (`ui-server.ts:503`) forwards raw `err.message` into
`ack.detail`; reachable only if `onCommand` throws, which the router never
does today (`:237-276`). Fix direction: redact `ack.detail` + `voice.transcript`
at the sink; route `console.error` (`coordinator.ts:243-250`, `daemon.ts:271`)
through the redacting logger. Stale comment: `ui-server.ts:213-222` cites
`daemon.ts:584/738/789`; true lines are `611/765/836`.

## 12.5 — Zero-Plaintext Invariants (normative, all must hold)

- **I-1 (disk):** no file in the repo or data dir (excluding the vault blob
  itself, which is ciphertext) matches `sk-…`, `gsk_…`, fish key patterns, or
  the server password. Enforced by pre-commit grep + CI secret-scan. Baseline
  scan: only deliberate `AAAA…` fake in `ui-server.test.ts:161`, which is what
  makes the redaction test meaningful.
- **I-2 (logs/ledger):** `common/logger` redacts on write — Bearer values, key
  substrings (>8-char matches against active key hashes), and `password=` pairs
  become `[REDACTED]`. Ledger writer throws on secret-pattern match
  (fail-closed, `10` §10.3).
- **I-3 (memory dumps):** crash reports strip env (`OPENCODE_SERVER_PASSWORD`,
  `*_KEYS`) before write; minidump annotation allowlist excludes secret fields.
- **I-4 (process list):** password passed via child `env` only — never `argv`.
  Verified: `ps` output grep finds no secret. `machine.key` hex travels via
  `VOXAURA_MACHINE_KEY` env to the sidecar only (`main.rs:868,886`).
- **I-5 (errors):** only `secretSafeMessage` reaches logs/ledger/UI; raw
  provider bodies (which may echo keys) are dropped after code extraction.
  Fish 401/402 bodies are never echoed (account metadata, `tts.ts:306-309`).

## 12.6 — Environment Variable Sanitization (normative)

1. **Allowlist:** only the keys in `03` §3.6 are read; everything else ignored.
2. **Precedence:** vault pool > env pool > unset (refuse feature with clear error).
   Env-supplied keys are migrated into the vault on first boot with operator consent,
   then the operator is instructed to unset them. Operator-only pre-dispatch
   `ensureVault('voxaura', resolveVaultRoot())` (`cli.ts:185-195`) runs for
   doctor/vault/live only — never `serve`.
3. **Startup audit:** boot logs list *which* required vars are set (names only, never
   values/lengths) and the vault-vs-env source per pool. A present-but-invalid
   key looks identical to a healthy one until the first utterance (L17 open): a
   401/403 advances the key pool silently — when STT/TTS/brain suddenly fails,
   check key validity before anything else.

## 12.7 — Network & Content Boundaries

- **Bind:** `127.0.0.1` only; `0.0.0.0` has zero matches in `main.rs`.
  Fixed ports: **4096** serve (`OPENCODE_PORT`, `main.rs:44`,
  `--hostname 127.0.0.1` at `:1434`), **4097** daemon WS bridge (`DAEMON_PORT`,
  `:45`; `UiServer.listen(port,'127.0.0.1')`, `ui-server.ts:151`), **4197** E2E
  stub control (`CONTROL_PORT`, `stub-daemon.mjs:57`), **1420** Vite dev
  (`vite.config.ts:11-14`, `strictPort`). CSP pins the browser:
  `connect-src 'self' ws://127.0.0.1:4097` (`tauri.conf.json:27`). Hello guard
  pins `servePort===4096` (`bridge/ws.ts:166`).
- **Bearer placement:** the WS bearer travels as an extra subprotocol token
  (`[voice-ui.v1, <token>]`, `bridge/ws.ts:283`) because browsers cannot set
  upgrade headers. Server `bearerOk()` (`ui-server.ts:306`): `Authorization:
  Bearer` timingSafeEqual **or** subprotocol token (`:316-322`), enforced
  pre-upgrade (`:355`) before any frame is parsed. Do NOT move the token to
  query (log leakage; RFC 6455 §1.9).
- **Frame caps:** `MAX_MESSAGE_BYTES` 1 MiB per-MESSAGE cumulative, checked
  BEFORE storing (`protocol.ts:22`, `accountFor :294`); `MAX_AUDIO_BYTES` 64
  KiB on the reassembled binary (`protocol.ts:28` → `error` frame, socket
  kept); `MAX_CONNECTIONS` 8 (evict-oldest `:378`) / `RESUME_CAP` 256
  (`protocol.ts:19-20`); `PING` 5000 ms / `MISSED` 3 (`:11-12`). History: the
  cap was per-FRAME until the audit found unbounded `pendingParts` + one
  `Buffer.concat` — now cumulative, pre-store.
- **Egress allowlist:** Groq (`api.groq.com`), Fish Audio (`api.fish.audio`),
  OpenRouter, plus package registries at install time. Unexpected egress in
  tests fails the suite (mock-only rule, `11` §11.2).
- **No inbound ports:** the daemon opens none beyond loopback 4097; mobile
  pairing is outbound-only and unshipped (`19`).
- **Content policy:** brain output validated against schema before speech;
  TTS input length-capped (oversize → summarized, never truncated mid-word
  silently). STT pins `language: 'ar'` (`stt.ts:99`) — English audio yields
  Arabic gibberish by design, not a bug.

## 12.8 — Audit Procedures

Quarterly (or on any incident): run secret-scan over repo + data dir, review
vault file ACLs (`dacl_is_protected()` reads the REAL descriptor via
`GetFileSecurityW`, `Control & 0x1000`), rotate all pools (`27`), verify
I-1–I-5 with the evidence commands in `27-CREDENTIALS.md`, and record the
audit in the checkpoint ledger (`10`). Guard catalog for break-testing:
sidecar-safety (dynamic `import()` seam, `sidecar-safety.test.ts:27-167`),
machine-key (`main.rs:2760+`, `env_lock()` Mutex, `icacls_reset()` staging,
wrong-length refused+deleted, CSPRNG provenance, fail-closed ACL),
reassembly-cap (8 tests, cumulative pre-store), WS-resume (first connect MUST
carry `?lastSeq=0`), TTS-credit (402/429 typed, 7-day escalation).

---

*End of `12-SECURITY.md`. Next: `13-DEPLOYMENT.md`.*
