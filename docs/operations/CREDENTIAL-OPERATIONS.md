# Credential Operations — single source of truth: the vault

## Policy
`vault/keyring.dat` (AES-256-GCM, 0600 machine key) is the **only** credential
source the Voxaura runtime reads. `OPENROUTER_API_KEY` in the environment is a
bootstrap input (consumed once by `vault bootstrap`, then unset).
`~/.local/share/opencode/auth.json` belongs to the OpenCode TUI/desktop apps —
Voxaura never reads it, so a revoked key there cannot break the daemon, but it
can confuse diagnosis. When in doubt, trust `scripts/key-report.mjs`, which
reads the vault and prints fingerprints, never values.

## Rotation runbook (all three providers)
```powershell
$env:GROQ_API_KEYS        = '<new groq key>'
$env:FISH_AUDIO_KEYS      = '<new fish key>'
$env:OPENROUTER_API_KEYS  = '<new openrouter key>'
node dist/cli.js vault bootstrap   # counts only, zero material
Remove-Item Env:\GROQ_API_KEYS, Env:\FISH_AUDIO_KEYS, Env:\OPENROUTER_API_KEYS
node scripts/key-report.mjs        # 1 key per pool, fingerprints match dashboards
node dist/cli.js live              # brain_ms < 2000 confirms reasoning
```
Back up `auth.json` before touching it (`auth.json.<ts>.bak`); never paste keys
into chat, logs, or test files — fixtures use `K1-g`-style dummies only.

## 401 drill
1. `key-report.mjs` → which pool is MISSING vs present.
2. If present-but-401: the stored key is revoked → rotate per above.
3. If MISSING: bootstrap never ran → run it.
4. Never "fix" a 401 by widening auth code paths; fix the credential.

## Workflow: credential-gated verification
Every gate that touches a provider (`live`, mission dry-run, E2E capture) runs
only after `key-report.mjs` shows the needed pool present. A red vault blocks
the run before any spend — fail-closed, zero wasted calls.
