import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { classifyError } from './error-class.js';
import { SanitizedErrorClassSchema } from './writer.js';
import { OrchestratorError } from '../common/errors.js';
import { SttTimeoutError, STT_TIMEOUT_MS } from '../voice/stt.js';
import { TtsTimeoutError, FishCreditError } from '../voice/tts.js';
import { FishWsError } from '../voice/fish-ws.js';
import { WsProtocolError } from '../ipc/protocol.js';
import { TaskStoreError } from '../tasks/store.js';
import { VadModelError, VadModelMissing } from '../runtime/vad.js';
import { KnowledgeParityError } from '../knowledge/types.js';
import { RedactionTrip } from '../diag/bundle.js';
import {
  APIError,
  APIUserAbortError,
  APIConnectionError,
  APIConnectionTimeoutError,
  RateLimitError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
} from 'groq-sdk/error.js';

// ─────────────────────────────────────────────────────────────────────────────
// THE CENSUS. Every `err.name` this codebase can actually produce, with the
// class the classifier gives it.
//
// WHY A CENSUS AND NOT A FEW CASES. `classify` used to be a two-string list —
// `name === 'AbortError' || name === 'TimeoutError'` — which is correct for
// exactly the two names it names. It was wrong for `SttTimeoutError`, so every
// STT stall logged `Unknown`, and nothing noticed: the function was a closure
// inside `startDaemon`, so no test could hand it a real error object. The list
// only ever saw the names that were already in it.
//
// Each row below constructs the REAL class. A row that asserted a synthetic
// stand-in would not have caught this, because the bug was that real classes
// were never passed at all.
// ─────────────────────────────────────────────────────────────────────────────

/** A constructor that throws on a missing required argument. */
function make<T>(E: new (...args: never[]) => T, ...args: unknown[]): T {
  try {
    return new (E as unknown as new (...a: unknown[]) => T)(...args);
  } catch (err) {
    return err as T;
  }
}

interface Row {
  readonly label: string;
  readonly err: unknown;
  readonly expectClass: string;
}

const rows: readonly Row[] = [
  // ── OURS ────────────────────────────────────────────────────────────────
  { label: 'SttTimeoutError', err: new SttTimeoutError(STT_TIMEOUT_MS), expectClass: 'TimeoutError' },
  { label: 'TtsTimeoutError', err: new TtsTimeoutError(20_000), expectClass: 'TimeoutError' },
  { label: 'FishCreditError 402', err: new FishCreditError(402, 'out of credit'), expectClass: 'QuotaExceeded' },
  { label: 'FishCreditError 429', err: new FishCreditError(429, 'rate limited'), expectClass: 'QuotaExceeded' },
  { label: 'FishWsError', err: make(FishWsError, 'x'), expectClass: 'Unknown' },
  { label: 'WsProtocolError', err: make(WsProtocolError, 'x'), expectClass: 'Unknown' },
  { label: 'TaskStoreError', err: make(TaskStoreError, 'x'), expectClass: 'Unknown' },
  { label: 'VadModelError', err: make(VadModelError, 'x'), expectClass: 'Unknown' },
  { label: 'VadModelMissing', err: make(VadModelMissing, 'x'), expectClass: 'Unknown' },
  { label: 'KnowledgeParityError', err: make(KnowledgeParityError, 'x'), expectClass: 'Unknown' },
  { label: 'RedactionTrip', err: make(RedactionTrip), expectClass: 'Unknown' },

  // ── ORCHESTRATOR — keyed on `code`, a closed union, so this cannot rot ──
  { label: 'OrchestratorError RATE_LIMITED', err: new OrchestratorError('RATE_LIMITED', true, 'x'), expectClass: 'QuotaExceeded' },
  { label: 'OrchestratorError BRAIN_AUTH', err: new OrchestratorError('BRAIN_AUTH', false, 'x'), expectClass: 'AuthError' },
  { label: 'OrchestratorError BRAIN_REJECTED', err: new OrchestratorError('BRAIN_REJECTED', false, 'x'), expectClass: 'FetchError' },
  { label: 'OrchestratorError SERVE_UNREACHABLE', err: new OrchestratorError('SERVE_UNREACHABLE', true, 'x'), expectClass: 'FetchError' },
  { label: 'OrchestratorError SSE_DISCONNECTED', err: new OrchestratorError('SSE_DISCONNECTED', true, 'x'), expectClass: 'FetchError' },
  { label: 'OrchestratorError CONFIG_INVALID', err: new OrchestratorError('CONFIG_INVALID', false, 'x'), expectClass: 'AuthError' },
  { label: 'OrchestratorError HIGH_STAKES_CONFIRM', err: new OrchestratorError('HIGH_STAKES_CONFIRM_REQUIRED', false, 'x'), expectClass: 'AuthError' },
  { label: 'OrchestratorError CONTRACT_DRIFT', err: new OrchestratorError('CONTRACT_DRIFT', false, 'x'), expectClass: 'ContractDrift' },
  { label: 'OrchestratorError SESSION_NOT_FOUND', err: new OrchestratorError('SESSION_NOT_FOUND', false, 'x'), expectClass: 'Unknown' },

  // ── PLATFORM ───────────────────────────────────────────────────────────
  { label: 'DOMException AbortError', err: abortReason(), expectClass: 'TimeoutError' },
  { label: 'AbortSignal.timeout reason', err: timeoutReason(), expectClass: 'TimeoutError' },
  { label: 'zod ZodError', err: zodError(), expectClass: 'ZodError' },
  { label: 'TypeError fetch failed', err: new TypeError('fetch failed'), expectClass: 'FetchError' },
  { label: 'TypeError (own bug)', err: new TypeError('x is not a function'), expectClass: 'Unknown' },
  { label: 'RangeError', err: new RangeError('x'), expectClass: 'Unknown' },
  { label: 'plain Error', err: new Error('boom'), expectClass: 'Unknown' },
  { label: 'non-Error throw', err: 'a string', expectClass: 'Unknown' },
  { label: 'null throw', err: null, expectClass: 'Unknown' },

  // ── GROQ / Stainless ───────────────────────────────────────────────────
  // MEASURED, and the reason the classifier reads `constructor.name` as well as
  // `name`: this SDK sets NO `name`, so every one of these reports the literal
  // string `'Error'` unless the constructor is consulted.
  { label: 'groq APIConnectionTimeoutError', err: make(APIConnectionTimeoutError, { message: 'x' }), expectClass: 'TimeoutError' },
  { label: 'groq APIUserAbortError', err: make(APIUserAbortError, undefined, undefined), expectClass: 'TimeoutError' },
  { label: 'groq AuthenticationError 401', err: make(AuthenticationError, 401, undefined, 'x', {}), expectClass: 'AuthError' },
  { label: 'groq RateLimitError 429', err: make(RateLimitError, 429, undefined, 'x', {}), expectClass: 'QuotaExceeded' },
  { label: 'groq BadRequestError 400', err: make(BadRequestError, 400, undefined, 'x', {}), expectClass: 'Unknown' },
  { label: 'groq InternalServerError 500', err: make(InternalServerError, 500, undefined, 'x', {}), expectClass: 'FetchError' },
  { label: 'groq APIError 500', err: make(APIError, 500, undefined, 'x', {}), expectClass: 'FetchError' },
  { label: 'groq APIConnectionError', err: make(APIConnectionError, { message: 'x' }), expectClass: 'Unknown' },
];

function abortReason(): unknown {
  const c = new AbortController();
  c.abort(new DOMException('This operation was aborted', 'AbortError'));
  return c.signal.reason;
}

function timeoutReason(): unknown {
  // `AbortSignal.timeout(1)` with a real tick, so the reason is the TimeoutError
  // DOMException rather than the abort signal itself.
  const s = AbortSignal.timeout(1);
  return s.aborted ? s.reason : new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

function zodError(): unknown {
  // `z.string().parse(1)` is the smallest real ZodError this tree can throw.
  // Built through the library rather than a hand-made `{name:'ZodError'}`
  // stand-in: a stand-in would have been satisfied by a classifier that matches
  // the NAME, which is precisely the half of the rule under test.
  try {
    z.string().parse(1);
    return new Error('unreachable');
  } catch (err) {
    return err;
  }
}

describe('classifyError — the full census of err.name this tree can produce', () => {
  test.each(rows.map((r) => [r.label, r.err, r.expectClass] as const))(
    '%s → %s',
    (_label, err, expected) => {
      expect(classifyError(err)).toBe(expected);
    },
  );

  test('every row lands on a member of the closed union', () => {
    // The union is the anti-injection property: no free text can ride the class
    // field. A row that produced a string outside the schema would mean the
    // writer would throw, and `record()` swallows the throw — so the row would
    // be LOST SILENTLY rather than rejected loudly.
    for (const r of rows) {
      expect(SanitizedErrorClassSchema.safeParse(classifyError(r.err)).success, `${r.label} left the union`).toBe(true);
    }
  });
});

describe('the two rows that were wrong before W27', () => {
  // Both of these are the recorded defect and its UNRECORDED twin. The plan named
  // only STT; `TtsTimeoutError` (`tts.ts`) fails the same way, on the same list,
  // and nobody had measured it.
  test('a real SttTimeoutError is a timeout, not Unknown', () => {
    // Constructed for real, not named: `stt.ts` sets `this.name` in its
    // constructor, and the old rule compared two literals that this string is
    // not one of.
    const err = new SttTimeoutError(STT_TIMEOUT_MS);
    expect(err.name).toBe('SttTimeoutError');
    expect(classifyError(err)).toBe('TimeoutError');
  });

  test('and a real TtsTimeoutError likewise — the twin the plan missed', () => {
    const err = new TtsTimeoutError(20_000);
    expect(err.name).toBe('TtsTimeoutError');
    expect(classifyError(err)).toBe('TimeoutError');
  });
});

describe('the rule is a NAME FAMILY, so it cannot rot into a list', () => {
  test('a timeout class this tree has never had is still a timeout', () => {
    // The point of the suffix rule over the old two-string list: adding a class
    // must not require editing the classifier. This is the failure the old list
    // had, expressed as an executable assertion.
    class HypotheticalTimeoutError extends Error {
      constructor() {
        super('x');
        this.name = 'HypotheticalTimeoutError';
      }
    }
    expect(classifyError(new HypotheticalTimeoutError())).toBe('TimeoutError');
  });

  test('BREAK: a SUBSTRING rule would over-match these, and they are not timeouts', () => {
    // Guards the anchoring. `/timeout/i` — or any unanchored variant — would
    // report all three as timeouts; the `$` anchor means a class must DECLARE
    // itself one. If this ever fails, the anchor was widened.
    class TimeoutPolicyError extends Error {
      constructor() {
        super('x');
        this.name = 'TimeoutPolicyError';
      }
    }
    class NotAnAbort extends Error {
      constructor() {
        super('x');
        this.name = 'NotAnAbort';
      }
    }
    class PromptBuilder extends Error {
      constructor() {
        super('x');
        this.name = 'PromptBuilder';
      }
    }
    expect(classifyError(new TimeoutPolicyError())).not.toBe('TimeoutError');
    expect(classifyError(new NotAnAbort())).not.toBe('TimeoutError');
    expect(classifyError(new PromptBuilder())).not.toBe('TimeoutError');
  });

  test('BREAK: dropping the `constructor.name` half loses the whole SDK pair', () => {
    // The reason the rule reads two signals rather than one. Both SDK rows have
    // `name === 'Error'`, so a `name`-only classifier reports `Unknown` for a
    // connection timeout and for a user abort. If this fails, the fallback was
    // removed.
    const timeout = make(APIConnectionTimeoutError, { message: 'x' });
    const abort = make(APIUserAbortError, undefined, undefined);
    expect((timeout as Error).name, 'premise: the SDK sets no name').toBe('Error');
    expect((abort as Error).name, 'premise: the SDK sets no name').toBe('Error');
    expect(classifyError(timeout)).toBe('TimeoutError');
    expect(classifyError(abort)).toBe('TimeoutError');
  });

  test('BREAK: dropping the `name` half loses the platform pair', () => {
    // The mirror image, and the half a constructor-only rule would drop: a
    // DOMException's constructor is `DOMException`, so `AbortError` and
    // `TimeoutError` are visible ONLY through `name`.
    const reason = abortReason() as Error;
    expect(reason.constructor.name, 'premise: name and constructor disagree').not.toBe(reason.name);
    expect(classifyError(reason)).toBe('TimeoutError');
    expect(classifyError(timeoutReason())).toBe('TimeoutError');
  });
});

describe('a stopped waiter is not a provider fault', () => {
  test('an OrchestratorError carrying a stopReason is never a quota or auth problem', () => {
    // `httpStatusOf` returns undefined for a stop, so the status arms cannot
    // fire on a deadline. A task that ran out of time must not be filed as an
    // auth failure — that is the distinction that keeps a key pool from being
    // drained by a slow machine.
    const stopped = new OrchestratorError('SESSION_BUSY', true, 'gave up', 'timeout');
    expect(classifyError(stopped)).toBe('Unknown');
  });
});