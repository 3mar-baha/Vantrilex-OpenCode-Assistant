# RAG — Orchestrator Reference (Nemotron Coordinator)

Role owner: Master Coordinator and Tool Router (`nvidia/nemotron-3-ultra-550b-a55b:free`).
Scope: decompose English missions into DAG tasks, dispatch execution, synthesize results.
All handoffs, prompts, and tool payloads in this lane are 100% English.

## 1. Topology

```text
Dots3 (Arabic intake)
  │  English mission {objective, constraints, acceptance}
  ▼
Nemotron (coordinator — this reference)
  │  DAG of tasks {id, kind, depends_on, target, payload}
  ├─► OpenCode sessions via WS-4097 / ServeClient
  └─► Inkling (subagent driver, in-session only)
  │  English summaries + receipts
  ▼
Nemotron synthesizes → user-facing result
```

The coordinator never executes tools directly against the OS. It routes.
This mirrors the LangGraph supervisor pattern: one strategic node decomposes and
synthesizes; worker nodes execute and return structured results.

## 2. Task decomposition rules

1. One mission → 1..N tasks with explicit `depends_on` lists. No task runs until
   its dependencies report `ok:true` (or a flagged partial the coordinator accepts).
2. Prefer fan-out for independent work (parallel session prompts); fan-in for
   synthesis. Latency of a parallel wave equals its slowest member.
3. Each task carries: `id`, `kind` (prompt | agent | model | skill | shell | control),
   `target_session`, `payload`, `acceptance` (what counts as done), and `budget`
   (max retries / max turns).
4. Decompose to the level where each task is verifiable by receipt, ack, or file —
   never by assumption ("measure, never assume").

Harvested from CrewAI hierarchical practice: a manager LLM must review worker
outputs and assess completion before consolidation — delegation without review is
just fan-out chaos.

## 3. Dispatch over WS-4097 / ServeClient

Available command kinds (see `src/ipc/protocol.ts`, `src/orchestrator/command-router.ts`):

| kind | effect | ack |
|---|---|---|
| `switchSession` | set active session context | `{ok:true}` |
| `setSessionAgent` | POST `/api/session/{id}/agent` | 204 → `{ok:true}` |
| `setSessionModel` | POST `/api/session/{id}/model` `{model:{id,providerID}}` | 204 → `{ok:true}` |
| `toggleSessionSkill` | attach/detach skill | 204 → `{ok:true}` |
| `execSessionShell` | POST `/api/session/{id}/shell` | 204 → `{ok:true}` |
| `prompt`/`dispatchPrompt` | POST `/api/session/{id}/prompt` flat `{text}` envelope (2.0.x) | 200 + `msg_…` receipt |

Failure semantics (fail-closed, never crash the socket):
- 404 → `SESSION_NOT_FOUND` (non-retryable)
- 409 → `SESSION_BUSY` (retryable via backpressure queue)
- 401 → credential rejection (non-retryable, halt lane)
- other non-2xx → transient, bounded retries with idempotency keys

## 4. Backpressure and cross-session governance

- `src/orchestrator/queue.ts`: bounded queue; `dispatchPrompt` with stable prompt
  keys so retries never double-apply.
- `src/orchestrator/inventory.ts`: level-triggered session snapshots over WS;
  the coordinator reads the live inventory instead of assuming session state.
- `src/launcher/siblings.ts`: single-supervisor rule — one Node owner of
  `opencode serve`; sibling processes are swept, never fought.
- A session reporting busy is normal load, not failure: requeue with backoff,
  and surface the queue depth in status reports.

Harvested from AutoGen practice: separate the thinker from the executor, keep
execution sandboxed (here: inside OpenCode sessions), and keep a human gate
(here: FR-12 confirmation) before destructive acts.

## 5. Handoff object (coordinator ↔ Inkling)

Every delegation and every report uses this shape (adapted from the
result/trace-split handoff pattern):

```text
[HANDOFF from=Nemotron to=Inkling task=<id>]
objective: <one sentence>
payload: <structured skill prompt / tool args>
acceptance: <receipt | ack | file | test result>
constraints: <FR-12, no out-of-band OS action, English only>
```

```text
[REPORT from=Inkling to=Nemotron task=<id> confidence=HIGH|MEDIUM|LOW flags=<none|NEEDS_REVIEW|PARTIAL>]
result: <concise structured summary>
receipts: <msg_… / ack ids / commit SHAs>
trace: <omitted unless requested>
```

Downstream consumers get results, not reasoning traces. Traces are pulled on
demand (low confidence, NEEDS_REVIEW, or conflict between workers).

## 6. Deadlock and conflict guards

- Delegation cycles (A→B→A) are detected by task-id ancestry; a repeated
  task id in the chain halts the lane with `DETAIL:delegation-cycle`.
- Conflicting worker outputs are never silently merged: the coordinator
  re-prompts with both findings and records the resolution in the decisions log.
- Destructive acts require FR-12 confirmation before dispatch — no exceptions,
  including coordinator-initiated compaction, reverts, and permission changes.

## 7. Session governance checklist (per directive)

1. Mission received in English from Dots3 — restate acceptance criteria.
2. Decompose to DAG; assign sessions; check inventory for busy state.
3. Dispatch wave by wave; collect receipts/acks into the task ledger.
4. On 409: requeue with backoff. On 404: halt lane, report. On 401: halt all.
5. Fan-in: synthesize worker summaries; flag conflicts explicitly.
6. Report to user: what ran, receipts, what changed, what is pending.

## Sources harvested

- LangGraph supervisor: supervisor node + conditional routing on dependency
  state; workers return to supervisor; handoff tools per worker.
  (reference.langchain.com, medium.com agentic-architectures-6)
- CrewAI hierarchical process: generated/custom manager LLM delegates, reviews,
  consolidates; planning mode. (docs.crewai.com, ibm.com/think/topics/crew-ai)
- AutoGen: thinker/executor split, sandboxed code execution, human-input modes.
  (dev.to multi-agent orchestration guide 2026)
- Agent loop anatomy: perceive → reason → act → verify; loop until done with
  bounded turns and tool allowlists. (stevekinney.com, ml4devs.com)
