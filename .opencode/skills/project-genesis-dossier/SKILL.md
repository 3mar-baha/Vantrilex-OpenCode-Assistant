---
name: Project Genesis Dossier
description: >-
  Bootstrap a new project from an external-AI brief through a structured clarification loop into a provisioned dossier. Use when the user brings a project brief (00-GENESIS-BRIEF.md), asks to scaffold a genesis dossier, or needs the 3-question inquiry → response → 28-file provisioning workflow. Handles the full loop: brief intake, exactly-3-question inquiry, response paragraph synthesis, dossier + catalog provisioning.
---

# Project Genesis Dossier

You turn an external project brief into a provisioned, reviewable dossier —
through questions, never guesses.

## Prior art (reuse, do not reinvent)

- `to-spec` (mattpocock/skills): test-seam analysis ("highest seam possible",
  prefer existing seams). Apply its seam discipline when the dossier reaches
  implementation decisions.
- `create-prd` (phuryn/pm-skills): 8-section PRD shape. Borrow its
  problem→release structure for dossier sections where it fits; the dossier
  is NOT a PRD and must not be force-fit into one.
- `dispatching-parallel-agents` (obra/superpowers): coordinate simultaneous
  agents. Use for the provisioning fan-out (Step 4) — independent file groups
  go to parallel workers.
- `session-memory` (NVIDIA/skills): durable working-session memory. Record the
  dossier state there when available so resume survives compaction.

## The loop (normative — follow in order, skip nothing)

### Step 1 — Brief intake

Read `00-GENESIS-BRIEF.md` from the project root. If it is absent, ask the user
to provide the brief (paste it or point at the file) and stop — never scaffold
from an imagined brief. Extract and restate back: goal, non-goals, constraints,
invariants, and known unknowns. Halt if the brief contradicts itself; ask.

### Step 2 — Exactly-3-question inquiry

Ask **exactly three** clarification questions using the `question` tool. Rules:

- Each question targets the highest-uncertainty load-bearing decision.
- Offer concrete options with a recommended default first; free text always allowed.
- Never ask what the brief already answers. Never ask more than three — defer
  the rest to dossier §Open Questions.

### Step 3 — Response paragraph

Synthesize the user's answers into one response paragraph: what was decided,
what changed vs. the brief, and what remains open. Present it and get explicit
confirmation before provisioning. No confirmation, no files.

### Step 4 — Provisioning fan-out

On confirmation, materialize the dossier and supporting files. Default target
set (adapt to the project; record deviations):

- `docs/PLAN.md` (or the project's plan surface) — gate map, per-gate contracts.
- Architecture Decision Records for each load-bearing choice.
- Checkpoint/ledger row for the genesis milestone.
- Catalog ingestion: skills, agents, MCP servers, plugins, LSP configs pulled
  from the registry per project need — record source URLs, never vendor blindly.

Dispatch independent file groups to parallel subagents (`dispatching-parallel-agents`
pattern); keep ADR + plan-surface writes in the main thread to avoid conflicts.
Every ingested component gets a provenance row (source, version, license).

### Step 5 — Verification before handoff

- Every created file exists on disk with non-zero size.
- Configs parse (`opencode.json`, manifests, `package.json` scripts).
- Test/typecheck/lint gates for the project's stack are green or explicitly
  recorded as deferred with a reason.
- Commit atomically (Conventional Commits) and push only on instruction.

## Hard boundaries

- Do not invent brief content, corpus licenses, benchmark numbers, or API shapes.
- Do not write secrets into the dossier, ledger, or configs.
- Do not modify runtime application code under this skill — dossier, docs, and
  config only. Runtime changes need their own gate.
- If a prior-art skill's source URL is dead (e.g. a moved repo), record it as
  catalog rot and proceed without it — never fabricate its content.
