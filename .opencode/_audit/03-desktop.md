# 03 — Desktop Forensic Audit (`apps/desktop/`)

**Auditor:** Forensic Auditor 3/7 · **Date:** 2026-09-28 · **HEAD:** `076cebc` (`feat(knowledge): restore the RAG layer, enforce information parity by type`) · **Branch:** `main` · **Working tree:** clean except untracked `.opencode/_audit/`

**Method.** 100 % of facts below are read out of physical source. Markdown is treated as untrusted; every doc claim is quoted with its line number and adjudicated against code. Two commands were executed to produce *measured* numbers (listed in §0.2); no files were modified, no installs, no commits.

---

## 0. Inventory and measured baselines

### 0.1 Production source (non-test), line counts from `@(Get-Content).Count`

| Path | Lines | Notes |
|---|---|---|
| `src/App.tsx` | 668 | the HUD; owns every state axis in §1 |
| `src/main.tsx` | 24 | 3-surface router on `?view=` |
| `src/index.css` | 30 | Tailwind + `--voxaura-*` tokens |
| `src/styles/tokens.css` | 177 | `--vx-*` tokens, scrollbar suppression, `.vx-session-bar` |
| `src/bridge/ws.ts` | 520 | `VoxauraBridge` |
| `src/audio/capture.ts` | 174 | `AudioCapture` |
| `src/audio/playback.ts` | 181 | `AudioPlayer`, `createDefaultPlayer` |
| `src/audio/vad.ts` | 93 | `frameEnergyDb`, `bargePolicy`, `micPolicy`, `micFailureNotice` |
| `src/audio/earcons.ts` | 107 | `RECIPES`, `renderEarcon`, `EarconPlayer` — **zero production importers (§9.1)** |
| `src/matrix/matrix-state.ts` | 177 | reducer + `matrixForDaemonState`; only the mapper is used |
| `src/sessions/store.ts` | 27 | pure reducer |
| `src/settings/chain.ts` | 13 | `AGENT_CHAIN` (3 entries) |
| `src/settings/ipc-token.ts` | 61 | token resolution + retry |
| `src/settings/open-settings.ts` | 65 | window spawner / `is*View` |
| `src/settings/services.ts` | 65 | `ensureServices` |
| `src/window/useAutoSize.ts` | 90 | `ResizeObserver` → Tauri `setSize` |
| `src/window/close-current-window.ts` | 18 | Esc handler target |
| `src/components/brand/Crest.tsx` | 24 | **zero production importers (§9.1)** |
| `src/components/brand/WaveformEmblem.tsx` | 22 | inlined 5-bar SVG |
| `src/components/icons/ControlGlyphs.tsx` | 78 | `MicGlyph`, `MicOffGlyph`, `BotGlyph`, `BotOffGlyph` |
| `src/components/portals/PortalShell.tsx` | 73 | `createPortal` → `document.body` |
| `src/components/portals/ApiKeysModal.tsx` | 113 | uncontrolled 3-key form |
| `src/components/portals/ConfirmPortal.tsx` | 39 | FR-12 T2 surface |
| `src/components/portals/CredentialPortal.tsx` | 29 | **zero importers, zero tests outside `portals.test.tsx` (§9.1)** |
| `src/components/session/SessionChip.tsx` | 113 | compact row + absolute dropdown |
| `src/components/session/AgentModelBadge.tsx` | 62 | `select` or `prompt` fallback |
| `src/components/session/ContextGauge.tsx` | 78 | `formatTokens`, `level` |
| `src/components/settings/SettingsView.tsx` | 331 | 4 tabs + its own WS-4097 link |
| `src/components/settings/KeysView.tsx` | 102 | keys window |
| `src/components/waveform/SiriWaveCanvas.tsx` | 192 | `SPEAKER_PALETTE`, canvas thread |
| `src-tauri/src/main.rs` | 1287 | supervisor (out of primary scope; cited where it touches the shell) |
| `e2e/stub-daemon.mjs` | 171 | the fake control plane |

### 0.2 Measured, with commands

| Command | Result |
|---|---|
| `cd apps/desktop && npx tsc --noEmit` | exit **0**, no diagnostics |
| `cd apps/desktop && npx vitest run` | **Test Files 24 passed (24) · Tests 153 passed (153)**, duration 4.42–4.67 s, environment `happy-dom` |

Per-file test counts from that run (all `✓`):

`src/audio/playback.test.ts` 17 · `src/bridge/ws.test.ts` 18 · `src/matrix/matrix-state.test.ts` 14 · `src/components/waveform/SiriWaveCanvas.test.tsx` 14 · `src/components/session/ContextGauge.test.tsx` 10 · `src/audio/mic-policy.test.ts` 9 · `src/audio/capture.test.ts` 7 · `src/settings/services.test.ts` 7 · `src/components/session/SessionChip.test.tsx` 5 · `src/audio/capture-permission.test.ts` 5 · `src/audio/earcons.test.ts` 5 · `src/components/settings/SettingsView.test.tsx` 5 · `src/components/portals/ApiKeysModal.test.tsx` 5 · `src/audio/playback-f01.test.ts` 4 · `src/audio/vad.test.ts` 4 · `src/components/session/AgentModelBadge.test.tsx` 4 · `src/window/useAutoSize.test.tsx` 4 · `src/components/icons/ControlGlyphs.test.tsx` 3 · `src/components/brand/Crest.test.tsx` 3 · `src/settings/ipc-token.test.ts` 3 · `src/audio/*.test` remainder 0 · `src/components/portals/portals.test.tsx` 2 · `src/components/settings/KeysView.test.tsx` 2 · `src/sessions/store.test.ts` 2 · `src/components/brand/WaveformEmblem.test.tsx` 1. Sum = 153.

**There is no `src/App.tsx.test.tsx`.** The 668-line component that owns the entire HUD state machine has **zero unit tests**. Its only coverage is the 18 Playwright tests (§7). `src/matrix/matrix-state.test.ts` and `src/bridge/ws.test.ts` are the closest thing.

Static E2E inventory (counted from the spec files, not from a run): **14 `.spec.ts` files, 18 `test()` blocks** — §7.1.

---

## 1. The UI state machine

### 1.1 There is no single state machine. There are **eleven** independent state axes in `src/App.tsx`.

The brief's claim ("idle/listening/thinking/speaking") is **partially correct and materially incomplete**. `idle|listening|thinking|speaking` is exactly one axis — `VoicePhase`, `src/App.tsx:25` — and it is the *only* axis whose union matches the brief. The **rendered status pill** uses a different, 5-value vocabulary (§1.2), and six further axes move visible UI independently.

| # | Axis | Type (declaration) | Default |
|---|---|---|---|
| 1 | `bridge` | `BridgeState` = `'connecting' \| 'live' \| 'degraded' \| 'refused'` — `src/App.tsx:24`, state `:36` | `envToken() !== undefined ? 'connecting' : 'degraded'` (`:36`) |
| 2 | `persona` | `'kareem' \| 'nour'` — `:37` | `'kareem'` |
| 3 | `matrix` | `MatrixState` = `0 \| 1 \| 2 \| 3 \| 4` — type at `src/matrix/matrix-state.ts:8`, state `src/App.tsx:38` | `0` |
| 4 | `userMuted` | `boolean` — `:39` | **`true`** (mic off at boot; privacy-safe default, asserted by `e2e/capture.spec.ts:18`) |
| 5 | `botMuted` | `boolean` — `:40` | `false` |
| 6 | `announce` | `string` — `:41` | `''` |
| 7 | `notice` | `Notice \| null` — `:42`, shape `:27-31` (`code`, `detail`, `level`) | `null` |
| 8 | `voicePhase` | `VoicePhase` = `'idle' \| 'listening' \| 'thinking' \| 'speaking'` — `:25`, state `:43` | `'idle'` |
| 9 | `micEnergy` | `number` 0..1 — `:45` | `0` |
| 10 | `pendingConfirm` | `{ id: string; detail: string } \| null` — `:46` | `null` |
| 11 | `speaking` | `boolean` + `speakingRef` mirror — `:59-65` | `false` |

Plus two `useReducer`/state containers: `sessionState` (`:47`, reducer `src/sessions/store.ts:20`) and the read-only-ish `agentModel` (`:48`), `agents` (`:52`), `context` (`:53`), `lastTranscript` (`:44`).

### 1.2 The status pill — the actual displayed state set

`src/App.tsx:417-430`, rendered at `:456-465` with `data-testid="bridge-status"`, `data-state={statusPill.state}`, `role="status"`, `aria-live="polite"`.

**Exactly five `data-state` values exist, in this strict precedence order:**

| Order | Condition (first match wins) | `text` | `state` | Line |
|---|---|---|---|---|
| 1 | `bridge !== 'live'` | `● غير متصل` | **`offline`** | `:418-419` |
| 2 | `speaking \|\| voicePhase === 'speaking'` | `● يتحدث الآن…` | **`speaking`** | `:420-421` |
| 3 | `voicePhase === 'thinking'` | `● جارٍ التفكير…` | **`processing`** | `:422-423` |
| 4 | `!userMuted \|\| voicePhase === 'listening'` | `● جارٍ الاستماع…` | **`listening`** | `:424-425` |
| 5a | `matrix === 0` | `● متصل وبانتظار الأوامر` | **`ready`** | `:426-427` |
| 5b | `matrix === 2` | `● جاري المعالجة...` | **`processing`** (2nd branch, same value) | `:428-429` |
| 5c | fallthrough (`matrix` ∈ `{1,3,4}`) | `● متصل وبانتظار الأوامر` | **`ready`** | `:430` |

**Finding — the set is 5, not 4.** The brief's four names map to: `idle` → **`ready`** (never rendered as "idle"), `listening` → `listening`, `thinking` → `processing`, `speaking` → `speaking`. The brief omits **`offline`**, which is the state the shell sits in whenever the bridge is not live — i.e. the state a user sees on a broken install. Note also that `processing` is reached by **two mutually exclusive** conditions (voice-phase-driven and matrix-driven), and that branches 5a and 5c render **identical text with different inputs**.

### 1.3 Transition triggers, axis by axis

**Axis 1 — `bridge`** (`'connecting' | 'live' | 'degraded' | 'refused'`)

| From → To | Trigger | Line |
|---|---|---|
| `—` → `connecting` | `envToken() !== undefined` at first render (web/E2E build) | `:36` |
| `—` → `degraded` | `envToken() === undefined` at first render (Tauri build, token comes from Rust) | `:36` |
| `degraded` → `degraded` | `resolveIpcTokenWithRetry()` returned `undefined` after 20 × 500 ms | `:90-93` |
| any → `live` | `onHello` — a well-formed hello with matching `contractVersion` | `:104-105` |
| any (≠ `refused`) → `live` | `onFrame` — **any** inbound frame, payload-independent | `:100-103` |
| `live` → `degraded` | `onClose` — socket closed, reconnect scheduled | `:163` |
| any → `refused` | `onRefusal` — malformed hello **or** `contractVersion` mismatch | `:164` (fired from `src/bridge/ws.ts:400`, `:410`) |

**Watchdog** (`src/App.tsx:181-188`): a `setInterval` every **5 000 ms** (`:186`). If `bridgeRef.current.live === false`, then `setBridge(s => s === 'refused' ? s : 'degraded')` (`:185`). It reads `client.live`, which is `socket.isOpen?.() ?? true` (`ws.ts:265-269`).

**`refused` is terminal.** `connect()` returns early when `this.refused` (`ws.ts:272`), and `scheduleReconnect()` likewise (`ws.ts:512`). `onFrame` refuses to promote out of it (`App.tsx:102`) and the watchdog preserves it (`App.tsx:185`). The only exit is component remount.

**There is no `connecting → live` edge that skips `connecting`.** On Tauri the shell mounts directly in `degraded` and only reaches `live`; `connecting` is a web/E2E-only initial state.

**Axis 8 — `voicePhase`** — **only** inbound WS frames change it.

- `onVoice` → `setVoicePhase(v.phase)` (`App.tsx:126-127`). The bridge accepts only the four literals (`ws.ts:481`), else the frame is dropped (`ws.ts:489`).
- `transcript` is applied only when non-empty (`App.tsx:128`) → `lastTranscript`.

Daemon-side producers (`src/daemon.ts`, one setter `setVoicePhase` at `:357-361`, which **dedupes** identical phases with no transcript at `:358`):

| Phase | Emitted at | Trigger |
|---|---|---|
| `listening` | `daemon.ts:662` | **every** uplink PCM chunk reaching `ui.onAudio` (`daemon.ts:658`), deduped so a steady mic costs 0 frames |
| `thinking` | `daemon.ts:428` | `think(transcript)` — only for a window that survived the speech gate (comment `:394-396`) |
| `speaking` | `daemon.ts:604` (`onUtterance`) and `daemon.ts:210` (narrator line) | both carry the transcript |
| `idle` | `daemon.ts:601` (unspeakable reply), `daemon.ts:629` (`finally` after TTS) | |

**Local barge-in does NOT touch `voicePhase`** (`App.tsx:234-239`) — it sets the local `speaking` flag and sends `abort`. So after a barge the pill reads from `voicePhase`, which is still `speaking` until the daemon's `finally` at `daemon.ts:629` lands.

**Axis 11 — `speaking`** (the "assistant is audibly producing" flag; distinct from `voicePhase`)

| To | Trigger | Line |
|---|---|---|
| `true` | `onStart` from the player, on the **first** `enqueue` — i.e. on **frame arrival**, before any decode succeeds | `:145` → `playback.ts:63-66` |
| `false` | 1 500 ms **after** `onEnd` (`setTimeout`, never cancelled) | `:147-149` |
| `false` | barge-in path, immediately | `:236` |

**Defect (state desync).** The 1 500 ms timer at `App.tsx:148` is never cleared. If a new utterance enqueues within that window, `onStart` sets `speakingRef.current = true` (`:63`) and the stale timer then fires `setSpeakingState(false)` (`:62-65`), which clears **both** the ref and the state **while audio is still queued**. Downstream effects: `waveSpeaker` flips back to `'user'` (`:415`) and the status pill drops out of `speaking` (`:420`) mid-reply. There is no test covering re-entry within the latch.

**Axis 3 — `matrix`** (`0`=IDLE, `1`=USER, `2`=THINKING, `3`=KAREEM, `4`=NOUR — `matrix-state.ts:8`)

| To | Trigger | Line |
|---|---|---|
| mapper result | `onEvent` → `matrixForDaemonState(event.state, personaRef.current)`; applied only when non-null | `:133-137` |
| `3` or `4` | `handleSelectPersona` — **optimistic local write**, `id === 'kareem' ? 3 : 4` | `:321` |
| `0` | abort button while `live` | `:620` |
| `1` | abort button while `!live` (the "re-generate" branch) | `:623` |

Mapping table (`matrix-state.ts:164-176`), exhaustive:

| Daemon `event.state` | Matrix |
|---|---|
| `awaiting-approval` | `2` |
| `running` | `2` |
| `complete` | `persona === 'kareem' ? 3 : 4` |
| `idle` | `persona === 'kareem' ? 3 : 4` |
| `error` | `0` |
| `aborted` | `0` |
| anything else | `null` (no visual change) |

**Reachability note.** Matrix `1` (USER) is produced by **no** daemon event — only by the "re-generate" button at `App.tsx:623`. Matrix `4` (NOUR) is reachable from a daemon event only when persona is `nour` at that instant. The colours for all five states are defined (`matrix-state.ts:11-25`) but **never rendered** — see §9.2.

**Axis 4 — `userMuted` / mic hardware.** `toggleUserMute` (`:369-381`) flips state, calls `capture.stop()` or `startMic()`, and sends `deafen`. Separately, a `visibilitychange`/`blur` effect (`:258-273`) applies `micPolicy(document.visibilityState === 'hidden' ? 'hidden' : 'visible', userMuted)` (`src/audio/vad.ts:54-57`): hidden → `'release'` → `capture.stop()`; visible → `'start'` when not muted, `'none'` when muted. **`userMuted` is never modified by that effect** (`:250-252`), so minimise/restore is non-destructive. Unmount stops the capture (`:202`).

**Axis 5 — `botMuted`** is changed in exactly one place, `toggleBotMute` (`:383-387`). It has **no effect on playback** — see §9.3.

**Axis 7 — `notice`.** Set by `onNotice` (`:114`) and `onErrorFrame` (`:132`); cleared only by the dismiss button (`:501`). Single-slot: a later `persona-changed` **info** notice overwrites a `voice-disabled-no-keys` **warn** banner, and vice versa — the CTA at `:487-496` disappears with it.

**Axis 10 — `pendingConfirm`.** Set when `sendCommandDetailed` resolves with `detail === 'confirmation-required'` (`:296-300`); the detail text is `cmd.command` or the Arabic fallback `'إجراء قد يكون مدمّراً'` (`:299`). Cleared in `resolveConfirm` (`:312`), which then sends `{ kind:'confirm', confirmId, approve }` (`:315`).

**Derived-but-not-stored:** `live = matrix !== 0` (`:432`) → `mode={live ? 'active' : 'idle'}` on the canvas (`:562`); `noSessions = sessionState.sessions.length === 0` (`:433`) → the empty-sessions paragraph (`:524-528`).

---

## 2. The IPC bridge — `src/bridge/ws.ts` (520 lines)

### 2.1 Constants and connection setup

| Constant | Value | Line |
|---|---|---|
| `UI_WS_URL` | `ws://127.0.0.1:4097/v1/ui` | `:5` |
| `UI_SUBPROTOCOL` | `voice-ui.v1` | `:6` |
| `RECONNECT_BASE_MS` | 50 | `:7` |
| `RECONNECT_JITTER_MS` | 30 | `:8` |
| `RECONNECT_CAP_MS` | 2500 | `:9` |
| `ACK_TIMEOUT_MS` | 5000 | `:10` |

`connect()` (`:271-294`):

1. Guard: `if (this.disposed || this.refused || this.socket !== null) return;` (`:272`).
2. Resume query: `lastSeq >= 0` → `withQuery(base, 'lastSeq', String(this.lastSeq))` (`:274`); `withQuery` appends `&` vs `?` correctly (`:187-189`).
3. Socket factory: injected `opts.createSocket`, else `adaptWebSocket(new WebSocket(url, protocols))` (`:275`).

### 2.2 The subprotocol token handshake

`const socket = create(url, [UI_SUBPROTOCOL, this.opts.token]);` — `src/bridge/ws.ts:276`.

The bearer is the **second element of the subprotocol array** because browsers cannot set `Upgrade`/header credentials; the file header says so at `:1-3`. The server side answers `Sec-WebSocket-Protocol: voice-ui.v1` only (`src/ipc/ui-server.ts:347`) and validates the pair.

`adaptWebSocket` (`:225-244`) forces `ws.binaryType = 'arraybuffer'` (`:228`) — the comment at `:226-227` notes that the browser default (`Blob`) would otherwise never reach the speech-downlink branch.

Token resolution happens **above** the bridge: `src/settings/ipc-token.ts:6-9` reads `import.meta.env['VOICE_RUNTIME_IPC_TOKEN']` (exposed by `vite.config.ts:10` `envPrefix: 'VOICE_'`), otherwise `invoke<string>('ipc_token')` from the Rust host (`ipc-token.ts:21-23`; command at `src-tauri/src/main.rs:527-535`, which fails closed when `ipc.token` is missing). Retry wrapper `resolveIpcTokenWithRetry` (`ipc-token.ts:46-61`): **20 attempts × 500 ms ≈ 10 s**, with an early bail-out for a non-Tauri host with no env token (`:57`).

**`contractVersion` is hardcoded `'3.1.0'` in three separate call sites** — `App.tsx:97`, `SettingsView.tsx:75`, `KeysView.tsx:31` — with no shared constant.

### 2.3 Hello validation and refusal

`isWellFormedHello` (`:163-172`) requires: `nodePid` number, **`servePort === 4096` exactly** (`:167`), `layaReady` boolean, integer `seq >= 0`, `contractVersion` string.

Two independent refusal paths, both of which set `refused = true`, fire `onRefusal`, `close()` the socket, and **never reconnect**:
- malformed hello → `got: 'malformed-hello'` (`:398-407`)
- `hello.contractVersion !== opts.contractVersion` → `got: String(hello.contractVersion)` (`:408-417`)

Daemon-restart detection precedes validation (`:390-397`): if `hello.seq < lastSeq`, the cursor is reset and `onGap()` fires.

### 2.4 Reconnect behaviour

`onclose` (`:282-286`): null the socket → `onClose?.()` → `scheduleReconnect()`. `onerror` (`:287-293`) only calls `close()`; the close handler drives recovery.

`scheduleReconnect` (`:511-519`): guards `disposed || refused || timer !== null`; computes `computeBackoff(this.attempt)`, increments, arms one `setTimeout` that calls `connect()`.

`computeBackoff(attempt, baseMs=50, jitterMs=30, capMs=2500, rand=Math.random)` (`:175-184`), pure and exported:
`Math.min(baseMs * 2 ** max(0, attempt) + rand() * jitterMs, capMs)`.

Attempt ladder (jitter = 0): **50, 100, 200, 400, 800, 1600, 2500, 2500 …** ms. `attempt` resets to 0 on `onopen` (`:279`).

`lastSeq` is advanced by `hello` (max, `:396`), `event` (`:423`), `inventory` (`:436`), `agents` (`:447`), `context` (`:460`).

### 2.5 Command ledger

`sendCommandDetailed(cmd)` (`:301-318`): returns `{ok:false}` immediately if there is no socket (`:303`); otherwise registers `{resolve, timer}` in `pending` under `cmd.id`, arms a **5 000 ms** timer (`:305-308`), then `socket.send(JSON.stringify(cmd))`. A synchronous send throw clears the timer and resolves `false` (`:312-316`). `sendCommand` is the boolean-flavoured wrapper (`:296-298`).

`sendPcm(bytes)` (`:324-333`): fire-and-forget binary, **deliberately outside the ack ledger** (comment `:320-323`).

`dispose()` (`:335-359`): sets `disposed`, fires `onDispose` **only on the first transition** (`:340`, `:343`), clears the reconnect timer, settles every pending command as `{ok:false}` (`:348-352`), best-effort `close()`. `onDispose` is separate from `onClose` on purpose (`:336-339`, `:216-221`) so a transient socket drop never kills the `AudioContext` mid-reply.

### 2.6 Every message type handled — exhaustive

| Type | Where | Validation | Handler |
|---|---|---|---|
| **binary (`ArrayBuffer`)** | `:367-373` | `byteLength >= 4 && bytes[0] === 0x01` | `onAudio(bytes.subarray(3))`; anything else binary is dropped |
| **`Blob`** | `:375-378` | `typeof Blob !== 'undefined' && data instanceof Blob` | re-enters `onMessage` with the converted `ArrayBuffer`; catch swallows |
| **`hello`** | `:388-419` | `isWellFormedHello` + `contractVersion` match | `onHello`; on failure `onRefusal` + close |
| **`event`** | `:421-426` | none (only `seq` typing) | `onEvent` |
| **`inventory`** | `:427-439` | `isInventoryList` (`:149-160`): every entry needs non-empty `sessionId` **and** `state` strings | `onInventory`, else `onErrorFrame('malformed inventory frame')` |
| **`agents`** | `:440-450` | `isAgentList` (`:135-146`): every entry needs non-empty `id` **and** `name` | `onAgents`, else `onErrorFrame('malformed agents frame')` |
| **`context`** | `:451-463` | `isContextMsg` (`:60-71`): `type`, `sessionId` matches `/^ses_[A-Za-z0-9_-]{1,120}$/`, integer `used >= 0`, integer `messageCount >= 0`, `limit === null \|\| > 0`, `percent === null \|\| 0..100` | `onContext`, else `onErrorFrame('malformed context frame')` |
| **`notice`** | `:464-478` | `detail` and `code` both strings; `level` coerced — `level === 'info' \|\| level === 'error' ? level : 'warn'` (`:474`), so **any unknown level becomes `warn`** | `onNotice` |
| **`voice`** | `:479-490` | `phase` must be one of the four literals (`:481`) | `onVoice`; `transcript` included only when a string |
| **`ack`** | `:491-504` | `typeof id === 'string'` | resolves the matching `pending` entry with `{ ok: ok !== false, detail? }` — note `ok` **missing entirely counts as success** |
| **`error`** | `:505-508` | `detail` string else `'unknown error'` | `onErrorFrame` |
| anything else | — | — | silently ignored (falls off the end of `onMessage`) |

`onFrame?.()` is the **first** statement of `onMessage` (`:364`) — liveness is stamped before any parsing, so even a malformed frame promotes the HUD to `live`.

### 2.7 Three independent bridge instances, one token, three sockets

`App.tsx` (`:95`), `SettingsView.tsx` (`:73`), `KeysView.tsx` (`:29`) each construct their own `VoxauraBridge` and each opens its own socket to 4097. Server-side connection cap is `MAX_CONNECTIONS` with **oldest-eviction** (`src/ipc/ui-server.ts:359-371`) — relevant because the three surfaces plus the E2E raw socket can contend.

---

## 3. Audio

### 3.1 Uplink (mic → daemon)

`src/audio/capture.ts`:

- `TARGET_RATE = 16000` (`:7`); `FRAME_SAMPLES = (16000 * 100) / 1000` = **1600 samples = 100 ms** (`:8`).
- `getUserMedia({ audio: { sampleRate: 16000, echoCancellation: true, noiseSuppression: true } })` (`:85-87`). A rejection is re-thrown with the original `DOMException.name` **preserved** and the original as `cause` (`:94-98`) — this is what `micFailureNotice` keys off.
- `AudioContext({ sampleRate: 48000 })` (`:100`) — deliberately *not* 16 k; the resampler is `downsample` (`:19-35`, linear interpolation, throws on upsampling `:21`).
- `AudioWorklet` from an inline Blob module (`:44-53`, registered as `voxaura-capture`, `process()` posts `channel.slice(0)`); fallback `createScriptProcessor(4096, 1, 1)` wired straight to `destination` on failure (`:136-144`).
- Energy: `onEnergy(Math.min(1, rms * 4))` (`:111`) — a hard 4× scaling of RMS.
- Encoding: `floatToInt16` clamps to ±1 and scales by **32767** (`:14`), then `encodeFrame` writes Int16**LE** via `DataView.setInt16(..., true)` (`:40`). Remainder samples are carried in `this.pending` (`:121`).
- `stop()` is idempotent: disconnects the node, stops all tracks, closes the context (`:154-173`).

**Barge/duck gate** — `src/audio/vad.ts`, applied in `App.tsx:232`:

- `frameEnergyDb` (`:7-17`): dBFS with a −100 floor, `20*log10(rms)`.
- `isSpeechFrame(frame, thresholdDb = -30)` (`:20-22`). The comment at `:19` states amplitude 4000/32768 ≈ −18 dBFS trips it.
- `bargePolicy(speaking, frame, thresholdDb = -30)` (`:32-35`): `!speaking → 'send'`; speech → `'barge'`; else `'duck'`.
- `'duck'` returns immediately in `App.tsx:233` — the frame **never reaches the daemon**.
- `'barge'` (`:234-239`): `playerRef.current?.stop()`, `setSpeakingState(false)`, then `sendCommand({kind:'abort'})` via `nextCmdId()`. Then `sendPcm(bytes)` at `:240` — **the barge frame itself also goes up**.
- `micEnergy` is throttled to **80 ms** (`App.tsx:220-224`).

**Uplink frames bypass the ack ledger** (`ws.ts:320-333`) — loss-tolerant by design.

### 3.2 Downlink (daemon → speakers) — MP3 bytes to audible output

Full chain, step by step:

1. **Wire format** — `src/ipc/audio.ts`: `[type:1][seq:u16be][mp3…]` (`:1-5`), `AUDIO_DOWNLINK_TYPE = 0x01` (`:6`), `MAX_AUDIO_CHUNK = 32 * 1024` = **32 KiB** (`:7`), chunker `splitAudio` (`:31-39`) with `seq % 65_536`.
2. **Daemon broadcast** — `daemon.ts:616` `ui.broadcastAudio(mp3)` per synthesised sentence (`:612-617`, gated by the speech-gate generation so a barge kills the rest).
3. **Frame arrival** — `ws.ts:367-373`. `data instanceof ArrayBuffer` (guaranteed by `binaryType='arraybuffer'`, `ws.ts:228`) → `new Uint8Array(data)`; requires `byteLength >= 4` **and** `bytes[0] === 0x01`; passes **`bytes.subarray(3)`** — i.e. the seq bytes are **discarded**. The renderer's minimum-length rule mirrors the server's `decodeAudioChunk` guard `if (frame.byteLength < 4) return null` (`src/ipc/audio.ts:24`).
4. **Handoff to the player** — `App.tsx:141-156`. The player is created **lazily on the first audio frame**: `createDefaultPlayer({ onStart, onEnd })`, wrapped in `try/catch` that `return`s silently if `AudioContext` is unavailable (`:151-153`). `onStart → setSpeakingState(true)` (`:145`); `onEnd → setTimeout(() => setSpeakingState(false), 1500)` (`:147-149`). Then `playerRef.current.enqueue(bytes)` (`:155`).
5. **Queue** — `src/audio/playback.ts:54-68`:
   - zero-length chunks are dropped without touching state (`:55`);
   - `PLAYBACK_QUEUE_CAP = 32` (`:28`); on overflow the **OLDEST is shifted off** and `droppedCount` increments (`:59-62`) — the comment at `:57-58` explains why (dropping the tail truncates the reply mid-sentence);
   - the first enqueue sets `started = true` and fires `onStart` **before any decode is attempted** (`:63-66`);
   - `void this.drain()`.
6. **Drain loop** — `playback.ts:94-135`. One loop at a time (`draining` flag, `:95-96`). It captures `const gen = this.generation` (`:97`) and re-checks it before and after each `await` (`:100`, `:105`), so anything decoded after a `stop()` is discarded rather than played. A throwing `decode` is caught and **skipped** (`:107-109`). The `finally` block (`:111-134`) resets `draining` **before** the try (comment `:120-123`), fires `onEnd` only when the queue is empty, re-enters `drain()` if items remain, and swallows a throwing consumer callback so the floating promise cannot become an unhandled rejection (`:124-133`).
7. **Decoder + sink (production)** — `createDefaultPlayer`, `playback.ts:147-181`:
   - throws `'audio output unavailable in this environment'` if `typeof AudioContext === 'undefined'` (`:148-150`);
   - one `GainNode` for the whole player, `gain.gain.value = PLAYBACK_GAIN = 0.9` (`:144`, `:154-156`) — the comment at `:139-143` notes ≈ −0.9 dB and that the provider is already asked for −2 dB;
   - `decode` (`:158-166`): `if (context.state === 'suspended') await context.resume()` (`:162`, the autoplay-policy fix), then the `Uint8Array` is **copied into a fresh `ArrayBuffer`** (`:163-164` — required because `decodeAudioData` detaches) and handed to `context.decodeAudioData`;
   - `sink.play` (`:167-174`): `createBufferSource()` → `.buffer = buffer` → `.connect(gain)` → `.start()` (no scheduling offset: chunks play strictly back-to-back, per the file header `:1-2`);
   - `dispose` (`:175-177`): `context.close()`.
8. **Player lifecycle** — `dispose()` (`:89-92`) = `stop()` + `options.dispose?.()`. `stop()` (`:75-82`) bumps the generation, empties the queue, and fires `onEnd` if started. Invoked from `App.tsx:159-162` (`onDispose`) and from the barge path `App.tsx:235`.

**Finding — the E2E proves the indicator, not the sound.** `e2e/downlink.spec.ts:19-23` injects 8 bytes `[0xff,0xfb,0x90,0x00,1,2,3,4]`; after the 3-byte header the player receives a **5-byte payload that is not a valid MP3**, so `decodeAudioData` rejects and `playback.ts:107-109` swallows it. The `speaking-indicator` appears purely because `enqueue` set `started` at `playback.ts:63-66`. Nothing in the E2E suite asserts that a byte ever reached `context.destination`. Whether real Fish MP3 decodes in WebView2 is **UNVERIFIED** in this tree.

**Finding — no `AnalyserNode`.** `docs/COMPREHENSIVE_AUDIT_REPORT.md:441` recommends mirroring speaker RMS with an `AnalyserNode`; `playback.ts` contains none. The waveform's amplitude is driven **only by mic RMS** (`App.tsx:564` → `SiriWaveCanvas.tsx:99,129-132`), so the thread does not track what is being said.

### 3.3 Earcons — `src/audio/earcons.ts`

`export type EarconKind = 'arm' | 'disarm' | 'abort' | 'kareem-done' | 'nour-done';` — `:4`.
`RECIPES`, `:13-19`, **exact values**:

| Kind | `frequency` (Hz) | `endFrequency` (Hz) | `durationMs` | `OscillatorType` | Line |
|---|---|---|---|---|---|
| `arm` | **1800** | **1800** | **40** | `triangle` | `:14` |
| `disarm` | **900** | **700** | **60** | `triangle` | `:15` |
| `abort` | **120** | **60** | **180** | `sine` | `:16` |
| `kareem-done` | **659.25** | **987.77** | **220** | `sine` | `:17` |
| `nour-done` | **987.77** | **1318.5** | **220** | `sine` | `:18` |

(659.25 Hz = E5, 987.77 Hz = B5, 1318.5 Hz = E6 — exact equal-temperament values, consistent with a designed rising pair.)

DSP (`renderEarcon`, `:40-58`):
- `length = floor(sampleRate * durationMs / 1000)` (`:45`) → at 48 kHz: `arm` 1920, `disarm` 2880, `abort` 8640, `kareem-done`/`nour-done` 10560 samples.
- mono (`createBuffer(1, length, sampleRate)`, `:46`), linear frequency glide `f0 → f1` over the buffer with integrated phase (`:52-53`) — a swept glide, not a glitch.
- envelope `Math.sin(Math.PI * t) ** 2`, raised-cosine, click-free (`:54`).
- output scale `* 0.5` (`:55`).
- `triangle(phase)` is a 4-term Fourier series scaled by `8/π²` (`:26-33`); `osc()` dispatches `triangle` vs `Math.sin` (`:35-37`).

`EarconPlayer` (`:60-106`): per-kind `AudioBuffer` cache (`:61`, `:76-87`), `Set<AudioBufferSourceNode>` of live sources (`:62`, `:91-92`), lazy `AudioContext` created only by `unlock()` (`:68-71`, "prime on first trusted gesture"), `play()` is a **silent no-op when `context === null`** (`:74`), buffers connect **straight to `destination`** with no gain (`:90`) — so earcons bypass the 0.9 playback gain entirely. `abort()` (`:97-106`) stops tracked sources individually and never suspends the shared context.

**Finding — `earcons.ts` has zero production importers.** The only reference in the whole desktop tree is its own test, `src/audio/earcons.test.ts:2`. `App.tsx` imports `capture`, `playback`, `vad` (`:10-12`) and nothing from `earcons`. Verified by a case-sensitive recursive grep over `apps/desktop/src` and `apps/desktop/e2e`. **The five earcons are DSP-complete and never sound.** Its 5 tests are green, which is precisely the "green suite + zero importers" pattern the repo warns about.

---

## 4. `SPEAKER_PALETTE` and where `waveSpeaker` is decided

### 4.1 The exact colours

`src/components/waveform/SiriWaveCanvas.tsx:20-24`:

```ts
export const SPEAKER_PALETTE: Record<WaveSpeaker, readonly [string, string]> = {
  user:   ['#2563EB', '#EAB308'],
  kareem: ['#16A34A', '#EAB308'],
  nour:   ['#9333EA', '#EC4899'],
};
```

`WaveSpeaker = 'user' | 'kareem' | 'nour'` (`:14`). `DEFAULT_PALETTE = SPEAKER_PALETTE.user` (`:26`). The literals are uppercase on purpose — `mixHex` uppercases its output (`:42`) so the ramp **endpoints are byte-identical** to the declared constants (comment `:35-37`).

### 4.2 Where `waveSpeaker` is decided — one line

`src/App.tsx:415`:

```ts
const waveSpeaker: WaveSpeaker = speaking || voicePhase === 'speaking'
  ? (persona === 'nour' ? 'nour' : 'kareem')
  : 'user';
```

Precedence: if the assistant is speaking (local playback flag **or** daemon phase) the persona's palette wins; otherwise the thread belongs to the human. Consumed at `App.tsx:563` → `palette={SPEAKER_PALETTE[waveSpeaker]}`.

### 4.3 How the palette becomes pixels

- Resolved to stops at `SiriWaveCanvas.tsx:117`: `palette ?? (color !== undefined ? [color, color] : DEFAULT_PALETTE)`.
- 5 curves, `CURVES` at `:63-69`: `{attenuation, lineWidth, opacity}` = `(-2,1,0.1) (-6,1,0.2) (4,1,0.4) (2,1,0.6) (1,1.5,1)`. Comment `:60-62` records that upstream iOS-classic uses `lineWidth 1.5` on the top curve and the old port used 2.5 "which is why the thread read as a bar".
- Per-curve stroke: `ctx.strokeStyle = mixHex(stops[0], stops[1], c / (CURVES.length - 1))` (`:153`) → `t ∈ {0, 0.25, 0.5, 0.75, 1}` across the 5 curves. `mixHex` (`:38-43`) clamps `t`, lerps per channel, rounds, pads to 2 hex digits, and `.toUpperCase()`s.
- Geometry: `WIDTH=320`, `HEIGHT=90`, `CY=45` (`:56-58`); centre-peaked envelope `1 / (1 + ((x-cx)/(WIDTH*0.26))**4)` (`:145`); x stepped by 2 px (`:142`); y scaled by `amplitude * 34`.
- Amplitude (`:119-135`): `targetSpeed` 0.9 active / 0.15 idle (`:126`); `targetAmp` active `= 0.2 + 0.8*e`, idle `= 0.2*(0.55 + 0.45*e)` with `IDLE_AMPLITUDE = 0.2` (`:74`) and `ACTIVE_AMPLITUDE = 1` (`:76`); asymmetric smoothing `ATTACK = 0.3` / `RELEASE = 0.06` (`:82-83`); `LERP_SPEED = 0.06` (`:71`) for speed; `phase += speed * 0.28` (`:135`).
- `energy` is clamped to 0..1 in an effect (`:99`); initial `amplitude = IDLE_AMPLITUDE * 0.6 = 0.12` (`:120`).
- DPR-aware backing store (`:105-110`), `globalAlpha = curve.opacity` (`:154`).
- Reduced motion (`prefers-reduced-motion`) or the `reducedMotion` prop → **one static frame**, no rAF (`:111-115`, `:161-164`).
- rAF with a `setTimeout(…, 16)` fallback (`:165-166`).

---

## 5. `useAutoSize` — mechanism, participants, RTL

### 5.1 The mechanism (`src/window/useAutoSize.ts`, 90 lines)

`useAutoSize(ref, options)` at `:33`:

1. **Defaults** (`:34-43`): `minWidth 320`, `minHeight 200`, `maxWidth 1600`, `maxHeight 1400`, `paddingX 0`, `paddingY 0`, `disabled false`, `setWindowSize = defaultSetWindowSize`.
2. **Four early returns** (`:45-50`): `disabled`; `ref.current === null`; **`!('__TAURI_INTERNALS__' in window)`**; `typeof ResizeObserver === 'undefined'`. This is why the hook is inert in web/E2E/unit runs — the E2E therefore asserts **nothing** about window sizing.
3. **Measure** (`:60-62`): `el.scrollWidth > 0 ? el.scrollWidth : rect.width`, and the same for height — full content extent including overflow, falling back to the border box only when the element reports 0.
4. **Clamp** (`:63-64`): `Math.ceil(raw + padding)`, then `Math.min(max, Math.max(min, …))`.
5. **Tolerance guard** (`:67`): skips the push when `|Δw| < 2 && |Δh| < 2` — explicitly to avoid a resize feedback loop (comment `:65-66`).
6. **Push** (`:69-75`): a floating async IIFE calling `setWindowSize(w, h)`, `try/catch` swallowing failures ("fail soft").
7. **Trigger** (`:78-83`): `ResizeObserver` → `cancelAnimationFrame` → `requestAnimationFrame(apply)` (coalesced to one layout per frame); `observer.observe(el)` then an **immediate** `apply()`.
8. **Teardown** (`:84-88`): `cancelled = true`, `disconnect()`, `cancelAnimationFrame`.
9. `defaultSetWindowSize` (`:14-17`): dynamic `import('@tauri-apps/api/window')`, then `getCurrentWindow().setSize(new LogicalSize(w, h))`.
10. Deps array (`:89`) includes every option — options are not stable by default, so an inline object literal re-runs the effect each render. All three call sites pass an inline literal (`App.tsx:68`, `SettingsView.tsx:66`, `KeysView.tsx:22`).

### 5.2 Which elements participate

| Surface | Measured element | Options | Line |
|---|---|---|---|
| HUD | the inner **card** `<div ref={cardRef}>`, `w-[440px] … rounded-lg border … vx-sketch-card` | `{ paddingY: 16 }` only → min 320×200, max 1600×1400 | `App.tsx:67-68`, element `:443-447` |
| Settings | the surface root `<div ref={rootRef}>` | `{ minWidth: 560, minHeight: 460, maxWidth: 900, maxHeight: 1000, paddingX: 2, paddingY: 2 }` | `SettingsView.tsx:65-66`, element `:136-142` |
| Keys | the surface root `<div ref={rootRef}>` | `{ minWidth: 560, minHeight: 460, maxWidth: 820, maxHeight: 1000, paddingX: 2, paddingY: 2 }` | `KeysView.tsx:21-22`, element `:80-86` |

Consequences, derived from the JSX:

- **In flow, therefore changing measured height:** the reconnect hint (`App.tsx:468-476`), the notice banner (`:478-507`), the session/context/agent/persona block (`:509-558`), `last-transcript` (`:605-609`, conditional), the speaking indicator (`:610-614`, conditional), the footer (`:637-655`).
- **Not participating:**
  - `ConfirmPortal` — `PortalShell` renders through `createPortal(..., document.body)` (`PortalShell.tsx:60-72`), so it lives outside the measured card entirely. Opening an FR-12 confirmation does **not** resize the window.
  - The session dropdown — `absolute inset-x-0 top-full` (`SessionChip.tsx:89`), and `.vx-session-bar { max-height: 48px }` (`tokens.css:173-177`) is a hard ceiling explicitly added so history "can NEVER stretch the auto-sized HUD". The list is also unmounted while closed (`SessionChip.tsx:84`), so it is not even in the DOM.
- **Window config:** `tauri.conf.json:16-23` — `width 440`, `height 600`, `resizable false`, `maximizable false`, `decorations false`, `transparent true`, `shadow true`. The child windows are created at runtime by `open-settings.ts:26-36` with `720×600`, `minWidth 560`, `minHeight 460`, `resizable true`, `decorations true`, `center true`.

### 5.3 RTL / Arabic — confirmed from source

- **`dir="rtl"` is set on all three surface roots**: `App.tsx:437`, `SettingsView.tsx:138`, `KeysView.tsx:82`. Nowhere else — and **never on `<html>` or `<body>`** (verified by grep: the only `dir=` occurrences in the desktop tree are those three).
- **`index.html:2` is `<html lang="en">`** — confirmed, and confirmed still `lang="en"` in the built artifact `apps/desktop/dist/index.html:2`. There is no `dir` attribute in `index.html` at all. The whole document therefore has `lang="en"` (screen-reader voice) while its content is Arabic and its direction is set per-subtree. `AGENTS.md:138` calls this a "known inconsistency" — **confirmed true**.
- Physical RTL-agnostic CSS is used throughout: logical utilities `ms-auto` (`App.tsx:462`, `SessionChip.tsx:81`), `border-e` (`SettingsView.tsx:147`), `text-start` (`SessionChip.tsx:100`, `SettingsView.tsx:164`, `:208`).
- **Font inconsistency.** `index.css:29` declares `font-family: Tajawal, 'Readex Pro', system-ui, sans-serif` on `body`, but every surface overrides it with `var(--vx-font)` — `App.tsx:33` + `:441`, `SettingsView.tsx:141`, `KeysView.tsx:85` — and `--vx-font` is `-apple-system, 'Segoe UI', Tahoma, Arial, sans-serif` (`tokens.css:25`), which contains **no Arabic-specific face beyond Tahoma**. The declared Arabic webfont stack is dead CSS; no `@font-face` exists in the tree.
- Scrollbars: `scrollbar-width: none; -ms-overflow-style: none` on `*` plus `*::-webkit-scrollbar { width: 0; height: 0; display: none }` (`tokens.css:46-59`) — chrome hidden but scrolling preserved, with the rationale in the comment. `html, body, #root` also get `overflow: hidden; overscroll-behavior: none` and `background: #090a0f !important` (`:30-40`).

---

## 6. Persona switching — the full path to the daemon

Two independent UI entry points, one daemon, one guard.

### 6.1 From the HUD

1. Radio group `role="radiogroup" aria-label="شخصية الصوت"` with two buttons `data-testid="hud-persona-kareem"` / `hud-persona-nour` (`App.tsx:538-557`), labels `كريم` / `نور` (`:554`), tooltips `كريم — الصوت الافتراضي` / `نور — الصوت البديل` (`:546`).
2. `onClick={() => handleSelectPersona(p)}` (`:547`).
3. `handleSelectPersona(id)` (`:319-323`): **three** writes —
   - `setPersona(id)` (`:320`) — optimistic local write;
   - `setMatrix(id === 'kareem' ? 3 : 4)` (`:321`) — the matrix recolours immediately;
   - `send({ id: nextCmdId(), kind: 'setPersona', persona: id }, 'تعذّر تبديل الشخصية')` (`:322`).
4. `nextCmdId()` (`:76-80`): `crypto.randomUUID()` when available, else `cmd-<Date.now()>-<counter>-<rand>`.
5. `send()` (`:288-307`): returns `'الخادم غير متصل'` if there is no bridge (`:289-292`); else `sendCommandDetailed(...).then(outcome => …)` — only `!outcome.ok` shows the failure text (`:305`), because on success the daemon supplies the spoken line.

### 6.2 From the settings window

1. Voice tab (3rd of 4: `models`, `skills`, `voice`, `system` — `SettingsView.tsx:21-28`), `data-testid="persona-group"` / `persona-kareem` / `persona-nour` (`:281-298`).
2. `selectPersona(id)` (`:114-117`): `setPersona(id)` then `void bridgeRef.current?.sendCommand({ id: nextCmdId(), kind: 'setPersona', persona: id })`. **Fire-and-forget — no ack, no failure text.**
3. That window has its **own** `VoxauraBridge` and its own token resolution (`SettingsView.tsx:71-98`).

### 6.3 The daemon side

- Router: `src/orchestrator/command-router.ts:196-200` — `if (cmd.persona === undefined) return { ok:false, detail:'persona required' }`, then `deps.setPersona?.(cmd.persona)`, then `{ ok: true, detail: 'persona-set' }`.
- Callback: `src/daemon.ts:245-260`.
- **`hello` propagation:** `UiServer.setPersona(persona)` stores it for the *next* connection (`src/ipc/ui-server.ts:132-134`, comment `:127-131`), and `hello` includes it only when defined: `...(this.persona !== undefined ? { persona: this.persona } : {})` (`ui-server.ts:383-386`). The renderer's `HelloMsg.persona` is **optional** (`ws.ts:24`, with the rationale at `:19-23`) so a pre-L22 daemon simply omits it.
- **`persona-changed` notice:** `ui.notice('persona-changed', persona, 'info')` (`daemon.ts:259`) → `ui-server.ts:210-212` → broadcast to **every** connected socket.

### 6.4 The equality guard (the echo-loop defence)

`src/daemon.ts:256`:

```ts
if (activePersona === persona) return;
```

Full callback (`daemon.ts:245-260`): guard → `activePersona = persona` (`:257`) → `ui.setPersona(persona)` (`:258`) → `ui.notice('persona-changed', persona, 'info')` (`:259`). The rationale is spelled out at `:246-255`.

**This makes a re-send a silent no-op:** the router still returns `{ ok: true, detail: 'persona-set' }` (`command-router.ts:199`) because the guard lives *below* the router, in the daemon callback — the ack does not distinguish "applied" from "already current".

**Client-side half of the guard — two independent ref comparisons, and neither one re-sends:**

| Surface | Guard | Sends `setPersona` back? |
|---|---|---|
| HUD | `onNotice`: `if (n.code === 'persona-changed' && (n.detail === 'kareem' \|\| n.detail === 'nour'))` then `if (n.detail !== personaRef.current) setPersona(n.detail)` — `App.tsx:122-124` | **No** — the handler sets local state and nothing else; the comment at `:115-121` states this explicitly ("It must not send `setPersona` back… the correct behaviour is to not start it") |
| HUD (on connect) | `onHello`: `if (h.persona !== undefined && h.persona !== personaRef.current) setPersona(h.persona)` — `App.tsx:109-111` | No |
| Settings | `onNotice`: same two-step check — `SettingsView.tsx:87-89`; comment `:85-86` "Local state ONLY — sending back would bounce the change between the two windows" | **No** |
| Settings (on connect) | `onHello`: `SettingsView.tsx:80-82` | No |

**Ref, not state, is what makes this work.** `personaRef` is kept current in a `useEffect`, never during render: `App.tsx:70,72-74` and `SettingsView.tsx:58-61`. `SettingsView.tsx:49-57` explains why — comparing against the `persona` state directly would tear down and re-create the bridge on every change and drop the connection mid-flight.

**Server-side guard test:** `src/ipc/persona-propagation.test.ts` — real loopback sockets, asserts (a) a change emits exactly `[{code:'persona-changed', detail:'nour'}]` (`:160-163`), (b) `hello` carries the persona for a late shell (`:165-179`), and (c) an unchanged persona emits nothing (the loop defence, `:141-145`). The harness even copies the guard **verbatim** from `daemon.ts` (`:140-144`) — a copy, not an import, so the test can drift from the production code.

**Channel-crossing detail:** the settings window is opened with the persona in the URL, `index.html?view=settings&persona=<p>` (`open-settings.ts:44-50`), and `main.tsx:16` parses it with a `'nour'`-else-`'kareem'` coercion. Off-Tauri it is a `window.open` popup (`open-settings.ts:39`); under Tauri a `WebviewWindow` labelled `settings` (or `api-keys`), reusing an existing one by label via `WebviewWindow.getByLabel` (`:21-25`). Because the query is only a hint, `onHello` is what actually corrects it.

---

## 7. E2E — `apps/desktop/e2e/`

### 7.1 Every spec file (14 files, 18 `test()` blocks) and what it asserts

| # | File | Tests | Asserts |
|---|---|---|---|
| 1 | `abort.spec.ts` (22 L) | 1 | pill contains `متصل وبانتظار الأوامر`; after `POST /fire {state:'complete'}` the canvas `data-mode` becomes `active`; clicking `abort-button` flips it back to `idle`; `GET /commands` contains a `kind === 'abort'` |
| 2 | `apikeys.spec.ts` (46 L) | 1 | clicking `open-apikeys` opens a **second page**; banner contains `All 3 API keys are required`; `apikey-save` is disabled, stays disabled after 1 key and after 2 keys, becomes enabled after the 3rd; after save, `GET /commands` contains `saveApiKeys` with `groqKey`/`fishKey`/`openrouterKey` matching the literals `gsk-e2e-groq`, `sk-fish-e2e`, `sk-or-e2e` |
| 3 | `bargein.spec.ts` (55 L) | 1 | records aborts before; `POST /audio/reset`; unmute mic and poll `GET /audio` until `frames > 0` (15 s); then loop up to **25 s** re-posting `POST /audio-down` with the 8-byte fake MP3 every 1 s, expecting the abort count to increase; asserts mic frames > 0; re-mutes to restore the default |
| 4 | `boot.spec.ts` (44 L) | 2 | (a) shell, pill text + `data-state='ready'`, `waveform-emblem`, `siri-wave`, `mic-toggle`, `bot-toggle`, `abort-button` all visible, and **`icon-cluster` and `action-bar` have count 0** (regression against the removed duplicate toolbar); (b) mic `title` matches `/الميكروفون/`, `aria-pressed` true→false on click, the `assistant-said` notice contains `كتمت الميكروفون` while the announce line and the banner **do not** contain `تم إيقاف` or `بنجاح`; bot toggle title `/صوت المساعد/` and `aria-pressed` flips to `true` |
| 5 | `capture.spec.ts` (37 L) | 1 | mic starts `aria-pressed='true'`; unmute → poll `GET /audio` frames > 0 (15 s) and `bytes > 0`; re-mute → after 1 500 ms at most **one** additional in-flight frame |
| 6 | `controls.spec.ts` (78 L) | 2 | (a) publish `ses_a` inventory, select it via `session-chip-trigger` → `session-ses_a`, accept `window.prompt` with `build` → `setSessionAgent` with `sessionId:'ses_a'`, `agent:'build'`; same for `model:'opus'` → `setSessionModel`; and `badge-agent` shows `build` while `badge-model` has count 0 (raw model id hidden in compact mode); (b) publish `agents:[build, architect]` → `agent-select` visible with **3** options (disabled placeholder + 2), `selectOption('architect')` → `setSessionAgent` with `agent:'architect'` |
| 7 | `disconnect.spec.ts` (13 L) | 1 | `POST /kill` → pill text contains `غير متصل` within 15 s; `POST /revive` for file-order independence |
| 8 | `downlink.spec.ts` (24 L) | 1 | `speaking-indicator` count 0 at rest; `POST /audio-down` returns `{chunks: 1}`; `speaking-indicator` becomes visible within 5 s |
| 9 | `fr12.spec.ts` (62 L) | 1 | opens a **raw `WebSocket` from `page.evaluate`** to `ws://127.0.0.1:4097/v1/ui?lastSeq=0` with protocols `['voice-ui.v1','e2e-token']`; sends `execSessionShell {command:'rm -rf build'}` → ack `{ok:true, detail:'confirmation-required'}`; `GET /shells` is `[]` (parked, not executed); `confirm {approve:…}` → `{ok:true}`; a **replayed** confirm → `{ok:false, detail:'no pending action'}`; and `/shells` finally equals exactly `[{session:'ses_e2e', command:'rm -rf build'}]` — executed once |
| 10 | `inventory.spec.ts` (45 L) | 1 | publish 2 sessions → both `session-ses_a` / `session-ses_b` appear behind the dropdown trigger; clicking `ses_b` → `switchSession` with `sessionId:'ses_b'`; publishing an empty inventory → `session-list` count 0 (no fabrication) |
| 11 | `matrix.spec.ts` (24 L) | 1 | `siri-wave` `data-mode` is `idle` initially; `POST /fire {state:'running'}` → `active`; `POST /fire {state:'complete'}` → **still** `active` (because `complete` maps to matrix 3/4 ≠ 0) |
| 12 | `portals.spec.ts` (50 L) | 2 | (a) `open-settings` opens a second page whose URL contains `view=settings`; `settings-view` visible; **4** tabs; `apikey-groq` count 0 (keys decoupled); `chain-list` visible and `[data-testid^="chain-"]` non-empty; voice tab → `persona-nour` `aria-checked='true'`; Escape closes the window; the original shell stays visible; (b) `open-apikeys` opens a page with `view=keys`, `keys-view` visible, **0** tabs, `apikey-groq` visible |
| 13 | `session-compact.spec.ts` (46 L) | 1 | 30 sessions published; `session-chip-trigger` visible and `session-list` count 0; `session-chip` bounding box **height ≤ 48 px**; mic + wave still visible; mic bottom edge `< 1400`; opening the dropdown shows `session-ses_hist_00` and moves the mic's `y` by **< 2 px** |
| 14 | `ux.spec.ts` (42 L) | 2 | (a) `POST /voice {phase:'thinking', transcript:'اعرض الملخص'}` → pill contains `التفكير` and `last-transcript` contains the text; `{phase:'speaking'}` → pill contains `يتحدث`; `{phase:'idle'}` → pill contains `متصل`; (b) `POST /notice {code:'voice-disabled-no-keys', …}` → `notice-banner` contains `المفاتيح` and `notice-open-keys` is visible; `notice-dismiss` → banner count 0 |

**Not asserted anywhere:** audible MP3 output (§3.2), window auto-sizing (§5.1 no-ops outside Tauri), earcons (§3.3), persona propagation (`persona-changed`), the settings-window WS bridge's failure modes, the `context` frame / `ContextGauge` (no spec posts `/context`, and `stub-daemon.mjs` has **no `/context` control endpoint** at all — `GET`/`POST` inventory and agents exist, context does not).

### 7.2 `stub-daemon.mjs` is a FAKE control plane — proof from its own source

**What is real** (imported from the built root daemon, not re-implemented):

| Line | Import | Consequence |
|---|---|---|
| `:5` | `import { UiServer } from '../../../dist/ipc/ui-server.js'` | the **real** zero-dep RFC 6455 server, handshake, ping/pong, resume buffer, connection cap |
| `:6` | `import { createCommandHandler } from '../../../dist/orchestrator/command-router.js'` | the **real** FR-12 router, including `DESTRUCTIVE_KINDS` parking, `CONFIRMATION_TTL_MS`, `SESSION_BUSY`, shell-command validation |
| `:9` | `new UiServer({ token, contractVersion: '3.1.0' })` | contract version pinned to the renderer's hardcoded value |
| `:8` | `token = process.env['VOICE_RUNTIME_IPC_TOKEN'] ?? 'e2e-token'` | the bearer is the literal string `e2e-token` when the env is absent |
| `:47-50` | `srv.onCommand = (cmd) => { received.push(cmd); return router(cmd); }` | every command is recorded for later assertion |

**What is faked — the complete list:**

| Line | Fake | Detail |
|---|---|---|
| `:17-19` | `client.setSessionAgent` | `async () => ({})` — no serve |
| `:19` | `client.setSessionModel` | `async () => ({})` |
| `:20` | `client.toggleSessionSkill` | `async () => ({})` |
| `:21-24` | `client.execSessionShell` | pushes `{session, command}` into `executedShells` and returns `{}` — **never runs a shell** |
| `:26` | `switchSession: () => {}` | silent no-op |
| `:27` | `activeSessionId: () => 'ses_e2e'` | hardcoded session id |
| `:28` | `saveKeys: { saveKeys: async () => ({}) }` | **no vault, no keyring, no encryption, no key material** |
| `:33-45` | `onExecuted` + `narratorLineFor` | a hardcoded Arabic string per command kind; the comment at `:29-32` admits the stub "cannot call a model" and that the spec therefore only proves a supplied line reaches the HUD |
| `:51-53` | `srv.onAudio` | records `pcm.byteLength` only |
| `:57` | `const CONTROL_PORT = 4197` | a plain `node:http` server, `:60-166` |
| `:63` | `'Access-Control-Allow-Origin': '*'` | in-page `fetch` from the vite origin |
| `:66-77` | `POST /fire` | fabricates `{type:'event', eventId:'e2e-<n>', state}` |
| `:78-81` | `GET /commands` | the recorded array |
| `:82-85` | `GET /shells` | the recorded array |
| `:86-89` | `GET /audio` | `{frames, bytes}` counters |
| `:90-94` | `POST /audio/reset` | zeroes them |
| `:95-106` | `POST /audio-down` | `server.broadcastAudio(Buffer.from(bytes))` — real framing, **fake content** |
| `:108-118` | `POST /notice` | real `server.notice(...)` |
| `:119-129` | `POST /voice` | real `server.voice(...)` |
| `:130-139` | `POST /inventory` | real `server.publishInventory(...)` |
| `:140-150` | `POST /agents` | real `server.publishAgents(...)` |
| `:152-155` | `POST /kill` | `server.close()` |
| `:156-164` | `POST /revive` | constructs a **new** `UiServer` and re-listens 4097 |
| `:165` | fallback | `404 {error:'unknown'}` |

**Ports:** WS-4097 (`:168` `await server.start(4097)`; again at `:159` on revive) and HTTP **4197** bound to `127.0.0.1` (`:57`, `:169`). **Port 4096 is never bound** — `opencode serve` does not exist in E2E, which is why `isWellFormedHello`'s `servePort === 4096` check (`ws.ts:167`) passes only because the stub's hello is produced by the real `UiServer` (`ui-server.ts:380` hardcodes `SERVE_PORT`).

**Absent from the E2E process entirely:** Tauri (`main.rs`, the Job Object, `ensure_ipc_token`, `ensure_all_services`), `~/.opencode-voice-runtime/`, the daemon composition root (`src/daemon.ts`), the inventory poller, the coordinator/narrator/inkling, Groq STT, Fish TTS, OpenRouter brain, the vault/keyring, and `useAutoSize`'s Tauri branch.

**Harness facts** (`playwright.config.ts`): `testDir './e2e'`, `testMatch '**/*.spec.ts'` (`:4-5`); `fullyParallel: false`, `workers: 1` (`:6-7`, with the reason in the comment); `retries: 0` (`:8`); baseURL `http://localhost:1420` (`:11`); chromium only, launched with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (`:19-22`) — **that is where the "real capture" in `capture.spec.ts`/`bargein.spec.ts` comes from**; two `webServer` entries — the stub on 4197 and `npm run dev:web -- --port 1420 --strictPort` with `VOICE_RUNTIME_IPC_TOKEN: 'e2e-token'` (`:25-38`), **both with `reuseExistingServer: false`**, so a running install makes the suite fail with `EADDRINUSE`.

**Build dependency:** `apps/desktop/package.json:15` — `"test:e2e": "npm run build --prefix ../.. && playwright test"`. The stub imports `../../../dist/…`, so **E2E tests the freshly compiled `src/ipc` + `src/orchestrator/command-router`, and nothing else from the daemon.**

**Runtime state of the last E2E run on this machine:** `apps/desktop/test-results/.last-run.json` = `{"status":"passed","failedTests":[]}`. I did **not** re-run Playwright in this audit (it would require binding 4096/4097/4099/1420 and driving a real browser); the 14/18 figure is a **static count** of `test()` blocks. Runtime pass/fail is **UNVERIFIED** in this session.

---

## 8. Discrepancies between code and `docs/` / `dossier/`

Ordered by severity. Verdict is mine; the code is authoritative.

| # | Doc claim (with line) | Code reality | Verdict |
|---|---|---|---|
| **D1** | `AGENTS.md:53`: "`test:vantrilex` is **typecheck → eslint → oxlint → root vitest → desktop vitest**. E2E is **not** part of it." `AGENTS.md:25` repeats the shorter chain. | `package.json:24`: `"test:vantrilex": "npm run typecheck && npm run lint && npm run lint:ox && npm run test && npm run test:desktop && npm run test:e2e"` — E2E **is** the last stage. `docs/10-CHECKPOINT.md:719` agrees with the code ("`test:vantrilex` exit 0 **with E2E included**"). | **Doc is FALSE.** AGENTS.md is internally contradicted by the repo's own newest checkpoint. |
| **D2** | `AGENTS.md:54` and `docs/10-CHECKPOINT.md:604,720,726…`: "desktop **149** (23 files)". `dossier/PROJECT_MASTER_DOSSIER.md:33` re-verifies it as "**TRUE — verified** … desktop `149 passed (149)`, 23 files". | Measured this session: **153 passed, 24 files** (§0.2). | **Doc is STALE.** The dossier's "re-executed this session" did not reproduce. |
| **D3** | `docs/RELEASE-CHECKLIST.md:16`: renderer unit "7 files, 44 passed". `:19`: E2E "5/5". `:18`: bundle "160.09 kB JS … **worker chunk 2.78 kB**". | 24 files / 153 tests. **There is no worker in the renderer at all** — `grep -r Worker apps/desktop/src` returns only prose in `matrix-state.ts:1,3,65`. The `.voxaura-matrix` class (`tokens.css:67-71`) is used by no component. | **Doc is FALSE on all three.** The claimed 2.78 kB worker chunk cannot exist. |
| **D4** | `dossier/PROJECT_MASTER_DOSSIER.md:221`: "`matrix-state.ts` (178 L, **192×192** `matrixForDaemonState`)". | `matrix-state.ts:5`: `export const MATRIX_SIZE = 48;` and the file is **177** lines. `matrixForDaemonState` returns `MatrixState` (`0\|1\|2\|3\|4`), never a matrix. 192 px is only the CSS box (`.voxaura-matrix`, `tokens.css:67-71`), never instantiated. | **Doc is WRONG on the dimension**; right by accident on "178 ≈ 177". |
| **D5** | `dossier/PROJECT_MASTER_DOSSIER.md:132`: "`test:vantrilex` = typecheck→eslint→oxlint→vitest→desktop-vitest". | `package.json:24` includes `&& npm run test:e2e`. | **Doc omits a stage** (same defect as D1). |
| **D6** | `docs/21-DESIGN-SYSTEM.md:37-45` — normative earcon set: `complete-green`, `complete-red`, `attention`, `loop-chime`, `duck-ping`, `capture-on`, `capture-off` (7 cues). | Implemented kinds are a disjoint set of 5: `arm`, `disarm`, `abort`, `kareem-done`, `nour-done` (`earcons.ts:4,13-19`). **Zero name overlap.** | **The spec and the code implement different products.** (The doc's own status note at `:49-51` scopes its claim to root `src/`, where earcon references are indeed zero — but a reader would not know the renderer has a second, unwired earcon module.) |
| **D7** | `docs/21-DESIGN-SYSTEM.md:47-49`: "Earcons are synthesized once, cached as LRU-exempt reserved clips … and replayed locally with zero provider calls." | The cache exists (`earcons.ts:61,76-87`) but nothing ever calls `play()`. Zero production importers (§3.3). | **Describes shipped behaviour that does not happen.** |
| **D8** | `dossier/PROJECT_MASTER_DOSSIER.md:217-220` line counts: `App.tsx` 648 L, `ws.ts` 515 L, `playback.ts` 166 L, `SiriWaveCanvas` 193 L, `matrix-state.ts` 178 L. | Measured: **668 / 520 / 181 / 192 / 177** (§0.1). `playback.ts` is off by 15 lines and `SiriWaveCanvas` by 1. | **Stale line counts** (consistent with the dossier being written against an older tree). The *content* claims (bridge owns frames + jittered backoff; `PLAYBACK_QUEUE_CAP`; `SPEAKER_PALETTE` per-speaker gradient; `mic-policy` cause-preserving `onError`) all check out. |
| **D9** | `dossier/PROJECT_MASTER_DOSSIER.md:26`: "`#141413` occurs **only** as a fill inside `Crest.tsx`". | `apps/desktop/src/index.css:9` — `--voxaura-obsidian: #141413;` (and `Crest.tsx:18`). | **FALSE.** The `#faf9f5` / `#cc785c` half of the same row is correct (verified absent from `apps/desktop/src`, `src`, `assets`, `docs`, `dossier`). |
| **D10** | `docs/COMPREHENSIVE_AUDIT_REPORT.md:28`: "Upstream top-curve `lineWidth` is **1.5**; our port uses **2.5**". | `SiriWaveCanvas.tsx:68` — the leading curve now uses `lineWidth: 1.5`, with the fix documented in the comment at `:60-62`. | **Stale (the fix shipped)** — but the same report at `:375-377` describes a dual-wave canvas that no longer exists (`:139-157` draws curves only). Point-in-time audit, not a live defect. |
| **D11** | `docs/COMPREHENSIVE_AUDIT_REPORT.md:441,443`: recommends a speaker-side `AnalyserNode` and 35 % ducking of the thread while TTS is active. | Neither exists: no `AnalyserNode` in `playback.ts`; no ducking factor in `SiriWaveCanvas.tsx`; the only ducking is the **uplink** frame gate (`vad.ts:32-35`). | **Unimplemented recommendation**, not a contradiction. |
| **D12** | `dossier/PROJECT_MASTER_DOSSIER.md:222`: "`e2e/` — **14 spec files**, 18 tests, driven against `e2e/stub-daemon.mjs` (a **fake** control plane: real `UiServer` + real router, fake serve on :4197, no providers, no vault)." | **Fully accurate** — verified file-by-file in §7. This is the one doc claim about E2E that survives scrutiny, including the fake-control-plane framing. | **TRUE.** (Same claim in `AGENTS.md:17` is also accurate.) |
| **D13** | `docs/11-TESTING.md:10-14,24-46,52-59`: runner layout `test/integration/`, fixtures `test/mocks/{serve,groq,fish}.ts`, `bench/latency.ts`, `pnpm bench`, `pnpm stress`. | No `test/`, `bench/`, or `ml/stress` directory exists in the repo root (verified by directory listing). `vitest.config.ts:5` *includes* `test/**/*.test.ts` and `bench/**/*.bench.ts`, but those globs currently match **nothing** in the renderer/desktop tree. `AGENTS.md` itself calls `pnpm-lock.yaml` vestigial with npm as the real package manager, contradicting `pnpm bench`/`pnpm stress`. | **Spec is aspirational and unbuilt.** Nothing in it describes running code. |
| **D14** | `docs/10-CHECKPOINT.md:604-605` ("root 498 (39 files) · cargo test 26") vs `:719-721` ("root 509 (41 files) · cargo test 27"). | Both are historical checkpoint entries for different releases; the newer (`:719`) is the current one. | **Not a defect** — a ledger, and it is ordered. Flagging only because grepping it for "the count" gives two answers; `AGENTS.md:54` picked the older pair (498/26) while simultaneously quoting the newer E2E/desktop figures. |
| **D15** | `AGENTS.md:138`: "`index.html` is `lang="en"` (known inconsistency)" and "`dir="rtl"` on the surface root". | Confirmed exactly: `index.html:2` `lang="en"`, no `dir` anywhere in HTML; `dir="rtl"` at `App.tsx:437`, `SettingsView.tsx:138`, `KeysView.tsx:82` only. | **TRUE.** |
| **D16** | `AGENTS.md:138`: "scrollbars are globally hidden". | `tokens.css:51-59` sets `scrollbar-width: none` / `-ms-overflow-style: none` / `::-webkit-scrollbar{display:none}` on `*`, and `html,body,#root` get `overflow: hidden` (`:38`). Panel-internal scroll is preserved by design (`:46-50`) — `SettingsView.tsx:182` and `SessionChip.tsx:89` keep `overflow-y-auto`. | **TRUE**, with a nuance the doc omits (scrolling is intentionally still functional). |

---

## 9. Defects found in the desktop renderer

### 9.1 Dead production modules (zero importers, tests green)

Verified by case-sensitive recursive grep over `apps/desktop/src` + `apps/desktop/e2e`:

| Module | Only reference | Consequence |
|---|---|---|
| `src/audio/earcons.ts` (107 L) | `src/audio/earcons.test.ts:2` | 5 earcon recipes + `EarconPlayer` never invoked. 5 green tests. |
| `src/components/brand/Crest.tsx` (24 L) | `src/components/brand/Crest.test.tsx:4` | Brand crest never rendered (the header uses `WaveformEmblem`, `App.tsx:449`). 3 green tests. |
| `src/components/portals/CredentialPortal.tsx` (29 L) | `src/components/portals/portals.test.tsx` | Key-count portal never mounted. 1 of the 2 tests in `portals.test.tsx` covers it. |

Partially dead: `src/matrix/matrix-state.ts` — only `matrixForDaemonState` (and its `MatrixState` type) are imported by `App.tsx:13`. `MATRIX_SIZE`, `createField`, `targetInto`, `targetFor`, `lerpToward`, `converged`, `stateBase`, `stateAccent`, `borderMask`, `LERP_ALPHA` are imported **only** by `matrix-state.test.ts`. The whole colour-field renderer (`:67-153`) has no runtime caller.

Unused declared dependencies (`package.json`): **`lucide-react` `^1.48.0` (`:19`)** — zero imports anywhere; **`simplex-noise` `^4.0.3` (`:22`)** — referenced only in a comment (`matrix-state.ts:3`). `docs/10-CHECKPOINT.md:158` credits "Crest, **Lucide icon cluster + action bar**" — the cluster was replaced by hand-drawn glyphs (`ControlGlyphs.tsx`, whose header at `:1-3` says exactly that), yet the package is still installed and `boot.spec.ts:16-17` asserts `icon-cluster`/`action-bar` are **absent**.

### 9.2 The 48×48 matrix is never drawn

`MATRIX_SIZE = 48`, per-state `BASE_HEX`/`ACCENT_HEX` (`matrix-state.ts:11-25`), the five `targetInto` cases (`:86-121`), `lerpToward`, `converged`, `LERP_ALPHA = 0.3` "converges within 15 frames" (`:7`) — all present, all unreachable from the UI. The only matrix-derived value that reaches a component is the integer compared at `App.tsx:432` (`live = matrix !== 0`) feeding `mode` on the canvas (`:562`) and two pill branches (`:426-430`). There is no canvas for it and no worker to run it.

### 9.3 `botMuted` is a cosmetic lie

`toggleBotMute` (`App.tsx:383-387`) flips `botMuted`, swaps the glyph (`BotGlyph`↔`BotOffGlyph`, `:593`), and sends `{kind:'mute'}`. The daemon's router handles `mute`, `deafen`, and `arm` in **one arm with no side effect at all**:

```ts
case 'mute':
case 'deafen':
case 'arm':
  return { ok: true };
```
— `src/orchestrator/command-router.ts:227-230`

And `onAudio` (`App.tsx:141-156`) never consults `botMuted`. **Pressing the assistant-mute button mutes nothing and acks `ok:true`.** Consequences:
- "صوت المساعد مكتوم" is displayed while every sentence plays at full volume through `PLAYBACK_GAIN = 0.9`.
- `deafen` is survivable because the HUD does the mic work locally (`App.tsx:369-381`), but the server's ack still asserts a state change it did not make.
- The "إعادة التوليد" button (`App.tsx:622-625`) sends `arm`, which the daemon also discards — it sets `matrix = 1` locally and re-generates nothing.

This is precisely the "cosmetic control that reports success" class the repo's own conventions forbid.

### 9.4 Uncancelled `onEnd` latch (§1.3)

`App.tsx:147-149` schedules `setSpeakingState(false)` 1 500 ms after `onEnd` and never clears it. Rapid re-entry (a new downlink chunk within 1.5 s of the queue emptying — entirely normal for back-to-back sentences across `ui.broadcastAudio` calls at `daemon.ts:612-617`) clears `speakingRef.current` while audio is queued, mis-driving both `waveSpeaker` (`:415`) and the pill (`:420`). No test covers it.

### 9.5 Single-slot `notice` can hide the keyless CTA

`notice` holds one entry (`:42`). `assistant-said` (fired on every command execution, `daemon.ts:213`) and `persona-changed` (`:259`) both land in that slot. Any one of them evicts a `voice-disabled-no-keys` banner, removing the "أدخل المفاتيح" button at `App.tsx:487-496` — precisely when the app is in its most common degraded state.

### 9.6 Optimistic writes never reconciled

`agentModel` (`:48`) is written locally by `handleSelectAgent` (`:337`), `handleSwitchAgent` (`:353`) and `handleSwitchModel` (`:365`) and is **never** updated from any daemon frame — `agents` (`:140`) carries only `{id, name}`, and there is no agent/model echo frame. A failed `setSessionAgent` (e.g. `SESSION_BUSY`, `command-router.ts:304`) leaves the badge showing an agent the daemon never applied. Same for `matrix` (`:321`) and `persona` (`:320`): all three are set optimistically and only corrected by a later daemon frame that may never come. `agents` is also never cleared when the active session changes.

### 9.7 Local build artifact is incomplete (low severity)

`apps/desktop/dist/` contains **only** `index.html` (392 bytes) whose `<script src="/assets/index-BolOedZb.js">` and `<link href="/assets/index-BK1HaIGH.css">` point at an `assets/` directory that does not exist. The directory is gitignored (`.gitignore:3`) and untracked (`git ls-files apps/desktop/dist` → 0 entries), so this is a local leftover, not a repo defect — but `tauri.conf.json:7` sets `frontendDist: "../dist"`, and a `tauri build` run **without** `beforeBuildCommand` firing would ship a blank window. `beforeBuildCommand: "npm run build"` (`:10`) normally regenerates it, so this is a warning about build-order dependence, not a shipping bug.

---

## 10. UNVERIFIED (deliberately not asserted)

1. **E2E runtime pass/fail.** I did not run Playwright (needs 1420/4097/4197 free and would bind a real browser). The 14-spec / 18-test figure is a static count of `test()` blocks; `test-results/.last-run.json` says the last run passed but is undated and carries no counts.
2. **Real MP3 decode in WebView2.** No test or code path in this tree decodes a valid Fish MP3 through `context.decodeAudioData`. §3.2 shows the E2E deliberately injects 5 bytes of garbage after the header.
3. **The whole auto-size path.** `useAutoSize` returns early unless `__TAURI_INTERNALS__` is present (`:49`), so no test — unit or E2E — has ever executed `setWindowSize`. Whether the window actually resizes correctly under Tauri is unproven here.
4. **Earcon audibility.** No hardware, no `AudioContext`, no production caller (§3.3).
5. **Crate build / `cargo test` for `src-tauri`.** Requires the MSVC env; out of scope and not attempted.
6. **Package audit of `apps/desktop/package-lock.json`** beyond the version field — not inspected.
7. **`docs/25-CLIENT-SERVER-RPC.md`, `docs/16-WORKFLOWS.md` §16.6, `docs/UX-AUDIT.md`** were not line-audited against the renderer; no claim from them is relied upon anywhere above.
8. **Behaviour of `WebviewWindow.getByLabel` under a duplicate-label race** in `open-settings.ts:21-25` — plausible, not observable from source alone.
