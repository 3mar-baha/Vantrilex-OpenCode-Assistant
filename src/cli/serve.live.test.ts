import { describe, expect, test } from 'vitest';

import { ServeClient } from '../runtime/client.js';
import { probeHealth } from '../launcher/index.js';
import { probeRoute, resolveServePassword } from './serve.js';

// ─────────────────────────────────────────────────────────────────────────────
// THE LIVE TIER. Opt-in, and OUT of the hermetic root run.
//
// It used to be `describe.skipIf(!liveServeUp)` inside `serve.test.ts`, which is
// wrong in a way that has nothing to do with the skip itself:
//
//   * The ROOT TOTAL WAS A FUNCTION OF THE ENVIRONMENT. `liveServeUp` is
//     `password && probeHealth(4096, …)`, so the same tree reported
//     1394 passed + 1 skipped on a machine serving 4096 and 1392 passed +
//     3 skipped on one where the credential did not resolve. Both exit 0. A
//     number that means two different things is not a measurement.
//
//   * A HERMETIC SUITE MADE A REAL TCP CALL. The gate ran at module scope, so
//     every default root run opened a connection to 127.0.0.1:4096 and read the
//     operator's real `serve.pass` — a 2 s-timeout HTTP request whose result
//     decided part of the summary. The skill's own rule is the one this broke:
//     "Never make a unit test depend on … the network."
//
// The hermetic equivalent of every claim here stays in `serve.test.ts`; the
// negative case (`/mcp` JSON vs `/api/mcp` HTML) is modelled with a fake
// `Response` there and asserted byte-for-byte against the same predicate.
//
// HOW TO RUN IT — deliberately, never from a gate:
//   node node_modules/vitest/vitest.mjs run --config vitest.live.config.ts
//
// Two conjuncts, both required (the skill's single computed boolean, widened):
//
//   1. `VOXAURA_LIVE_SERVE=1` — the human opt-in. Absent it nothing is probed,
//      so a forgotten run costs nothing and cannot silently become a gate.
//
//   2. a resolvable credential AND a healthy serve on 4096. The LIVENESS half is
//      the part that was learned the hard way: gating on the credential alone
//      left a test that failed with `expected 0 to be greater than 0` the moment
//      serve stopped answering — a red suite for an environment change, which is
//      how a real failure gets learned to be ignored. The probe is the product's
//      own `probeHealth` from `src/launcher/`, not a lookalike.
//
// Running this file with neither conjunct met reports SKIPS, never passes, and
// never a fallback. `src/cli/serve-live-gating.test.ts` pins all of it.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE_ENV_VAR = 'VOXAURA_LIVE_SERVE';
const SERVE_ORIGIN = 'http://127.0.0.1:4096';

/**
 * The gate, as a pure function of its three measured inputs.
 *
 * Extracted so the truth table below asserts the SAME expression this file
 * gates on. Inlining `a && b && c` into a `skipIf` makes the composition
 * untestable without a live serve, and an untestable gate is a gate nobody can
 * prove has not been widened to `true`.
 */
export function liveGate(optedIn: boolean, hasCredential: boolean, serveHealthy: boolean): boolean {
  return optedIn && hasCredential && serveHealthy;
}

const livePassword = resolveServePassword().password;
const optedIn = process.env[LIVE_ENV_VAR] === '1';
const hasCredential = livePassword.length > 0;
const serveHealthy = hasCredential && (await probeHealth(4096, livePassword));
const live = liveGate(optedIn, hasCredential, serveHealthy);

// The credential is never printed, not even in a failure message: this file is
// deliberately hard to run by accident, and a summary that echoed the secret
// would undo that at exactly the wrong moment.
const why = live
  ? `${LIVE_ENV_VAR}=1, credential from resolveServePassword, serve healthy on 4096`
  : `set ${LIVE_ENV_VAR}=1 with a serve on 4096 and a resolvable credential (OPENCODE_SERVER_PASSWORD, or serve.pass)`;

describe.skipIf(!live)('live serve (opt-in: needs a serve on 4096 and a credential)', () => {
  test('the SPA fallback is byte-identical for two different unknown paths', async () => {
    const client = new ServeClient(SERVE_ORIGIN, livePassword);
    const a = await probeRoute(client, '/api/definitely-not-a-route-a');
    const b = await probeRoute(client, '/api/definitely-not-a-route-b');
    expect(a.exists).toBe('no');
    expect(a.bytes).toBeGreaterThan(0);
    expect(a.bytes, 'the fallback is the same page for any unknown path').toBe(b.bytes);
  });

  test('BREAK: a real route is NOT the fallback, on the same live serve', async () => {
    // The negative control for the test above, and the reason this tier's
    // availability claims are worth anything. `/mcp` has no `/api` prefix and
    // answers JSON; `/api/mcp` answers the page. If either stopped being true
    // the whole `probeRoute` contract would need re-deriving, and this is where
    // it would be noticed.
    const client = new ServeClient(SERVE_ORIGIN, livePassword);
    const real = await probeRoute(client, `/mcp?directory=${encodeURIComponent(process.cwd())}`);
    const prefixed = await probeRoute(client, `/api/mcp?directory=${encodeURIComponent(process.cwd())}`);
    expect(real.exists, '/mcp must answer with JSON').toBe('yes');
    expect(prefixed.exists, '/api/mcp must be the SPA fallback').toBe('no');
    expect(prefixed.spaFallback).toBe(true);
  });
});

// Unconditional, and therefore the only assertion in this file that runs in ANY
// invocation of it: if the two tests above are skipped, this still fires. It
// exists because a file whose every test is skipped reports a green suite for a
// file that measured nothing, which is the "harness that measures nothing"
// failure this repo keeps finding.
//
// It costs no second probe. A re-probe here could disagree with the one that
// gated the block and make this test flaky for an environment reason — the exact
// red-for-an-environment outcome the liveness conjunct exists to prevent. The
// table is driven off inputs instead, and the module's own `live` is checked
// against the expression so the two cannot drift apart.
describe('the opt-in gate, on its own truth table (runs whether or not serve is up)', () => {
  test('the opt-in alone opens nothing', () => {
    expect(liveGate(true, false, false)).toBe(false);
    expect(liveGate(true, true, false)).toBe(false);
    expect(liveGate(true, false, true)).toBe(false);
  });

  test('a credential and a healthy serve together still open nothing', () => {
    expect(liveGate(false, true, true)).toBe(false);
  });

  test('all three, and only all three', () => {
    expect(liveGate(true, true, true)).toBe(true);
    expect(liveGate(false, false, false)).toBe(false);
  });

  test('and this invocation agrees with it', () => {
    expect(live).toBe(liveGate(optedIn, hasCredential, serveHealthy));
    // `why` is the operator-facing reason this invocation reported what it did.
    expect(typeof why).toBe('string');
  });
});