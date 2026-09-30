import { describe, expect, test } from 'vitest';

import { dispatchTruth } from './report.js';
import { promptBody } from './serve.js';
import { OrchestratorError } from '../common/errors.js';

// THE TRUTH LINE — the one place a report could describe work that did not happen.
//
// Every case below is a BREAK in the sense that matters: the assertion is that the
// runner says the UNCOMFORTABLE thing. A mapping that returned `DELIVERED` for a
// refusal would satisfy a weaker test, so the tests are written against the
// pessimistic reading and the injection (a wrong input shape) is shown to change
// the output.

describe('dispatchTruth — three states, no fourth', () => {
  test('no attempt at all is NOTHING, and never ok', () => {
    const truth = dispatchTruth({ attempts: 0, delivered: 0, failure: null, resultDetail: 'permission-required', needsPermission: true });
    expect(truth.headline).toBe('NOTHING');
    expect(truth.ok).toBe(false);
    // The reason is the PRODUCT's `detail`, not a word this file chose.
    expect(truth.why).toBe('permission-required');
  });

  test('a refusal with no detail still says permission when that is what happened', () => {
    const truth = dispatchTruth({ attempts: 0, delivered: 0, failure: null, resultDetail: null, needsPermission: true });
    expect(truth.why).toBe('permission required, not granted');
    expect(truth.ok).toBe(false);
  });

  test('BREAK: an attempt that threw is ATTEMPTED, FAILED — and carries the thrown code', () => {
    // THE case this whole file exists for. `attempts: 1` with a failure is what a
    // live serve rejecting the prompt body looks like, and the word on screen must
    // not be anything a reader could take for success.
    const truth = dispatchTruth({
      attempts: 1,
      delivered: 0,
      failure: 'SERVE_UNREACHABLE: session.prompt failed with HTTP 400',
      resultDetail: 'dispatch-failed',
      needsPermission: false,
    });
    expect(truth.headline).toBe('ATTEMPTED, FAILED');
    expect(truth.ok).toBe(false);
    expect(truth.why).toContain('HTTP 400');
  });

  test('BREAK: a partial delivery is not DELIVERED', () => {
    // Two attempts, one landed. Reporting this as delivered would be the same lie
    // one layer up.
    const truth = dispatchTruth({ attempts: 2, delivered: 1, failure: null, resultDetail: null, needsPermission: false });
    expect(truth.headline).toBe('ATTEMPTED, FAILED');
    expect(truth.ok).toBe(false);
    expect(truth.why).toBe('1 of 2 attempts did not land');
  });

  test('a fully delivered dispatch is the only DELIVERED', () => {
    const truth = dispatchTruth({ attempts: 1, delivered: 1, failure: null, resultDetail: null, needsPermission: false });
    expect(truth.headline).toBe('DELIVERED');
    expect(truth.ok).toBe(true);
  });

  test('BREAK: an impossible ledger fails closed rather than reporting DELIVERED', () => {
    // Found by the exhaustive case above: `delivered > attempts` fell through to
    // DELIVERED. More deliveries than attempts is not a good outcome, it is a
    // broken ledger, and a report built on it describes work it has no record of.
    const truth = dispatchTruth({ attempts: 1, delivered: 2, failure: null, resultDetail: null, needsPermission: false });
    expect(truth.headline).toBe('ATTEMPTED, FAILED');
    expect(truth.ok).toBe(false);
    expect(truth.why).toContain('INCONSISTENT LEDGER');
  });

  test('the injection changes the answer: attempts 0→1 moves NOTHING → ATTEMPTED, FAILED', () => {
    // The mapping is load-bearing on `attempts`, not decorative.
    const base = { delivered: 0, failure: 'boom', resultDetail: null, needsPermission: false };
    expect(dispatchTruth({ ...base, attempts: 0 }).headline).toBe('NOTHING');
    expect(dispatchTruth({ ...base, attempts: 1 }).headline).toBe('ATTEMPTED, FAILED');
  });

  test('no headline is ever a word a reader could take for success', () => {
    const headlines = new Set(['NOTHING', 'ATTEMPTED, FAILED', 'DELIVERED']);
    for (const attempts of [0, 1, 2]) {
      for (const delivered of [0, 1, 2]) {
        const t = dispatchTruth({ attempts, delivered, failure: 'x', resultDetail: null, needsPermission: false });
        expect(headlines.has(t.headline), `${attempts}/${delivered} → ${t.headline}`).toBe(true);
        expect(t.ok).toBe(delivered > 0 && delivered === attempts);
      }
    }
  });
});

describe('promptBody mirrors the two shapes ServeClient sends', () => {
  // The diagnostic re-read has to put the SAME bytes on the wire as the request
  // that failed. The first version hardcoded the flat shape, so a `nested` attempt
  // reported a 400 complaining about a missing `prompt` key — the flat shape's
  // error, printed under a nested heading. This pins the distinction.
  test('flat is the bare object', () => {
    expect(promptBody('t', 'flat', { origin: 'cli', actor: 'a' })).toEqual({
      text: 't',
      metadata: { origin: 'cli', actor: 'a' },
      delivery: 'steer',
    });
  });

  test('nested wraps it in `prompt`', () => {
    expect(promptBody('t', 'nested', { origin: 'cli', actor: 'a' })).toEqual({
      prompt: { text: 't', metadata: { origin: 'cli', actor: 'a' }, delivery: 'steer' },
    });
  });

  test('BREAK: the two shapes are genuinely different on the wire', () => {
    const flat = JSON.stringify(promptBody('t', 'flat', { origin: 'cli', actor: 'a' }));
    const nested = JSON.stringify(promptBody('t', 'nested', { origin: 'cli', actor: 'a' }));
    expect(flat).not.toBe(nested);
    // And the difference is the one serve names in its 400: `Missing key at
    // ["prompt"]` (measured live 2026-09-30 through this runner's own diagnostic).
    expect(Object.keys(JSON.parse(flat) as object)).not.toContain('prompt');
    expect(Object.keys(JSON.parse(nested) as object)).toContain('prompt');
  });
});

describe('the runner never invents a transport error', () => {
  test('an OrchestratorError keeps its own code on the path that reports it', () => {
    // `promptCommand` prints `err.code` and `err.message`; a wrapper that stringified
    // the throw would lose the code that says whether the key, the session or the
    // route is the problem. Pinned here because nothing else in the suite reads
    // both fields.
    const err = new OrchestratorError('SESSION_BUSY', true, 'session ses_x busy — backpressure');
    expect(err.code).toBe('SESSION_BUSY');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('backpressure');
  });
});
