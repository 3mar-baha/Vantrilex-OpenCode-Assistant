# 06 — Complete API, Protocol & Routing Inventory

**Repo:** `O:\opencode-Vantrilex` · **HEAD:** `9f41c96eb716985a12b7a6b8c235b5acad42f6b8` · **Version:** `0.8.2` (`package.json:version`, `apps/desktop/package.json:version`, `apps/desktop/src-tauri/Cargo.toml:version`, `apps/desktop/src-tauri/tauri.conf.json:version` — all four agree).

**Method.** Every line below is read from a physical file at this HEAD, or measured against a live `opencode serve` **1.18.32** (`opencode --version`) already bound to `127.0.0.1:4096` (HTTP Basic `opencode:<value of %USERPROFILE%\.opencode-voice-runtime\serve.pass>`; the password is never printed). Live probes were run from scratch scripts in `%LOCALAPPDATA%\Temp\opencode\`. `dossier/PROJECT_MASTER_DOSSIER.md` was **not** opened.

**Documentation deliberately NOT opened:** `docs/**` (52 tracked files), `README.md`, `README.ar.md`, `CHANGELOG.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.opencode/**` (154 tracked files). No code comment was treated as evidence; where a comment asserts a measurement, the assertion was re-measured and the disagreement is reported.

**Correction to the file-count premise.** The briefing's "279 project source files: src 157, apps 110, scripts 10" does not match the tree. `git ls-files` yields `src` **156**, `apps` **175**, `scripts` **11** tracked paths (342 total for those three trees). There is a fourth and fifth project tree the briefing omits: `.opencode/` (**154**) and `ml/` (**38**). The "ALL `.py` are inside `.venv`" claim is also false: **22** `.py` files sit outside `.venv` — **19** under `ml/` (`ml/train_laya.py`, `ml/export_onnx.py`, `ml/laya_hub.py`, `ml/eval_onnx.py`, `ml/data/harvest_joda.py`, …), **2** under `.hf_cache/`, **1** under `node_modules/flatted/python/`. `ml/` is git-tracked and is real project code. `go.mod`, `pyproject.toml`, root `Cargo.toml`, `setup.py`, `requirements.txt` are all **ABSENT — verified by `Test-Path` on each**.

**Concurrent, uncommitted work — not a shipped subsystem.** `src/cli/` exists as **5 untracked files** (`intents.ts`, `reason.ts`, `report.ts`, `serve.ts`, `turn.ts`, mtimes 14:41–14:44 today) and is **not imported by any tracked module** (`git status --short` shows `?? src/cli/`). Every reference to it below is labelled `[IN-FLIGHT]`. It is excluded from all reachability and API claims about the shipped product.

---

## Plane 1 — Voxaura's own inbound command protocol (WS-4097)

### Transport

| Property | Value | Location |
|---|---|---|
| Bind | `127.0.0.1` only, fixed port `4096 + 1 = 4097` | `src/ipc/protocol.ts:6`, `src/ipc/ui-server.ts:196` |
| Path | `/v1/ui` | `src/ipc/protocol.ts:7`; enforced `src/ipc/ui-server.ts:493` |
| Subprotocol | `voice-ui.v1` | `src/ipc/protocol.ts:8`; required pre-upgrade `src/ipc/ui-server.ts:493` |
| Auth | `Authorization: Bearer <token>` **or** a subprotocol token equal to the token | `src/ipc/ui-server.ts:449-466` |
| Fail-closed | Empty token ⇒ `throw` in the constructor, server never starts | `src/ipc/ui-server.ts:160-162` |
| Plain HTTP | every non-upgrade request gets a bare `404`, no body | `src/ipc/ui-server.ts:189-192` |
| Ping/pong | 5000 ms interval, 3 missed ⇒ socket destroyed | `src/ipc/protocol.ts:11-12`, `src/ipc/ui-server.ts:754-772` |
| Max connections | 8, evict-oldest | `src/ipc/protocol.ts:19`, `src/ipc/ui-server.ts:521-533` |
| Max assembled message | 1 MiB, cumulative, checked **before** a part is stored | `src/ipc/protocol.ts:22`, `src/ipc/ui-server.ts:365` → `accountFor` `289-307` |
| Max pre-header buffer | 2 MiB | `src/ipc/protocol.ts:24`, `src/ipc/ui-server.ts:329-336` |
| Max binary (audio) frame | 64 KiB on the **reassembled** payload ⇒ `error` frame, socket kept | `src/ipc/protocol.ts:30`, `src/ipc/ui-server.ts:688-691` |
| Resume window | 256 frames **and** 64 KiB, evict-oldest | `src/ipc/protocol.ts:20`, `src/ipc/ui-server.ts:57`, `221-230` |

Bodies that are binary **over** 64 KiB are refused before `onAudio` is touched; a rejected frame yields `{type:'error',detail:'audio frame too large'}` and the connection survives (`src/ipc/ui-server.ts:688-691`). Malformed JSON yields `{type:'error',detail:'invalid JSON'}` (`703`); a zod-rejected command yields `{type:'error',detail:'unknown command'}` (`708`). The `error` frame has **no zod schema** and is built as an inline literal at `src/ipc/ui-server.ts:689` and `703` and `708`.

### Frame inventory (every frame type, producer → consumer)

Server → client, **11** wire types. `type` literals declared in `src/ipc/protocol.ts`: `hello`(414), `event`(448), `inventory`(572), `agents`(618), `notice`(632), `voice`(647), `context`(658), `flow`(684), plus three `const` kinds `ACK_KIND='ack'`(31), `ERROR_KIND='error'`(32), `OUTPUT_KIND='output'`(33) — whose zod schemas are `AckFrameSchema:546-551` and `OutputFrameSchema:908-941`. `error` has **no schema** (inline literals only). That is **8 declared schemas + 2 const-backed + 1 schema-less = 11**, matching the renderer's **11** inbound branches (`apps/desktop/src/bridge/ws.ts`: `611, 658, 664, 677, 688, 701, 719, 739, 754, 766, 780`).

| Frame | zod schema | Retained for resume | Producer |
|---|---|---|---|
| `hello` | `protocol.ts:413-444` | no | `ui-server.ts:538-571` |
| `event` | `protocol.ts:447-452` | **yes** | `ui-server.ts:233-242` — **zero production callers** (grep for `ui.broadcast(` in `src/daemon.ts` returns no match) |
| `inventory` | `protocol.ts:571-584` + cap `569` | latest only | `ui-server.ts:248-257` ← `daemon.ts:1611`, `1629` |
| `agents` | `protocol.ts:617-620` | latest only | `ui-server.ts:260-269` ← `daemon.ts:1625` |
| `notice` | `protocol.ts:631-639` | no | `ui-server.ts:341-345` (redaction sink) |
| `voice` | `protocol.ts:646-652` | no | `ui-server.ts:355-359` (redaction sink) |
| `context` | `protocol.ts:657-668` | no | `ui-server.ts:368-386` ← `daemon.ts:901` |
| `flow` | `protocol.ts:683-687` | no | `ui-server.ts:402-407` ← `daemon.ts:1148`, `1578` |
| `ack` | `protocol.ts:546-551` | no | `ui-server.ts:723-734` |
| `output` | `protocol.ts:908-941` | **yes** | `ui-server.ts:312-323` ← `daemon.ts:841` |
| `error` | **ABSENT — no zod schema; inline literals at `ui-server.ts:689,703,708` only** | no | same |

Because `broadcast()` has no production caller, `retainForResume` in a shipped build is fed **only** by `output()`; consequently `noticeResumeGap` (`ui-server.ts:625-647`) cannot fire in production — verified by `Select-String -Path src/daemon.ts -Pattern 'ui\.broadcast\('` returning nothing.

Binary downlink framing (`src/ipc/audio.ts`): `[type:1 = 0x01][seq:u16be][mp3…]`, `MAX_AUDIO_CHUNK = 32 * 1024` (`audio.ts:6-7`, `encodeAudioChunk:9-16`, `splitAudio:31-38`). Sequence wraps `mod 65_536` (`audio.ts:35`, `ui-server.ts:418`).

### `UiCommandSchema` — every field (`protocol.ts:469-543`), 18 fields, `.strict()`

| Field | Constraint | Line |
|---|---|---|
| `id` | `string().min(1).max(128)`, no `[\u0000-\u001F\u007F]` | 471 |
| `kind` | `z.enum([…16…])` | 472-502 |
| `persona` | `z.enum(['kareem','nour']).optional()` | 503 |
| `minutes` | `int().positive().max(1440).optional()` | 504 |
| `sessionId` | `regex(/^ses_[A-Za-z0-9_-]{1,120}$/).optional()` | 505-508 |
| `agent` | `min(1).max(64)` + `IDENT_RE = /^[A-Za-z0-9._:\/-]+$/` | 509 |
| `model` | `min(1).max(128)` + `IDENT_RE` | 510 |
| `skill` | `min(1).max(128)` + `IDENT_RE` | 511 |
| `skillAction` | `z.enum(['attach','detach']).optional()` | 512 |
| `command` | `min(1).max(512).optional()` | 513 |
| `groqKey` / `fishKey` / `openrouterKey` | `min(1).max(512)`, no control chars | 516, 517, 518 |
| `confirmId` | `min(1).max(128)`, no control chars | 519 |
| `approve` | `boolean().optional()` | 520 |
| `playbackId` | `min(1).max(64)` + `/^[A-Za-z0-9._:-]{1,64}$/` | 529-538 |
| `title` | `min(1).max(200).optional()` | 540 |
| `contextLimit` | `int().positive().max(10_000_000).optional()` | 541 |

`CONTROL_CHARS_RE` `protocol.ts:465`; `IDENT_RE` `protocol.ts:467`. Field count **18**, derived by parsing `protocol.ts:469-543` with block comments stripped.

### The 16 command kinds → handler → gate → return

Router: `src/orchestrator/command-router.ts`. Gate lookup is one call, `tierOf(cmd.kind)` at `command-router.ts:793`. `ok` means **DISPATCH, not OUTCOME** (`command-router.ts:19-48`).

| # | kind | zod line | `dispatch` case | Tier | Returns |
|---|---|---|---|---|---|
| 1 | `switchSession` | 484 | 549-553 | read-only | `{ok:true}`, no detail |
| 2 | `setSessionAgent` | 485 | 554-560 | read-only | `{ok:true}` / `no active session` / `agent required` |
| 3 | `setSessionModel` | 486 | 561-567 | read-only | `{ok:true}` / `no active session` / `model required` |
| 4 | `toggleSessionSkill` | 487 | 568-574 | **state-mutating** | `{ok:true}` / `skill required`; parks first |
| 5 | `execSessionShell` | 488 | 575-591 | **state-mutating** | `{ok:true, detail: SHELL_OUTCOME_DETAIL[outcomeOf(result)]}`; parks first |
| 6 | `saveApiKeys` | 489 | 627-634 | read-only (stated carve-out) | `{ok:true}` / `key intake unavailable` / `all 3 keys required` |
| 7 | `setPersona` | 490 | 635-639 | read-only | `{ok:true, detail:'persona-set'}` |
| 8 | `abort` | 473 | 640-642 | read-only | `{ok:true}` |
| 9 | `stopSpeech` | 478 | 645-647 | read-only | `{ok:true}` |
| 10 | `playbackStarted` | 487 | 651-653 | read-only | `{ok:true}` |
| 11 | `mute` | 488 | 677-680 | read-only | `{ok:true}` — **no dependency call at all** |
| 12 | `deafen` | 489 | 677-680 | read-only | `{ok:true}` — no dependency call |
| 13 | `arm` | 490 | 677-680 | read-only | `{ok:true}` — no dependency call |
| 14 | `sessionContext` | 500 | 656-669 | read-only | `{ok:true, detail: '<n> رمز (الحد غير معروف)'}` or `{ok:true, detail:'<p>% من <l> رمز'}` |
| 15 | `createSession` | 501 | 670-676 | **state-mutating** | `{ok:true, detail:'جلسة جديدة: ses_…'}`; parks first |
| 16 | `confirm` | 498 | handled **before** the tier lookup, 779-788 | unclassified | `{ok:true, detail:'cancelled'}` or `execute(parked.cmd)`; `confirmId required` / `no pending action` / `confirmation expired` |

`confirm` is deliberately **not** in the tier table (`command-router.ts:238-243`, `WorkCommandKind = Exclude<UiCommand['kind'],'confirm'>` at `243`).

### Tier classification is TOTAL — proved by count, not by reading

`COMMAND_TIERS` (`command-router.ts:280-340`) is `satisfies { readonly [K in GovernedKind]: CommandTier }` (`340`), so totality is a **compile-time** property. Derived counts:

- `UiCommand['kind']` members parsed from `protocol.ts:472-502` = **16**
- `WorkCommandKind` = 16 − 1 (`confirm`) = **15**
- `PENDING_PROTOCOL_KINDS` (`command-router.ts:269`) = **3** (`writeFile`, `deleteFile`, `setSensitiveConfig`)
- `GovernedKind` = 15 + 3 = **18**
- `COMMAND_TIERS` rows parsed from `command-router.ts:280-340` = **18**; `read-only` **12** (`switchSession, sessionContext, abort, stopSpeech, playbackStarted, mute, deafen, arm, setSessionAgent, setSessionModel, setPersona, saveApiKeys`), `state-mutating` **6** (`execSessionShell, writeFile, deleteFile, setSensitiveConfig, toggleSessionSkill, createSession`)
- `missing = []`, `extra = []` — the table is exactly `GovernedKind`, no more and no less.

Tier model definition: `read-only | state-mutating` (`command-router.ts:235`). `DESTRUCTIVE_KINDS` (`363-367`) is the derived **wire-reachable** gated set = 3 members (`execSessionShell`, `toggleSessionSkill`, `createSession`) — the other 3 are pending-wire kinds filtered out by `PENDING_KIND_SET`.

### Three classified kinds are structurally unreachable in the shipped daemon

`mutateFile` and `setSensitiveConfig` are **optional** deps (`command-router.ts:182-190`) and the daemon does **not** supply them — verified by `Select-String -Path src/daemon.ts -Pattern 'askLine|onConfirmationRequired|mutateFile|setSensitiveConfig'` returning **no match**. Therefore `writeFile`, `deleteFile`, `setSensitiveConfig` always resolve to `file operations unavailable` (`596`) / `configuration writes unavailable` (`614`) — and, because `createSession` *is* reachable, its prevalidate runs (`730-733`).

The same search shows **`askLine` and `onConfirmationRequired` are not wired either**. Consequences, both live today:
- `askFor()` (`command-router.ts:750-770`) calls `deps.askLine?.(...)` → `undefined ?? ''` → `line = ''` → `askAr` is **empty**. The Arabic ask is **withheld**, exactly as the code documents, but the code's premise (`daemon.ts` wires it) is false.
- `deps.onConfirmationRequired?.(askFor(cmd))` (`819`) is a no-op. The only user-visible signal that a command was parked is `ack.detail: 'confirmation-required'` (`820`), read by the shell at `apps/desktop/src/App.tsx:592`.

### Payload shape checks, park TTL, queue

- `shellCommandError` (`command-router.ts:443-449`): empty, >512 chars, `TRAVERSAL_RE = /\.\./` (`431`), `UNSAFE_SHELL_RE = /[;&|`$<>\n\r*?(){}!~]/` (`429`).
- `filePathError` (`466-472`): empty, >1024, control chars, `..`.
- `parseModelRef` (`475-479`): `provider/id` split at the first `/`; bare id defaults `providerID: 'opencode'`.
- `describeAction` (`498-514`): payload-derived, truncated to 240 chars. **`execSessionShell` omits the verb** by design.
- `CONFIRMATION_TTL_MS = 60_000` (`397`); `MAX_PARKED = 8`, evict-oldest (`404`, `807-811`). The `pending` map is deleted **before** `execute` runs (`784` then `787`).
- Second gate: `withServeGate` (`src/runtime/serve-health.ts:294-305`), allowlist `SERVE_LOCAL_ONLY_COMMANDS` = **9** members (`serve-health.ts:258-268`). Wired at `src/daemon.ts:872-873`. **Default-deny** — every other kind, `confirm` included, is refused with `serve-degraded` / `serve-reconnecting` / `serve-reconnect-exhausted` (`serve-health.ts:207-209`, `276-279`).

---

## Plane 2 — daemon → `opencode serve` (HTTP Basic, loopback 4096)

Client: `src/runtime/client.ts`, class `ServeClient:448`. Single choke point `request()` (`483-498`): `Content-Type: application/json`, `Authorization: Basic base64("opencode:"+password)` (`basicAuth:42-44`), optional `Idempotency-Key`, hard 30 s `AbortController`. The serve host is pinned to `127.0.0.1:${options.servePort}` at `src/daemon.ts:317`. **13 `this.request()` sites and 6 `this.control()` sites**, both counts derived with comments stripped.

### THE MEASURED FACT — confirmed, and it is worse than "one route"

Measured live against opencode **1.18.32** on 2026-09-30:

| Probe | Status | Content-Type | Bytes |
|---|---|---|---|
| `GET /doc` | 200 | `application/json` | **478 968** — declares **162 paths** |
| `GET /openapi.json` | 200 | `text/html;charset=UTF-8` | **2 884** |
| `GET /api/zzz-absent-route-probe` | 200 | `text/html;charset=UTF-8` | **2 884** |
| `GET /totally/bogus/route/zzz` | 200 | `text/html;charset=UTF-8` | **2 884** |

Byte-identity of the two arbitrary unknown paths: **`true`**. The SPA fallback is a **2884-byte** `<!doctype html>` page returned with **HTTP 200** for *any* unmatched path. **`res.ok` is therefore not evidence a route exists.** Both the shell route and the skill route in the client are on the wrong side of this.

### Route-existence verdict table

`/doc` = the only real spec. `ABSENT from /doc` was determined by parsing the 478 968-byte document; `live` is a measured HTTP call against the running server.

| Method + path | Client call site | In `/doc`? | Live result | VERDICT |
|---|---|---|---|---|
| `POST /api/session` | `client.ts:506` | ✅ `v2.session.create` | 200 `{data:{id,projectID,cost,tokens,time,title…}}` | **VERIFIED WORKING** |
| `POST /api/session/{id}/prompt` | `client.ts:559` | ✅ `v2.session.prompt` | client's **default flat** body `{text,metadata,delivery}` → **400 `Missing key at ["prompt"]`**; `{prompt:{text},delivery}` → **500 UnknownError** | **VERIFIED BROKEN — both envelopes** |
| `GET /api/session/{id}` | `client.ts:575`, `952` | ✅ `v2.session.get` | 200 `{data}` — keys `id,projectID,agent,model,cost,tokens,time,title,location,subpath` | **VERIFIED WORKING**; the `state`/`outcome` fields the client reads are **absent from every row** |
| `GET /api/session` | `client.ts:868` | ✅ `v2.session.list` | 200 `{data:[47 rows],cursor}` | **VERIFIED WORKING**; same missing `state`/`outcome` |
| `GET /api/session/{id}/context` | `client.ts:891` | ✅ `v2.session.context` (spec itself declares a 500) | **500 `UnknownError`** | **VERIFIED EXISTING, VERIFIED FAILING** |
| `GET /api/session/{id}/message` | `client.ts:1068` | ✅ `v2.session.messages` | 200 `{data:[],cursor}` | **VERIFIED WORKING** (empty for this session) |
| `GET /api/agent?directory=…` | `client.ts:849` | ✅ `v2.agent.list` | 200, `data.length = 19`, **identical with and without the query** | **VERIFIED WORKING**; the "an unscoped call returns no data" claim at `client.ts:846-847` is **false as measured** |
| `GET /api/model` | `client.ts:972` | ✅ `v2.model.list` | 200, **502 rows**, `row.limit.context` present (row0 = 1 050 000) | **VERIFIED WORKING** |
| `GET /api/skill` | `client.ts:997` | ✅ `v2.skill.list` | 200, 19 rows, keys `name,description,location,content` | **VERIFIED WORKING**; `slash` is **absent from every row** ⇒ `r['slash'] === true` (`client.ts:1008`) is **always false** |
| `GET /api/command` | `client.ts:1048` | ✅ `v2.command.list` | 200, 2 rows, keys `name,template,description` | **VERIFIED WORKING**; `template` and `description` **discarded** |
| `POST /api/session/{id}/agent` | `client.ts:657` (via `control`, guard **off**) | ✅ `v2.session.switchAgent`, 204 | **500 `UnknownError`** | **VERIFIED EXISTING, VERIFIED FAILING** |
| `POST /api/session/{id}/model` | `client.ts:675` (guard **off**) | ✅ `v2.session.switchModel`, 204 | **500 `UnknownError`** | **VERIFIED EXISTING, VERIFIED FAILING** |
| `POST /api/experimental/session/{id}/skill` | `client.ts:714` (guard **on**, `true` at `720`) | ❌ **ABSENT** — the only `/experimental/session*` path in `/doc` is `…/{sessionID}/background` | **200 text/html 2 884 B** | **ABSENT — confirmed.** Now fails loudly as `CONTRACT_DRIFT` |
| `POST /session/{id}/shell` (v1, **no `/api`**) | `client.ts:790-793` | ✅ `session.shell` | 200 `{info,parts}`, `transfer-encoding: null`, `t_headers == t_end` | **VERIFIED WORKING** |
| `POST /api/session/{id}/shell` (old path) | no call site (removed) | ❌ **ABSENT** | **200 text/html 2 884 B** | **ABSENT — confirmed** |
| `POST /api/session/{id}/compact` | `client.ts:1015` (guard **off**) | ✅ `v2.session.compact`, 204 **+ 503** | **503 `ServiceUnavailableError: "Session compact is not available yet"`** | **VERIFIED EXISTING, VERIFIED UNAVAILABLE** |
| `POST /api/session/{id}/interrupt` | `client.ts:1027` (guard **off**) | ✅ `v2.session.interrupt`, 204 | **204, 0-byte body, no content-type** | **VERIFIED WORKING** |
| `POST /api/session/{id}/revert/stage` | `client.ts:1033` (guard **off**) | ✅ `v2.session.revert.stage`, **`required:["messageID"]`** | **400 `Missing key at ["messageID"]`** (client sends `{}`) | **VERIFIED BROKEN — client body omits a required field** |
| `POST /api/session/{id}/revert/commit` | same | ✅ 204, no requestBody | **204** | **VERIFIED WORKING** |
| `POST /api/session/{id}/revert/clear` | same | ✅ 204, no requestBody | **204** | **VERIFIED WORKING** |
| `GET /openapi.json` | `client.ts:1092` (`probeContract`) | ❌ **ABSENT** | **200 text/html 2 884 B** | **ABSENT — confirmed.** `res.json()` throws ⇒ caught ⇒ `probeContract()` returns `'unknown'` in every production run |
| `GET /api/session` (health probe) | `launcher/launcher.ts:28` | ✅ | 200 | **VERIFIED WORKING** |
| `GET /api/session` (diagnostic probe) | `diag/bundle.ts:649` | ✅ | 200 | **VERIFIED WORKING** |
| `GET /mcp` | **no call site in `src/`** | ✅ `mcp.status` | 200 `{"context7":{"status":"connected"},…}` — 9 servers, real map | **EXISTS, NEVER CALLED** |
| `GET /api/mcp` | no call site | ❌ **ABSENT** | 200 text/html 2 884 B | **ABSENT** |
| `GET /lsp` | **no call site in `src/`** | ✅ `lsp.status` | 200 `[]` | **EXISTS, NEVER CALLED** |
| `GET /api/lsp` | no call site | ❌ **ABSENT** | 200 text/html 2 884 B | **ABSENT** |
| `GET /doc` | **no call site in `src/`** | n/a (the spec cannot list itself) | 200 `application/json` 478 968 B, 162 paths | **REAL SPEC, NEVER CALLED by product code** |

**Confirmed from the briefing's known-absence list, all three:** the shell route is ABSENT at `/api/session/{id}/shell`; `/api/experimental/session/{id}/skill` is ABSENT; `/api/mcp` and `/api/lsp` are ABSENT **while `/mcp` and `/lsp` exist without the `/api` prefix** — verified independently, exactly as instructed.

### Response shapes, read literally

- `POST /api/session` request: `{location:{directory}, model?}` (`client.ts:508-511`). `LocationRef` = `{directory: string (required), workspaceID?: /^wrk/}` — `{location:{directory}}` is **valid** (measured 200). But `model` is typed `string` in `ServeClient.createSession(directory, model?: string)` (`500`) and serialized as a bare string, while the spec requires `ModelRef` = `{id, providerID, variant?}` with **`additionalProperties:false`**. Measured with a string: **400 `Expected Model.Ref | null, got "some/string"`**. `[IN-FLIGHT]` `src/cli/bridge.ts:179` is the only caller that passes a model, so today the default `undefined` path is the only one exercised.
- `POST /api/session/{id}/prompt` request per spec: `{id?, prompt: PromptInput, delivery?: "steer"|"queue", resume?}`, `required:["prompt"]`, `additionalProperties:false`. `PromptInput` = `{text (required), files?, agents?}`. `client.ts:555-558` builds `{text, metadata, delivery:'steer'}` when `promptEnvelope === 'flat'` and `{prompt:{text, metadata, delivery:'steer'}}` when `'nested'`. The **flat branch puts `metadata` and `delivery` at the top level of an object whose `additionalProperties` is `false` and whose `prompt` key is required** — a guaranteed 400. The nested branch puts `metadata`/`delivery` *inside* `PromptInput`, which also disallows them. `promptEnvelope` defaults to `'flat'` (`client.ts:462`) and the daemon constructs `ServeClient` **with no options object** (`daemon.ts:317`), so the shipped daemon always takes the 400 branch.
- `GET /api/session` response: `SessionsResponse = {data: SessionV2Info[], cursor: {previous?, next?}}`, `required:["data","cursor"]`. `SessionV2Info` declares `id,parentID,projectID,agent,model,cost,tokens,time,title,…` — **`state` and `outcome` are not in the schema and are not in any of the 47 measured rows.** `sessionState()` (`client.ts:134-140`) therefore returns the literal `'idle'` for every session, on every list, always; and `getSession()` (`585`) hard-codes `outcome: 'unknown'` for every session, always. The comment at `client.ts:129-131` asserting `outcome` was "verified live: succeeded" is **false as measured**.
- `GET /api/session/{id}/context` response per spec: `{data: SessionMessage[]}` where `SessionMessage` is a 9-way `anyOf`. The client's `rowTokens` (`167-203`) looks for a top-level `tokens` on each row, with a legacy `{info,parts}` fallback. **The endpoint returns 500 live, so this shape was never observed on this server.**
- `POST /session/{id}/shell` request per spec: `{messageID?: /^msg/, agent (required), model?: {providerID,modelID} (required both), command (required)}`, `additionalProperties:false`. The client sends exactly `{agent, command}` (`client.ts:792`) with `agent = DEFAULT_SHELL_AGENT = 'build'` (`client.ts:288`). Without `agent`, measured: **400 `{"name":"BadRequest","data":{"message":"Missing key\n at [\"agent\"]","kind":"Payload"}}`**. Note the v1 error envelope is `{name, data:{message, kind?}}`, **not** the v2 `{data}` envelope and **not** `{ok}`.
- `POST /session/{id}/shell` 200 response: `{info: Message, parts: Part[]}`, `required:["info","parts"]`. Measured three times against a real session: `info.role = "assistant"`, `parts[0]` = `{id, sessionID, messageID, type:"tool", callID, tool:"bash", state:{status, input, output, title, metadata, time}}`. **`state` carries no exit code.** `echo hi`, `exit 3`, and `definitely-not-a-binary-xyz` all came back `status: "completed"`; the last was 1 930 B (PowerShell error text). `ToolStateCompleted` in `/doc` = `{status, input, output, title, metadata, time, attachments}` — no `exitCode`; `ToolStateError` = `{status, input, error, metadata, time}` — no `exitCode`. `transfer-encoding: null` and `t_headers == t_end` on all three: **the endpoint completes-then-returns and blocks; it does not stream.**
- `POST /api/session/{id}/agent` 204 per spec, **measured 500**; `POST …/model` 204 per spec, **measured 500**. Both are dispatched by the router (`command-router.ts:558`, `565`) and both fail.
- `GET /api/model` 200 = `{location, data: ModelV2Info[]}`; `ModelV2Info` row keys measured: `id,providerID,family,name,api,capabilities,request,variants,time,cost,status,enabled,limit`, with `limit = {context, input, output}`. The client reads `id`, `name`, `limit.context` (`client.ts:980-986`) and discards `providerID`, `family`, `api`, `capabilities`, `request`, `variants`, `time`, `cost`, `status`, `enabled`, `limit.input`, `limit.output`.
- `GET /api/skill` 200 = `{location, data: SkillV2Info[]}`; row keys measured `name,description,location,content`. The client reads `name`, `description`, `slash` (`client.ts:1005-1008`) and discards `location` and the full `content` body of every installed skill.
- `GET /api/command` 200 = `{location, data: CommandV2Info[]}`; row keys measured `name,template,description`. The client keeps **only** `name` (`client.ts:1055-1056`) and additionally enforces a 64-char cap that the spec does not require.

### The SPA-fallback guard is on exactly one of six `control()` call sites

`spaFallbackContentType(res)` (`client.ts:344-348`) returns the offending content-type when a 2xx declares one and it is not JSON; `''` (no content-type, i.e. a legitimate 204) is deliberately accepted. Derived count of `control(..., guardSpaFallback = true)` call sites with comments stripped: **1** — `toggleSessionSkill` (`client.ts:714-721`, `true` at `720`). `execSessionShell` calls `spaFallbackContentType` directly at `client.ts:820` and re-checks before `res.json()` at `832-841`. The other four (`agent`, `model`, `compact`, `interrupt`, `revert` — five sites) run **unguarded**, which is now harmless for `agent`/`model`/`compact`/`interrupt` because each was measured to answer a real non-2xx, but it is harmless **by accident, not by construction**: an unmeasured verb hitting the fallback would again read `res.ok` as success. The `control()` body reads `res.status !== 204 && !res.ok` (`624`) and then `await res.body?.cancel()` (`637-641`).

### Daemon-side call sites (`src/daemon.ts`)

`client.execSessionShell` `839`; `setSessionAgent` `880`; `setSessionModel` `881`; `toggleSessionSkill` `882-883`; `createSession` `884`; `contextUsage` `885`; `promptSession` `1111`; `compactSession` `1213`; `createSession` `1218`; `listAgents` `1624`; `listSessions` `1628`. The `CommandClient` the router receives is a **wrapper object literal, not the `ServeClient` instance** (`daemon.ts:875-896`) — a deliberate choice, because `{...client}` would copy no prototype methods.

`OpenCodeBridge` (`src/runtime/opencode-bridge.ts:78`) **is** production: constructed at `daemon.ts:319` and used for the agent/skill catalog (`daemon.ts:326-334`). Its own calls: `listAgents:91`, `listCommands:95`, `listSessions:107`, `contextUsage:118`, `listSessionMessages:159`, `setSessionModel:172`, `setSessionAgent:181`, `compactSession:194`, `revertSession:197`, `revertSession:199`, `interruptSession:203`, `listSkills:220`, `listModels:221`.

---

## Plane 3 — the renderer bridge (`apps/desktop/src/bridge/ws.ts`)

| Aspect | Behaviour | Line |
|---|---|---|
| URL | `ws://127.0.0.1:4097/v1/ui` | 5 |
| Subprotocol array sent | `[UI_SUBPROTOCOL, this.opts.token]` — i.e. `['voice-ui.v1', <bearer>]` | 492 |
| Reconnect | `50 · 2^attempt` + `rand()*30`, capped 2500 ms, `setTimeout`, not `setInterval` | `computeBackoff:349-358`, `scheduleReconnect:786-794` |
| Attempt reset | on `onopen` | 495 |
| Terminal states | `disposed` (never reconnect, `dispose():558-582`) and `refused` (bad `hello`/version — **permanent**, `481`) | 436-437 |
| Resume cursor | `?lastSeq=` always sent, floored at `Math.max(0, lastSeq)` so the first connect carries `0` | 490 |
| Ack ledger | `pending: Map<id, {resolve, timer}>`, 5 000 ms timeout, resolve `{ok:false}` on expiry | 463, `521-524` |
| Liveness | `onFrame` fires on **any** inbound byte, before any parsing | 587 |
| Audio | `ArrayBuffer` with `byteLength >= 4 && bytes[0] === 0x01` ⇒ `onAudio(bytes.subarray(3))`; `Blob` fallback re-enters async | 590-601 |
| Uplink pause | `flow` frames and `hello.uplinkPaused` set a latch; `sendPcm` drops while latched | 462, 634, 715, 546-556 |

**Why the bearer travels in a subprotocol.** The code states the constraint in three places: `ws.ts:2-3` ("Browsers cannot set upgrade headers, so the bearer travels as an extra subprotocol token and resume as `?lastSeq=N`"), `492` (the token is pushed as the second protocol string), and the server side `ui-server.ts:456-465` ("Browser WebSocket clients cannot set upgrade headers, so the renderer carries the bearer as an extra subprotocol token instead"). The `WebSocket` constructor's second argument is the subprotocol list; there is no API to set an `Authorization` header on an upgrade, and `fetch` has no `Sec-WebSocket-Protocol` option at all (the same fact is re-measured in `src/diag/bundle.ts:696-703`). The server accepts either shape and compares with `timingSafeEqual` plus a length pre-check (`ui-server.ts:451-465`), and the echoed protocol is always `voice-ui.v1` (`ui-server.ts:509`) — it never echoes the token.

**Auth is enforced pre-upgrade, before any frame is parsed:** `handleUpgrade` checks path, `Sec-WebSocket-Key`, `Sec-WebSocket-Version === '13'` and the `voice-ui.v1` offer first (`ui-server.ts:493-497`, `400` + destroy), then the bearer (`498-502`, `401` + destroy), and only then writes `101` and attaches `socket.on('data', …)` (`534`).

**Resume.** The daemon reads `last-seq` header first, then the `?lastSeq=` query (`ui-server.ts:468-480`), and replays only when `lastSeq >= 0 && lastSeq < this.seq` (`574`). It replays the retained buffer, then the latest `inventory` and `agents` snapshots (`575-584`), then `noticeResumeGap` (`591`). The shell's daemon-restart detector is `hello.seq < this.lastSeq` ⇒ reset cursor + `onGap` (`ws.ts:615-620`). The `uplinkPaused` latch is adopted on **every** connect, not only in that branch (`634`).

**Frame validation at the boundary.** Whole-shape guards, each of which calls `onErrorFrame` and returns without moving the cursor: `isInventoryList:323-334`, `isAgentList:309-320`, `isContextMsg:68-79`, `isFlowMsg:97-104`, `isOutputFrame:211-237`, `isWellFormedHello:337-346`. `ack` (766-779) and `error` (780-783) are read field-by-field with no whole-shape guard; `ack` resolves `{ok: ok !== false}` (775), so **any non-`false` `ok` — including a missing field — is treated as success**.

**`CommandKind` in the renderer is 16 members and matches the wire exactly** (`ws.ts:239-259`): `protocol-only: []`, `renderer-only: []`, both derived by parsing with comments stripped. `CommandMsg` (`ws.ts:261-279`) is a 16-field mirror of `UiCommandSchema` minus `title` and `contextLimit` — so **`sessionContext` cannot carry a `contextLimit` from this renderer**, and `createSession` cannot carry a `title`, even though the protocol allows both.

**The token's origin in the renderer:** `apps/desktop/src/settings/ipc-token.ts:22` calls the Tauri command `ipc_token`. The token is never baked into the bundle.

---

## LSP integration surface

**ABSENT from the product.** Verified by `grep -i '\blsp\b|/lsp|lsp\.status|LSPStatus'` over `src/` and `apps/`: the only matches are `opencode.json:82` (this repo's own dev-session LSP config) and `.mcp.json:37,72`. No `ServeClient` method targets `/lsp`; no `apps/desktop/src` file references it. The live server does expose it — `GET /lsp` → 200 `application/json`, body `[]`, spec `lsp.status` → `LSPStatus[]` — and the **unprefixed** path is the only one; `GET /api/lsp` returns the 2 884-byte HTML fallback. `[IN-FLIGHT]` `src/cli/bridge.ts:117-129` and `src/cli/headless.ts:84,223` and `src/cli/commands.ts:21` add an `lsp` verb to the untracked CLI; none of that is shipped.

## MCP integration surface

**ABSENT from the product, and the code asserts the opposite.** `grep "'/mcp'|\"/mcp\"|\`/mcp|mcp\.status|MCPStatus"` over `src/` returns only two hits, **both inside the untracked `src/cli/`**. Meanwhile `src/runtime/opencode-bridge.ts:71-72` declares `mcpServers: readonly {name, status:'unknown'}[]` and `230-233` returns `mcpServers: []` with the comment **"No MCP health endpoint exists on serve, so this stays empty rather than inventing a status."** That is **false as measured**: `GET /mcp` returns 200 with a real map — `{"context7":{"status":"connected"},"github":{"status":"connected"},"filesystem":{"status":"connected"},"sqlite":{"status":"connected"},"memory":{"status":"connected"},"fetch":{"status":"connected"},"obsidian-vault":{"status":"connected"},"sequential-thinking":{"status":"connected"},…}` — and the spec declares `mcp.status` → `{additionalProperties: MCPStatus}`. So `EnvironmentStatus.mcpServers` is a hard-coded empty array next to a comment that incorrectly rules the data unavailable, and the sibling field `plugins: []` (`opencode-bridge.ts:229`) is the honest one.

---

## Every place a response is read but discarded, or fabricated rather than read

Ordered by severity.

1. **`ServeClient.execSessionShell` — the response is read, but the only verdict the transport supports is discarded.** `normalizeShellResult` (`client.ts:389-446`) reads `info.id`, `part.id`, `part.tool`, `state.status`, `state.output`/`state.error`, `state.time.start`/`end`, and probes `exitCode`/`exit_code`/`code` (`353-359`) — then `readExitCode` returns `null` **every time**, because the live `ToolStateCompleted` has no such field. `deriveShellOutcome` (`protocol.ts:784-792`) therefore returns `'unknown'` for every successful command. This is the correct outcome and it is now surfaced honestly in three places (ack `detail: 'shell-outcome-unknown'` via `command-router.ts:590` and `SHELL_OUTCOME_DETAIL:72-76`; `output.outcome: 'unknown'` via `protocol.ts:982`; notice severity `warn` via `qualifyTaskNotice:626-632`). **The defect is not fabrication here — it is that `state.metadata.output` is never read** even though `client.ts:384-387` documents that `metadata` "holds the same bytes today".
2. **`execSessionShell` drops the `AbortSignal` — the task deadline cannot cancel the HTTP call.** `ShellTaskBridgeOptions.run` is typed `(sessionId, command, signal) => Promise<SessionShellResult>` (`src/daemon/shell-tasks.ts:68`) and the executor passes a real signal (`shell-tasks.ts:199`). The daemon's implementation is `run: (sessionId, command) => client.execSessionShell(sessionId, command)` (`daemon.ts:839`) — **two parameters, signal discarded.** TypeScript accepts it. The only cancellation that exists is `request()`'s own fixed 30 s `AbortController` (`client.ts:489-490`), so a 15-minute `SHELL_TASK_TIMEOUT_MS` (`shell-tasks.ts:64`) is moot for the wire call: the HTTP request dies at 30 s regardless of the task state, and the task record and the frame will report the HTTP abort, not the deadline.
3. **`serve-health.ts` is wired into the daemon, and two file headers say it is not.** `new ServeHealthMonitor({...})` is at `daemon.ts:284-315` and `withServeGate` at `daemon.ts:872-873`. The header of `src/runtime/serve-health.ts:16-17` still says "it is **not wired into the daemon at all yet**", and `apps/desktop/src/serve-health-signal.ts:11-12` repeats the claim. The renderer's recovery arm reads `SERVE_HEALTH_CODES` (`serve-health-signal.ts:80`), which are exactly the three literals the daemon now emits at `daemon.ts:302`, `313`, and `SERVE_NOTICE_RECONNECTING`. **The wiring is live; the two documented statements that it is not are stale.**
4. **`mute`, `deafen`, `arm` fabricate success.** `command-router.ts:677-680` returns `{ ok: true }` with **no dependency call whatsoever** — no state is read, no state is written, and no `deps.*` member is invoked. All three are in the `SERVE_LOCAL_ONLY_COMMANDS` allowlist (`serve-health.ts:262-264`) on the stated grounds that they "return `{ok:true}` with no dependency call at all", so the gate treats the no-op as a genuine local capability. Each is a read-only tier entry (`command-router.ts:292-294`). A `mute` that does not mute is a fabricated outcome in the exact class this audit is chartered to find.
5. **`OpenCodeBridge.runInternalCommand('/model')` fabricates success.** `opencode-bridge.ts:76` lists `model` in `INTERNAL_COMMANDS`; the switch at `192-208` handles `compact`, `undo`, `revert`, `clear`, `interrupt` — and `case 'model': return { ok: true };` at **`201`**, with no client call. The `default` arm throws at `207` "so that 'cannot' is not load-bearing", but `model` never reaches it because it is a real `case`. The other arms return the client's own `{ok:true}` (`194`, `197`, `199`, `203`), so only `model` is fabricated.
6. **`UiServer.dispatchCommand` fabricates a success default.** `ui-server.ts:717-719`: `let outcome: CommandOutcome = { ok: true }` and `outcome = (await this.onCommand?.(cmd)) ?? { ok: true }`. If `onCommand` is `null` (`ui-server.ts:127` default) or a handler returns `void`, the shell receives `ok: true` for a command that was never executed. `onCommand` is assigned at `daemon.ts:872`, so in the shipped daemon this arm is unreachable — but the default is the fabrication, not the assignment.
7. **`OpenCodeBridge.getSessionDetails` writes `effort: null` unconditionally** (`opencode-bridge.ts:140`) against a declared `effort: string | null` field ("Reasoning effort when serve reports one" — `44`). No source reads reasoning effort; the field is a placeholder with a real type.
8. **`EnvironmentStatus.mcpServers` is a hard-coded `[]`** with a factually wrong justification (`opencode-bridge.ts:230-233`), as documented above. `plugins: []` (`229`) is the same shape but the comment there is honest.
9. **`contextUsage` and `getSessionDetails` both swallow their own failure into zeros.** `client.ts:929-938` wraps the `modelForSession` + `listModels` catalog lookup in `catch { known = null }`; `opencode-bridge.ts:117-121` wraps `contextUsage` in `catch { usage = null }` and then `122-124` substitutes `0` for `windowFill`, `messageCount` and `peak`. A 500 from `/api/session/{id}/context` — the **measured** live status — is therefore indistinguishable from a session with an empty window. The `context` frame the shell renders (`daemon.ts:901` → `ui.context`) is never emitted on that path, because `sessionContext` throws first (`command-router.ts:660`).
10. **`listAgents`, `listModels`, `listSkills`, `listCommands`, `modelForSession` all return an empty list on any non-2xx** (`client.ts:850`, `973`, `998`, `1049`, `953`) rather than an error. `opencode-bridge.ts:218-221` then wraps all four in `.catch(() => [])`. A daemon whose serve password is rejected therefore reports "no agents, no models, no skills, no commands" — the same "asserts nothing is missing" class the codebase names elsewhere.
11. **`listSessionMessages` returns `[]` on every failure** (`client.ts:1066-1089`, whole body in `try/catch{return []}`), and `opencode-bridge.ts:158-163` turns that into `lastMessageAt: null` with no error signal.
12. **`serve.pass` and `ipc.token` are read verbatim into the diagnostic collector and then never emitted.** `diag/bundle.ts:864-866` reads `servePassword`, `ipcToken` and `ownerKey` from env or file. `ipcToken` is used only to drive the 4097 handshake probe (`1223`); `servePassword` only for the 4096 probe (`1188`). The emitted bundle carries the **path** at `1466` (`paths.ipcToken`), never the value. Correct, and worth stating because it is the one place in the tree where three live credentials are held in memory together.
13. **`control()` discards the body of every non-guarded verb by design** (`client.ts:637-641`, `res.body?.cancel()`), and the return type is `Promise<void>` — so `setSessionAgent`, `setSessionModel`, `compactSession`, `interruptSession` and `revertSession` all return `{ok:true}` typed objects (`664`, `682`, `722`, `1022`, `1028`, `1040`) that carry **nothing the server said**. This is the same fabrication the `output` frame was built to remove, one layer up: five verbs return a fabricated `ok`.

---

# 09 — Security Architecture & Secret Management

**No key, password or token value appears anywhere in this section.** Only key *names*, *sources* and *derivations* are described.

## Vault implementation and cipher

- Module: `src/voice/vault.ts` (160 lines). On-disk type `VaultBlob` (`vault.ts:15-19`): `{version: 1, updatedAt: string, pools: Record<'groq'|'fish'|'openrouter', {nonce, ciphertext, checksum}>}`. Pool names: `KEY_POOLS = ['groq','fish','openrouter']` (`vault.ts:12`).
- Container: `FileVault` (`vault.ts:117-160`). `load()` (`120-127`) returns `null` when absent and throws `VAULT_CORRUPT` on an unknown `version`. `save()` (`129-149`) writes `<path>.tmp` with `mode: 0o600` then `renameSync` — **the rename replaces the file and therefore replaces its ACL**; the module says so at `141-147`.
- Vault path resolution: `VOXAURA_VAULT_PATH` → `VOXAURA_VAULT_DIR` → `join(cwd,'vault','keyring.dat')` (`daemon.ts:1700-1704`).

### Cipher and parameters, read literally

| Parameter | Value | Line |
|---|---|---|
| Algorithm | **AES-256-GCM** | `vault.ts:87` (encrypt), `103` (decrypt) |
| Key size | 32 bytes | `vault.ts:87` |
| Nonce | 12 random bytes per pool per save, base64 in the blob | `vault.ts:86`, `92` |
| Auth tag | 16 bytes, **prepended** to the ciphertext, whole thing base64 | `vault.ts:90-91`, `101` |
| Checksum | SHA-256 hex over the base64 `ciphertext` string; a mismatch throws `VAULT_CORRUPT` **before** any decryption | `vault.ts:92`, `96-98` |
| Shape check | decrypted JSON must have `keys: string[]`; anything else throws and is re-labelled `VAULT_CORRUPT` | `vault.ts:106-109`, `111-114` |

**The checksum is not an integrity check** — it is a corruption check. It is computed over the *encoded* payload, so an attacker who can write the file can recompute it. Integrity comes from the GCM tag (`setAuthTag`, `vault.ts:104`), which is why a tag failure is also reported as `VAULT_CORRUPT` and never distinguished.

### Key derivation — the KDF and its cost parameters, literally

`appKey()` (`vault.ts:77-79`):

```
scryptSync(machineKey(), 'opencode-voice-runtime:vault:v1', 32)
```

**Cost parameters are NOT specified.** `scryptSync` is called with only three arguments, so Node's defaults apply: `N = 16384`, `r = 8`, `p = 1`, `maxmem = 32 * 1024 * 1024`. The salt is the **hard-coded ASCII string literal** `'opencode-voice-runtime:vault:v1'` — it is not per-installation, not per-pool, and not random. The derived key is 32 bytes. Consequence stated plainly: the KDF stretches only the 32-byte machine key, and the entire security of every provider key rests on the confidentiality of `machine.key`. There is no second factor, no user passphrase, and no per-installation salt.

### The root secret — `machine.key`

`machineKey()` (`vault.ts:45-75`), in precedence order:
1. **`VOXAURA_MACHINE_KEY`** env var, hex-decoded, **must be exactly 32 bytes** or it throws `VAULT_CORRUPT` naming the real problem (`vault.ts:46-58`). Supplied by the Rust supervisor.
2. File `~/.opencode-voice-runtime/machine.key` (`vault.ts:60`). If absent: `randomBytes(32)` (`71`), `mkdirSync` the runtime dir (`72`), `writeFileSync(..., {mode: 0o600})` (`73`). On Windows that mode is `SetFileAttributes` and changes **no** ACL, so `ownerOnlyAclAvailable()` is consulted first and a one-shot `process.emitWarning` is emitted naming the gap (`61-69`).
3. There is **no** third fallback and no error path — the function always returns 32 bytes.

The Node-created file therefore has the inherited profile ACL. The Rust supervisor creates the same file with a real owner-only DACL (§ *Windows ACL*, below), which is why `machineKey()` prefers the env handoff.

## Credential intake path

- **Primary: the renderer's API-keys window.** `apps/desktop/src/components/settings/KeysView.tsx:77-84` sends `{kind:'saveApiKeys', groqKey, fishKey, openrouterKey}` over WS-4097. The command is `read-only` in the tier table (`command-router.ts:318`, the single stated carve-out) and is in the serve-gate allowlist (`serve-health.ts:267`).
- **Router validation:** `command-router.ts:627-634` — refuses unless **all three** of `groqKey`, `fishKey`, `openrouterKey` are present (`629-631`, detail `all 3 keys required`).
- **Protocol bounds:** each key `min(1).max(512)` with control characters refused (`protocol.ts:516-518`) — the comment at `514-515` states the reason: "a key can never be used to forge a log line."
- **Daemon sink:** `saveKeys` wired at `daemon.ts:970-971`, delegating to `writeKeyPools` (`src/voice/key-store.ts:37-45`), which **merges** rather than replaces (`mergeKeyPools:28-35`) so saving one provider never wipes the others.
- **Fallback / first boot:** `FileVault.bootstrapFromEnv` (`vault.ts:152-159`) reads **`GROQ_API_KEYS`**, **`FISH_AUDIO_KEYS`**, **`OPENROUTER_API_KEYS`**, comma-split and trimmed, and is **fail-closed on all three** being non-empty (`157`). Reached only via the `vault bootstrap` CLI branch, which runs before dispatch for `doctor`/`vault`/`live` only, never for `serve`.
- **On-disk effect of a save:** `FileVault.save` (`vault.ts:129-149`) rewrites the whole file via temp + rename, **destroying the DACL**. The renderer immediately re-asks the host to re-lock it: `KeysView.tsx:110` → `restrictVaultFile()` (`apps/desktop/src/settings/vault-dacl.ts:45-70`) → Tauri `restrict_vault_file` → `main.rs:906-924`. Three distinct verdicts are surfaced: `ok` (host returned literal `true`), `unconfirmed` (host ran, did not confirm, keys still on disk), `keyring-lost` (host **failed** — and on that path the Rust command deletes `keyring.dat` at `main.rs:917-919`). `KeysView.tsx:124-133` withdraws the green receipt, wipes the form, and shows a red line at `166-181`. The contract is `raw === true` and nothing softer (`vault-dacl.ts:14-15`, `56-59`).
- **Presence reporting:** `vaultKeyStatus` (`key-store.ts:65-81`) reports **counts only** — "zero material" is in the string at `71` — and names each missing pool individually (`77`).

## Key rotation policy and limits

- `ROTATION_LIMIT = 10` requests per key (`src/voice/keyring.ts:9`).
- `acquire(pool)` (`keyring.ts:75-87`): `slot = Atomics.add(view, 0, 1)` on a per-pool `SharedArrayBuffer` counter (`41-42`), `keyIndex = floor(slot / ROTATION_LIMIT) % list.length` (`79`) — so request #11 deterministically rolls over. A rollover that changes the index pushes a `RolloverInfo{reason:'count-exhausted'}` and **zeroes the cached buffer** (`82`).
- `release(key, ok, status)` (`89-94`): zeroes the returned copy (`90`); advances the pool **only** on `429 | 401 | 403` (`91-93`). Unrecognised failures do not rotate, by design (`137`).
- `forceAdvance` (`97-108`): `Atomics.store` to the next 10-boundary (`103`), zeroes the cache, records `rate-limited` / `auth-failed` / `manual`.
- `withKey` (`138-166`): the single provider-call wrapper; on failure it releases with `httpStatusOf(err)` (`150`) and, if the rollover actually moved to a *different* key (`entry.from !== entry.to`, `161`), stamps a **non-enumerable** symbol `ADVANCED` (`162`, symbol at `169`) so the marker never reaches JSON. `keyAdvanced(err)` (`176-178`) reads it.
- **Caching:** `poolMaterial` (`61-73`) keeps one `Buffer` per pool in `this.cached` and returns a **copy** per acquire (`72`). `destroy()` (`115-118`) zeroes and clears the cache.
- **Fish credit faults do NOT rotate the pool.** `src/voice/tts.ts:638-639` computes `credit = status === 402 || status === 429` and passes it as the `ok` argument, so `release(key, true, 402)` never advances. A typed `FishCreditError` (`tts.ts:364-384`, thrown at `648`) carries `isCreditFault` (`374-376`) and `remediation` (`379-383`).
- **Lifetime exposure:** `poolMaterial` caches per-pool `Buffer`s for the process's life and `destroy()` is called only on the `cli live` shutdown path. `grep -n 'destroy\(\)' src/` finds no daemon-side call — the steady-state heap therefore holds up to three decrypted provider keys until the process exits.

## Every redaction / sanitization boundary

| # | Boundary | Mechanism | Location |
|---|---|---|---|
| 1 | **Notice frame sink** — the single sink for every provider error reaching the screen | `redactString(detail)` inside `NoticeFrameSchema.parse` | `src/ipc/ui-server.ts:343` |
| 2 | **Voice transcript frame** (user's own speech, so a spoken key is masked fail-closed) | `redactString(transcript)` inside the conditional spread, before parse | `ui-server.ts:357` |
| 3 | **`ack.detail`** | `redactString(outcome.detail)` at the sink; `detail` is an open `string`, not a code union, and the catch at `721` forwards a raw `err.message` | `ui-server.ts:721`, `732` |
| 4 | **`output` frame** — explicitly **not** redacted | closed-union literals only; `publishFault` writes `errorCodeFor(err)`, never `err.message` | `src/daemon/shell-tasks.ts:293-303` |
| 5 | **`event` / `inventory` / `agents` / `context` / `flow`** — not redacted | no sink; carries locally generated ids and numbers | `ui-server.ts:233-280`, `368-407` |
| 6 | **Telemetry rows** | `redactObject({timestamp, seq, ...parsed})` **before** `JSON.stringify`; the schema has no free-text field and every enum is closed | `src/telemetry/writer.ts:126-130`; schema `73-83` |
| 7 | **JSON-lines logger** | `redactSecrets(args)` on **every** argument and `redactObject(bindings)` on the bindings, before render | `src/common/logger.ts:293`, `297` |
| 8 | **Fish error bodies** | `fishErrorDetail` reads the body **only** for HTTP 422 and only the `{loc,type,msg}` array; everything else returns `null` so account metadata cannot be echoed | `src/voice/tts.ts:426-434` |
| 9 | **Fish 401/403** | message interpolates the **status number only**; the response body is never read | `tts.ts:388-396` |
| 10 | **`daemon.owner` publish failure** to stderr | `err instanceof Error ? redactString(err.message) : redactSecrets(err)` — non-Error goes through the fail-closed deep scrubber | `src/daemon.ts:390` |
| 11 | **Diagnostic bundle — per-line** | `scrubLogLine`: `redactString` → case-insensitive sweep → control-byte replace → length cap → residual check; a line that cannot be proven safe is replaced with `[REDACTION-REFUSED]` and the rest of the bundle is still emitted | `src/diag/bundle.ts:479-492`, marker at `488-490` |
| 12 | **Diagnostic bundle — case-insensitive sweep** | the shared patterns carry no `i` flag, so `SK-OR-V1-…` would survive; three `/gi` patterns close that | `bundle.ts:445-451` |
| 13 | **Diagnostic bundle — key fingerprints** | key material is a function **parameter** to `fingerprintsOf`, never a field on any object handed to `JSON.stringify`; only `sha256:<10 hex>` escapes, and a secret under the entropy floor is not fingerprinted at all | `bundle.ts:505-521`, floor at `512-515` |
| 14 | **Diagnostic bundle — whole-artifact tripwire** | `hasResidualMaterial` + `ASSIGNMENT_SCAN`; deliberately **not** `containsSecret`, because `containsSecret('apiKey=[REDACTED]')` is `true` and would make the assertion unsatisfiable | `bundle.ts:525-559` |
| 15 | **Diagnostic bundle — serve password** | read from `OPENCODE_SERVER_PASSWORD` or `serve.pass`, used **only** to probe 4096; the value is never serialised | `bundle.ts:864`, `1188` |
| 16 | **Diagnostic bundle — IPC token** | read from `VOICE_RUNTIME_IPC_TOKEN` or `ipc.token`, used **only** to drive the 4097 handshake probe; only the **path** is emitted | `bundle.ts:865`, `1223`, `1466` |
| 17 | **`error` frames** | fixed literals only (`audio frame too large`, `invalid JSON`, `unknown command`) | `ui-server.ts:689`, `703`, `708` |
| 18 | **`orchestrator` error sink** | `errorCodeFor(err)` derives the user-visible code from the typed `stopReason` field, never from message prose; `OrchestratorError.secretSafeMessage` is the only string allowed to reach logs/ledger/UI | `src/common/errors.ts:121-125`, `130`, `146-153` |
| 19 | **Shell payload refusal messages** | `shellCommandError` and `filePathError` return a **fixed literal** and never echo the offending command or path | `command-router.ts:443-449`, `466-472` |

**Shared redactor** (`src/common/logger.ts`): `REDACTION_MARKER = '[REDACTED]'` (`30`); `LIVE_PREFIXES = ['sk-or-v1-','sk-fish-','gsk_']` (`39`); `SECRET_PATTERNS` (`60-67`) = `sk-or-v1-…{8,}`, `sk-fish-…{8,}`, `gsk_…{8,}`, a generic `sk-` fallback **with a negative lookahead** so it is independent of the specific three (`64`), plus `Bearer\s+…{4,}` and `Basic\s+…{8,}` (`65-66`); `SECRET_ASSIGNMENT` (`99-100`) matches `password|passwd|pwd|secret|token|api[-_]?key|apikey|authorization|auth` and uses the escaped-quote-aware quoted-value class `"(?:[^"\\]|\\.)*"`; walk bounds `MAX_DEPTH = 8`, `MAX_NODES = 1000` (`103-104`), cycles → `[CIRCULAR]`, over-budget → `[TRUNCATED]`. The logger writes to **stderr**, never stdout (`287`).

**Case-sensitivity is a real, documented gap at boundaries 1/2/3/6/7/10:** `SECRET_PATTERNS` (`60-64`) carry no `i` flag, so an upper-cased key survives the shared redactor. Only the diagnostic bundle (boundary 12) closes it. Every other sink inherits the gap.

## Bearer-token generation, both sides

**Node side — WS-4097 token.** `ensureIpcToken` (`src/daemon.ts:1724-1738`): if the file exists and is non-empty, return it (`1725-1728`); otherwise `randomBytes(32).toString('hex')` (`1729`) — 32 bytes from `node:crypto`, CSPRNG, **64 hex chars**, no fallback path — `mkdirSync` the runtime dir (`1730`), `writeFileSync(path, token, {mode: 0o600})` (`1731`), best-effort `chmodSync(0o600)` (`1732-1736`). Precedence: `ipcTokenFromEnv()` reads `VOICE_RUNTIME_IPC_TOKEN` or `''` (`1711-1713`), and the CLI composes `ipcTokenFromEnv() || ensureIpcToken()` (`src/cli.ts:205`). **Fail-closed:** an empty token throws in the `UiServer` constructor (`ui-server.ts:160-162`) and `startDaemon` refuses without one (`daemon.ts:260-262`).

**Rust side — every secret.** `SECRET_BYTES` CSPRNG at `main.rs:594-598`: `getrandom::fill(&mut buf)` (kernel `RtlGenRandom`/`BCryptGenRandom`), **returning `Err` rather than degrading** — `generate_secret()` (`601-604`) has no fallback. The replaced generator was an xorshift64\* seeded from `SystemTime::now().as_nanos() as u64 ^ process::id() as u64` (`main.rs:580-589`), i.e. ~2^30 effective bits, which is the defect the current code exists to close.

| Secret | Bytes | Created by | Locked by |
|---|---|---|---|
| `ipc.token` | `SECRET_BYTES`, lower-case hex | `ensure_ipc_token` `main.rs:926-…` → `write_protected_secret(&path, &token, "ipc.token")` `main.rs:942` | `write_protected_secret:619-631` |
| `serve.pass` | as above | `main.rs:972` `write_protected_secret(&path, &password, "serve.pass")` | same |
| `owner.key` | as above | `main.rs:1043` `write_protected_secret(&path, &key, "owner.key")` | same |
| `daemon.owner` | empty marker (created empty) | `main.rs:1049` `write_protected_secret(&marker, "", "daemon.owner")` | same |
| `machine.key` | **32 raw bytes** (hex only for the env handoff) | `ensure_machine_key` `main.rs:856-887`; create `880-886`, **adopt** `862-869` | `restrict_to_owner` on **both** paths (`864`, `882`) |
| `keyring.dat` | (not a secret of its own) | Node's `FileVault.save` | `restrict_to_owner` at resolve (`main.rs:917`, `1374`) and on demand (`restrict_vault_file`, `906-924`) |

`write_protected_secret` (`main.rs:619-631`) writes the bytes **first**, then applies the DACL, and on DACL failure **deletes the file and returns `Err`** — because the next launch's read-fast-path would otherwise adopt a weakly-permissioned file as permanent (`624-628`). A wrong-length `machine.key` is removed and reported rather than adopted (`main.rs:870-877`).

## Windows ACL code in `apps/desktop/src-tauri/src/main.rs` (3 093 lines)

| Range | Content |
|---|---|
| `main.rs:661-813` | `restrict_to_owner` (the `#[cfg(windows)]` arm) — the real implementation |
| `main.rs:664-672` | the Win32 imports: `GetLastError`, `LocalFree`, `GENERIC_ALL`; `SetEntriesInAclW`, `SetNamedSecurityInfoW`, `EXPLICIT_ACCESS_W`, `SE_FILE_OBJECT`, `SET_ACCESS`, `TRUSTEE_W`, `TRUSTEE_IS_SID`, `TRUSTEE_IS_USER`, `TRUSTEE_IS_WELL_KNOWN_GROUP`; `CreateWellKnownSid`, `DACL_SECURITY_INFORMATION`, `GetFileSecurityW`, `WinLocalSystemSid`, `NO_INHERITANCE`, `OWNER_SECURITY_INFORMATION`, **`PROTECTED_DACL_SECURITY_INFORMATION`** |
| `main.rs:696-699` | owner SID read back from the file's own descriptor via `GetFileSecurityW(OWNER_SECURITY_INFORMATION)` — deliberately **not** `OpenProcessToken`+`GetTokenInformation(TokenUser)`, which returns `ERROR_NOT_ENOUGH_MEMORY` (998) on this host (`690-695`) |
| `main.rs:762-786` | two `EXPLICIT_ACCESS_W` entries: the **user** SID with `GENERIC_ALL` / `SET_ACCESS` / `TRUSTEE_IS_USER`, and **LocalSystem** (`TRUSTEE_IS_WELL_KNOWN_GROUP`) so system maintenance is not locked out (`657-660`) |
| `main.rs:800-813` | `SetNamedSecurityInfoW(SE_FILE_OBJECT, DACL_SECURITY_INFORMATION \| PROTECTED_DACL_SECURITY_INFORMATION, …)`; a non-zero return code becomes `Err("acl: SetNamedSecurityInfoW failed (…)")` |
| `main.rs:819-823` | the `#[cfg(not(windows))]` arm: `fs::set_permissions(path, Permissions::from_mode(0o600))` |
| `main.rs:635-641` | why `set_permissions(0o600)` is **not** the answer on Windows: it is `SetFileAttributes`, toggles only `FILE_ATTRIBUTE_READONLY`, returns `Ok(())`, and changes no access control |
| `main.rs:643-655` | the three properties that make it a real `0600`: NULL `oldacl` in `SetEntriesInAclW`; `PROTECTED_DACL_SECURITY_INFORMATION` (blocks parent inheritance); `GENERIC_ALL` mask |
| `main.rs:906-924` | `#[tauri::command] restrict_vault_file` — re-locks `keyring.dat`; non-Windows returns `Ok(false)`; a DACL failure **deletes the file** and returns `Err` |
| `main.rs:2779-2831` | test-only: `icacls /reset` staging so the **adopt** path can be exercised in isolation (`2858-2881`) |
| `main.rs:2577-2615`, `2739-2749`, `3239-3250` | source-level guards asserting the CSPRNG, `restrict_to_owner`, `SetNamedSecurityInfoW`+`PROTECTED_DACL_SECURITY_INFORMATION` are present and `fs::set_permissions` is **not** reintroduced as the vault's protection |
| `main.rs:3259-3263` | `tauri::generate_handler![ipc_token, ensure_all_services, restrict_vault_file]` — **3 registered commands.** Verified by reading the list; there is no `shutdown_all_services` entry, and `grep "invoke\(" apps/desktop/src` finds only `restrict_vault_file` (`settings/vault-dacl.ts:55`), `ensure_all_services` (`settings/services.ts:44`) and `ipc_token` (`settings/ipc-token.ts:22`) |
| `main.rs:1434` | serve is spawned with `--hostname 127.0.0.1`; every `TcpListener::bind` in the file uses `127.0.0.1` and `grep -c '0\.0\.0\.0' main.rs` = **0** |

**The Node-side ACL position, measured and reported rather than faked.** `src/voice/win-acl.ts` (76 lines) is deliberately near-empty. `ownerOnlyAclAvailable()` (`win-acl.ts:56-65`) returns `{supported:false}` on `win32` and `{supported:true}` on POSIX. The recorded reason (`win-acl.ts:14-23`): `icacls <file> /inheritance:r /grant:r <user>:(F)` **reports "Successfully processed 1 files"** and then produces a file the named account cannot read (`EPERM`), because `icacls` grants a **name** and cannot name the **owner SID**, so it replaces the implicit owner access. `icaclsAvailable()` (`68-76`) is not on the product path. The module is consumed at exactly one place, `vault.ts:61-69`, to emit one `VoxauraVault` warning per process. **Net effect:** under the Rust supervisor, all five secret files get a real owner-only DACL on create **and** adopt, and `keyring.dat` is re-locked after every save. A daemon run outside the supervisor (a bare `node dist/cli.js serve`) creates `machine.key` and `keyring.dat` with the inherited profile ACL and says so once.

## Trust boundaries

**1. Webview ⇄ Rust supervisor (Tauri invoke).** Capability surface is window/webview only: `apps/desktop/src-tauri/capabilities/default.json:6-12` grants exactly `core:window:allow-get-all-windows`, `allow-create`, `allow-set-focus`, `allow-close`, `core:webview:allow-create-webview-window` for windows `main`, `settings`, `api-keys`. **No filesystem, shell, http or process plugin is exposed** (asserted in the file's own `description`, `4`). CSP (`tauri.conf.json` `app.security.csp`): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:4097; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` — `connect-src` admits exactly the UI bridge and nothing else. The webview obtains the bearer only by asking the host (`ipc_token`, fail-closed on empty) and never reads a file.

**2. Webview ⇄ daemon (WS-4097, Plane 1).** The renderer holds three things: the bearer, microphone audio, and command authority. It is bounded by `.strict()` `UiCommandSchema` (18 fields, 16 kinds), the 64 KiB binary cap, the 1 MiB assembled-message cap, `MAX_CONNECTIONS = 8`, and the 5 s ack timeout. Two structural weaknesses: `ack.ok` is trusted as `ok !== false` on the renderer side (`ws.ts:775`), so a malformed or absent `ok` reads as success; and the renderer can send `groqKey`/`fishKey`/`openrouterKey` over the same socket that carries audio, which is why those three fields carry the control-character refusal (`protocol.ts:514-518`).

**3. Daemon ⇄ `opencode serve` (Plane 2).** Daemon → serve is HTTP Basic, one shared `serve.pass` value, loopback-only, with a 30 s per-request abort. **serve → daemon has no authenticated inbound path** in this design: the daemon is a client of 4096, never a server on it. The measured finding that matters for this boundary is that the boundary is currently **leaky in the integrity direction**: three of the daemon's verbs (`promptSession`, `setSessionAgent`/`setSessionModel`, `contextUsage`, `revertSession`/`stage`) were measured to fail against the real server, and one verb (`toggleSessionSkill`) targets a path the server does not have. A boundary that is drawn but not connected is the same defect class as a boundary that is not drawn.

**4. Supervisor ⇄ child processes.** `ipc.token` and `machine.key` cross into the Node child as environment variables (`VOICE_RUNTIME_IPC_TOKEN` at `main.rs:927`, `VOXAURA_MACHINE_KEY` consumed at `vault.ts:46`). Both are therefore visible in the child process's environment block to any process that can read it. Both are generated by the CSPRNG path with no fallback and both are DACL-protected at rest; neither is protected in transit into the child, and the mitigation is that the child is the same user's process.

**5. Daemon ⇄ providers (Groq STT, Fish TTS, OpenRouter brain/intake/planner/narrator).** Outbound HTTPS, keys supplied per-call from the keyring and zeroed on release (`keyring.ts:90`), never persisted in the clear. The telemetry channel carries closed enums only (`telemetry/writer.ts:9-71`) and is structurally redacted before serialisation (`126-130`).
