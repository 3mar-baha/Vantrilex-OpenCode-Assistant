import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

describe('promptBody is the body ServeClient ACTUALLY sends (W26)', () => {
  // The diagnostic re-read has to put the SAME bytes on the wire as the request
  // that failed, or its answer describes a different request. That mistake was made
  // twice: first by hardcoding one shape, then by parameterising a `flat|nested`
  // flag that `promptWithKey` never read — so the re-read described a request that
  // could not have been sent, under either flag value.
  //
  // The shape below is DERIVED from `ServeClient.promptWithKey`, not typed here:
  // the guard reads the client source and asserts the two agree. A future edit to
  // the egress that changes the body fails this file instead of silently making
  // the diagnostic describe a request that never happened.
  test('it is the v2 body, with no `metadata` and no envelope flag', () => {
    expect(promptBody('t')).toEqual({ prompt: { text: 't' }, delivery: 'steer' });
  });

  test('BREAK: the body ServeClient builds is byte-identical to this one', () => {
    // Read the production serialiser out of the client source rather than
    // restating it, so the two cannot drift apart silently. This is the load-
    // bearing half: the equality above could be satisfied by any stable body.
    const CLIENT = readFileSync(join(process.cwd(), 'src/runtime/client.ts'), 'utf8');
    const bodies = CLIENT.match(/body: JSON\.stringify\((\{[^\n]*\})\)/g) ?? [];
    expect(bodies.length, 'the prompt egress must still serialise inline bodies').toBeGreaterThan(0);
    expect(bodies.some((b) => b.includes('{ prompt: { text }, delivery: \'steer\' }'))).toBe(true);
    // `metadata` has no home in `PromptInput` (additionalProperties:false) and
    // putting it there measured 400/500 — so its absence is the contract.
    expect(CLIENT).not.toMatch(/body: JSON\.stringify\(\{[^}]*metadata/);
    // The absence of the removed option is asserted in ONE place, not two:
    // `prompt-envelope-removed.test.ts` owns that claim and scans code with a
    // comment stripper. Repeating it here would mean a raw-text grep, which
    // fails on the explanatory comments this very removal left behind — the guard
    // would report its own documentation as a live capability.
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
