---
name: vault-sync
description: Read/write discipline for the Obsidian memory vault (vault/projects/<project>/ + MOC). Use at task start for context retrieval and at task end for persisting decisions and state.
---

# Vault Sync

## Retrieve (task start)

1. Read `vault/projects/<project>/03-active-state.md` for live constraints.
2. Follow `vault/indexes/MOC-master.md` to the one atomic note covering the
   task area. Read that note, never the whole vault.
3. If a prior decision constrains the task, cite it; do not relitigate it.

## Persist (task end)

- State changes → `03-active-state.md`.
- New decisions → append to `04-decisions-log.md` (newest last).
- Verification history → append to `05-sessions-history.md`.
- Skills/references used → append to `06-skills-used.md`.
- One fact per section; link instead of duplicating.
- Scale by adding granular files, never by growing old ones.

## Bootstrap

If the vault is absent (fresh install), call `ensureVault(project)` from
`src/memory/vault.ts`: it scaffolds the six atomic notes plus the MOC with
default templates, never overwrites existing files, and resolves paths from
`VOXAURA_VAULT_DIR` or `<cwd>/vault` — no hardcoded absolute paths.

Never store secrets, key material, or auth file contents in notes.
