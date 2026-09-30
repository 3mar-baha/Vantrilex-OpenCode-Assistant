# HEADLESS BRIDGE VERIFICATION — plan artifact

Per `Vantrilex-Precision-Workflow`: the plan is the artifact, and **refuted
premises are written down before anything is built.** Everything below was
measured against a live `opencode serve` 1.18.32 on 127.0.0.1:4096, 2026-09-30.

## Scope

Four suites run headless in CMD, bypassing the Tauri webview and the
audio pipeline entirely. A stranger can check each verdict against the raw
evidence the harness prints.

## THE MEASURED API SURFACE — every agent needs this

**An unknown path on this server answers `200`, not `404`.** It returns the SPA
HTML fallback: `text/html`, **exactly 2884 bytes**, byte-identical for every
unknown path. `res.ok` is therefore **not evidence a route exists.** The
permanent test is content type, not status.

| fact | value |
|---|---|
| real spec | **`GET /doc`** (478,968 B) — `/openapi.json` is the SPA fallback |
| declared paths | **162** |
| auth | HTTP Basic `opencode:<serve.pass>` |
| sessions present | **46** |

Three measurement traps already hit, recorded so they are not re-hit:

1. **Control routes are POST-only.** `GET /api/session/{id}/agent` returns the
   fallback even though the route exists. A GET probe cannot prove absence.
2. **Session-scoped routes need a real session id.** A fake id returns `400` —
   a refusal, not an absence. Different from both cases above.
3. **`/mcp` and `/lsp` have NO `/api` prefix.** `GET /api/mcp` is the fallback;
   `GET /mcp` returns the real `MCPStatus` map. Voxaura's own
   `opencode-bridge.ts:230` asserts "no MCP health endpoint exists on serve" —
   **that comment is false for this version** and is recorded as a finding.

## Refuted premises

- **"AREEB as the local intent engine."** AREEB does not exist. `src/runtime/laya/*`
  is 7 modules dead by decision, the model is 294 MB and never loads,
  `layaReady: false`, and the owner deferred weights to v0.9.0 with routing
  built now on **rule-based classification**. Suite 1 therefore tests the
  rule-based classifier (the contextual permission gate, `slash.ts`,
  `mentions.ts`, `isActionableInstruction`) and reports it under that name.
  Building to a refuted premise ships a limit for a problem that does not exist.
- **"Enumerate MCP servers and LSP diagnostics per session."** MCP and LSP are
  **directory-scoped, not session-scoped** — `GET /mcp?directory=` returns a map
  keyed by server name, `GET /lsp?directory=` returns an array. No per-session
  MCP/LSP read exists. Re-scoped to per-directory, stated as such.
- **"Context size (token/message count) for all sessions."**
  `GET /api/session/{id}/context` is declared but returns **`500`**; its declared
  200 shape is `{data: SessionMessage[]}`, i.e. **messages, not tokens.** There
  is no token-count field on it. Re-scoped: report message counts from the
  routes that answer, and report the token figure as **unavailable** rather than
  deriving one from a field that is not a token count.
- **"Skills per session."** `GET /api/skill` and `GET /skill` exist and are
  **location/directory-scoped**. No per-session skill list exists.

## Suites and write-sets

| # | Suite | Write-set | Gate |
|---|---|---|---|
| 1 | Reasoning, intent gating, RAG precision | **none in repo** — scratch in `%LOCALAPPDATA%\Temp\opencode\` | classification table + RAG hits with no fabrication |
| 2 | Read-only session audit + controlled MCP test | **none in repo**; mutates **exactly one** chosen session | 46 sessions read; before/after MCP diff on the one |
| 3 | New session, Dino game | **only** the designated output dir | `index.html`, `style.css`, `game.js` exist and parse |
| 4 | Agent role switching | **only** the Suite 3 session | Planning→Building→Planning, read back from metadata |

**Suites 1–3 are disjoint and may run concurrently. Suite 4 operates on the
session Suite 3 creates, so it runs after 3 — not in parallel with it.**

## Non-goals

- **Not modifying any existing session**, except the single named one in the
  controlled MCP test. Suite 4 runs on the new session, never an old one.
- **Not invoking the Tauri webview, the microphone, STT or TTS.** Headless means
  headless; a suite that needs audio proves nothing about the bridge.
- **Not reviving AREEB.** No ONNX, no 294 MB, no weights. v0.9.0 owns that.
- **Not adding a harness to the repo.** Scratch lives in `%LOCALAPPDATA%\Temp\opencode\`.
- **Not deriving a token count that no field reports.**

## Owner-only, not finishable by an agent

- Suite 1's multi-case reasoning needs **live free-tier model calls**, so it
  burns quota and needs the vault keys present. An agent can run it; only the
  owner decides whether the quota is worth spending.
- The `/api/session/{id}/context` **500** may be a serve bug. Reporting it is in
  scope; fixing serve is not — it is not this repository.

## Self-check before calling this done

| Question | If no |
|---|---|
| Did every route claim cite the spec or a raw response, never an assumption? | Re-measure it. |
| Did every `200` get checked for `text/html`? | A route may not exist. |
| Is every unavailable figure reported as unavailable, not estimated? | That is fabrication. |
| Is the one mutated session named, and is every other session untouched? | The read-only invariant is broken. |
| Did each harness print its own raw evidence? | A pass nobody can read is not evidence. |

---

# PART TWO — the headless bridge is now PRODUCT CODE (`src/cli/`), 2026-09-30

Everything above is a plan and a set of raw `fetch` measurements. The plan's own
non-goal said "not adding a harness to the repo", and that is right for a scratch
harness and wrong for the thing that has to survive: three earlier attempts measured
**OpenCode**, not Voxaura, because they called `fetch` on `127.0.0.1:4096` directly.
Those numbers stay green if the coordinator is gutted, the gate is inverted, or
dispatch is dead. So the runner is now eight new modules under `src/cli/` plus one
branch in `src/cli.ts`, and every figure it prints is traceable to a module.

## 2.1 What was built, and where each claim comes from

| subcommand | product module it drives | what it can prove | what it cannot |
|---|---|---|---|
| `gate` | `src/orchestrator/coordinator.ts`, counted from source | that exactly one `kind:'proceed'`, one `deps.dispatch(` call site and one `permission.consume(` exist | anything about the model |
| `intents` | `src/orchestrator/permission.ts` — `addresseeSystem()` + `ADDRESSEE_RESPONSE_FORMAT` + `parseAddressee()`, the identical triple `Coordinator.gate()` passes at `coordinator.ts:388-393` | that `parseAddressee` classifies the way the gate's own prompt specifies, and that `PermissionSlot` is single-use | the model's own judgement, in replay mode. It says so on every run. |
| `reason` | `Coordinator` end to end, egress through `src/runtime/client.ts ServeClient.promptSession` | the whole chain, per stage, including whether a dispatch happened | audio. There is none, and the report says so. |
| `sessions` | `ServeClient.listSessions()` | the session list, plus whether the route answered with JSON | — |
| `mcp` / `lsp` | ServeClient's own request path (`ServeClient.request`, composed — see 2.3) | per-directory MCP/LSP, and that `/api/…` is the fallback while `/…` is real | anything session-scoped. There is no such route. |
| `skills` | `ServeClient.listSkills()` plus a route check | the skill list, and whether an empty list means "none" or "no route" | — |
| `create-session` | `ServeClient.createSession()` + `getSession()` | the id, read back from serve rather than trusted from the create response | — |
| `prompt` | `ServeClient.promptSession()` | whether serve accepts the prompt, and in which body shape | see 2.2 — it does not. |
| `shell` | `ServeClient.execSessionShell()` on the v1 route | that the command ran, and what it printed | whether it SUCCEEDED. Serve sends no exit code. |
| `spec` | ServeClient's request path | where the route list actually lives | — |

## 2.2 FINDING — the voice loop cannot currently deliver a prompt to this serve

This is the reason the runner is product code. Every gate in this repository is
green and `ServeClient.promptSession` does not work against the serve the product
runs. Measured through `ServeClient`'s own request path, 2026-09-30, opencode
1.18.32, both body shapes it can send, on two different sessions:

| body shape | status | what serve said |
|---|---|---|
| `flat` — **the shipped default** (`client.ts:461-463`) | **400** | `{"_tag":"InvalidRequestError","message":"Missing key\n  at [\"prompt\"]","kind":"Payload"}` |
| `nested` | **500** | `{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_c2a69d68"}}` |

Three things follow, and none of them is a guess:

1. The default is wrong for this server. The flat envelope is missing the `prompt`
   key serve's schema requires, so the refusal names the fix.
2. The documented workaround does not work either. `nested` clears the schema
   check and then dies inside serve with a per-call correlation id. The failure is
   not in Voxaura's serialiser.
3. The error shape is neither of the two `runtime/client.ts` documents. It is
   `{_tag, message, kind}` and `{name, data}`, not the `{data}` envelope of the v2
   family, so the diagnostics written around the envelope will not read these.

The serve was restarted once during the session and both refusals reproduced
identically afterwards, so this is not a transient.

`src/runtime/client.ts` is outside this change's write-set, so **nothing was
fixed**. What was built is the ability to see it: `--envelope flat|nested` selects
the shape through `ServeClient`'s own constructor option, and a failed prompt
re-reads the same bytes through the same request path so serve's complaint is
legible rather than discarded.

The end-to-end demonstration, through the product's own chain, is
`reason --replay --approve`: the gate asks, the runner answers with the model's own
ask, the gate approves by name, the plan is built, `buildHandoff()` produces the
envelope, `ServeClient.promptSession` is called — and serve answers 400. The run
prints `dispatched ATTEMPTED, FAILED` and exits 1. It does not claim a dispatch.

## 2.3 The one composed method, and why it is not a second HTTP client

`ServeClient` has no method for `GET /mcp`, `GET /lsp` or `GET /doc` — the first
two have no `/api` prefix, so there is no path it builds. `request` is `private`
and `client.ts` is outside the write-set. So `src/cli/serve.ts` binds the existing
method off the instance (`requestPathOf`). Reused, because it is the same function
object and not a copy: the Basic auth header, the JSON content-type, the 30 s
abort, the `SERVE_UNREACHABLE` mapping, the `spaFallbackContentType` rule. If the
method is ever renamed the seam throws a typed `CONTRACT_DRIFT` and the runner
refuses rather than falling back to a bare `fetch` — and that refusal is a test.

`spaFallbackContentType` is not exported, so `serve.ts` restates the same three-line
rule. That is stated rather than hidden, and `serve.test.ts` pins the restatement
against the REAL `execSessionShell` on the same three measured response shapes, so
the two cannot drift without a failure.

## 2.4 The structural invariant, and the count that is NOT the count

`gate` counts three patterns in `coordinator.ts` source, using the patterns
`src/orchestrator/command-tiers.test.ts:630-631` already pins, so the CLI and the
suite cannot disagree about the number:

```
return { kind: 'proceed'   1  (expected 1)
this.deps.dispatch(        1  (expected 1)
this.permission.consume(   1  (expected 1)
naive "kind: 'proceed'"    2  <- the type member + the returned value
```

**The naive substring count is 2, not 1, and that is published on every run.** A
reader who greps the file gets 2: one is `gate()`'s return-type annotation
(`coordinator.ts:372`) and one is the returned value (`coordinator.ts:438`). A
guard written on the naive number fails forever, or gets "fixed" by loosening the
pattern until it goes green — which is a guard that passes for the wrong reason.
The anchored count is 1, and the anchor is on `return {`.

Break-verified end to end through the built CLI, against a mutated **copy** — the
real orchestrator is outside this write-set and was not touched:

```
$ node dist/cli.js gate --source …\coordinator-BROKEN.ts
  return { kind: 'proceed'  2 (expected 1)
  naive "kind: 'proceed'"   3
  FAIL  return { kind: 'proceed': 2 (expected 1)
### exit=1
$ node dist/cli.js gate
  return { kind: 'proceed'  1 (expected 1)
  PASS  one proceed, one dispatch call site, one consume
### exit=0
```

The runtime half is separate and catches what a source count cannot: a dispatch
with no `approve` verdict, more than one dispatch in a run, or a permission slot
still open beside a delivered dispatch. All three are violations. An `approve` with
NO dispatch is explicitly **not** one, because that is the fail-closed
`approval-unbound` re-ask, and calling it a violation would punish the product for
refusing.

## 2.5 What this runner cannot serve, precisely

| suite from the plan above | served? | why |
|---|---|---|
| 1 · reasoning, intent gating | **yes** | `reason` and `intents`. Live by default; `--replay` proves the chain with no model and no quota. |
| 1 · RAG precision | **no** | retrieval is servable through the existing `knowledge` subcommand, but "was the retrieved chunk a correct answer" needs a judgement table this runner has no vocabulary for. Not built, not faked. |
| 2 · read-only session audit | **yes** | `sessions`, with the route checked so an empty list is distinguishable from a missing route. |
| 2 · controlled MCP test | **partly** | the read is there (`mcp`); the mutating half is not, and no session was mutated by this work. |
| 3 · new session, Dino game | **partly** | `create-session` creates the session. The game's three files existing and parsing is checked by nothing here, and `prompt` cannot reach serve at all (2.2). |
| 4 · agent role switching | **no** | needs `OpenCodeBridge.setSessionAgent` and a subcommand. Named, not built: it is state-mutating and the brief did not ask for it. |
| any audio suite | **no** | headless means headless. No microphone, no Whisper, no Fish, no WS-4097. |

## 2.6 What this change cost the repository, stated plainly

`npm run docs:verify` re-derives its figures from the tree and compares them to
`AGENTS.md`, which is outside this change's write-set. Six of its claims now
contradict the code, and every one of them is the code added here:

| claim | `AGENTS.md` | re-derived | delta |
|---|---|---|---|
| root vitest tests | 1197 | 1297 | +100 (6 new files) |
| root vitest files | 81 | 87 | +6 |
| live modules | 66 | 74 | +8 (`src/cli/*.ts`, production) |
| live source lines | 18300 | 20777 | +2477 |
| test-reachable modules | 71 | 79 | +8 |
| test total modules | 74 | 82 | +8 |

**`npm run docs:verify` exits 1 until `AGENTS.md` is reconciled.** This is not a
false alarm and must not be suppressed: the gate is right, the document is behind,
and the fix is the document. The one claim that WAS this change's fault — `cited
line anchors: 3 dangling` in `src/cli.ts` — is fixed. The headless branch is
reached from the existing fallback `else` rather than from a sixth `else if` plus a
top-level import, so not one line above it moves; `docs:verify` now reports
`cited line anchors 166 cited, all resolve PASS`.

## 2.7 One process incident worth recording

A concurrent code-first audit quarantined this work mid-session because
`src/cli.ts` was modified, and reported that the change "broke
`docs:verify --self-test`". The self-test passes, before and after
(`4 behavioural check(s)`). The real `docs:verify` failure was the six count claims
above — documentation debt, not a broken tree — plus the 3 dangling anchors, which
were real and are the reason the branch is shaped the way it is. Recorded because a
reader hitting the same gate needs to know which of the two was which.

## 2.8 Non-goals, restated and honoured

- No GUI, no audio, no TTS, no STT. `reason` starts from a CLI argument.
- The five existing subcommands are byte-identical, pinned by source text in
  `src/cli/commands.test.ts` rather than by behaviour — a behavioural test of
  `doctor` needs keys and a live serve to run at all.
- AREEB and `src/runtime/laya/*` untouched. No ONNX, no 294 MB load.
- The orchestrator, daemon, protocol and client are imported, never edited.
- No raw `fetch` to `127.0.0.1:4096` anywhere in `src/cli/`. The serve base URL is
  built from `loadConfig().serve.hostname`, and every call goes through
  `ServeClient` or the bound request path above.

## 2.9 Figures re-measured through the product's own path

Every row below came from `node dist/cli.js <subcommand>` on 2026-09-30 against
opencode 1.18.32 on 127.0.0.1:4096. None of them came from a bare `fetch`.

| figure | value | printed by |
|---|---|---|
| declared paths in `GET /doc` | 162 | `spec` |
| `GET /doc` body | 478 968 bytes | `spec` |
| `GET /openapi.json` | `text/html;charset=UTF-8`, 2 884 bytes, `exists=no` | `spec` |
| `GET /mcp` (no prefix) | `application/json`, 283 bytes, `exists=yes` | `mcp` |
| `GET /api/mcp` | `text/html`, 2 884 bytes, `exists=no` | `mcp` |
| MCP servers connected | 8 (9 before the serve was restarted mid-session) | `mcp` |
| `GET /lsp` (no prefix) | `application/json`, 2 bytes (`[]`), `exists=yes` | `lsp` |
| `GET /api/lsp` | `text/html`, 2 884 bytes, `exists=no` | `lsp` |
| sessions listed | 48 (was 46 in the plan above) | `sessions` |
| `/api/session` route check | `json`, `exists=yes` | `sessions` |
| skills | 19; `/api/skill` `json`, bare `/skill` `json` | `skills` |
| `create-session` | id read back via `getSession` → `state=idle` | `create-session` |
| `shell "echo headless-ok"` | `status=completed`, `outcome=unknown`, 13 B, 308 ms | `shell` |
| `shell "exit 3"` | `status=completed`, `outcome=unknown`, 0 B, 230 ms | `shell` |
| `shell "cd ."` | `status=completed`, `outcome=unknown`, 0 B | `shell` |

The last three rows are the plan's trap re-confirmed on a new serve instance: a
failed command and a silent success are byte-identical, and the runner prints
`unknown` for both and says why.
