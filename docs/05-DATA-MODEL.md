# 05 — Data Model: Canonical TypeScript Schemas

> **Canonical status:** Foundation. Type truth for all modules.
> Ingress data enters as `unknown` and is validated with `zod`; the inferred types below
> are the only shapes that cross module boundaries (`03` §3.2).

## 5.1 — Conventions

- All timestamps: ISO-8601 UTC strings (`ISODateString`), never epoch numbers at boundaries.
- All IDs: opaque non-empty strings; `SessionId`, `EventId`, `ApprovalId` are branded types.
- Secrets NEVER appear in these schemas — the vault blob (§5.5) stores ciphertext only,
  and key material is held in zeroed buffers inside `keyring.ts`, never in ledger rows.
- Optional properties use `exactOptionalPropertyTypes` semantics: absent ≠ `undefined`
  unless explicitly declared.

```ts
// src/common/brands.ts — shared primitives
export type ISODateString = string; // validated: /^\d{4}-\d{2}-\d{2}T/
export type SessionId = string & { readonly __brand: 'SessionId' };
export type EventId = string & { readonly __brand: 'EventId' };
export type ApprovalId = string & { readonly __brand: 'ApprovalId' };
export type VoiceId = 'male-default' | 'female-toggle';

export const VOICE_IDS = {
  'male-default': '5b90451e0cd34b2788841744af7c55c3',
  'female-toggle': '88c0375e46fa4e3b929755fa077ca5ad',
} as const;

export type SessionState =
  | 'creating' | 'running' | 'awaiting-approval'
  | 'idle' | 'complete' | 'error' | 'aborted';

export type SessionOutcome = 'green' | 'red' | 'amber' | 'unknown';
```

## 5.2 — Sessions

```ts
// src/orchestrator/session.ts
export interface SessionRecord {
  readonly sessionId: SessionId;
  readonly directory: string;            // absolute repo path
  readonly model?: string;               // e.g. 'gpt-oss-120b' or upstream model id
  state: SessionState;
  outcome: SessionOutcome;
  readonly createdAt: ISODateString;
  updatedAt: ISODateString;
  lastEventId?: EventId;                 // SSE replay cursor per session
  briefingCount: number;                 // T1 briefings delivered
  pendingApproval?: ApprovalId;
  provenance: SessionProvenance;         // how the session was created
}

export interface SessionProvenance {
  readonly origin: 'voice' | 'cli' | 'mobile' | 'reconciled';
  readonly transcript?: string;          // verbatim STT transcript (voice origin)
  readonly actor: string;                // operator identity
}

export interface SessionSummary {
  readonly sessionId: SessionId;
  readonly outcome: SessionOutcome;
  readonly filesTouched: readonly string[];
  readonly tests?: { readonly passed: number; readonly failed: number };
  readonly errorExcerpt?: string;        // redacted, secretSafe
  readonly blufLead: string;             // ≤ 15 spoken words, outcome first (doc 02)
  readonly fullText: string;             // Ammani narrative + EN technical spans
}
```

```ts
// zod ingress validator (illustrative shape — full schemas live in src/)
import { z } from 'zod';
export const SessionRecordSchema = z.object({
  sessionId: z.string().min(1),
  directory: z.string().min(1),
  model: z.string().optional(),
  state: z.enum(['creating','running','awaiting-approval','idle','complete','error','aborted']),
  outcome: z.enum(['green','red','amber','unknown']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastEventId: z.string().optional(),
  briefingCount: z.number().int().nonnegative(),
  pendingApproval: z.string().optional(),
  provenance: z.object({
    origin: z.enum(['voice','cli','mobile','reconciled']),
    transcript: z.string().optional(),
    actor: z.string().min(1),
  }),
});
```

## 5.3 — Event Envelopes (SSE lifecycle)

```ts
// src/orchestrator/events.ts
export type LifecycleEventType =
  | 'session:start'
  | 'agent:action'
  | 'subagent:complete'
  | 'session:complete'
  | 'session:idle';

export interface EventEnvelope<T extends LifecycleEventType = LifecycleEventType> {
  readonly id: EventId;                  // idempotency key — dedupe on redelivery
  readonly type: T;
  readonly sessionId: SessionId;
  readonly at: ISODateString;
  readonly payload: LifecyclePayload[T];
  readonly cursor: string;               // opaque SSE replay cursor (Last-Event-ID)
}

export interface LifecyclePayload {
  'session:start': { readonly directory: string; readonly model?: string };
  'agent:action': {
    readonly action: string;             // secretSafe description
    readonly stepIndex: number;
    readonly routine: boolean;           // true → T0 silent tier (doc 02)
  };
  'subagent:complete': {
    readonly subagentId: string;
    readonly outcome: SessionOutcome;
    readonly digest: string;             // secretSafe
  };
  'session:complete': {
    readonly outcome: SessionOutcome;
    readonly summary: SessionSummary;
  };
  'session:idle': { readonly idleSeconds: number; readonly awaiting?: string };
}

export interface LedgerRow {
  readonly seq: number;                  // monotonic per daemon lifetime
  readonly event: EventEnvelope;
  readonly receivedAt: ISODateString;
  readonly briefingEnqueued: boolean;
  readonly gap?: boolean;                // true if appended after reconnect replay
}
```

**Idempotency rule (normative):** `envelope.id` is the exactly-once key for briefing
enqueue (E-4, E-10). A redelivered `session:complete` with a seen `id` appends a ledger
row marked `duplicate: true` and enqueues nothing.

## 5.4 — Audio Cache Entries (50-clip LRU)

```ts
// src/voice/cache.ts
export interface AudioCacheEntry {
  readonly key: string;                  // sha256(normalizedText + '|' + fishVoiceId)
  readonly text: string;                 // normalized source text (trimmed, whitespace-collapsed)
  readonly voice: VoiceId;
  readonly fishVoiceId: string;          // resolved provider voice id (see §5.1)
  readonly blobPath: string;             // relative path under cache dir
  readonly bytes: number;                // blob size; enforced cap per entry
  readonly createdAt: ISODateString;
  lastHitAt: ISODateString;
  hits: number;
}

export interface AudioCacheStats {
  readonly size: number;                 // live entries, ≤ 50
  readonly maxSize: 50;
  readonly bytesTotal: number;
  readonly bytesCap: number;             // e.g. 64 MiB — LRU evicts by age when exceeded
  readonly hits: number;
  readonly misses: number;
}

export interface AudioCacheConfig {
  readonly dir: string;
  readonly maxEntries: 50;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;        // single-clip ceiling; oversize never cached
}
```

Eviction policy: least-recently-used by `lastHitAt`; ties broken by `createdAt`.
Eviction is synchronous with `set()` — the cache never transiently exceeds bounds.

## 5.5 — DPAPI Vault Blobs

```ts
// src/voice/keyring.ts — persisted vault shape (ciphertext only)
export interface VaultBlob {
  readonly version: 1;
  readonly updatedAt: ISODateString;
  readonly pools: Record<KeyPool, EncryptedPool>;
}

export type KeyPool = 'groq' | 'fish';

export interface EncryptedPool {
  readonly nonce: string;                // base64, unique per encryption
  readonly ciphertext: string;           // base64 — DPAPI(safeStorage).encrypt(JSON(PoolSecrets))
  readonly checksum: string;             // sha256(ciphertext), integrity pre-check
}

export interface PoolSecrets {
  // PLAINTEXT — lives ONLY inside a zeroed buffer between decrypt and use.
  // Never assigned to these interfaces outside keyring.ts; never logged.
  readonly keys: readonly string[];      // ≥ 1 key per pool; ≥ 2 recommended
  readonly activeIndex: number;
  readonly requestCount: number;         // requests served on active key since rotation
}
```

**Vault file:** single JSON blob (`vault/keyring.dat` + OS keychain entry where
applicable), mode `0600` on POSIX / ACL-restricted on Windows. Corrupt checksum →
refuse pool with operator error (E-11); no plaintext fallback.

## 5.6 — Key Rotation State

```ts
// src/voice/keyring.ts — in-memory rotation state machine
export interface KeyRotationState {
  readonly pool: KeyPool;
  readonly poolSize: number;
  activeIndex: number;
  requestCount: number;                  // 0..10 — request #11 triggers rollover
  consecutiveFailures: number;           // 429/auth-fail streak on active key
  lastRolloverAt?: ISODateString;
  lastRolloverReason?: 'count-exhausted' | 'rate-limited' | 'auth-failed' | 'manual';
}

export const ROTATION_LIMIT = 10;        // invariant: rollover ON request #11

export function nextRotation(s: KeyRotationState): {
  readonly rollover: boolean;
  readonly keyIndex: number;
} {
  // Called under the pool mutex BEFORE dispatching the request.
  // requestCount counts COMPLETED requests on the active key.
  if (s.requestCount >= ROTATION_LIMIT) {
    return { rollover: true, keyIndex: (s.activeIndex + 1) % s.poolSize };
  }
  return { rollover: false, keyIndex: s.activeIndex };
}
```

Worked sequence (pool of 3): requests 1–10 → K1 (`requestCount` 0→10); request 11 →
`rollover: true`, active K2, counter reset; requests 12–20 → K2; request 21 → rollover
to K3. Concurrency: the pool mutex serializes `nextRotation` + dispatch + counter
increment so concurrent requests cannot double-spend a slot (`20-KEYRING.md`).

## 5.7 — Configuration and Errors

```ts
// src/common/config.ts
export interface OrchestratorConfig {
  readonly openclaw?: never;             // compile-time guard: no legacy coupling
  readonly serve: { readonly hostname: '127.0.0.1'; readonly port: number };
  readonly voice: {
    readonly default: VoiceId;
    readonly brainGoldenMs: 2000;
    readonly brainCeilingMs: 5000;
    readonly sttModel: 'whisper-large-v3-turbo';
    readonly ttsModel: 's2.1-pro-free';
  };
  readonly cache: AudioCacheConfig;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// src/common/errors.ts
export type ErrorCode =
  | 'SERVE_UNREACHABLE' | 'CONTRACT_DRIFT' | 'SSE_DISCONNECTED'
  | 'SESSION_NOT_FOUND' | 'STT_FAILED' | 'BRAIN_TIMEOUT'
  | 'TTS_FAILED' | 'AUDIO_DEVICE_MISSING' | 'VAULT_CORRUPT'
  | 'POOL_EXHAUSTED' | 'RATE_LIMITED' | 'APPROVAL_EXPIRED';

export class OrchestratorError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly secretSafeMessage: string;    // the ONLY string allowed into logs/ledger
  constructor(code: ErrorCode, retryable: boolean, secretSafeMessage: string) {
    super(secretSafeMessage);
    this.code = code; this.retryable = retryable;
    this.secretSafeMessage = secretSafeMessage;
  }
}
```

---

*End of `05-DATA-MODEL.md`. Next: `06-API-SPECIFICATION.md`.*
