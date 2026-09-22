# 06 — API Specification: serve HTTP/SSE, Groq Whisper, Fish Audio TTS & Error Schemas

> **Canonical status:** Foundation. Wire truth. Implements FR-2, FR-3, FR-5, FR-7 (see `01`).
> Types: `05-DATA-MODEL.md` · RPC/reconnect detail: `25-CLIENT-SERVER-RPC.md`.

## 6.1 — Conventions

- Base URL: `http://127.0.0.1:<port>` (default port `4096`, `03` §3.5).
- Auth: `Authorization: Bearer <OPENCODE_SERVER_PASSWORD>` on every `serve` call.
  The password travels in the header and the child-process environment only — never in
  URLs, never in logs (redacted as `[REDACTED]` by `common/logger`).
- All JSON bodies validate against `zod` schemas mapping to `05` types; unknown fields
  are stripped, missing required fields are hard errors (`SESSION_NOT_FOUND`-style
  typed errors, never raw stack text to the ledger).
- Clocks: server timestamps trusted for ordering within a session; local `receivedAt`
  used for ledger sequencing.

## 6.2 — opencode serve: REST Surface (consumed)

### 6.2.1 `GET /health` — readiness probe

```http
GET /health HTTP/1.1
Host: 127.0.0.1:4096
Authorization: Bearer [REDACTED]
```

```json
// 200 OK — ready
{ "status": "ok", "version": "2.x.y" }
```

```json
// 503 — starting / degraded (launcher keeps polling, §26)
{ "status": "starting", "version": "2.x.y" }
```

Poll policy: 250 ms interval, 40 attempts (≤ 10 s cold-boot budget, NFR-10).

### 6.2.2 `POST /session` — create session (`session.create`)

```http
POST /session HTTP/1.1
Content-Type: application/json
```

```json
// Request
{ "directory": "O:/repos/payments", "model": "gpt-oss-120b" }
```

```json
// 201 Created
{ "sessionId": "ses_9f3k…", "state": "creating", "createdAt": "2026-09-22T10:00:00.000Z" }
```

Error: `400` unknown directory · `401` bad password · `409` duplicate idempotency key.

### 6.2.3 `POST /session/{id}/prompt` — dispatch prompt (`session.prompt`)

```json
// Request
{
  "text": "Refactor the retry helper to exponential backoff with jitter.",
  "provenance": { "origin": "voice", "actor": "omar",
    "transcript": "…verbatim STT transcript…" }
}
```

```json
// 202 Accepted
{ "sessionId": "ses_9f3k…", "state": "running", "receipt": "evt_…" }
```

### 6.2.4 `GET /session/{id}` and `GET /session`

```json
// 200 OK — single
{
  "sessionId": "ses_9f3k…", "state": "running", "outcome": "unknown",
  "updatedAt": "2026-09-22T10:04:11.000Z", "lastEventId": "evt_…"
}
```

```json
// 200 OK — list (reconciliation after restart, §10)
{ "sessions": [ { "sessionId": "ses_9f3k…", "state": "running" } ] }
```

### 6.2.5 `GET /openapi.json` — contract-version probe

Fetched once per boot; `info.version` recorded in the ledger. Major-version drift →
`CONTRACT_DRIFT` warning + read-only-safe mode (E-12, `04` §4.5).

## 6.3 — opencode serve: SSE Event Stream (consumed)

```http
GET /event HTTP/1.1
Accept: text/event-stream
Authorization: Bearer [REDACTED]
Last-Event-ID: evt_7c2a…
```

Wire format (one event per dispatch; `event:` carries the lifecycle type):

```
event: agent:action
id: evt_7c2b
data: {"sessionId":"ses_9f3k…","at":"2026-09-22T10:01:00.000Z",
       "payload":{"action":"ran vitest suite","stepIndex":4,"routine":true},
       "cursor":"evt_7c2b"}

event: session:complete
id: evt_7c9d
data: {"sessionId":"ses_9f3k…","at":"2026-09-22T10:04:11.000Z",
       "payload":{"outcome":"green","summary":{…SessionSummary…}},
       "cursor":"evt_7c9d"}
```

Rules (full FSM in `25`): client sends `Last-Event-ID` on every (re)connect; server
replays missed events; client dedupes on `envelope.id` (§5.3 idempotency rule);
heartbeat comments (`: ping`) keep NAT mappings alive; three missed heartbeats →
reconnect with backoff + jitter.

## 6.4 — Groq Whisper STT (multipart, consumed)

```http
POST https://api.groq.com/openai/v1/audio/transcriptions HTTP/1.1
Authorization: Bearer [REDACTED — pool key, keyring-supplied]
Content-Type: multipart/form-data; boundary=…
```

| Part | Value |
|------|-------|
| `file` | Audio chunk (`audio/wav` or `audio/webm`, ≤ 25 MB per part) |
| `model` | `whisper-large-v3-turbo` |
| `language` | `ar` (hint; code-switching preserved — English tokens verbatim) |
| `response_format` | `verbose_json` (word timestamps for chunk stitching) |

```json
// 200 OK (per chunk)
{ "text": "…verbatim bilingual transcript…", "language": "ar",
  "words": [{ "word": "…", "start": 0.0, "end": 0.42 }] }
```

Chunking policy (`18`): 5 s windows with 0.5 s overlap; stitch on word-boundary
timestamps; overlap region deduped by timestamp. Key header uses the keyring-active
Groq key; on `429` → forced rollover + retry with jitter (`20`).

## 6.5 — Groq Chat (cognitive brain, consumed)

```http
POST https://api.groq.com/openai/v1/chat/completions HTTP/1.1
Authorization: Bearer [REDACTED — pool key, keyring-supplied]
Content-Type: application/json
```

```json
{
  "model": "openai/gpt-oss-120b",
  "messages": [
    { "role": "system", "content": "…Ammani prompt system (doc 18 §18.3)…" },
    { "role": "user", "content": "…transcript + session context…" }
  ],
  "temperature": 0.4,
  "max_tokens": 300,
  "stream": false
}
```

```json
// 200 OK
{ "choices": [{ "message": {
    "role": "assistant",
    "content": "{\"intent\": \"followUp\", \"reply\": \"…Ammani Arabic…\"}" } }],
  "usage": { "prompt_tokens": 412, "completion_tokens": 88 } }
```

Budget enforcement is client-side: p50 target 2.0 s, hard timeout 5.0 s → `BRAIN_TIMEOUT`
→ fallback briefing (`02` §2.6). Response `content` is a JSON string validated against
the brain-output schema (`18` §18.3.3) before any speech.

## 6.6 — Fish Audio Streaming TTS (consumed)

Model: `s2.1-pro-free`. Voices resolved from logical IDs (`05` §5.1):

| Logical voice | Fish voice ID | Role |
|---------------|---------------|------|
| `male-default` | `5b90451e0cd34b2788841744af7c55c3` | Default narrator |
| `female-toggle` | `88c0375e46fa4e3b929755fa077ca5ad` | User toggle |

```http
POST https://api.fish.audio/v1/tts/stream HTTP/1.1
Authorization: Bearer [REDACTED — pool key, keyring-supplied]
Content-Type: application/json
Accept: audio/mpeg
```

```json
{
  "model": "s2.1-pro-free",
  "voice": "5b90451e0cd34b2788841744af7c55c3",
  "input": "…briefing text (Ammani + EN technical spans)…",
  "format": "mp3",
  "chunk": true
}
```

```http
HTTP/1.1 200 OK
Content-Type: audio/mpeg
Transfer-Encoding: chunked
```

Playback starts on first chunk (target p50 < 800 ms after text ready, NFR-3).
Cache lookup (`05` §5.4) precedes synthesis: hit → local blob playback (< 50 ms),
no provider call, no keyring acquisition.

## 6.7 — Error Schemas (unified)

All three providers plus `serve` normalize into `OrchestratorError` (`05` §5.7):

| HTTP | Meaning | Mapped code | Retry policy |
|------|---------|-------------|--------------|
| 400 | Bad request / validation | provider-specific | No retry; ledger + operator error |
| 401/403 | Bad key / bad password | `POOL_EXHAUSTED` (provider) / fatal (serve) | Provider: rollover once then fail; serve: halt boot |
| 404 | Unknown session/voice | `SESSION_NOT_FOUND` | No retry |
| 429 | Rate limited | `RATE_LIMITED` | Forced keyring rollover + jittered backoff, max 3 |
| 5xx | Provider/server fault | `TTS_FAILED` / `STT_FAILED` / `SERVE_UNREACHABLE` | Backoff retry, then degraded-mode briefing |
| timeout | No response in budget | `BRAIN_TIMEOUT` (brain) | Fallback briefing, ledger flag |

Rate-limit response bodies SHOULD include `Retry-After`; when present it caps the
jittered delay. Every error written to logs/ledger uses `secretSafeMessage` only —
raw bodies (which may echo keys) are never persisted (`12`).

---

*End of `06-API-SPECIFICATION.md`. Next: `07-IMPLEMENTATION-PLAN.md`.*
