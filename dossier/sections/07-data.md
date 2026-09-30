# 07 — DATA STRUCTURES, SCHEMAS & STATE REGISTRY

Audit target: `O:\opencode-Vantrilex` @ `9f41c96eb716985a12b7a6b8c235b5acad42f6b8`
(`release: v0.8.2 — record the verified artefact and the release's real numbers`).

**Zero-trust posture.** No file under `docs/`, no `README.md`, `README.ar.md`,
`CHANGELOG.md`, `AGENTS.md`, `CONTRIBUTING.md`, no `dossier/PROJECT_MASTER_DOSSIER.md`,
and **no source comment** was used as evidence. Where a code comment makes a
claim, this section reports what the CODE does; where the code contradicts the
comment, that is stated. Every figure below was derived by a script written to
`%LOCALAPPDATA%\Temp\opencode\` and is re-runnable.

**In-flight additions.** `src/cli/` is untracked and under active write by another
process; `src/cli.ts` is ` M` (modified, unstaged) in `git status --short`. Nothing
in `src/cli/` is counted as shipped and nothing in it is treated as absent either
where it declares a wire-relevant type. It is labelled `[IN-FLIGHT]` throughout.

---

## 0. SCOPE ESTABLISHMENT

### 0.1 Non-source files that exist and are excluded

| Claim | Command | Result |
|---|---|---|
| No SQL database anywhere | `Get-ChildItem -Recurse -File -Include go.mod,pyproject.toml,Cargo.toml,*.db,*.sqlite,*.sqlite3` filtered on `node_modules\|.venv\|\\target\\\|sidecar` | exactly one hit: `apps/desktop/src-tauri/Cargo.toml` — **a Rust manifest, not a database** |
| No Go module | same command, `go.mod` | 0 hits |
| No Python project manifest at root | same command, `pyproject.toml` | 0 hits |
| No root `Cargo.toml` | `Get-ChildItem -File` (root listing) | absent; the only manifest is `apps/desktop/src-tauri/Cargo.toml` |

**There is no relational database, no ORM, no migration directory, and no query
language in this repository.** Persistence is exclusively files (§3) and
process memory. Verified by the command above plus
`Get-ChildItem -Recurse -File -Include *.db,*.sqlite,*.sqlite3` returning zero
rows under the same filter.

### 0.2 The `.py` population — briefing claim is FALSE

The briefing stated "12,338 `.py` files exist and ALL are inside `.venv`".
The file wins.

```
Get-ChildItem -Recurse -File -Filter *.py | Measure-Object            -> 12339
Get-ChildItem -Recurse -File -Filter *.py |
  Where-Object { $_.FullName -notmatch '\\\.venv\\' }                -> 21 files
```

| Count | Location | Project code? |
|---|---|---|
| 16 | `ml/*.py` and `ml/data/*.py` — `bench_onnx.py`, `diagnose_shortcut.py`, `eval_adversarial.py`, `eval_onnx.py`, `export_onnx.py`, `finalize_l2.py`, `gen_tokenizer_golden.py`, `head_metrics.py`, `latency_compare.py`, `laya_hub.py`, `negation_probe.py`, `score_probe.py`, `stress_battery.py`, `train_laya.py`, `verify_g1.py`, `verify_g2.py`, `data/generate_synth.py`, `data/harvest_joda.py` | **yes — 18 files of first-party ML tooling** |
| 3 | `.hf_cache/` — HuggingFace dataset/module caches | no — third-party cache |
| 1 | `node_modules/flatted/python/flatted.py` | no — vendored dependency |
| 12,318 | `.venv/**` | no |

`pyrightconfig.json` exists at the root, which is consistent with the `ml/`
tree being real project code and not vendoring. **`ml/` is excluded from this
section's schema inventory only because it contains no TypeScript/zod schema and
no IPC wire type**; it is not "not project code".

### 0.3 Source-file census (contradicts the briefing)

```
Get-ChildItem -Recurse -File -Path src | Group-Object Extension   ->  162 .ts, 1 .json
git ls-files src                                                 ->  156 tracked paths
git ls-files apps                                                ->  175 tracked paths
git ls-files scripts                                             ->  11 tracked paths
```

The briefing's "279 project source files: `src` 157, `apps` 110, `scripts` 10"
does not reconcile with the tree under any filter I could construct. Tracked
counts are 156 / 175 / 11. The physical `.ts`-only count under `src/` is 162 at
first scan and **168 by the end of this audit** — `src/cli/` is growing while I
work. `apps/desktop/src` holds 83 `.ts`+`.tsx` files. Tracked-only sums to 342;
physical `src/*.ts` + `apps/desktop/src/*.ts,tsx` sums to 245–251 depending on
when it is sampled.

**The briefing's own parts do not sum to its own total:** `157 + 110 + 10 = 277`,
not 279. The figure is internally inconsistent before any filter is applied.

---

## 1. ZOD SCHEMAS — EXHAUSTIVE VERBATIM

`zod` is imported by **7 production files** (all others are `node_modules`,
`src-tauri/sidecar/dist/**` build artefacts, or `src-tauri/target/**`):

```
Select-String -Pattern "from 'zod'" -Path src,apps/desktop/src -Include *.ts,*.tsx
  src/common/config.ts:1        src/ipc/protocol.ts:1
  src/diag/bundle.ts:7         src/orchestrator/coordinator.ts:1
  src/orchestrator/permission.ts:1
  src/telemetry/writer.ts:2    src/voice/brain.ts:1
```

**Total zod schema constants: 28** (15 in `protocol.ts`, 6 in `writer.ts`, 3 in
`coordinator.ts`, 1 each in `permission.ts`, `config.ts`, `brain.ts`, `bundle.ts`).
**Total `.refine()` call sites: 7** (all in `protocol.ts`). **Total
`.superRefine()` call sites: 0** — verified by script across all 250 `.ts`/`.tsx`
files under `src/` and `apps/desktop/src/`.

### 1.1 `src/ipc/protocol.ts` — 15 schemas, verbatim

#### `HelloFrameSchema` — `protocol.ts:413-444`

```ts
export const HelloFrameSchema = z.object({
  type: z.literal('hello'),
  contractVersion: z.string().min(1),
  nodePid: z.number().int().positive(),
  servePort: z.literal(SERVE_PORT),          // SERVE_PORT = 4096, protocol.ts:10
  layaReady: z.boolean(),
  seq: z.number().int().nonnegative(),
  persona: z.enum(['kareem', 'nour']).optional(),
  uplinkPaused: z.boolean(),                 // REQUIRED on the wire
});
```

`.refine()`: none. **Enforced**: `HelloFrameSchema.parse({…})` at
`src/ipc/ui-server.ts:538`. `layaReady` is hardcoded `false` at `ui-server.ts:551`.

#### `UiEventSchema` — `protocol.ts:447-452`

```ts
export const UiEventSchema = z.object({
  type: z.literal('event'),
  seq: z.number().int().nonnegative(),
  eventId: z.string().min(1),
  state: z.string().min(1),
});
```

`.refine()`: none.
**FINDING — the schema is defined and never parsed.** `UiServer.broadcast`
(`ui-server.ts:233-242`) constructs the frame as a plain object literal and
`JSON.stringify`s it:

```ts
broadcast(input: Omit<UiEvent, 'type' | 'seq'> & { type?: 'event' }): UiEvent {
  this.seq += 1;
  const frame: UiEvent = { type: 'event', seq: this.seq, eventId: input.eventId, state: input.state };
  this.retainForResume(frame);
  const wire = encodeTextFrame(JSON.stringify(frame));
```

The only references to `UiEventSchema` outside its own definition are
`src/ipc/index.ts:24` (barrel re-export) and `protocol.ts:453` (`z.infer`).
A negative `seq` or an empty `eventId` reaching `broadcast` would be serialised
onto the wire unchecked.

#### `UiCommandSchema` — `protocol.ts:469-543` (the trust boundary)

```ts
export const UiCommandSchema = z
  .object({
    id: z.string().min(1).max(128).refine((v) => !CONTROL_CHARS_RE.test(v), 'control characters'),
    kind: z.enum([
      'abort', 'stopSpeech', 'playbackStarted', 'mute', 'deafen', 'arm',
      'setPersona', 'switchSession', 'setSessionAgent', 'setSessionModel',
      'toggleSessionSkill', 'execSessionShell', 'saveApiKeys', 'confirm',
      'sessionContext', 'createSession',
    ]),
    persona: z.enum(['kareem', 'nour']).optional(),
    minutes: z.number().int().positive().max(1440).optional(),
    sessionId: z.string().regex(/^ses_[A-Za-z0-9_-]{1,120}$/, 'session id must be an opaque ses_ token').optional(),
    agent: z.string().min(1).max(64).regex(IDENT_RE, 'invalid agent').optional(),
    model: z.string().min(1).max(128).regex(IDENT_RE, 'invalid model').optional(),
    skill: z.string().min(1).max(128).regex(IDENT_RE, 'invalid skill').optional(),
    skillAction: z.enum(['attach', 'detach']).optional(),
    command: z.string().min(1).max(512).optional(),
    groqKey: z.string().min(1).max(512).refine((v) => !CONTROL_CHARS_RE.test(v), 'control characters').optional(),
    fishKey: z.string().min(1).max(512).refine((v) => !CONTROL_CHARS_RE.test(v), 'control characters').optional(),
    openrouterKey: z.string().min(1).max(512).refine((v) => !CONTROL_CHARS_RE.test(v), 'control characters').optional(),
    confirmId: z.string().min(1).max(128).refine((v) => !CONTROL_CHARS_RE.test(v), 'control characters').optional(),
    approve: z.boolean().optional(),
    playbackId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]{1,64}$/, 'invalid playback id').optional(),
    title: z.string().min(1).max(200).optional(),
    contextLimit: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict();
```

Supporting constants, verbatim (`protocol.ts:465-467`):

```ts
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;
const IDENT_RE = /^[A-Za-z0-9._:/-]+$/;
```

**All 7 `.refine()` predicates in the tree are here or in `OutputFrameSchema`.**
Each predicate is literally `!CONTROL_CHARS_RE.test(v)` except the byte-length one
in §1.2. `.strict()` is present, so unknown keys are rejected.

**Enforcement: real.** `UiCommandSchema.safeParse(parsed)` at
`src/ipc/ui-server.ts:706`, on the single inbound path. This is the only inbound
frame in the system that is validated at all.

**FINDING — two accepted fields the renderer can never send.** `title`
(`protocol.ts:540`) and `contextLimit` (`protocol.ts:541`) exist in the schema.
Verified by script over `apps/desktop/src/**` and `apps/desktop/e2e/**`: **zero**
non-test sites write a `title` or `contextLimit` property onto a `CommandMsg`.
Consequences, both read from the router's `execute`:

- `createSession` (`command-router.ts:670-676`) ignores `cmd.title` entirely and
  calls `deps.client.createSession(deps.projectDirectory())` — the schema's
  `title` field is dead on arrival, and `createSession` has no directory input
  at all in the live path.
- `sessionContext` (`command-router.ts:660`) passes `cmd.contextLimit`, which is
  therefore always `undefined`, so `ContextUsage.limit` is whatever serve reports
  with no client override.

#### `AckFrameSchema` — `protocol.ts:546-551`

```ts
export const AckFrameSchema = z.object({
  type: z.literal(ACK_KIND),        // ACK_KIND = 'ack', protocol.ts:31
  id: z.string().min(1),
  ok: z.boolean(),
  detail: z.string().optional(),
});
```

**FINDING — defined, exported, and NEVER PARSED.** `UiServer.dispatchCommand`
(`ui-server.ts:716-735`) builds the ack inline:

```ts
const ack = { type: ACK_KIND, id: cmd.id, ok: outcome.ok,
  ...(outcome.detail !== undefined ? { detail: redactString(outcome.detail) } : {}) };
safeWrite(conn, this.conns, encodeTextFrame(JSON.stringify(ack)));
```

The only other reference to the symbol is `src/ipc/index.ts:13`. No
`AckFrameSchema.parse` / `.safeParse` exists anywhere in the tree (verified by
script across `src/` and `apps/desktop/src/`). `id` carries no control-character
refusal on this frame even though the same value arriving as a *command* is
refused one at `protocol.ts:471`.

#### `InventorySessionSchema` — `protocol.ts:556-559`, `InventoryFrameSchema` — `protocol.ts:571-584`

```ts
export const INVENTORY_MAX_SESSIONS = 200;                       // protocol.ts:569

export const InventorySessionSchema = z.object({
  sessionId: z.string().min(1),
  state: z.string().min(1),
});

export const InventoryFrameSchema = z.object({
  type: z.literal('inventory'),
  seq: z.number().int().nonnegative(),
  sessions: z.array(InventorySessionSchema).max(INVENTORY_MAX_SESSIONS),
  totalSessions: z.number().int().nonnegative().optional(),
});
```

`.refine()`: none; the cap is `.max()` inside the array.
**Enforced**: `InventoryFrameSchema.parse` inside `buildInventoryFrame`
(`protocol.ts:603`), called from `UiServer.publishInventory` (`ui-server.ts:250`).
Truncation is producer-side `slice(0, 200)` at `protocol.ts:602`, and
`totalSessions` is emitted only when truncated (`protocol.ts:601`, `:607`).

#### `AgentEntrySchema` — `protocol.ts:612-615`, `AgentFrameSchema` — `protocol.ts:617-620`

```ts
export const AgentEntrySchema = z.object({ id: z.string().min(1), name: z.string().min(1) });
export const AgentFrameSchema = z.object({
  type: z.literal('agents'),
  seq: z.number().int().nonnegative(),
  agents: z.array(AgentEntrySchema),          // NO .max() — unbounded
});
```

**FINDING — `AgentFrameSchema.agents` has no length cap**, unlike the sibling
`InventoryFrameSchema.sessions` which has `.max(200)`. `buildAgentFrame`
(`protocol.ts:626`) copies the whole array. `agents` is populated from
`deps.agents()`; the producer's own bound is not in this file. Provenance for
the asymmetry is absent from the code (only `protocol.ts:561-568` justifies the
inventory cap).

#### `NoticeFrameSchema` — `protocol.ts:631-639`, `NoticeFrame` type at `:640`

```ts
export const NoticeFrameSchema = z.object({
  type: z.literal('notice'),
  seq: z.number().int().nonnegative(),
  code: z.string().min(1),
  detail: z.string().min(1),                    // Arabic, human-readable
  level: z.enum(['info', 'warn', 'error']),
});
```

**Enforced**: `NoticeFrameSchema.parse` at `ui-server.ts:343`, with
`redactString(detail)` applied to the value *before* the parse.

#### `VoicePhaseSchema` — `protocol.ts:643`, `VoiceFrameSchema` — `protocol.ts:646-652`

```ts
export const VoicePhaseSchema = z.enum(['idle', 'listening', 'thinking', 'speaking']);
export const VoiceFrameSchema = z.object({
  type: z.literal('voice'),
  seq: z.number().int().nonnegative(),
  phase: VoicePhaseSchema,
  transcript: z.string().optional(),
});
```

**Enforced**: `VoiceFrameSchema.parse` at `ui-server.ts:357`.

#### `ContextFrameSchema` — `protocol.ts:657-668`

```ts
export const ContextFrameSchema = z.object({
  type: z.literal('context'),
  seq: z.number().int().nonnegative(),
  sessionId: z.string().regex(/^ses_[A-Za-z0-9_-]{1,120}$/),
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive().nullable(),
  percent: z.number().min(0).max(100).nullable(),
  messageCount: z.number().int().nonnegative(),
});
```

**Enforced**: `ContextFrameSchema.parse` at `ui-server.ts:376`.

#### `FlowFrameSchema` — `protocol.ts:683-687`

```ts
export const FlowFrameSchema = z.object({
  type: z.literal('flow'),
  seq: z.number().int().nonnegative(),
  state: z.enum(['pause', 'resume']),
});
```

**Enforced**: `FlowFrameSchema.parse` at `ui-server.ts:406`.

#### `ShellOutputStatusSchema` — `protocol.ts:767`, `ShellOutputOutcomeSchema` — `protocol.ts:777`

```ts
export const ShellOutputStatusSchema = z.enum(['completed', 'error', 'pending', 'running', 'unknown']);
export const ShellOutputOutcomeSchema = z.enum(['ok', 'failed', 'unknown']);
```

Derivation, verbatim (`protocol.ts:784-792`):

```ts
export function deriveShellOutcome(
  status: z.infer<typeof ShellOutputStatusSchema>,
  exitCode: number | null,
): z.infer<typeof ShellOutputOutcomeSchema> {
  if (status === 'error') return 'failed';
  if (exitCode !== null) return exitCode === 0 ? 'ok' : 'failed';
  return 'unknown';
}
```

`ShellOutputStatus` / `ShellOutcome` are **duplicated verbatim** as plain TS
unions at `src/runtime/client.ts:291` and `:297`, and a third time in the
renderer at `apps/desktop/src/bridge/ws.ts:172-173`. Three declarations, no
shared import.

#### `OutputFrameSchema` — `protocol.ts:908-941`

```ts
export const MAX_OUTPUT_TEXT_BYTES = 32 * 1024;          // protocol.ts:751
export const OUTPUT_MAX_COMMAND_CHARS = 512;             // protocol.ts:753
export const OUTPUT_MAX_COMMAND_ID_CHARS = 128;         // protocol.ts:755

export const OutputFrameSchema = z.object({
  type: z.literal(OUTPUT_KIND),                          // OUTPUT_KIND = 'output', :33
  seq: z.number().int().nonnegative(),
  sessionId: z.string().regex(/^ses_[A-Za-z0-9_-]{1,120}$/),
  commandId: z.string().min(1).max(OUTPUT_MAX_COMMAND_ID_CHARS)
              .refine((v) => !CONTROL_CHARS_RE.test(v), 'control characters'),
  command: z.string().max(OUTPUT_MAX_COMMAND_CHARS),    // no .min() — "" is legal
  status: ShellOutputStatusSchema,
  outcome: ShellOutputOutcomeSchema,
  exitCode: z.number().int().nullable(),
  output: z.string()
            .refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_OUTPUT_TEXT_BYTES,
                    'output exceeds MAX_OUTPUT_TEXT_BYTES'),
  outputBytes: z.number().int().nonnegative(),
  droppedBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  durationMs: z.number().int().nonnegative().nullable(),
});
```

The two `.refine()` predicates, verbatim:
- `protocol.ts:913` — `(v) => !CONTROL_CHARS_RE.test(v)`
- `protocol.ts:932` — `(s) => Buffer.byteLength(s, 'utf8') <= MAX_OUTPUT_TEXT_BYTES`

**Enforcement: real and on the only production path.** `buildOutputFrame`
(`protocol.ts:966-990`) runs the payload through `OutputAssembler.pushPrefixText`
and then `OutputFrameSchema.parse` at `:975`. `UiServer.output` calls only this
builder (`ui-server.ts:316`). The byte check is measured in **bytes, not zod
`.max()` units** — deliberate, and the two differ by up to 3× for Arabic/CJK.

### 1.2 Zod schemas outside `protocol.ts`

| Schema | `path:line` | Body | `.refine()` | Parsed where |
|---|---|---|---|---|
| `ConfigSchema` | `src/common/config.ts:32-44` | 11 env keys: `OPENCODE_PORT` (`z.coerce.number().int().positive().default(4096)`), `VOICE_DEFAULT` enum `['male-default','female-toggle']`, `TTS_CACHE_SIZE` (`coerce.int.positive.max(50)`), `LOG_LEVEL` enum of 4, `CAPTURE_MODE` enum of 2, `BRIEFINGS` enum of 2, `QUIET_HOURS` `z.string().default('22:00-07:00')`, `MUTE_ON_CALL` enum `['on','off']`, `MIC_DEFAULT` enum `['armed','disarmed']`, `VAD_MODEL_PATH` `z.string().default('models/silero-vad.onnx')`, `VAD_THRESHOLD` `z.coerce.number().min(0).max(1).default(0.5)` | none | `ConfigSchema.parse(env)` at `config.ts:47` |
| `Shape` (local, not exported) | `src/diag/bundle.ts:1071-1077` | `{ total: z.number(), passed: z.number(), failed: z.number(), unverified: z.number(), failedNames: z.array(z.string()) }` | none | `Shape.safeParse(payload)` at `bundle.ts:1089` |
| `IntakeSchema` | `src/orchestrator/coordinator.ts:34-37` | `{ reply_ar: z.string().min(1), task_en: z.string().min(1) }` | none | `parseSchema(IntakeSchema, raw)` at `:544` and `:613` |
| `PlanStepSchema` | `src/orchestrator/coordinator.ts:40-44` | `{ id: z.string().min(1), kind: z.string().min(1), detail: z.string().min(1) }` | none | nested inside `PlanSchema` |
| `PlanSchema` | `src/orchestrator/coordinator.ts:47-51` | `{ steps: z.array(PlanStepSchema).min(1), tools: z.array(z.string()).optional(), skills: z.array(z.string()).optional() }` | none | `parseSchema(PlanSchema, …)` at `:688` and `:699` |
| `ADDRESSEE_SCHEMA` | `src/orchestrator/permission.ts:54-63` | `{ addressed: z.boolean(), needs_opencode: z.boolean(), decision: z.enum(['answer','ask_permission','not_addressed','undecided','approve','deny']), ask_ar: z.string(), approves_id: z.string(), reason_en: z.string() }` | none | `ADDRESSEE_SCHEMA.safeParse` at `permission.ts:286` |
| `BrainOutputSchema` | `src/voice/brain.ts:25-30` | `{ intent: z.enum(['newSession','followUp','control']), control: z.enum(['approve','cancel','repeat','switchVoice','none']).default('none'), reply: z.string().min(1).max(1200), sessionDirective: z.string().optional() }` | none | `safeParse` at `brain.ts:66`, `parse` at `brain.ts:90` |

Non-zod model-facing response formats, declared as raw JSON Schema objects:
`PLAN_RESPONSE_FORMAT` (`coordinator.ts:162-190`, `strict: true`,
`additionalProperties: false`, `required: ['steps']`),
`ADDRESSEE_RESPONSE_FORMAT` (`permission.ts:65-87`, all 6 fields required).
`ADDRESSEE_CHAT_OPTIONS` (`permission.ts:90-95`) is `as const`:
`reasoning:{effort:'none'}, maxTokens:250, temperature:0, timeoutMs:6000`.

### 1.3 Constraint-enforcement verdict, per schema

| Schema | Parsed at a call site? | Verdict |
|---|---|---|
| `HelloFrameSchema` | `ui-server.ts:538` | enforced |
| `UiEventSchema` | **nowhere** | **unenforced** |
| `UiCommandSchema` | `ui-server.ts:706` | enforced |
| `AckFrameSchema` | **nowhere** | **unenforced** |
| `InventoryFrameSchema` | `protocol.ts:603` via `buildInventoryFrame` | enforced |
| `InventorySessionSchema` | nested in the above | enforced |
| `AgentFrameSchema` | `protocol.ts:626` via `buildAgentFrame` | enforced |
| `AgentEntrySchema` | nested in the above | enforced |
| `NoticeFrameSchema` | `ui-server.ts:343` | enforced |
| `VoicePhaseSchema` | nested in `VoiceFrameSchema` | enforced |
| `VoiceFrameSchema` | `ui-server.ts:357` | enforced |
| `ContextFrameSchema` | `ui-server.ts:376` | enforced |
| `FlowFrameSchema` | `ui-server.ts:406` | enforced |
| `ShellOutputStatusSchema` / `ShellOutputOutcomeSchema` | nested in `OutputFrameSchema` | enforced |
| `OutputFrameSchema` | `protocol.ts:975` | enforced |
| `ConfigSchema` | `config.ts:47` | enforced |
| `Shape` | `bundle.ts:1089` | enforced |
| `IntakeSchema` / `PlanStepSchema` / `PlanSchema` | `coordinator.ts:544, 613, 688, 699` | enforced |
| `ADDRESSEE_SCHEMA` | `permission.ts:286` | enforced |
| `BrainOutputSchema` | `brain.ts:66, 90` | enforced |
| `SanitizedErrorClassSchema` / `RemediationSchema` / `SubsystemSchema` / `StatusSchema` / `ErrorCodeSchema` / `RecordInputSchema` | `writer.ts:125` | enforced |

**2 of 20 top-level zod schemas in the tree are dead validation.**

---

## 2. TYPESCRIPT `interface` / `type` ACROSS MODULE BOUNDARIES

Derived by script over 121 production `.ts`/`.tsx` files under `src/` and
`apps/desktop/src/` (test files excluded):

```
interfaces declared      : 227
type aliases declared    : 117
zod schema constants     :  28
```

Per-file density is tabulated in the audit script at
`%LOCALAPPDATA%\Temp\opencode\count07b.mjs`. Largest boundary surfaces:
`apps/desktop/src/bridge/ws.ts` (13 interfaces), `src/runtime/client.ts` (11),
`src/orchestrator/command-router.ts` (8), `src/diag/bundle.ts` (25),
`src/ipc/protocol.ts` (2 interfaces + 13 type aliases).

### 2.1 Serve-client request/response types (`src/runtime/client.ts`)

| Type | `path:line` | Fields (all `readonly`) |
|---|---|---|
| `SessionTokens` | `client.ts:55-61` | `input: number`, `output: number`, `reasoning: number`, `cacheRead: number`, `cacheWrite: number` |
| `SessionInfo` | `client.ts:64-77` | required: `sessionId: string`, `state: string`. optional: `title?: string`, `agent?: string`, `model?: string`, `projectId?: string`, `cost?: number`, `tokens?: SessionTokens`, `updatedAt?: number`, `createdAt?: number` |
| `MessageTokens` | `client.ts:80-86` | `input`, `output`, `reasoning`, `cacheRead`, `cacheWrite` — all `number` |
| `ContextUsage` | `client.ts:108-118` | `sessionId: SessionId`, `used: number`, `limit: number \| null`, `percent: number \| null`, `byMessage: MessageTokens`, `messageCount: number`, `peak: number` |
| `SessionStatusInfo` | `client.ts:247-253` | `sessionId: string`, `state: string`, `outcome: string`, `updatedAt: string`, `lastEventId?: string` |
| `ModelRef` | `client.ts:256-260` | `id: string`, `providerID: string`, `variant?: string` |
| `AgentInfo` | `client.ts:263-267` | `id: string`, `name: string`, `mode?: string` |
| `Provenance` | `client.ts:269-273` | `origin: 'voice' \| 'cli' \| 'mobile' \| 'reconciled'`, `transcript?: string`, `actor: string` |
| `DispatchProvenance` | `client.ts:275-278` | extends `Provenance` with `fromSessionId?: SessionId`, `taskId?: string` |
| `ShellToolResult` | `client.ts:300-310` | `messageId: string`, `partId: string`, `tool: string`, `status: ShellStatus`, `output: string`, `exitCode: number \| null`, `startedAt: number \| null`, `endedAt: number \| null` |
| `SessionShellResult` | `client.ts:312-319` | extends `ShellToolResult` with `sessionId: string`, `command: string`, `outcome: ShellOutcome`, `outputBytes: number`, `durationMs: number \| null` |
| `ShellStatus` | `client.ts:291` | `'completed' \| 'error' \| 'pending' \| 'running' \| 'unknown'` |
| `ShellOutcome` | `client.ts:297` | `'ok' \| 'failed' \| 'unknown'` |

**Producers/consumers.** Produced by `ServeClient` (class at `client.ts:448`),
which is the only HTTP client to `127.0.0.1:4096`. Consumed by
`src/orchestrator/command-router.ts` (via the structurally identical
`ShellResultLike` at `:67-69` and `ContextUsageLike` at `:119-124`, so the router
does not import the HTTP layer), by `src/daemon/shell-tasks.ts:15` (imports
`SessionShellResult`, `ShellOutcome` as types), and by
`src/runtime/opencode-bridge.ts`.

**FINDING — `'mobile'` in `Provenance.origin` (`client.ts:270`) has no producer.**
Verified by script: no occurrence of the string `'mobile'` in any non-test file
under `src/`. It is a union member accepted at the type boundary and never
constructed.

`src/runtime/opencode-bridge.ts` declares its own view types, not aliases of the
client's: `SessionTokensView` (`:21-37`, note `cache` is a nested object here and
flat in `client.ts:SessionTokens`), `SessionDetails` (`:39-49`),
`AgentInfoView` (`:51-54`), `CommandInfoView` (`:56-58`), `EnvironmentStatus`
(`:60-70`).

### 2.2 Coordinator plan and receipt shapes

| Type | `path:line` | Fields |
|---|---|---|
| `Intake` (=`z.infer<IntakeSchema>`) | `coordinator.ts:38` | `reply_ar: string`, `task_en: string` |
| `PlanStep` | `coordinator.ts:45` | `id: string`, `kind: string`, `detail: string` |
| `Plan` | `coordinator.ts:52` | `steps: PlanStep[]`, `tools?: string[]`, `skills?: string[]` |
| `ChatOptions` | `coordinator.ts:195-201` | `reasoning?: unknown`, `maxTokens?: number`, `temperature?: number`, `timeoutMs?: number`, `responseFormat?: unknown` |
| `ChatFn` | `coordinator.ts:192` | `(model: string, system: string, user: string, options?: ChatOptions) => Promise<string>` |
| `IntakeContext` | `coordinator.ts:58-65` | all optional: `sessionTitle?`, `currentModel?`, `currentAgent?`, `contextPercent?: number`, `lastOutcome?` |
| `IntakeAck` | `coordinator.ts:268-293` | `ok: boolean`, `receipt: string \| null`; optional `replyAr?`, `taskEn?`, `intakeModel?`, `detail?`, `transcript?`, `reasked?: boolean` |
| `MissionResult` | `coordinator.ts:230-257` | `ok: boolean`, `receipt: string \| null`; optional `replyAr?`, `taskEn?`, `plan?: Plan`, `intakeModel?`, `needsConfirmation?: boolean`, `flagged?: string[]`, `detail?`, `cancelled?: boolean`, `needsPermission?: boolean`, `permissionAskAr?`, `permissionId?` |
| `CoordinatorDeps` | `coordinator.ts:203-228` | `chat: ChatFn`; optional `intakeModel?`, `coordinatorModel?`, `fallbackModel?`, `speak?`, `onPermissionRequired?`, `now?`, `permissionTtlMs?`, `newPermissionId?`; required `dispatch(text): Promise<{receipt: string}>`, `activeSessionId(): SessionId \| undefined` |

`buildHandoff(taskId, taskEn, sessionId, steps)` — `coordinator.ts:296-307` —
produces the exact text envelope, verbatim format:

```
[HANDOFF from=Nemotron to=Inkling task=${taskId}]
objective: ${taskEn}
session: ${sessionId}
steps:
- [${s.id}] ${s.kind} :: ${s.detail}
acceptance: dispatch receipt
constraints: FR-12 confirmed where flagged; English only; in-session execution only
```

### 2.3 Command outcome — the shape three layers agree on, twice

`src/orchestrator/command-router.ts:45-48`, verbatim:

```ts
export interface CommandOutcome {
  readonly ok: boolean;
  readonly detail?: string;
}
```

Duplicated verbatim at `apps/desktop/src/bridge/ws.ts:281-284`.
`src/ipc/ui-server.ts:121` declares a *third* `CommandOutcome` (the `onCommand`
slot's return type). `src/telemetry/writer.test.ts` and
`apps/desktop/src/App.tsx` reference the name further.

`detail` is an **open `string`**, not an `ErrorCode` union. Read literally from
the producers:

| Producer | `path:line` | `detail` value |
|---|---|---|
| router, catch-all | `command-router.ts:837` | `errorCodeFor(err)` → `ErrorCode \| 'internal'` (`common/errors.ts:121-125`) |
| router, no session | `command-router.ts:701, 658` | `'no active session'` |
| router, shell validation | `command-router.ts:702-704` | `'command required'`, or `shellCommandError(cmd)` prose |
| router, park | `command-router.ts:820` | `'confirmation-required'` |
| router, persona set | `command-router.ts:199` (per the audit trail) | `'persona-set'` |
| router, session switch | `command-router.ts` dispatch arm | a session id string |
| router, terminal draws | `command-router.ts:681-682` | `'unsupported command'` |
| `UiServer.dispatchCommand` catch | `ui-server.ts:721` | raw `err.message` — **then `redactString`'d at `ui-server.ts:732`** |

**FINDING — the wire `ack` carries no schema.** The redacted value is spread
into a plain object literal at `ui-server.ts:723-733` and serialised; the
`AckFrameSchema` that would have bounded `detail` is never applied. `detail` has
no length bound and no character-class bound anywhere on the path between
`CommandOutcome.detail` and `encodeTextFrame`.

`CommandClient` (`command-router.ts:90-116`) is the router's port onto serve:
`setSessionAgent`, `setSessionModel`, `toggleSessionSkill` all required;
`execSessionShell(sessionId, command, commandId)` **three required parameters**;
`createSession?(directory)` and `contextUsage?(sessionId, limit?)` optional.
`KeySaver` (`:126-128`) is `{ saveKeys(keys: {groq: string; fish: string; openrouter: string}): Promise<unknown> }`.

`PendingProtocolCommand` (`command-router.ts:378-390`) declares `writeFile`,
`deleteFile`, `setSensitiveConfig` with `path?`, `contents?`, `configKey?`,
`configValue?`. **These three kinds are absent from `UiCommandSchema.kind`**, so
no WS peer can produce one; `prevalidate` (`command-router.ts:707-725`) refuses
them with `'file operations unavailable'` / `'configuration writes unavailable'`.

### 2.4 Task types under `src/tasks/`

Two classes named `TaskQueue` and two `TaskRecord` types exist. They are not the
same thing:

| | `src/tasks/` (durable engine) | `src/orchestrator/task-queue.ts` (plan queue) |
|---|---|---|
| class | `TaskQueue` — `engine.ts:164` | `TaskQueue` — `task-queue.ts:135` |
| record type | `TaskRecord` — `types.ts:125-144` | `TaskRecord` — `task-queue.ts:55-82` |
| result type | *(none; `TaskEvent` carries it)* | `TaskResult` — `task-queue.ts:47-53` |
| imported by | `src/daemon/shell-tasks.ts:3-13` | `src/daemon.ts:23` |

`src/tasks/types.ts` verbatim members:

```ts
export type TaskId = string & { readonly [taskIdBrand]: true };                     // :28
export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';      // :35
export const TERMINAL_STATES: readonly TaskState[] =
  Object.freeze(['done', 'failed', 'cancelled']);                                    // :41
export type TaskFailureCode = 'timeout' | 'threw' | 'interrupted';                    // :68-78
export type RecoveryCode = 'replayed' | 'interrupted' | 'store-unreadable';          // :81-87
export type TaskOutcomeCode = 'ok' | 'cancelled' | TaskFailureCode;                   // :96
export type TaskExecutor = (task: TaskRecord, signal: AbortSignal) => Promise<unknown>; // :157

export const LEGAL_TRANSITIONS = Object.freeze({
  queued:    Object.freeze<TaskState[]>(['running', 'cancelled']),
  running:   Object.freeze<TaskState[]>(['done', 'failed', 'cancelled']),
  done:      Object.freeze<TaskState[]>([]),
  failed:    Object.freeze<TaskState[]>([]),
  cancelled: Object.freeze<TaskState[]>([]),
}) satisfies Readonly<Record<TaskState, readonly TaskState[]>>;                       // :55-61
```

`TaskRecord` — `types.ts:125-144` — all members `readonly`:
`id: TaskId`, `seq: number`, `kind: string`, `label: string`,
`payload: Readonly<Record<string, unknown>> | null`, `timeoutMs: number`,
`state: TaskState`, `enqueuedAt: number`, `startedAt: number | null`,
`settledAt: number | null`, `failure: TaskFailure | null`,
`restoredFrom: TaskState | null`.

`TaskSpec` — `types.ts:99-122` — `kind: string`, `label: string`,
`payload?: Readonly<Record<string, unknown>>`, `timeoutMs?: number`.
`TaskFailure` — `types.ts:89-93` — `code: TaskFailureCode`, `message: string`.

`engine.ts` local types: `EnqueueResult` (`:83-89`,
`{ok:true,id} | {ok:false,code:'queue-full'|'queue-closed'|'invalid-payload',detail}`),
`TaskEvent` (`:91-99`, four arms `queued|started|settled|rejected`),
`TaskRecovery` (`:107-110`), `QueueStats` (`:112-126`, ten numeric fields plus
`closed: boolean`), `TaskQueueOptions` (`:128-145`), `TaskInternal` (`:147-160`,
the only interface here with mutable `state`/`startedAt`/`settledAt`/`failure`/`restoredFrom`).

`src/tasks/notices.ts`: `NoticeSeverity` (`:16`) `'ok'|'warn'|'error'`;
`TaskNotice` (`:18-27`) `code: string`, `detailAr: string`, `severity: NoticeSeverity`,
`visual: true` (literal), `speak: boolean`; `NoticeContext` (`:29-35`)
`speechAvailable: boolean`.

`src/tasks/store.ts`: `FsPort` (`:33-39`, five sync `node:fs` fns),
`TaskSnapshot` (`:43-46`) `{v: number, tasks: readonly unknown[]}` — **`tasks` is
`unknown[]`, deliberately untyped** — `StoreRead` (`:48-51`)
`{ok:true,snapshot:TaskSnapshot|null} | {ok:false,error:string}`,
`TaskStore` (`:54-57`) `{read(): StoreRead; write(snapshot): void}`,
`TaskStoreError` (`:60-65`).

`src/orchestrator/task-queue.ts`: `TaskStatus` (`:34`)
`'queued'|'running'|'completed'|'failed'|'cancelled'` — note `completed` here vs
`done` in `src/tasks/`; `TaskOwner` (`:37`) `'voice'`; `TaskKind` (`:40`) `'plan'`;
`TaskResult` (`:47-53`) `ok`, `receipt: string|null`, `detail?`, `needsConfirmation?`,
`flagged?: readonly string[]`; `TaskRecord` (`:55-82`) `id`, `owner`, `kind`,
`epoch: number`, `transcript: string`, `taskEn: string`, `replyAr: string`,
`intakeModel?: string`, `enqueuedAt: number`, mutable `status: TaskStatus`,
`detail?`, `result?: TaskResult`, `startedAt?: number`, `finishedAt?: number`;
`EnqueueInput` (`:84-90`); `TaskStats` (`:92-101`); `TaskQueueOptions` (`:103-120`).

### 2.5 Persona and knowledge types

`src/common/brands.ts`: `ISODateString` (`:2`), branded `SessionId` (`:3`),
`EventId` (`:4`), `ApprovalId` (`:5`), `VoiceId` (`:6`)
`'male-default'|'female-toggle'`, `PersonaId` (`:10`) `'kareem'|'nour'`,
`SessionState` (`:27-29`) 7 arms, `SessionOutcome` (`:31`)
`'green'|'red'|'amber'|'unknown'`.
`PERSONA_VOICE` (`:12-15`), `PERSONA_LABEL` (`:17-20`), `VOICE_IDS` (`:22-25`,
two 32-hex transport ids, `as const`).

`src/knowledge/personas.ts` — `PersonaProfile` (`:12-36`), verbatim fields:
`id: PersonaId`, `nameAr: string`, `label: string`, `role: string`,
`toneMarkers: readonly string[]`, `shieldLexicon: readonly string[]`,
`directive: string`. Two instances: `KAREEM` (`:38-54`, 5 tone markers, 4 shield
lexemes, directive = 5 joined sentences), `NOUR` (`:56-72`, 4 tone markers, 4
shield lexemes, directive = 5 joined sentences).
`PERSONA_DIRECTIVES` (`:79-82`) is `satisfies Record<PersonaId, string>`.
`PERSONAS` (`:84`) is `Record<PersonaId, PersonaProfile>`.
`shieldHolds(profile, reply)` (`:91-94`): returns `true` when
`!reply.includes('أنا')`, else `profile.shieldLexicon.some(p => reply.includes(p))`.

**FINDING — `PersonaProfile.nameAr` and `.label` and `.role` have no consumer
outside this file.** Verified by script: `nameAr`, `label` (as a
`PersonaProfile` member) and `role` are referenced only in
`personas.ts` itself and in `personas.test.ts`. The live narration path consumes
only `directive` (prepended to the narrator system prompt) and `shieldLexicon`
(through `shieldHolds`). `PERSONA_LABEL` at `brands.ts:17` is a separate literal
that duplicates `KAREEM.label`/`NOUR.label` character-for-character.

`src/knowledge/types.ts` — verbatim:

```ts
export interface SharedChunk {          // :27-32
  readonly id: string;
  readonly source: string;
  readonly text: string;
}
export interface SharedHit extends SharedChunk {   // :34-36
  readonly score: number;
}
export interface StylisticExample {     // :42-49
  readonly id: string;
  readonly persona: PersonaId;
  readonly when: string;
  readonly say: string;
}
```

`SHARED_HAS_NO_PERSONA` (`types.ts:58`) is typed
`type HasPersona = 'persona' extends keyof SharedChunk ? true : false` assigned
the literal `false` — a compile-time assertion, not a runtime check.
`assertSharedChunks(chunks)` (`types.ts:76-84`) throws
`KnowledgeParityError` if any chunk `hasOwnProperty('persona')`.
`PARITY_INVARIANT` (`types.ts:92`) is a string constant.
`IndexedDoc` (`retriever.ts:33-38`, module-private):
`chunk: SharedChunk`, `tf: ReadonlyMap<string, number>`, `length: number`.

`src/knowledge/build.ts` — `KnowledgeReport` (`:76-85`): `sharedChunks: number`,
`digest: string`, `nourExamples: number`, `kareemExamples: number`,
`personaKeyLeaks: number`, `styleIdAsymmetries: number`.
`src/knowledge/guard.ts` — `GuardVerdict` (`:12-15`):
`blocked: boolean`, `reason?: 'blocklist' | 'neural'`; `REFUSAL_AR` (`:10`) is a
single Arabic string constant.

`src/tasks/notices.ts` and `src/runtime/laya/types.ts` `LayaDecision`
(`types.ts:17-22`: `scores: Record<LayaHead, number>`, `elapsedMs: number`,
`at: string`) are dead — §5.6.

### 2.6 Renderer-side wire mirrors (no zod on the client)

`apps/desktop/src/bridge/ws.ts` re-declares every frame as a hand-written
interface because `src/` is outside the desktop tsconfig's `include` (stated at
`ws.ts:110-113`). Verified: **zero zod imports anywhere under
`apps/desktop/src/`** except test files.

| Mirror | `path:line` | Divergence from the daemon schema |
|---|---|---|
| `HelloMsg` | `ws.ts:12-33` | `persona?` and `uplinkPaused?` optional; the daemon's `uplinkPaused` is **required** on the wire (`protocol.ts:443`). Deliberate, documented at `ws.ts:29-31`. |
| `EventMsg` | `ws.ts:35-40` | structural copy of `UiEventSchema` |
| `NoticeMsg` | `ws.ts:42-48` | structural copy |
| `VoiceMsg` | `ws.ts:50-55` | structural copy |
| `ContextMsg` | `ws.ts:58-66` | structural copy; guarded by hand-written `isContextMsg` (`ws.ts:68-79`) |
| `FlowMsg` | `ws.ts:90-94` | guarded by `isFlowMsg` (`ws.ts:97-104`) |
| `OutputFrameMsg` | `ws.ts:179-195` | 13 fields, all 13 present; guarded by `isOutputFrame` (`ws.ts:211-237`) which **deliberately does not check `output.length`** (`ws.ts:163-171`) |
| `CommandKind` | `ws.ts:239-259` | 16 members, matching `UiCommandSchema.kind` exactly |
| `CommandMsg` | `ws.ts:261-279` | **missing `title` and `contextLimit`** — the two fields the daemon schema accepts |
| `CommandOutcome` | `ws.ts:281-284` | the ack's `{ok, detail}`; `type` and `id` are consumed inline at `ws.ts:766-777` |
| `InventorySession` / `AgentEntry` | `ws.ts:298-306` | structural copies |
| `TerminalLine` / `OutputFrameLike` / `ResolvedShellOutcome` | `TerminalDrawer.tsx:126`, `:175`, `:249` | a 10-field projection of the 13-field frame |

The three `InventoryMsg`/`AgentListMsg`/`AckMsg` receivers are guarded by
hand-written predicates, not by the schema. **The renderer's own `output`
acceptance therefore has no byte cap** — by design, per `ws.ts:163-171`.

---

## 3. PERSISTED STATE — every file the system writes

| # | File | Path expression | Redirect env var | Format | Write path | Mode / ACL |
|---|---|---|---|---|---|---|
| 1 | `keyring.dat` (encrypted key vault) | `vaultPathFromEnv()` — `daemon.ts:1699-1705`: `env['VOXAURA_VAULT_PATH']` → `join(env['VOXAURA_VAULT_DIR'],'keyring.dat')` → `join(cwd,'vault','keyring.dat')`. Installed builds resolve differently: `resolve_vault_dir` in `main.rs:1313-1386` prefers `VOXAURA_VAULT_DIR`, then a `vault/` ancestor of the daemon entrypoint, then `%LOCALAPPDATA%\Voxaura\vault`. | `VOXAURA_VAULT_PATH`, `VOXAURA_VAULT_DIR` | JSON `VaultBlob` — `vault.ts:15-19`: `{version:1, updatedAt:string, pools:Record<KeyPool,{nonce:string,ciphertext:string,checksum:string}>}`. AES-256-GCM, 12-byte random nonce (`vault.ts:86`), `payload = tag(16) ‖ ciphertext` base64 (`:91`), SHA-256 checksum over the base64 payload (`:82`). `appKey = scryptSync(machineKey(),'opencode-voice-runtime:vault:v1',32)` (`:78`) | **temp + rename** — `vault.ts:138-140`: `tmp = ${path}.tmp`, `writeFileSync(tmp, …, {mode:0o600})`, `renameSync(tmp, path)` | `{mode: 0o600}` at `vault.ts:139` — **a silent no-op on Windows**. Rust applies a real owner-only protected DACL at `main.rs:1373-1377` (`restrict_to_owner`, fail-open, logged `WARN`), and re-applies it on demand via `restrict_vault_file` (`main.rs:906-924`, fail-closed: deletes the file on DACL failure). **`restrict_vault_file` IS now invoked** — `apps/desktop/src/settings/vault-dacl.ts:55`, called from `KeysView.tsx:110` after every save. |
| 2 | `machine.key` (32-byte root secret) | `join(homedir(), '.opencode-voice-runtime', 'machine.key')` — `vault.ts:60` (Node fallback). Rust: `dir.join("machine.key")` where `dir = runtime_dir()` (`main.rs:859`) | Node path: **not redirectable** (hardcodes `homedir()`). Rust path: `VOICE_RUNTIME_DIR` (`main.rs:519-523`) | raw 32 bytes | Node: in-place `writeFileSync(keyPath, key, {mode:0o600})` (`vault.ts:73`). Rust: `fs::write` (`main.rs:881`) then `restrict_to_owner` (`main.rs:882-884`) | Node: `{mode:0o600}` — no-op on Windows; `ownerOnlyAclAvailable()` probe at `vault.ts:61` emits `process.emitWarning` once per process (`vault.ts:64-68`). Rust: real protected DACL on create **and** adopt; a wrong-length key is deleted (`main.rs:875`). |
| 3 | `ipc.token` | `ipcTokenPath(home = homedir())` — `daemon.ts:1716-1718`: `join(home,'.opencode-voice-runtime','ipc.token')`. Rust: `runtime_dir()?.join("ipc.token")` — `main.rs:572`, `main.rs:933` | `VOICE_RUNTIME_IPC_TOKEN` (read-side: `ipcTokenFromEnv`, `daemon.ts:1711-1713`) | 64 lowercase hex chars (`randomBytes(32).toString('hex')` — `daemon.ts:1729`; `secure_random_bytes` in Rust) | Node: in-place `writeFileSync(path, token, {mode:0o600})` + `chmodSync(path, 0o600)` in a try (`daemon.ts:1731-1736`). Rust: `write_protected_secret` (`main.rs:619-620, 942`) | Node: `mode` + `chmod`, both ineffective on Windows. Rust: `write_protected_secret` → `restrict_to_owner` with `PROTECTED_DACL_SECURITY_INFORMATION` (`main.rs:662-671`), fail-closed. |
| 4 | `serve.pass` | `runtime_dir()?.join("serve.pass")` — `main.rs:963` | `VOICE_RUNTIME_DIR` | plaintext password | `write_protected_secret` (`main.rs:972`) | owner-only protected DACL (`main.rs:619`) |
| 5 | `owner.key` | `runtime_dir()?.join("owner.key")` — `main.rs:1034` | `VOICE_RUNTIME_DIR`, or `VOXAURA_OWNER_KEY` read-side (`main.rs:1028`) | plaintext per-install identity key | `write_protected_secret` (`main.rs:1043`) | owner-only protected DACL |
| 6 | `daemon.owner` (port-ownership marker) | Node: `join(runtimeDir, DAEMON_OWNER_FILE)` — `daemon.ts:357`, `DAEMON_OWNER_FILE='daemon.owner'` (`daemon.ts:161`). `runtimeDir = options.runtimeDir ?? join(homedir(),'.opencode-voice-runtime')` (`daemon.ts:335`). Rust: `runtime_dir()?.join("daemon.owner")` (`main.rs:1007`) | Node: `options.runtimeDir` only — **`VOICE_RUNTIME_DIR` is NOT read by `daemon.ts`**. Rust: `VOICE_RUNTIME_DIR` | JSON `DaemonOwnerMarker` — `daemon.ts:165`, content written at `daemon.ts:1805`: `{"v":1,"pid":<pid>,"ipcPort":4097,"contractVersion":"3.1.0","ownerKey":"<owner>"}`. `DAEMON_OWNER_VERSION = 1` (`daemon.ts:159`). The Rust side pre-creates it **empty** with `write_protected_secret(&marker, "")` (`main.rs:1049`) so the daemon overwrites in place. | Node: `writeFileSync(ownerPath, JSON.stringify(marker), {mode:0o600})` — `daemon.ts:373`, **in place, no temp+rename** | Node: `{mode:0o600}`, no-op on Windows. Rust pre-create: owner-only protected DACL. |
| 7 | `voice-runtime.jsonl` (telemetry) | `join(runtimeDir, 'voice-runtime.jsonl')` — `daemon.ts:1005` | same as `daemon.owner` — Node `options.runtimeDir` only | JSON Lines. Row = `{timestamp, seq, ...RecordInputSchema}` where `seq` is writer-assigned monotonic (`writer.ts:126-130`). `RecordInputSchema` at `writer.ts:73-82`. Every row is passed through `redactObject` **before** `JSON.stringify` (`writer.ts:126`). | **`appendFileSync(this.file, batch, 'utf8')`** (`writer.ts:151`) — append, no mode argument. Rotation: `rotateIfNeeded` (`writer.ts:170-188`) `statSync`s and, at `size >= maxBytes` (default `10 * 1024 * 1024`, `writer.ts:109`), `renameSync(file, file + '.1')`. Exactly one generation is retained; `.1` is overwritten by the next rotation. | **NONE.** `appendFileSync` is called with no `mode`; no `chmod`, no ACL call anywhere in `writer.ts`. The directory inherits the user-profile ACL. Stated plainly: **the telemetry log has no mode and no ACL applied by the writer.** |
| 8 | `voice-runtime.jsonl.1` | same + `'.1'` | same | rotated generation | `renameSync` | same: none |
| 9 | `supervisor.log` | `dir.join("supervisor.log")` — `main.rs:550` | `VOICE_RUNTIME_DIR` | append-only text, `[{stamp}] {message}\n` (`main.rs:559`) | `fs::write` append (`main.rs:559`) | **NONE, deliberately** — `main.rs:530-532` states the file carries no credential so it does not get the DACL. The non-Windows build compiles `log_line` to a no-op (`main.rs:569`). |
| 10 | `daemon.log` + `daemon-stdout.log` | `runtime_dir()` (`main.rs:1582`, `:1985`, `:2028`, `:2045-2046`) | `VOICE_RUNTIME_DIR` | append-only captured child streams | Rust child-spawn capture | **NONE** |
| 11 | `opencode.log` + `opencode-stdout.log` | `runtime_dir()` | `VOICE_RUNTIME_DIR` | append-only captured child streams | Rust child-spawn capture | **NONE** |
| 12 | audio cache blobs `<sha256>.mp3` | `join(this.cfg.dir, `${key}.mp3`)` — `cache.ts:83`. `cfg.dir` is the literal `'audio-cache'` from `loadConfig` (`config.ts:58`) — **a relative path, resolved against the daemon process CWD** | none — `AudioCacheConfig.dir` is not env-backed | raw MP3 bytes | `await writeFile(blobPath, audio)` — `cache.ts:84`, in place, no mode. Evicted blobs are `unlink`ed from the LRU `dispose` callback (`cache.ts:58-61`). | **NONE.** No `mode`, no ACL, anywhere in `cache.ts`. |
| 13 | task snapshot (`tasks.json`) | `FileTaskStore` takes `filePath` as a constructor argument (`store.ts:70-73`). **No production caller supplies one.** `createShellTaskBridge` leaves `options.store` unset in production (`shell-tasks.ts:98`, the rationale at `:81-96`), so the engine falls back to `new MemoryTaskStore()` (`engine.ts:191`). | n/a | JSON `{v: 1, tasks: TaskRecord[]}` — `TaskSnapshot` (`store.ts:43-46`), `SNAPSHOT_VERSION = 1` (`store.ts:30`) | **temp + rename**, temp name `${filePath}.${process.pid}.${counter}.tmp` — `store.ts:103-109`, with best-effort `unlinkSync(tmp)` on failure (`store.ts:114-118`) | **NONE** — `fs.writeFileSync(tmp, body, 'utf8')` (`store.ts:108`) carries no mode. |

**FINDING — `VOICE_RUNTIME_DIR` is honoured by the Rust supervisor
(`main.rs:519-523`) but NOT by the Node daemon.** `daemon.ts:335` reads only
`options.runtimeDir`; `src/cli/serve.ts:52` and `src/diag/bundle.ts:843` read
`env['VOICE_RUNTIME_DIR']`. A daemon started without an explicit
`options.runtimeDir` ignores the variable the supervisor and the diagnostics
bundle both honour.

**FINDING — `src/tasks/store.ts` is production-dead.** `FileTaskStore` is
referenced only by `src/tasks/index.ts:20` (barrel) and by
`src/tasks/persistence.test.ts`. The task snapshot is therefore **never written
in a shipped build**, and the `interrupted` / `store-unreadable` recovery paths
(`engine.ts:535-548`, `:513-519`) are unreachable. Stated deliberately in
`shell-tasks.ts:91-96`.

**Memory-vault notes (`src/memory/vault.ts`) are markdown, not state.**
`VAULT_NOTES` (`:8-15`) is a 6-element `as const` tuple;
`resolveVaultRoot` (`:19-26`) is `VOXAURA_VAULT_DIR` → `join(cwd,'vault')`;
`ensureVault` (`:50-67`) writes each note plus `indexes/MOC-master.md` only when
absent (`write` at `:56-61` guards on `existsSync`), UTF-8, no mode, no ACL.
Project name is validated against `/^[A-Za-z0-9][A-Za-z0-9_-]*$/` (`:51`).

---

## 4. CACHES AND BOUNDED STRUCTURES

28 distinct bounds, split by **where the cap is consulted relative to the
allocation it is meant to prevent**.

### 4.1 Enforced BEFORE allocation or BEFORE insertion — real caps

| Bound | Value | Unit | `path:line` | Behaviour at the bound |
|---|---|---|---|---|
| `MAX_MESSAGE_BYTES` per frame | 1,048,576 | bytes | `protocol.ts:22`; checked `protocol.ts:157` (`decodeFrames`), `protocol.ts:252` (`parseHeader`) | `throw WsProtocolError('frame exceeds message cap — refusing allocation')`; connection destroyed by the caller |
| `MAX_MESSAGE_BYTES` cumulative | 1,048,576 | bytes per assembled message | `protocol.ts:297-307` (`accountFor`), called at `:365` (continuation) and `:393` (opening fragment) | counters + parts cleared **first**, then throw. Checked *before* `pendingParts.push`. |
| `MAX_OUTPUT_TEXT_BYTES` | 32,768 | bytes | `protocol.ts:751`; `OutputAssembler.push` `protocol.ts:838` | fragment refused, counted in `droppedBytes`, `push` returns `false`, **no throw**, socket survives |
| `MAX_OUTPUT_TEXT_BYTES` single-shot | 32,768 | bytes | `OutputAssembler.pushPrefixText` `protocol.ts:871-887` | `room = cap - stored` computed **before** retention; a prefix `subarray` is kept and the tail counted as dropped |
| `OutputFrameSchema.output` | 32,768 | UTF-8 **bytes** | `protocol.ts:932` | `.refine` fails → `parse` throws at `protocol.ts:975` |
| `MAX_AUDIO_BYTES` | 65,536 | bytes on the reassembled payload | `protocol.ts:30`; checked `ui-server.ts:688` | `error` frame written, socket kept — **but see §4.2 item 2: the payload is already allocated** |
| `RESUME_BUFFER_CAP` | 256 | frames | `protocol.ts:20`; loop `ui-server.ts:224` | `resume.shift()`, `resumeEvicted += 1` |
| `RESUME_BUFFER_MAX_BYTES` | 65,536 | JSON payload bytes | `ui-server.ts:57`; loop `ui-server.ts:224` | same `while` loop, both axes; oldest-first |
| `MAX_CONNECTIONS` | 8 | connections | `protocol.ts:19`; loop `ui-server.ts:521` | oldest connection `socket.end()`ed and removed |
| `MAX_PENDING` (durable engine) | 8 | waiting tasks | `engine.ts:59`; check `engine.ts:261` | `enqueue` returns `{ok:false, code:'queue-full', detail}` and emits a `rejected` event (`engine.ts:265`). **No record is created.** |
| `MAX_CONCURRENCY` (durable engine) | 2 | running tasks | `engine.ts:46`; enforced in `drain()` `engine.ts:352` | slot not taken; task waits |
| `MAX_HISTORY` | 64 | terminal records | `engine.ts:66`; `trimHistory` `engine.ts:434-446` | oldest terminal `tasks.delete`, `evictedFromHistory` counter. Never evicts `queued`/`running`. |
| `MAX_TASK_TIMEOUT_MS` / `MIN_TASK_TIMEOUT_MS` / `DEFAULT_TASK_TIMEOUT_MS` | 4 h / 1 s / 15 min | ms | `engine.ts:69`, `:72`, `:79` | `clampTimeout` `engine.ts:480-483`; non-integer/`<1` options throw `RangeError` (`engine.ts:566-568`) |
| `TASK_MAX_DEPTH` (plan queue) | 8 | pending | `task-queue.ts:126`; `while (pending.length >= maxDepth)` `task-queue.ts:201` | oldest `finish(oldest,'cancelled','queue-full')` **before** the push at `:206` |
| `TASK_RECORDS_CAP` | 64 | map entries | `task-queue.ts:133` | declared and used in the module; eviction policy is documented at `:128-133` |
| `DELIVERY_CAP` | 4 | held items | `delivery.ts:117`; `while (items.length >= maxHeld)` `delivery.ts:192` | oldest `shift()`ed, `droppedCount += 1`, before `push` at `:197` |
| `DELIVERY_TTL_MS` | 30,000 | ms | `delivery.ts:123`; swept `delivery.ts:224` | dropped, `onExpired?.(item)` fires |
| `MAX_PARKED` | 8 | parked confirmations | `command-router.ts:404`; loop `command-router.ts:807` | oldest `pending.delete` — **but see §4.2 item 3** |
| `CONFIRMATION_TTL_MS` | 60,000 | ms | `command-router.ts:397`; swept `command-router.ts:804-806` | `pending.delete(key)` |
| `PERMISSION_TTL_MS` | 30,000 | ms | `permission.ts:105`; `PermissionSlot.current` `permission.ts:332-335` | slot nulled, `consume` returns `null`, nothing is authorised |
| `MAX_SPOKEN_ASK_WORDS` | 20 | words | `permission.ts:131`; `spokenAsk` `permission.ts:157` | returns `null`; caller withholds the ask, never substitutes a template |
| `INVENTORY_MAX_SESSIONS` | 200 | sessions | `protocol.ts:569`; `.max()` at `:574`, producer slice at `:602` | producer truncates and sets `totalSessions` |
| `MAX_BUFFERED_BYTES` (ingest) | 960,000 (160,000 × 6) | bytes | `ingest.ts:8`; loop `ingest.ts:196` | oldest whole 160,000-byte window shed, `droppedWindows += 1`. Loop runs **after** `concat` — see §4.2 item 5 |
| `PAUSE_BYTES` / `RESUME_BYTES` | 262,144 / 32,768 | bytes | `ingest.ts:47-48`; latch `ingest.ts:155-166` | edge-triggered `pause` / `resume` via `onWatermark` |
| Audio cache entry size | 4,194,304 (`maxEntryBytes`) | bytes | `config.ts:61`; check `cache.ts:80` | `set()` returns without writing |
| Audio cache total size | 67,108,864 (`maxBytes`) | bytes | `config.ts:60`; `LRUCache({maxSize})` `cache.ts:55-56` | `lru-cache` evicts LRU; `dispose` decrements `bytesTotal` and `unlink`s the blob (`cache.ts:58-61`) |
| Audio cache entries | 50 | entries | `cache.ts:54` (`max: 50` — a hardcoded literal) and `cache.ts:23` (`readonly maxSize: 50` in `AudioCacheStats`) | LRU eviction |
| `ROTATION_LIMIT` (keyring) | 10 | requests per key | `keyring.ts:9`; `keyring.ts:79` | key index advances: `Math.floor(slot/10) % list.length` |
| Telemetry log rotation | 10,485,760 (10 MiB) | bytes | `writer.ts:109`; `rotateIfNeeded` `writer.ts:170-188` | `renameSync(file, file+'.1')`, one generation retained |
| Telemetry flush cadence | 500 | ms | `writer.ts:108`; timer `writer.ts:135` (`unref`'d) | `appendFileSync` of the joined batch |
| `MAX_PREHEADER_BYTES` | 2,097,152 (2 × MAX_MESSAGE_BYTES) | bytes | `protocol.ts:24`; check `protocol.ts:329` | throws — **but see §4.2 item 1** |

### 4.2 Enforced AFTER the allocation — not caps

**1. `MAX_PREHEADER_BYTES` — `protocol.ts:316-336`.** `push` allocates the
concatenation **first**:

```ts
push(chunk: Uint8Array): WsFrame[] {
  this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);   // :317  ALLOC
  if (this.buffer.byteLength > MAX_PREHEADER_BYTES) {              // :329  CHECK
```

A 65,536-byte socket `data` event against a 2 MiB buffer allocates 2,065,536
bytes before the check; the next event allocates again before the throw. The cap
bounds the *retained* buffer, not the transient peak. The code comment at
`protocol.ts:322-328` states the head frame cannot exceed the cap because
`parseHeader` refuses it, so in practice the loop cannot be driven — but the
check itself is post-allocation.

**2. `MAX_AUDIO_BYTES` — `ui-server.ts:687-691`.** The 64 KiB cap is applied to
`frame.payload.byteLength`, which is the **already-reassembled and already-masked**
`Buffer`:

```ts
if (frame.opcode === Opcode.Binary) {
  if (frame.payload.byteLength > MAX_AUDIO_BYTES) {
    safeWrite(conn, this.conns, encodeTextFrame(JSON.stringify({ type: ERROR_KIND, detail: 'audio frame too large' })));
    continue;
  }
```

The allocation that produced this payload is bounded only by `MAX_MESSAGE_BYTES`
(1 MiB). **A binary message of 1 MiB is fully allocated, fully unmasked into a
second 1 MiB buffer at `protocol.ts:357`, and only then rejected** — 16× the
stated 64 KiB audio cap. "Never reaches the pipeline" is true; "bounded at
64 KiB" is not.

**3. `MAX_PARKED` — `command-router.ts:803-811`.** The entry is inserted first:

```ts
pending.set(cmd.id, { at: now(), cmd });            // :803  INSERT
for (const [key, entry] of pending) { … }           // :804  TTL sweep
while (pending.size > MAX_PARKED) {                 // :807  CHECK
  const oldest = pending.keys().next(); … pending.delete(oldest.value);
}
```

The `while` converges, so the map ends at ≤ 8 — but the 9th entry is fully
retained (a whole `GovernedCommand`, including a 512-char shell string) before the
eviction runs.

**4. `MAX_CONNECTIONS` — `ui-server.ts:520-533`.** `conns.add(conn)` at `:520`
runs **after** `handleUpgrade` has already written the complete HTTP 101
handshake (`ui-server.ts:497-514`) and after `new FrameReassembler()` at `:515`.
An over-limit client is fully upgraded, then immediately `socket.end()`ed.

**5. `MAX_BUFFERED_BYTES` — `ingest.ts:191-200`.** The concatenation is allocated
before the shed loop:

```ts
push(chunk) {
  if (chunk.byteLength === 0) return [];
  this.buffered = concat(this.buffered, chunk);      // :193  ALLOC (unbounded growth to this line)
  this.evaluateWatermark();
  while (this.buffered.byteLength > MAX_BUFFERED_BYTES) {   // :196  CHECK
    this.buffered = this.buffered.subarray(WINDOW_BYTES);
    this.dropped += 1;
```

The `while` restores the bound within one call, so the *steady state* is bounded;
the transient peak is `MAX_BUFFERED_BYTES + chunk.byteLength` (up to 960,000 +
65,536 = 1,025,536 B) and a single 65,536-byte chunk is concatenated in full
before any accounting.

**6. `MAX_MESSAGE_BYTES` in `decodeFrames` vs `FrameReassembler` — asymmetric.**
`decodeFrames` (`protocol.ts:124-218`) checks the frame cap at `:157` and the
cumulative cap at `:181`; `FrameReassembler` checks at `parseHeader` (`:252`) and
`accountFor` (`:299`). **Both are pre-allocation. `decodeFrames` is not the live
path** — `ui-server.ts` uses `FrameReassembler` (`ui-server.ts:515`) — and it is
exported from `src/ipc/index.ts:16`, so it is one import away.

**7. No cap at all — `Keyring.rollovers` — `keyring.ts:28`, pushed at
`keyring.ts:83` and `:107`, exposed unbounded by the `rolloverLog` getter
(`keyring.ts:110-112`).** The array is never trimmed, never rotated, and has no
size limit in any form. It grows by one entry per pool advance for the lifetime
of the process. `Keyring.destroy()` (`keyring.ts:115-118`) zeroes the key
`Buffer`s and clears `cached` — it does **not** touch `rollovers`.

**8. No cap at all — `AudioIngest.pushChunk` overlap.** `ui.onAudio` is
fire-and-forget, so concurrent `push` calls can overlap; the code states the
transient ceiling as `(WINDOW_BYTES - 1) + MAX_AUDIO_BYTES = 225,535 B`
(`ingest.ts:35`) with at most 3 windows in flight against STT's 15 s ceiling
(`ingest.ts:41-42`). Arithmetic, not a cap.

**9. No cap — `TaskQueue.timers` / `controllers` / `listeners` maps.**
`engine.ts:169`, `:170`, `:171`. `timers` and `controllers` are deleted on
settle (`engine.ts:396-402`) and `close()` (`engine.ts:331-334`); `listeners` is
caller-owned and only cleared by the returned unsubscribe (`engine.ts:244-247`).

### 4.3 Renderer-side caps (for completeness)

`RECONNECT_BASE_MS = 50`, `RECONNECT_JITTER_MS = 30`, `RECONNECT_CAP_MS = 2500`
(`ws.ts:7-9`); `ACK_TIMEOUT_MS = 5000` (`ws.ts:10`). `ws.ts:176-177` mirrors
`OUTPUT_MAX_COMMAND_CHARS = 512` and `OUTPUT_MAX_COMMAND_ID_CHARS = 128` as
local literals. `SPEECH_GATE_DB = -30` (`ingest.ts:71`) is duplicated in the
renderer as `apps/desktop/src/audio/vad.ts`.

---

## 5. THE KNOWLEDGE / RAG CORPUS

### 5.1 Chunk counts — verified by script, not by comment

```
Select-String -Pattern "^\s*id:\s*'" per file:
  src/knowledge/shared/architecture.ts    id= 8   persona=0   text= 8
  src/knowledge/shared/capabilities.ts    id=11   persona=0   text=11
  src/knowledge/shared/commands.ts       id= 8   persona=0   text= 8
  src/knowledge/shared/failures.ts       id= 8   persona=0   text= 8
  src/knowledge/shared/lexicon.ts        id= 8   persona=0   text= 8
  src/knowledge/styles/kareem.ts         id= 8   persona=8   text= 0
  src/knowledge/styles/nour.ts           id= 8   persona=8   text= 0
```

| Tier | Count | Composed at |
|---|---|---|
| **Tier 1 — `SHARED_CHUNKS`** | **43** | `build.ts:23-29` (spread of the five arrays) |
| **Tier 2/3 — `STYLISTIC_EXAMPLES`** | **16** (8 Nour + 8 Kareem) | `build.ts:32-35` |
| Persona keys leaking into Tier 1 | **0** (`verifyKnowledge().personaKeyLeaks`) | `build.ts:94-97` |
| `when`-coverage asymmetries | **0** (`verifyKnowledge().styleIdAsymmetries`) | `build.ts:104-108` |

Chunk shape is `SharedChunk` (§2.5). Example, verbatim (`architecture.ts:12-18`):

```ts
{
  id: 'arch-ports',
  source: 'AGENTS.md#runtime-topology; src/ipc/ui-server.ts',
  text:
    'المنفذ 4096 هو opencode serve والمنفذ 4097 هو جسر WS-4097 للواجهة. ' +
    'المنفذ 1420 هو خادم Vite في وضع التطوير، والمنفذ 4197 هو stub للاختبارات E2E. ' +
    'Voxaura daemon runs on port 4097 and drives opencode serve on port 4096. ' +
    'These four ports are a fixed contract: if one is busy, the daemon is not running.',
}
```

`StylisticExample` carries `id`, `persona`, `when`, `say` — **no `text` member**,
which is what makes it structurally impossible to smuggle a fact into styling.

`sharedDigest` (`build.ts:50-63`) is FNV-1a 32-bit **doubled** — two seeds
`0x811c9dc5` and `0x01000193`, multipliers `0x01000193` and `0x85ebca6b`, each
`>>> 0`, concatenated as two zero-padded 8-hex halves → a 16-char digest over
`id + ' ' + source + ' ' + text` joined by `''`. It is a change detector, not a
cryptographic provenance claim.

### 5.2 BM25 parameters — read literally

`src/knowledge/retriever.ts:30-31`, verbatim:

```ts
const K1 = 1.2;
const B = 0.75;
```

Scoring, verbatim (`retriever.ts:81-82`):

```ts
const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / Math.max(1, this.avgLen)));
```

- `n = this.docs.length` (`retriever.ts:73`)
- `df` from `this.docFreq`, a `Map<string, number>` built once in the constructor
  (`retriever.ts:58-60`); absent term → `df = 0` (`retriever.ts:80`)
- `avgLen = total / docs.length`, or `0` for an empty corpus (`retriever.ts:62`)
- `doc.length` is the count of tokens **before** `normalizeToken` folding
  (`retriever.ts:50`, `:56`)
- `search(query, topK)` returns `[]` when `topK <= 0` (`:70`) or when the query
  normalises to zero tokens (`:72`)
- `score > 0` is the inclusion predicate (`:85`); sort descending, then
  `slice(0, topK)` (`:87-88`)

`IndexedDoc` is `{chunk, tf: ReadonlyMap<string, number>, length: number}`
(`retriever.ts:33-38`). Zero dependencies — no `minisearch`, no tokenizer package.

### 5.3 Tokenizer and normalizer — the four escape classes, verbatim

`src/knowledge/normalize.ts:23-26`, verbatim:

```ts
const TASHKEEL = /[\u064B-\u065F\u066A\u066D-\u0672]/g; // harakat + wasla alef, NOT the digits
const TATWEEL = /\u0640/g; // U+0640 ARABIC TATWEEL
const ALEF_VARIANTS = /[\u0622\u0623\u0625\u0671]/g; // alef + hamza variants
const ALEF_MAKSURA = /\u0649/g; // U+0649 alef maksura -> yeh
```

The class is written as explicit escapes with the gaps as the comment. `U+0660`–
`U+0669` (Arabic-Indic digits) and `U+066B` / `U+066C` are **deliberately
outside** `TASHKEEL`, so `المنفذ ٤٠٩٦` survives normalization with its digits
intact. Digits are never folded to ASCII.

`normalizeArabic` (`normalize.ts:38-45`): `.normalize('NFKC')` → strip
`TASHKEEL` → strip `TATWEEL` → `ALEF_VARIANTS → 'ا'` → `ALEF_MAKSURA → 'ي'`.

`tokenize` (`normalize.ts:58-62`): `normalizeArabic(input).split(/[^\p{L}\p{N}_]+/u).filter(t => t.length > 0)` — split on any run of non-letter, non-number, non-underscore, with the `u` flag for `\p{…}`.

`normalizeToken` (`normalize.ts:74-76`), verbatim:

```ts
export function normalizeToken(term: string): string {
  return /[\u0600-\u06FF]/.test(term) ? normalizeArabic(term) : term.toLowerCase();
}
```

A term containing **any** Arabic-block codepoint takes the full NFKC +
orthographic path; a pure-Latin term is lowercased only and NFKC is deliberately
not applied (`normalize.ts:71-72`).

`isIdempotent(input)` (`normalize.ts:52-55`): `normalizeArabic(normalizeArabic(input)) === normalizeArabic(input)`.

Application points, both sides, no exception: `retriever.ts:50` (`tokenize(chunk.text)`),
`retriever.ts:53` (`normalizeToken(term)` per index term), `retriever.ts:71`
(`new Set(tokenize(query).map(normalizeToken))`).

A second, independent Arabic folder lives at `coordinator.ts:110-114`
(`foldArabic`), which strips `/[\u0640\u064B-\u0652\u0670]/g` and maps
`/[آأإٱ]/g → 'ا'` — **a different class from `normalizeArabic`'s** (no `U+066A`,
`U+066D-\u0672`; no alef-maksura folding). Used only by `claimsOutcome`
(`coordinator.ts:117-120`).

### 5.4 Persona registry — the full shape

`PersonaProfile` (`personas.ts:12-36`), all members `readonly`:
`id: PersonaId`, `nameAr: string`, `label: string`, `role: string`,
`toneMarkers: readonly string[]`, `shieldLexicon: readonly string[]`,
`directive: string`.

Two instances, verbatim counts: `KAREEM` (`personas.ts:38-54`) — `toneMarkers`
has **5** entries (`يا غالي`, `يا كبير`, `ولا يهمك`, `هسا بنرتب`, `هسا بنرتبها`),
`shieldLexicon` has **4** (`أنا جاهز`, `شفت`, `رتبت`, `عملت`), `directive` is
5 sentences joined by `' '`. `NOUR` (`personas.ts:56-72`) — `toneMarkers` has
**4** (`تمام، بس للتأكيد`, `من عيوني`, `ولا تشيل هم`, `تمام`), `shieldLexicon`
has **4** (`أنا جاهزة`, `شفت`, `رتبت`, `عملت`), `directive` is 5 sentences.

The two registries:

```ts
export const PERSONA_DIRECTIVES = {                        // personas.ts:79-82
  kareem: KAREEM.directive,
  nour: NOUR.directive,
} satisfies Record<PersonaId, string>;

export const PERSONAS: Record<PersonaId, PersonaProfile> = // personas.ts:84
  { kareem: KAREEM, nour: NOUR };
```

`satisfies Record<PersonaId, string>` makes a persona without a directive a
compile error. The narrator receives the **string**, never the `PersonaId` — the
inference from `PERSONA_DIRECTIVES[id]`.

`shieldHolds(profile, reply)` (`personas.ts:91-94`), verbatim:

```ts
export function shieldHolds(profile: PersonaProfile, reply: string): boolean {
  if (!reply.includes('أنا')) return true;
  return profile.shieldLexicon.some((phrase) => reply.includes(phrase));
}
```

The `src/knowledge/index.ts` barrel exports `KAREEM`, `NOUR`, `PERSONAS`,
`shieldHolds`, `PersonaProfile` (line 11) — but **not** `PERSONA_DIRECTIVES`,
which the daemon imports deep from `personas.js` so the BM25 retriever and the
43-chunk corpus stay off its startup graph.

### 5.5 Tier-D guard

`screenText(text, blocklist)` (`guard.ts:18-25`) normalises both the text and
every blocklist entry through `normalizeArabic`, drops zero-length entries, and
returns `{blocked:true, reason:'blocklist'}` on the first substring hit, else
`{blocked:false}` with `reason` absent.
`guardText(text, blocklist, isDestructive)` (`guard.ts:31-44`) runs the
deterministic screen first, then `await isDestructive(text)`, and returns
`{blocked:true, reason:'neural'}` on a positive. **A throwing
`isDestructive` returns `{blocked:false}`** (`guard.ts:41`) — the neural
backstop fails open.

### 5.6 FINDING — the RAG layer is not on the narration path

`InMemoryRetriever` and `buildIndex` are imported only by `src/cli/*` and by
`src/knowledge/**`. Verified by script: no importer of `./retriever.js` or
`buildIndex` exists in `src/daemon.ts`, `src/orchestrator/**`, `src/voice/**`,
or `src/ipc/**`. `assertParity()` (`build.ts:121-132`) and `verifyKnowledge()`
(`build.ts:93-118`) are exported but have no production caller.
`guardText` / `screenText` have no caller outside `src/knowledge/`.

### 5.7 FINDING — `src/runtime/laya/` is dead and its types ship to nothing

Verified by script — every module under `src/runtime/laya/` has **zero
importers outside `src/runtime/laya/`**:

| Module | Non-laya importers | Lines |
|---|---|---|
| `constants.ts` | 0 | 16 |
| `types.ts` | 0 | 20 |
| `index.ts` | 0 | 28 |
| `laya-engine.ts` | 0 | 106 |
| `telemetry.ts` | 0 | 89 |
| `loader.ts` | 0 | 126 |
| `tokenizer.ts` | 0 | 132 |

Types declared there and shipped nowhere: `LayaDecision` (`types.ts:17-22`),
`LayaHead` (`constants.ts:18`), `LayaSession` (`laya-engine.ts:33`),
`LayaAdvisory` / `LoadLayaOptions` (`loader.ts:36`, `:43`),
`LayaTokenizer` / `TokenizerJson` (`tokenizer.ts:11`, `:15`),
`LayaTelemetrySink` / `LayaTelemetryRow` / `LayaTelemetryFacts`
(`telemetry.ts:34`, `:36`, `:39-52`).

---

## 6. TELEMETRY SCHEMA

`src/telemetry/writer.ts`. `RecordInputSchema` verbatim (`:73-82`):

```ts
const RecordInputSchema = z.object({
  sessionId: z.string().min(1),
  eventId: z.string().uuid(),
  subsystem: SubsystemSchema,
  status: StatusSchema,
  latencyMs: z.number().nonnegative(),
  errorCode: ErrorCodeSchema.optional(),
  sanitizedErrorClass: SanitizedErrorClassSchema.optional(),
  remediationAttempted: RemediationSchema.optional(),
});
```

There is **no transcript field and no free-text field anywhere in the schema** —
stated as an invariant at `writer.ts:5-8`. Row on disk is
`{timestamp: ISO, seq: writer-monotonic, ...parsed}` (`writer.ts:126-130`).

The daemon's own wrapper (`daemon.ts:1006-1012`) fills `sessionId` with
`activeSession ?? 'none'` and `eventId` with `randomUUID()`, and **swallows every
throw** from `record()` in a bare `catch {}`.

### 6.1 `subsystem` — every member, producer or orphan

`SubsystemSchema` — `writer.ts:40`, 6 members.
Producer census (script: `subsystem: '<X>'` across `src/`, `apps/desktop/src/`,
`apps/desktop/e2e/`, `scripts/`, excluding `dist/` and `target/`):

| Member | Declared | Production producers | Verdict |
|---|---|---|---|
| `STT` | `writer.ts:40` | `daemon.ts:1163`, `:1171`, `:1415` | live |
| `BRAIN` | `writer.ts:40` | `daemon.ts:484`, `:1199`, `:1214`, `:1221`, `:1269`, `:1307`, `:1324`, `:1353`, `:1399` | live |
| `TTS` | `writer.ts:40` | `daemon.ts:1479`, `:1504`, `:1517` | live |
| `KEYRING` | `writer.ts:40` | `daemon.ts:1587` | live |
| `LAYA` | `writer.ts:40` | **none reachable.** The only producers are `src/runtime/laya/telemetry.ts:58` and `:71`, inside a module with zero non-laya importers (§5.7). | **ORPHANED** |
| `LAUNCHER` | `writer.ts:40` | **none anywhere.** `src/launcher/launcher.ts` (36 lines) contains no `record()` call; it exports only `probeHealth`. | **ORPHANED** |

### 6.2 `sanitizedErrorClass` — `SanitizedErrorClassSchema`, `writer.ts:9-21`, 11 members

Producers: `classify()` at `daemon.ts:1014-1031` (the only mapping function in
production), plus dead `laya/telemetry.ts:64`.

| Member | Reachable producer |
|---|---|
| `FetchError` | `daemon.ts:1021`, `:1022`, `:1029` |
| `AbortError` | **none** — `daemon.ts:1027` collapses `AbortError` and `TimeoutError` into `'TimeoutError'`. `'AbortError'` appears in `brain.ts:259`/`:367` and `daemon.ts:1501` for retry classification, not for telemetry. **ORPHANED** |
| `TimeoutError` | `daemon.ts:1027`, `:1419` |
| `ZodError` | `daemon.ts:1028` |
| `OnnxError` | **none reachable** — only `laya/telemetry.ts:64`, dead (§5.7). **ORPHANED** |
| `AudioDecodeError` | **none anywhere.** **ORPHANED** |
| `AudioDeviceError` | **none anywhere.** **ORPHANED** |
| `AuthError` | `daemon.ts:1020`, `:1023`, `:1591` |
| `QuotaExceeded` | `daemon.ts:1019` |
| `ContractDrift` | `daemon.ts:1024` |
| `Unknown` | `daemon.ts:1030` (the fallthrough) |

**4 of 11 members are orphaned.**

### 6.3 `remediationAttempted` — `RemediationSchema`, `writer.ts:24-37`, 11 members

| Member | Reachable producer |
|---|---|
| `None` | `daemon.ts:1327`, `:1356`, `:1420`, `:1592`, and the false arm of the three ternaries at `:1179`, `:1312`, `:1404` |
| `KeyAdvanced` | `daemon.ts:1179`, `:1312`, `:1404` — `remediationAttempted: keyAdvanced(err) ? 'KeyAdvanced' : 'None'`. `keyAdvanced` (`keyring.ts:176-178`) reads a non-enumerable `Symbol('voxaura.keyAdvanced')` set at `keyring.ts:162` |
| `Reasked` | `daemon.ts:1359` |
| `ReconnectedSSE` | **none. ORPHANED** |
| `ReconnectedWS` | **none. ORPHANED** |
| `QueuePurged` | **none. ORPHANED** |
| `PlaybackAborted` | **none. ORPHANED** |
| `ServeRestarted` | **none. ORPHANED** |
| `ModelThrottled` | **none. ORPHANED** |
| `CacheBypassed` | **none. ORPHANED** |

**7 of 11 members are orphaned.**

### 6.4 `errorCode` — `ErrorCodeSchema`, `writer.ts:42-71`, 20 members

Produced either as a literal or, for the two credit codes, as a template
(`daemon.ts:1522`: `` errorCode: `TTS_CREDIT_${err.status}` ``, where
`err.status` is `402 | 429` per the `FishCreditError` construction).

| Member | Line | Reachable producer | Verdict |
|---|---|---|---|
| `STT_FAILED` | `:48` | `daemon.ts:1174` | live |
| `STT_TIMEOUT` | `:53` | `daemon.ts:1418` | live |
| `BRAIN_TIMEOUT` | `:49` | `daemon.ts:1310` | live |
| `BRAIN_FAILED` | `:54` | `daemon.ts:1402` | live |
| `KEYS_MISSING` | `:55` | `daemon.ts:1590` | live |
| `SESSION_NOT_FOUND` | `:46` | `daemon.ts:1272` | live |
| `CONFIG_INVALID` | `:68` | `daemon.ts:1199`; also `laya/telemetry.ts:63` (dead) | live |
| `TTS_FAILED` | `:56` | `daemon.ts:1507` | live |
| `TTS_CREDIT_402` | `:61` | `daemon.ts:1522` (template) | live |
| `TTS_CREDIT_429` | `:62` | `daemon.ts:1522` (template) | live |
| `ALREADY_RUNNING` | `:69` | `daemon.ts:491` (`as const`) | live |
| `SERVE_UNREACHABLE` | `:43` | — | **ORPHANED** |
| `CONTRACT_DRIFT` | `:44` | — | **ORPHANED** |
| `SSE_DISCONNECTED` | `:45` | — | **ORPHANED** |
| `AUDIO_DEVICE_MISSING` | `:63` | — | **ORPHANED** |
| `VAULT_CORRUPT` | `:64` | — | **ORPHANED** |
| `POOL_EXHAUSTED` | `:65` | — | **ORPHANED** |
| `RATE_LIMITED` | `:66` | — | **ORPHANED** |
| `APPROVAL_EXPIRED` | `:67` | — | **ORPHANED** |
| `HIGH_STAKES_CONFIRM_REQUIRED` | `:70` | — | **ORPHANED** |

**9 of 20 members are orphaned.** All 9 are consumed *as classifier inputs* by
`classify()` at `daemon.ts:1019-1024`, which is why they are referenced in
`src/` at all — but no `errorCode: '<X>'` site ever writes them to a telemetry
row.

### 6.5 `status` — `StatusSchema`, `writer.ts:41`, 3 members

`OK`, `DEGRADED`, `ERROR`. All three are written by the daemon
(`daemon.ts:485`, `:1199`, `:1505`, `:1588` and the surrounding branches).

### 6.6 FINDING — the two error taxonomies are not the same taxonomy

`ErrorCode` (`src/common/errors.ts:3-48`) has **22** members.
`ErrorCodeSchema` (`src/telemetry/writer.ts:42-71`) has **20**. The set
difference in `ErrorCode` but **not** in the telemetry schema:

```
BRAIN_AUTH, BRAIN_CREDIT, BRAIN_REJECTED, CANCELLED, DAEMON_STOPPED,
SESSION_BUSY, TASK_TIMEOUT
```

A row carrying any of those seven would make `RecordInputSchema.parse`
(`writer.ts:125`) **throw**, and `daemon.ts:1009` swallows the throw in a bare
`catch {}` — so the row would vanish with no signal. This is not currently
reachable (no producer passes one), but it is a live landmine: the `ack.detail`
path (`command-router.ts:837` → `errorCodeFor`, `errors.ts:121-125`) *does* emit
those seven to the shell, so the two code sets describe the same fault differently
to two different sinks.

`ShellStopReason` (`errors.ts:84`) `'timeout' | 'cancelled' | 'daemon-stopped'`
maps one-directionally to `TASK_TIMEOUT | CANCELLED | DAEMON_STOPPED`
(`SHELL_STOP_REASON_CODES`, `errors.ts:87-92`). `errorCodeFor` returns
`'internal'` for a non-`OrchestratorError`, and `'internal'` is deliberately
**not** a member of either union (`errors.ts:115-119`).

---

## 7. FINDINGS INDEX

| # | Finding | Evidence |
|---|---|---|
| F1 | `AckFrameSchema` defined and exported; never parsed. `ack.detail` reaches the wire with no length or character bound. | `protocol.ts:546`; `ui-server.ts:723-734`; `ipc/index.ts:13` |
| F2 | `UiEventSchema` defined and exported; never parsed. `broadcast` builds the frame as an object literal. | `protocol.ts:447`; `ui-server.ts:233-242`; `ipc/index.ts:24` |
| F3 | `AgentFrameSchema.agents` has no `.max()`, unlike its sibling `InventoryFrameSchema.sessions` (`.max(200)`). | `protocol.ts:620` vs `:574` |
| F4 | `UiCommandSchema` accepts `title` and `contextLimit`; the renderer's `CommandMsg` has neither, and no renderer site writes either. `createSession` therefore ignores its own directory input. | `protocol.ts:540-541`; `ws.ts:261-279`; `command-router.ts:670-676` |
| F5 | `MAX_AUDIO_BYTES` (64 KiB) is applied to an already-reassembled, already-unmasked buffer; the true allocation bound is `MAX_MESSAGE_BYTES` (1 MiB), 16× larger. | `ui-server.ts:688`; `protocol.ts:357` |
| F6 | `MAX_PREHEADER_BYTES` is checked after `Buffer.concat`. | `protocol.ts:317` then `:329` |
| F7 | `AudioIngest.MAX_BUFFERED_BYTES` shed loop runs after `concat`; transient peak is cap + chunk. | `ingest.ts:193` then `:196` |
| F8 | `MAX_PARKED` and `MAX_CONNECTIONS` both insert/admit first and evict in a `while` loop after. `MAX_CONNECTIONS` runs after a complete HTTP 101 has been written. | `command-router.ts:803`; `ui-server.ts:520`, `:497-514` |
| F9 | `Keyring.rollovers` is an unbounded array with no trim, no rotation, and no cap in any form; `destroy()` does not clear it. | `keyring.ts:28`, `:83`, `:107`, `:110-118` |
| F10 | `FileTaskStore` has no production caller; the task snapshot is never written in a shipped build and both recovery paths are unreachable. | `store.ts:67`; `engine.ts:191`; `shell-tasks.ts:98` |
| F11 | The telemetry log is written with `appendFileSync(file, batch, 'utf8')` — **no mode, no ACL**. Stated plainly. | `writer.ts:151` |
| F12 | The audio cache is written with `writeFile(blobPath, audio)` — **no mode, no ACL** — into a relative `'audio-cache'` directory. | `cache.ts:84`; `config.ts:58` |
| F13 | The task snapshot temp file is written with `writeFileSync(tmp, body, 'utf8')` — **no mode, no ACL**. | `store.ts:108` |
| F14 | `VOICE_RUNTIME_DIR` is honoured by the Rust supervisor and by `src/cli/serve.ts` / `src/diag/bundle.ts`, but **not** by `daemon.ts:335`, which reads only `options.runtimeDir`. | `main.rs:519-523`; `cli/serve.ts:52`; `diag/bundle.ts:843`; `daemon.ts:335` |
| F15 | Telemetry orphan census: **2 of 6** `subsystem` members, **4 of 11** `sanitizedErrorClass`, **7 of 11** `remediationAttempted`, **9 of 20** `errorCode`. **22 orphaned enum members total.** | §6.1–§6.4 |
| F16 | `ErrorCode` (22) and telemetry `ErrorCodeSchema` (20) are disjoint on 7 members; a row carrying one would throw in `parse` and be swallowed by `daemon.ts:1009`. | `errors.ts:3-48`; `writer.ts:42-71`; `daemon.ts:1009` |
| F17 | `Provenance.origin` includes `'mobile'` with no producer anywhere in `src/`. | `client.ts:270` |
| F18 | `PersonaProfile.nameAr`, `.label`, `.role` have no consumer outside `personas.ts` and its test; `brands.ts:17` `PERSONA_LABEL` duplicates the labels independently. | `personas.ts:12-36`; `brands.ts:17-20` |
| F19 | `src/runtime/laya/**` — 7 modules, 0 non-laya importers. `LayaDecision`, `LayaHead`, `LayaSession`, `LayaAdvisory`, `LayaTokenizer`, `LayaTelemetrySink/Row/Facts` ship to nothing. | §5.7 |
| F20 | The RAG layer is not on the narration path: `buildIndex`, `verifyKnowledge`, `assertParity`, `screenText`, `guardText` have no production caller. | §5.6 |
| F21 | `ShellStatus` / `ShellOutcome` are declared **three** times — `protocol.ts:767`, `:777` (zod), `client.ts:291`, `:297` (TS), `ws.ts:172-173` (TS) — plus `command-router.ts:55` as `ShellOutcomeLike`. Four declarations, no shared import. | as listed |
| F22 | Two classes named `TaskQueue` and two `TaskRecord` types coexist (`src/tasks/` vs `src/orchestrator/task-queue.ts`), with incompatible state vocabularies (`done` vs `completed`). | `engine.ts:164`; `task-queue.ts:135` |
| F23 | The renderer's client-side frame acceptance is hand-written (`isContextMsg`, `isFlowMsg`, `isOutputFrame`) with **no zod anywhere under `apps/desktop/src/`**, and `isOutputFrame` deliberately omits any `output` length check. | `ws.ts:68-79`, `:97-104`, `:211-237`, `:163-171` |
| F24 | `normalizeArabic`'s `TASHKEEL` class (`normalize.ts:23`) and `coordinator.ts:112`'s `foldArabic` are **two different Arabic folders** with different code point sets. | as listed |
| F25 | The only model-facing contracts are `PlanResponse`/`ADDRESSEE_RESPONSE_FORMAT` raw JSON-Schema literals (`coordinator.ts:162`, `permission.ts:65`) plus `BrainOutputSchema` (`brain.ts:25`). There is no zod schema for the narrator's `{"reply_ar": …}` output; `narrator.ts` parses it by hand. | as listed |
| F26 | `decodeFrames` (`protocol.ts:124`) is a second reassembler exported from the barrel (`ipc/index.ts:16`) but not the live path; its caps are pre-allocation and match `FrameReassembler`, so it is one import away from being safe. | `protocol.ts:124-218`; `ui-server.ts:515` |

---

## 8. AUDIT COMMANDS (all re-runnable)

```powershell
cd O:\opencode-Vantrilex
git rev-parse HEAD
git status --short

# §0 — no database, no manifests
Get-ChildItem -Recurse -File -Include go.mod,pyproject.toml,Cargo.toml,*.db,*.sqlite,*.sqlite3 `
  -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch 'node_modules|\.venv|\\target\\|sidecar' } |
  Select-Object -ExpandProperty FullName

# §0.2 — the .py population
(Get-ChildItem -Recurse -File -Filter *.py | Measure-Object).Count
Get-ChildItem -Recurse -File -Filter *.py | Where-Object { $_.FullName -notmatch '\\\.venv\\' } |
  Select-Object -ExpandProperty FullName

# §1 — zod sites and refine sites
Get-ChildItem -Recurse -File -Path src,apps/desktop/src -Include *.ts,*.tsx |
  Where-Object { $_.FullName -notmatch '\\dist\\' } |
  Select-String -Pattern "from 'zod'|z\.object|z\.enum|\.refine\(|\.superRefine\(" |
  ForEach-Object { "{0}:{1}" -f $_.Path, $_.LineNumber }

# §1.3 — which schemas are actually parsed
foreach ($s in 'AckFrameSchema','UiEventSchema','UiCommandSchema','HelloFrameSchema',
               'OutputFrameSchema','InventoryFrameSchema','AgentFrameSchema',
               'NoticeFrameSchema','VoiceFrameSchema','ContextFrameSchema','FlowFrameSchema') {
  Get-ChildItem -Recurse -File -Path src -Include *.ts |
    Select-String -SimpleMatch -Pattern "$s.parse", "$s.safeParse"
}

# §6 — the orphan census
foreach ($m in 'STT','BRAIN','TTS','LAYA','LAUNCHER','KEYRING') {
  Get-ChildItem -Recurse -File -Path src,apps/desktop/src -Include *.ts |
    Where-Object { $_.Name -notmatch '\.test\.ts$' } |
    Select-String -SimpleMatch -Pattern "subsystem: '$m'"
}
foreach ($m in 'ReconnectedSSE','ReconnectedWS','QueuePurged','PlaybackAborted',
               'ServeRestarted','ModelThrottled','CacheBypassed') {
  Get-ChildItem -Recurse -File -Path src -Include *.ts |
    Where-Object { $_.Name -notmatch '\.test\.ts$' } |
    Select-String -SimpleMatch -Pattern "remediationAttempted: '$m'"
}
Get-ChildItem -Recurse -File -Path src -Include *.ts |
  Where-Object { $_.Name -notmatch '\.test\.ts$' } |
  Select-String -Pattern 'errorCode'
```

Scratch scripts used to produce the counts in §0.3, §1 and §2 live at
`%LOCALAPPDATA%\Temp\opencode\count07.mjs` and `count07b.mjs`. **Nothing was
written into the repository except this file.**
