# AGENTIC BRIDGE PLAN — Phases 1–7

**Status:** approved by owner, 2026-09-30. Source of truth for the bridge work
that follows v0.8.1. Supersedes the narrative parts of `docs/26-AGENT-LAUNCHER.md`.

**Owner decisions binding (2026-09-30), recorded verbatim in intent:**

1. Project is 100% private, internal/personal. **CC BY-NC 4.0 is approved and
   non-blocking.** The licence fact is recorded here once and not re-litigated.
2. AREEB: routing architecture is built **now** on rule-based intent
   classification. **Model weights are formally deferred to v0.9.0.**
3. Window: `resizable: true`, `min_width: 440`, `min_height: 600`.
4. `promptSession` (dialogue, inquiry, Q&A) flows **outside** the permission
   gate. Verbal confirmation applies strictly to `execSessionShell`, file
   writes/deletes, and sensitive configuration toggles.
5. Phase 1 is grounded by **measuring** `POST /api/session/{id}/shell` first.
6. OpenPencil is **visual inspiration only**. All UI is hand-written native
   React + Tailwind **3.4.19** with RTL.

---

## Where the bridge actually stands (measured 2026-09-30, v0.8.1 tree)

| Surface | State |
|---|---|
| Inbound command kinds in the contract | 16 |
| Kinds the renderer actually sends | 13 |
| Implemented daemon-side, never sent by the HUD | `createSession`, `toggleSessionSkill`, `execSessionShell` |
| Frames the protocol can carry | `hello event inventory agents notice voice context flow` |
| Frames that carry tool or shell output | **0** — `flow` is backpressure `pause/resume` |
| `client.execSessionShell` return | hardcoded `{ ok: true }`; the server response is never read |
| Serve health loop | **none.** `probeHealth` runs once at boot; failure throws `SERVE_UNREACHABLE` and the daemon exits |
| Task lifecycle | **none.** `brands.ts` states are narration states, not tasks |
| Tailwind | 3.4.19 (OpenPencil emits v4 — not a code source) |
| Window | 440×600, `resizable: false`, `useAutoSize` resizes to content |

The bridge can **act** and cannot **see**. Phases 1 and 3 close that.

---

## Phase 1 — Terminal output (the eyes)

**Blocks Phases 3, 4 and 7.** Nothing downstream is trustworthy until a shell
command can be observed.

- Measure `POST /api/session/{id}/shell` against a live `serve` **before**
  writing a line of streaming code. Record whether it returns a body, whether
  it streams, and whether it completes or returns immediately.
- `client.execSessionShell` stops discarding the response.
- New additive `output` frame. **Cumulative per-message cap**, mirroring
  `MAX_MESSAGE_BYTES`, because the same fragmentation arithmetic that once let
  a peer assemble an unbounded message applies here.
- Audio rule: silent while running; a ≤20-word spoken summary on completion;
  a spoken warning on failure only. Zero canned speech.

**Kill condition:** if the endpoint is fire-and-forget with no body, the design
becomes "summary on completion" only and the terminal drawer shows the command
plus the model-written summary — not a live stream. Measure, do not assume.

## Phase 2 — Multi-session

- HUD affordance for `createSession`; voice intents for create / switch / list.
- **The project directory becomes per-session and user-selectable.** Today
  `createSession` reads a single `deps.projectDirectory()`. Backend and UI as
  two directories is the owner's stated requirement, and
  `GET /api/agent?directory=` already requires a directory scope.
- Session tabs render from the existing inventory, not a second source.

## Phase 3 — Async task queue

- Persistent FIFO `TaskQueue` under `src/tasks/`.
- Survival across restart, or a task is lost to a closed window.
- **Bounded concurrency and bounded pending depth.** The `vadGate` defect
  (~156 serial awaits with no timeout) is this same class of bug; it must not
  be reproduced in the task layer.
- The audio loop never blocks on a task. Visual notice always; spoken notice
  only inside a silence window.

## Phase 4 — Resizable HUD

- `resizable: true`, `min_width: 440`, `min_height: 600` in `tauri.conf.json`.
- `useAutoSize` **stands down** — it fights a minimum-bounds window, since it
  drives the OS window size from content height.
- Bento grid: compact session bar, task cards, collapsible terminal drawer.
- Hand-written React + Tailwind 3.4.19, RTL, Arabic tooltips on every control.

## Phase 5 — Governance tiers

| Tier | Verbs | Gate |
|---|---|---|
| Read-only | `promptSession`, `sessionContext`, `switchSession`, listing | none |
| State-mutating | `execSessionShell`, file write/delete, sensitive config toggles | **verbal confirmation, fail-closed** |

Existing structural property to preserve: `kind: 'proceed'` returned from
exactly one place, after `consume` matches the id exactly.

## Phase 6 — 4096 resilience

- Periodic health probe on a new `src/runtime/serve-health.ts`.
- Loss is **not** fatal mid-session: amber banner, commands blocked, reconnect
  attempted. `SERVE_UNREACHABLE` **at boot** stays fail-closed — that is a
  deliberate choice and is not what this phase changes.

## Phase 7 — OpenCode orchestration skill

**A skill does not define tools.** OpenCode's tools already exist. A skill is
instructions that steer its agent, attached per session via
`toggleSessionSkill`, which is already implemented at
`command-router.ts:192`. This phase is careful authoring, not engineering.

## v0.9.0 — local edge routing

Rule-based intent classification and session routing, built now, with a single
seam where weights may be introduced later. The model itself is out of scope
for v0.8.x.

---

## Write-set discipline

Two files are contested by more than one work item and therefore have exactly
one owner each: **`src/daemon.ts` (integration) and `apps/desktop/src/App.tsx`
(shell wiring)**. Everything else is disjoint by construction. This is a
correction of a real failure in the previous fleet, where two agents edited
`App.test.tsx` and one overwrote another's work wholesale with no git baseline
to recover from.

## Per-task FSM

`Break guard first` → implement → verify → peer review → atomic BOM-free commit.

A guard is real only once it has been seen failing. A task that pins a bug is
worse than no task. Docs are re-derived, never asserted.
