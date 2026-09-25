# voxaura — architecture

> Atomic note. One fact per section; link, do not duplicate.

- Single Supervisor: Node owns `opencode serve`; Tauri owns window/tray/hotkey.
- WS-4097 (`voice-ui.v1`): bearer via subprotocol token, `?lastSeq=` resume,
  shared seq with ledger. Client contracts are frozen.
- Control plane: HTTP Basic `opencode:<password>`; sessions at `/api/session`
  (`{data}` envelopes); SSE at `/api/event`. Controls return 204.
- Prompt envelope is version-specific: flat `{text}` for 2.0.x (default),
  nested `{prompt:{text}}` for 1.18.x via `ServeClient.promptEnvelope`.
- Backpressure queue with idempotency keys; sibling-serve sweeper; per-session
  inventory snapshots streamed to the shell.
- Roles: Dots3 intake → Nemotron DAG coordination → Inkling in-session driving.

See [[projects/voxaura/01-overview]], [[projects/voxaura/04-decisions-log]].
