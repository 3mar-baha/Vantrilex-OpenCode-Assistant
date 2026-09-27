# Dead code — quarantined 2026-09-27 (Phase 1D, v0.7.0)

These modules had **zero importers** from the production composition roots
(`src/daemon.ts`, `src/cli.ts`) at the moment they were moved. They are kept,
not deleted, so the research is reversible — several represent real work
(the Laya ONNX system in `ml/` trained to passing gates, the RAG/guidance layer)
that a future phase may want to wire properly.

**They are not part of the product.** `vitest.config.ts` includes only
`src/**/*.test.ts`, so nothing here runs in the test suite, and the root
`tsconfig.json` does not compile `.opencode/`.

Restoring one is a `git mv` plus an import from the composition root — but read
`dossier/PROJECT_MASTER_DOSSIER.md` §2 first, because `mentions.ts`,
`slash.ts` and `prompt-optimizer.ts` were in exactly this position while
`CHANGELOG.md` and `docs/10-CHECKPOINT.md` claimed they shipped. That
mismatch is why reachability is now a gate, not a convention.

## What was here
- `src/guidance/` — RAG retriever, persona profiles, content guard, BLUF briefings, guild-skill scoring, session overseer
- `src/runtime/laya/` — `LayaEngine` (ONNX, 4 heads) + BPE tokenizer; the trained weights and eval live in `ml/` and are unaffected
- `src/orchestrator/` — the legacy lifecycle coordinator (`orchestrator.ts`, `dispatch`, `queue`, `ledger`, `events`, `laya-advisor`) superseded by the lean `Coordinator`
- `src/ui/` — legacy `MicControl`/`SettingsStore`/`buildSettingsModal`, superseded by the React `SettingsView`/`KeysView`
- `src/ipc/attach.ts`, `src/voice/{disambiguation,index}.ts`
