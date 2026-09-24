# RAG-ORCHESTRATOR-INTEGRATION.md — Shared RAG & Multi-Session Orchestration Reference

**Status:** Reference (audit-grounded). No runtime code was modified to produce this file.
**Audit date:** 2026-09-24. Every claim cites the file or endpoint it was verified against.
**Scope:** How Voxaura discovers, governs, and dispatches work across parallel
OpenCode v2 sessions, and how shared RAG + catalog ingestion plug in per project.

---

## 1. Architecture Topology

```
┌─ Voxaura Desktop Shell (Tauri/Rust + React, apps/desktop/) ──────┐
│  bridge/ws.ts ── native WebSocket ──► single daemon connection   │
└───────────────────────────────┬──────────────────────────────────┘
                                │ ws://127.0.0.1:4097/v1/ui
                                │ subprotocol voice-ui.v1 + bearer
                                │ (token via subprotocol, seq via ?lastSeq=)
┌─ Voxaura IPC Daemon (Node 22, src/) ─────────────────────────────┐
│  src/ipc/ui-server.ts  — authenticated fan-out, Last-Seq resume  │
│  src/orchestrator/     — ONE subscribe loop, ONE ledger, ONE queue│
│  src/launcher/         — sole supervisor of ONE serve on :4096   │
│  src/runtime/client.ts — legacy paths: /session, /session/{id},  │
│                          /session/{id}/prompt, /openapi.json      │
│  src/guidance/rag/     — in-process BM25 + personas + Tier-D     │
└───────────────────────────────┬──────────────────────────────────┘
                                │ HTTP + SSE (single session today)
┌─ OpenCode v2 Instance(s) ────────────────────────────────────────┐
│  NATIVE multi-session API (verified in                            │
│  node_modules/@opencode/client/dist/chunks/service-5mmhmmk7.js):  │
│   /api/session, /api/session/active, /api/session/{id},           │
│   /api/session/{id}/fork, /agent, /model, /move, /prompt,          │
│   /api/session/{id}/command, /synthetic, /shell, /compact,         │
│   /api/experimental/session/{id}/skill, /stats, /import, /export   │
└──────────────────────────────────────────────────────────────────┘

**Verified asymmetry (the whole gap in one picture):** the OpenCode v2 API is
multi-session-native (list, fork, per-session agent/model/skill mutation); the
Voxaura daemon uses exactly one session-shaped stream (`ServeClient` legacy
paths + `Orchestrator.subscribe` single loop + single `Ledger` dataDir), and the
WS-4097 bridge carries no session switch vocabulary (`UiCommand.kind` today:
abort/mute/deafen/arm/setPersona — `src/ipc/protocol.ts`, `apps/desktop/
src/bridge/ws.ts`). Multiplicity exists below us, not in us.

---

## 2. Session Lifecycle & Governance (as implemented → as required)

### 2.1 Discovery

- **Works today:** `ServeClient.listSessions()` (`src/runtime/client.ts:92-96`)
  and `Orchestrator.reconcile()` (`src/orchestrator/orchestrator.ts:194-196`).
- **Missing:** no periodic discovery loop, no session inventory in the ledger,
  no `active` polling. The daemon reconciles only on restart recovery.
- **Required:** a `SessionInventory` poller (extend `reconcile()` on an interval)
  emitting `enqueued`-style lifecycle signals per session so the shell can render
  Project A/B/C states. Native endpoint: `GET /api/session` (+ `/active`).

### 2.2 Switching

- **Works today:** nothing. The bridge has no `switchSession` command; the App
  holds no session id; the orchestrator cursor tracks one stream.
- **Required:** `UiCommand.kind += 'switchSession'` carrying a session id validated
  against the inventory; daemon retargets `cursor` + ledger partition per session;
  renderer shows the active project chip. Native endpoint: direct — subsequent
  `/prompt`/`/command` calls address the switched id.

### 2.3 Monitoring

- **Works today:** single-stream SSE with staggered reconnect
  (`src/orchestrator/orchestrator.ts:65-79`), per-envelope ledger append,
  `LifecycleSignal` sink (`enqueued/spoken/aborted`) consumed by the matrix
  mapper (`matrixForDaemonState`).
- **Missing:** per-session cursors, per-session FR-12 state, `/stats` polling,
  busy-session backpressure (`SessionBusy` error type exists in the SDK).
- **Required:** key all of the above by session id; honor `SessionBusy` with
  queue-and-retry instead of fail-open speech.

### 2.4 Prompt injection (dispatching work INTO a session)

- **Works today:** `ServeClient.promptSession` with stable idempotency keys
  (`src/runtime/client.ts:74-83`).
- **Missing:** no cross-session dispatch API on the daemon, no bridge command
  for it, no provenance beyond `{origin, actor}`.
- **Required:** `POST`-equivalent daemon method `dispatchPrompt(sessionId, text,
  provenance)` → native `POST /api/session/{id}/prompt` (or `/command`,
  `/synthetic` for non-interruptive inserts); extend `Provenance` with
  `{fromSessionId, taskId}` for audit. This is THE bridge for "report from
  Project A while working in B and bootstrapping C."

### 2.5 Dynamic runtime mutation (per session, no restart)

Verified natively supported by the OpenCode v2 API (SDK chunk evidence above):

| Mutation | Native endpoint | Voxaura status |
|---|---|---|
| Switch agent | `POST /api/session/{id}/agent` | NOT WIRED |
| Switch model | `POST /api/session/{id}/model` | NOT WIRED |
| Attach skill | `POST /api/experimental/session/{id}/skill` | NOT WIRED |
| Move session | `POST /api/session/{id}/move` | NOT WIRED |
| Fork session | `POST /api/session/{id}/fork` | NOT WIRED |
| Compact | `POST /api/session/{id}/compact` | NOT WIRED |
| Shell/pty exec | `POST /api/session/{id}/shell` | NOT WIRED |
| MCP/plugin/hook/LSP changes | plugin transforms (`ctx.agent/skill/mcp.transform`) + `opencode.json` reload | NOT WIRED; `opencode.json` is static file config today |

No Voxaura restart is required for any row — all are runtime API calls. The
missing piece is exclusively daemon-side methods + bridge vocabulary, per §4.

### 2.6 PTYs, terminals, watchers (correction of assumed paths)

The directive named `src/engine/runner/` with `spawn.ts`, `sessions.ts`,
`history.ts`. **None exist** (verified by repo-wide filename search). Actuals:

- Process supervision: `src/launcher/launcher.ts` (adopt-or-spawn `opencode
  serve`, password via env only) + `src/launcher/sweeper.ts` (tasklist
  fingerprint, tree-kill orphans). No PTY allocation anywhere; no concurrent
  PTY tracking; the sweeper would treat a second project's serve as an orphan
  and kill it — multi-project daemons MUST coordinate supervised PIDs first.
- Watcher loop: SSE reconnect + sweeper interval only. No file watchers, no
  terminal output capture. `POST /api/session/{id}/shell` is the native path
  for managed execution; local PTYs (e.g. node-pty) are NOT a dependency and
  must not be added silently (native module, breaks the zero-native profile).

---

## 3. Genesis Brief & Clarification Protocol (end-to-end)

Owner: skill `project-genesis-dossier` (`.opencode/skills/project-genesis-dossier/
SKILL.md`). The skill is normative; this section is the systems view.

```
User + External AI ──► 00-GENESIS-BRIEF.md ──► OpenCode 3-question inquiry
      (question tool, exactly 3, highest-uncertainty first)
  ──► AI response paragraph (decided/changed/open, explicit confirm)
  ──► Automated provisioning ──► 28-file dossier + catalog components
```

1. **Intake:** read `00-GENESIS-BRIEF.md`; restate goal/non-goals/constraints/
   invariants; halt on contradiction or absence (never scaffold from imagination).
2. **Inquiry:** exactly 3 questions, options with recommended default first.
3. **Response paragraph:** decided/changed/open + explicit user confirmation.
   No confirmation, no files.
4. **Provisioning fan-out:** independent file groups to parallel subagents
   (`dispatching-parallel-agents` pattern); ADR + plan surface in the main thread.
   Target: plan surface, ADRs, checkpoint row, catalog ingestion with provenance
   (source URL, version, license) per component.
5. **Verify:** files exist non-zero, configs parse, gates green or explicitly
   deferred; atomic Conventional Commits; push only on instruction.

Prior art wired into the skill: `to-spec` (seam discipline — note: it explicitly
refuses interviews, hence a separate skill was required), `create-prd`
(structural borrowing only), `session-memory` (durable dossier state).

---

## 4. Catalog Ingestion Rules (per-project, dynamic)

Source of truth: `vantrilex-registry/` (421 KB `VANTRILEX_CATALOG.md` + `skills/`,
`agents/`, `hooks/`, `mcp/`, `plugins/` descriptors with `Raw URL` sources).

1. **Descriptors are not content.** Every registry file resolves to a `Raw URL`;
   fetch it, verify bytes, then materialize. Dead URLs (e.g. `spec-writer` →
   `dannwaneri/spec-writer` 404, verified 2026-09-24) are recorded as catalog
   rot — never fabricated.
2. **Skills** → `.opencode/skills/<id>/SKILL.md` (OpenCode v2 frontmatter:
   `name` + `description`). Drop-in when the source already matches.
3. **Agents** → `.opencode/agents/<name>.md` with `mode: subagent`; strip
   Claude-only frontmatter (`model`, `tools`, `color/emoji/vibe`). Never clobber
   repo-tailored agents (see GATE 1: generic `architect` refused).
4. **Hooks** → Claude Code `hooks.json`/`.sh` assets are NOT OpenCode-native.
   Retain under `.opencode/hooks/` as porting spec with a README mapping each
   guard to the plugin equivalent (`ctx.tool.transform`, `ctx.session.hook`).
   Claim no enforcement until a tested `@opencode-ai/plugin` ships.
5. **MCP servers** → merge into `opencode.json` → `mcp.servers` (V2 shape:
   `{type, command[], environment}` with `{env:VAR}` substitution, never
   secrets). Verify package names on the npm registry first (GATE 1 caught
   `server-sequentialthinking` vs real `server-sequential-thinking`).
6. **Plugins** → registry descriptors pointing at Claude plugin repos are NOT
   OpenCode v2-compatible. Fabricate nothing; defer to a tested
   `@opencode-ai/plugin` implementation.
7. **LSP engines** → `opencode.json` → `lsp` (command + extensions), as already
   configured for TypeScript + Python.

---

## 5. Cross-Session Dispatch Architecture (the missing bridge)

To let one session (or Voxaura) dispatch a report request to Project A, continue
in Project B, and bootstrap Project C in parallel, build — in this order:

1. `SessionInventory` poller (§2.1) — know all sessions.
2. `dispatchPrompt` + extended `Provenance` (§2.4) — reach any session.
3. Bridge `switchSession` + shell project chip (§2.2) — work anywhere.
4. Per-session agent/model/skill methods (§2.5) — govern each session's brain.
5. Supervised-PID coordination in the sweeper (§2.6) — stop killing siblings.

Until then: Voxaura is a single-project ambient companion with a multi-project
API underneath it. The API is proven; the wiring is the roadmap (§6 of the
deliverable report, not this file).

*End of `RAG-ORCHESTRATOR-INTEGRATION.md`.*
