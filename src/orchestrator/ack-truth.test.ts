import { readFileSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import type { SessionId } from '../common/brands.js';
import { OrchestratorError, SHELL_STOP_REASON_CODES, errorCodeFor, httpStatusOf, stopReasonOf } from '../common/errors.js';
import { deriveShellOutcome, type UiCommand } from '../ipc/protocol.js';
import { ServeClient } from '../runtime/client.js';
import {
  SHELL_OUTCOME_DETAIL,
  createCommandHandler,
  outcomeOf,
  type ShellOutcomeLike,
  type ShellResultLike,
} from './command-router.js';

// FOUR DEFECTS, ONE FILE, because they are one defect seen from four sides: the
// ack, the `output` frame, the task notice and the `notice` frame were each
// reporting something different about the same command.
//
//   1. `ok` in a `CommandOutcome` said "the command succeeded" while the frame
//      said `unknown` and the notice said `warn`. `ok` is DISPATCH now, and the
//      derived verdict rides `detail`.
//   2. `toggleSessionSkill` called a route that does not exist and reported the
//      SPA HTML fallback as success — behind an FR-12 approval.
//   3. The `output` frame's `commandId` was a daemon task id, not the WS command
//      id, because the router never forwarded `cmd.id`.
//   4. A task timeout, a cancellation and the daemon stopping all surfaced as
//      `ack.detail: 'SESSION_BUSY'`.
//
// Every guard below is behavioural — built from an observation a cooperative
// fake cannot manufacture — and each was broken once and seen to fail. The
// OBSERVED results, in the order they were run, with the number of tests that
// actually went red (a break that "fails" with no named test is a spawn
// failure, not evidence):
//
//   BG1  `{ ok: true }` with the verdict discarded   → 6 failed  (all FIX-1 tests)
//   BG2  `cmd.id` replaced by a placeholder          → 5 failed  (2 behavioural
//        + 2 in command-router.test.ts + 1 in command-tiers.test.ts)
//   BG3  skill guard off (`true` → `false`)          → 3 failed
//   BG4  skill failure swallowed in the router       → 1 failed  (the router half
//        only — every client-half test stayed green, which is what makes the two
//        halves independent rather than two descriptions of one thing)
//   BG5  raw `err.code` restored                    → 2 failed
//   BG7  `outcomeOf` defaults to `ok`                 → 1 failed
//   BG8  stop arm returns 401                        → 1 failed  (see below: the
//        FIRST version of this guard was vacuous, and finding out why changed
//        the implementation)
//   BG10 `errorCodeFor` stops re-coding              → 2 failed
//   BG11 the shared `spaFallbackContentType` neutered → 4 failed (3 mine + 1 the
//        pre-existing `client-shell.test.ts` one, so the refactor into a shared
//        rule did not weaken the original guard)
//   BG12 `unknown` mapped to `shell-outcome-ok`       → 5 failed
//   BG13 the message-prefix shim RE-ADDED to
//        `stopReasonOf`                              → 1 failed  ('THE LEGACY
//        PREFIX TEXT IS NOW AN ORDINARY SESSION_BUSY') — and the
//        one-text-three-reasons test stayed GREEN, because it builds its errors
//        WITH the field and so was never reachable by a text matcher. That
//        asymmetry is the point: a guard that cannot tell the two mechanisms
//        apart cannot prove either is gone.
//
//   BG8b (deleting the `httpStatusOf` stop arm outright) DID NOT FAIL, and is
//   therefore NOT claimed as a second guard. The arm and the fallthrough return
//   the same `undefined`; they are the same observable, so the two injections
//   are not independent and one of them was always untestable. The arm is kept
//   because it is a statement of intent next to a load-bearing default, and its
//   doc comment says so.
//
//   BG6 (rewording a shim prefix) is RETIRED, not deleted: the pin it belonged
//   to was guarding a compatibility table, and the table is gone. It has been
//   replaced by BG13, which guards the mechanism that replaced it.

// ── FIXTURES ─────────────────────────────────────────────────────────────────

interface ShellHarness {
  readonly h: (cmd: UiCommand) => Promise<{ ok: boolean; detail?: string }>;
  readonly calls: Array<{ sessionId: SessionId; command: string; commandId: string }>;
}

function shellHarness(run: (commandId: string) => Promise<ShellResultLike | void>): ShellHarness {
  const calls: Array<{ sessionId: SessionId; command: string; commandId: string }> = [];
  const h = createCommandHandler({
    client: {
      setSessionAgent: async () => undefined,
      setSessionModel: async () => undefined,
      toggleSessionSkill: async () => undefined,
      execSessionShell: async (sessionId, command, commandId) => {
        calls.push({ sessionId, command, commandId });
        return await run(commandId);
      },
    },
    switchSession: () => undefined,
    activeSessionId: () => 'ses_active' as SessionId,
    projectDirectory: () => 'O:/project',
  });
  return { h, calls };
}

/** Park, then confirm, because `execSessionShell` is state-mutating. */
async function runShell(h: ShellHarness['h'], id: string, command: string): Promise<{ ok: boolean; detail?: string }> {
  const parked = await h({ id, kind: 'execSessionShell', command } as UiCommand);
  expect(parked).toEqual({ ok: true, detail: 'confirmation-required' });
  return await h({ id: `${id}-confirm`, kind: 'confirm', confirmId: id } as UiCommand);
}

// ── FIX 1 · WHAT `ok` MEANS ──────────────────────────────────────────────────

describe('FIX 1 — `ok` is DISPATCH, and the verdict is not thrown away', () => {
  test('a completed command with no exit code acks DISPATCHED + UNKNOWN, never plain ok', async () => {
    // The measured live case: `exit 3` and a silent success are byte-identical,
    // so the only honest reading is `unknown`. The old code returned a bare
    // `{ ok: true }`, which under any success reading is the fabrication.
    const { h } = shellHarness(async () => ({ outcome: 'unknown' }));
    expect(await runShell(h, 'c1', 'exit 3')).toEqual({ ok: true, detail: 'shell-outcome-unknown' });
  });

  test('a serve-flagged failure still acks ok:true — because the DISPATCH succeeded', async () => {
    // This is the test that pins the DEFINITION rather than restating it. If
    // `ok` meant "the command worked", this assertion would have to be
    // `ok: false`, and the same code path would be reporting two different
    // meanings of one boolean depending on which verb produced it. It does not:
    // the command WAS dispatched, serve DID answer, the contract held, and the
    // failure is in `detail` where it belongs.
    const { h } = shellHarness(async () => ({ outcome: 'failed' }));
    expect(await runShell(h, 'c1', 'false')).toEqual({ ok: true, detail: 'shell-outcome-failed' });
  });

  test('the one verdict that IS a success is reported as such', async () => {
    // A future serve that sends an exit code makes this reachable. The mapping
    // is total over the three literals, so a future fourth is a compile error
    // rather than a silent fallthrough to `ok`.
    const { h } = shellHarness(async () => ({ outcome: 'ok' }));
    expect(await runShell(h, 'c1', 'true')).toEqual({ ok: true, detail: 'shell-outcome-ok' });
  });

  test('a client that concludes NOTHING is `unknown`, never defaulted to ok', async () => {
    // The `break-the-guard` for this one is changing `outcomeOf`'s final
    // `return 'unknown'` to `return 'ok'`, and the first of these three fails.
    expect(outcomeOf(undefined)).toBe('unknown');
    expect(outcomeOf({})).toBe('unknown');
    expect(outcomeOf({ outcome: 'nonsense' as ShellOutcomeLike })).toBe('unknown');
    const { h } = shellHarness(async () => undefined);
    expect(await runShell(h, 'c1', 'rm -rf build')).toEqual({ ok: true, detail: 'shell-outcome-unknown' });
  });

  test('empty output is NEVER read as failure — it is the same `unknown` as noise', async () => {
    // Explicitly forbidden, and this is the guard against it. `output: ''` is
    // what `exit 3` produces AND what `touch x` produces. Treating it as a
    // failure would invent an exit code the transport never sent.
    const { h } = shellHarness(async () => ({ outcome: 'unknown', ...{ output: '' } }) as ShellResultLike);
    expect(await runShell(h, 'c1', 'exit 3')).toEqual({ ok: true, detail: 'shell-outcome-unknown' });
  });

  test('the ack detail and the output frame can never disagree — same three values, one table', async () => {
    // Cross-surface agreement, stated structurally. `deriveShellOutcome` is the
    // frame's own function (imported from `ipc/protocol.ts`, not re-derived);
    // `SHELL_OUTCOME_DETAIL` is the ack's. The frame emits the bare verdict and
    // the ack emits `shell-outcome-<verdict>`, so equality here means no
    // command can be `warn` in the notice and `ok` in the ack.
    const cases: ReadonlyArray<readonly [ShellOutcomeLike, Parameters<typeof deriveShellOutcome>[0], number | null]> = [
      ['ok', 'completed', 0],
      ['failed', 'completed', 3],
      ['failed', 'error', null],
      ['unknown', 'completed', null],
    ];
    for (const [expected, status, exitCode] of cases) {
      const framed = deriveShellOutcome(status, exitCode);
      expect(SHELL_OUTCOME_DETAIL[framed], `${status}/${String(exitCode)}`).toBe(SHELL_OUTCOME_DETAIL[expected]);
    }
    // And the table is total: three verdicts, three distinct machine codes.
    expect(Object.keys(SHELL_OUTCOME_DETAIL).sort()).toEqual(['failed', 'ok', 'unknown']);
    expect(new Set(Object.values(SHELL_OUTCOME_DETAIL)).size).toBe(3);
  });

  test('a dispatch that FAILS is `ok: false` — the other half of the definition', async () => {
    const { h } = shellHarness(async () => {
      throw new OrchestratorError('SERVE_UNREACHABLE', true, 'serve request failed: ECONNREFUSED');
    });
    expect(await runShell(h, 'c1', 'git status')).toEqual({ ok: false, detail: 'SERVE_UNREACHABLE' });
  });
});

// ── FIX 3 · THE `commandId` IS THE WS COMMAND ID ─────────────────────────────

describe('FIX 3 — the command id is threaded, not dropped', () => {
  test('the id the shell sent reaches the client, through the park', async () => {
    const { h, calls } = shellHarness(async () => ({ outcome: 'unknown' }));
    await runShell(h, 'cmd_exec_7', 'rm -rf build');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.commandId).toBe('cmd_exec_7');
    expect(calls[0]?.sessionId).toBe('ses_active');
    expect(calls[0]?.command).toBe('rm -rf build');
  });

  test('the id is the EXEC command id, not the confirm that released it', async () => {
    // `pending.delete(id)` then `execute(parked.cmd)`: the payload that runs is
    // the one the shell originally sent, so its id is the one the output frame
    // has to carry. A regression reading the confirm's id would pass every other
    // guard in this file.
    const seen: string[] = [];
    const { h } = shellHarness(async (id) => {
      seen.push(id);
      return { outcome: 'unknown' };
    });
    await runShell(h, 'exec-abc', 'git status');
    expect(seen).toEqual(['exec-abc']);
    expect(seen[0]).not.toBe('exec-abc-confirm');
  });

  test('the OTHER four client verbs deliberately take no id, and this pins that', async () => {
    // Read from the SOURCE, so the check is about the declared contract rather
    // than about which stubs happen to exist. One parameter nothing consumes is
    // a false affordance; one missing from the ONE verb that produces a
    // command-keyed frame is the defect. Both directions are pinned here.
    //
    // `break-the-guard`: delete the `commandId` parameter from the interface —
    // the source assertion AND the two behavioural tests above fail.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, 'command-router.ts'), 'utf8');
    const block = source.match(/export interface CommandClient \{([\s\S]*?)\n\}/);
    expect(block, 'the CommandClient block is where this guard looks').not.toBeNull();
    const body = block?.[1] ?? '';
    const signatures = [...body.matchAll(/^\s{2}(\w+)(\??)\(([^)]*)\)/gm)].map((m) => ({
      name: m[1] ?? '',
      params: (m[3] ?? '').split(',').map((p) => p.trim()).filter((p) => p.length > 0),
    }));
    const byName = new Map(signatures.map((s) => [s.name, s.params]));
    // The one that produces the `output` frame carries the id.
    expect(byName.get('execSessionShell')).toEqual(['sessionId: SessionId', 'command: string', 'commandId: string']);
    // The other four do not, and the reason is written on the interface.
    for (const name of ['setSessionAgent', 'setSessionModel', 'toggleSessionSkill', 'createSession']) {
      const params = byName.get(name);
      expect(params, `${name} is declared`).toBeDefined();
      expect(params?.some((p) => p.includes('commandId')), `${name} must not take a commandId`).toBe(false);
    }
  });
});

// ── FIX 2 · `toggleSessionSkill` MUST NOT FABRICATE SUCCESS ───────────────────

const probes: Server[] = [];
afterEach(async () => {
  await Promise.all(probes.splice(0).map((p) => new Promise<void>((res) => p.close(() => res()))));
});

/**
 * A stand-in for opencode serve, built to the measured behaviour that makes the
 * defect possible: **an unknown path answers 200 with the SPA HTML fallback.**
 * Every path that is not explicitly handled gets the same 2 884-byte page.
 */
async function serveLikeProbe(
  handler: (url: string) => { status: number; ct?: string; body?: string } | undefined,
): Promise<string> {
  const probe = createServer((req: IncomingMessage, res: ServerResponse) => {
    const out = handler(req.url ?? '');
    if (out === undefined) {
      res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' });
      res.end('<!doctype html>\n<html><head><title>OpenCode</title></head><body></body></html>\n'.padEnd(2_884, ' '));
      return;
    }
    res.writeHead(out.status, { 'Content-Type': out.ct ?? 'application/json' });
    res.end(out.body ?? '{}');
  });
  probes.push(probe);
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const addr = probe.address();
  if (addr === null || typeof addr === 'string') throw new Error('probe failed to bind');
  return `http://127.0.0.1:${addr.port}`;
}

describe('FIX 2 — the skill verb cannot report success against a route that does not exist', () => {
  test('the SPA fallback is a typed CONTRACT_DRIFT, not a success', async () => {
    // The same rule `execSessionShell` uses (`spaFallbackContentType`), not a
    // second mechanism. `break-the-guard`: pass `false` instead of `true` as
    // `control()`'s sixth argument at `toggleSessionSkill`, and this fails with
    // "promise resolved { ok: true } instead of rejecting" — the measured lie.
    const base = await serveLikeProbe(() => undefined);
    const client = new ServeClient(base, 'pw');
    await expect(client.toggleSessionSkill('ses_abc' as SessionId, 'probe', 'attach')).rejects.toMatchObject({
      code: 'CONTRACT_DRIFT',
      retryable: false,
    });
  });

  test('the refusal is diagnosable from one log line', async () => {
    const base = await serveLikeProbe(() => undefined);
    const client = new ServeClient(base, 'pw');
    await expect(client.toggleSessionSkill('ses_abc' as SessionId, 'probe', 'detach')).rejects.toThrow(/SPA fallback/);
  });

  test('a 204 from a REAL route still succeeds — the guard is not a blanket 2xx refusal', async () => {
    // The control, and the reason the rule tests the CONTENT TYPE and not the
    // status. A guard written as "2xx means fabrication" would break a working
    // verb; the fallback is specifically a response that DECLARES a non-JSON
    // type. This is also the only test that would catch someone "fixing" the
    // defect by refusing every 2xx.
    const base = await serveLikeProbe(() => ({ status: 204, body: '' }));
    const client = new ServeClient(base, 'pw');
    await expect(client.toggleSessionSkill('ses_abc' as SessionId, 'probe', 'attach')).resolves.toEqual({ ok: true });
  });

  test('a 200 JSON answer also succeeds', async () => {
    const base = await serveLikeProbe(() => ({ status: 200, body: '{"data":{"id":"probe"}}' }));
    const client = new ServeClient(base, 'pw');
    await expect(client.toggleSessionSkill('ses_abc' as SessionId, 'probe', 'attach')).resolves.toEqual({ ok: true });
  });

  test('THE ROUTER SURFACES IT: an approved skill attach that reached nothing acks CONTRACT_DRIFT', async () => {
    // The half that matters. The client half is a unit test; this is the
    // end-to-end claim: a user says yes to "attach skill probe", the request
    // hits the fallback, and the ack they get back must not read as success.
    //
    // This router is wired to a REAL `ServeClient` over a REAL loopback probe,
    // so nothing between the throw and the ack is a stub — a fake that returned
    // `{ok:true}` here would pass the client-half tests and fail this one, which
    // is what makes the pair non-redundant.
    //
    // `break-the-guard`: wrap the `toggleSessionSkill` await in
    //    `try { … } catch { return { ok: true, detail: 'skill-attached' }; }`
    // and this fails, while every FIX-2 client test still passes.
    const base = await serveLikeProbe(() => undefined);
    const client = new ServeClient(base, 'pw');
    const handler = createCommandHandler({
      client: {
        setSessionAgent: async () => undefined,
        setSessionModel: async () => undefined,
        toggleSessionSkill: (sessionId, skill, action) => client.toggleSessionSkill(sessionId, skill, action),
        execSessionShell: async () => ({ outcome: 'unknown' }),
      },
      switchSession: () => undefined,
      activeSessionId: () => 'ses_abc' as SessionId,
      projectDirectory: () => 'O:/project',
    });

    // Gated: the user is asked first, and nothing runs on the asking turn.
    const parked = await handler({ id: 's1', kind: 'toggleSessionSkill', skill: 'probe' } as UiCommand);
    expect(parked).toEqual({ ok: true, detail: 'confirmation-required' });

    // Approved. The command reached a route that does not exist.
    const approved = await handler({ id: 's2', kind: 'confirm', confirmId: 's1' } as UiCommand);
    expect(approved).toEqual({ ok: false, detail: 'CONTRACT_DRIFT' });
    expect(approved.ok, 'never a fabricated success').toBe(false);
  });

  test('`setSessionAgent` is NOT guarded, and the reason is stated rather than accidental', async () => {
    // The scope boundary, pinned so the next agent does not "fix" this by
    // blanket-guarding. `/api/session/{id}/agent` may well be another phantom
    // route — nobody has measured it — and turning the guard on for an
    // UNMEASURED verb risks refusing calls that work, which is a fabrication in
    // the opposite direction. The honest state is: skill is measured and
    // guarded, agent and model are unmeasured and labelled as such.
    const base = await serveLikeProbe(() => undefined);
    const client = new ServeClient(base, 'pw');
    // Currently reports success against the fallback — recorded as an OPEN
    // finding, not asserted as correct. If a future measurement proves the
    // route exists, this assertion is what should change.
    await expect(client.setSessionAgent('ses_abc' as SessionId, 'build')).resolves.toEqual({ ok: true });
  });
});

// ── FIX 4 · THREE FAILURES STOP COLLAPSING ONTO `SESSION_BUSY` ───────────────

describe('FIX 4 — a stopped waiter is named, not filed as "busy"', () => {
  /**
   * The three literal messages `src/daemon/shell-tasks.ts` constructs. COPIED
   * here on purpose, and cross-checked against the real file by the pin test
   * below — a copy that is not checked against its source is a second truth.
   *
   * THEY ARE NOW THE UNDECIDING HALF OF THE FIX, not the deciding one. They are
   * still the human-readable diagnostic a user sees in `daemon.log`, and the
   * tests below assert they are consulted for NOTHING.
   */
  const SHELL_MESSAGES = {
    timeout: 'shell: the command exceeded its deadline; the daemon stopped waiting and serve may still be running it',
    cancelled: 'shell: the command was cancelled before it completed',
    stopped: 'shell: the daemon stopped',
  } as const;

  test('a daemon-side deadline, a cancellation and the daemon stopping are three codes', async () => {
    // Constructed the way production constructs them: `code: 'SESSION_BUSY'`
    // plus the TYPED fourth argument. The message is the real one from the throw
    // site and plays no part in the verdict, which is what the next test proves.
    const cases = [
      { reason: 'timeout', retryable: true, detail: 'TASK_TIMEOUT' },
      { reason: 'cancelled', retryable: false, detail: 'CANCELLED' },
      { reason: 'daemon-stopped', retryable: false, detail: 'DAEMON_STOPPED' },
    ] as const;
    for (const [i, c] of cases.entries()) {
      const { h } = shellHarness(async () => {
        throw new OrchestratorError('SESSION_BUSY', c.retryable, Object.values(SHELL_MESSAGES)[i] as string, c.reason);
      });
      expect(await runShell(h, `c${String(i)}`, 'npm test')).toEqual({ ok: false, detail: c.detail });
    }
  });

  test("serve's OWN 409 is still SESSION_BUSY — the mapping does not over-reach", async () => {
    // The non-regression, and the reason the mapping is not "anything that is
    // not ok becomes something else". A real backpressure 409 genuinely means
    // busy and genuinely is worth retrying; relabelling it would lose the only
    // code that says "wait".
    const { h } = shellHarness(async () => {
      throw new OrchestratorError('SESSION_BUSY', true, 'session ses_abc busy — backpressure');
    });
    expect(await runShell(h, 'c1', 'npm test')).toEqual({ ok: false, detail: 'SESSION_BUSY' });
  });

  test('the typed `stopReason` field is the durable mechanism and needs no message', async () => {
    // There is no message-prefix shim any more, so this is the ONLY mechanism:
    // an error whose text says nothing at all is still classified, and the
    // classification comes from the field alone.
    expect(stopReasonOf(new OrchestratorError('SESSION_BUSY', true, 'anything', 'timeout'))).toBe('timeout');
    expect(stopReasonOf(new OrchestratorError('SESSION_BUSY', true, 'anything', 'cancelled'))).toBe('cancelled');
    expect(stopReasonOf(new OrchestratorError('SESSION_BUSY', true, 'anything', 'daemon-stopped'))).toBe(
      'daemon-stopped',
    );

    const { h } = shellHarness(async () => {
      throw new OrchestratorError('SESSION_BUSY', false, 'no recognisable wording at all', 'daemon-stopped');
    });
    expect(await runShell(h, 'c1', 'npm test')).toEqual({ ok: false, detail: 'DAEMON_STOPPED' });
  });

  test('THE MESSAGE DECIDES NOTHING — one text, three reasons, three codes', async () => {
    // While `stopReasonOf` carried a `startsWith` loop over
    // `SHELL_STOP_MESSAGE_PREFIXES`, the classification of a failure was a
    // function of its prose. These constructions are the axis that shows it no
    // longer is: identical text, three reasons, three different acks; and one
    // reason, three unrelated texts, one code. Neither axis can be produced by a
    // text matcher, because in both the field is what varies.
    //
    // NOT THE BREAK-GUARD, and that is measured rather than assumed: re-adding
    // the prefix loop leaves THIS test GREEN, because every error here is built
    // WITH the field and so was never reachable by a fallback. The test that
    // catches the loop is the next one, which builds the errors WITHOUT one. The
    // two are kept as a pair because neither alone can distinguish "text is not
    // consulted" from "the field is always set": only the tombstone proves the
    // mechanism is gone, and only this one proves the field is load-bearing.
    //
    // The converse is asserted too, because the two halves are different
    // failures: the same reason behind three unrelated texts is ONE code, so a
    // field that was not being read cannot produce that either.
    const one = 'shell: the command finished with an unremarkable wording';
    for (const [reason, detail] of [
      ['timeout', 'TASK_TIMEOUT'],
      ['cancelled', 'CANCELLED'],
      ['daemon-stopped', 'DAEMON_STOPPED'],
    ] as const) {
      const { h } = shellHarness(async () => {
        throw new OrchestratorError('SESSION_BUSY', true, one, reason);
      });
      expect(await runShell(h, 'c1', 'npm test'), `${reason} behind one fixed text`).toEqual({
        ok: false,
        detail,
      });
    }
    for (const text of ['', 'x', SHELL_MESSAGES.cancelled, SHELL_MESSAGES.stopped]) {
      const { h } = shellHarness(async () => {
        throw new OrchestratorError('SESSION_BUSY', true, text, 'timeout');
      });
      expect(await runShell(h, 'c1', 'npm test'), `"${text}" behind the timeout reason`).toEqual({
        ok: false,
        detail: 'TASK_TIMEOUT',
      });
    }
  });

  test('THE LEGACY PREFIX TEXT IS NOW AN ORDINARY SESSION_BUSY — the shim cannot come back silently', async () => {
    // The consequence of the deletion, stated as an observable rather than as a
    // source-reading check. These are the exact strings
    // `SHELL_STOP_MESSAGE_PREFIXES` used to match. With the loop gone they
    // classify NOTHING on their own, and an error carrying one is reported as
    // `SESSION_BUSY` — the code whose whole meaning is serve's own 409.
    //
    // THIS IS SAFE ONLY BECAUSE EVERY STOP SITE SETS THE FIELD, which is what
    // the next test reads out of the throw-site file. Together the two say:
    // "text is not consulted" AND "nothing production needs it to be".
    //
    // `break-the-guard`: re-add the `startsWith` loop and the three-prefix
    // table to `stopReasonOf` in `common/errors.ts`. The first assertion below
    // goes red on `stopReasonOf`, this whole test goes red on the ack, and the
    // typed-field test above stays GREEN — which is the asymmetry that makes
    // the mechanism identifiable at all.
    const legacy = [
      'shell: the command exceeded its deadline',
      'shell: the command was cancelled before it completed',
      'shell: the daemon stopped',
    ] as const;
    for (const text of legacy) {
      expect(stopReasonOf(new OrchestratorError('SESSION_BUSY', true, text)), `"${text}"`).toBeNull();
      const { h } = shellHarness(async () => {
        throw new OrchestratorError('SESSION_BUSY', true, text);
      });
      expect(await runShell(h, 'c1', 'npm test'), `"${text}" must not be re-coded by prose`).toEqual({
        ok: false,
        detail: 'SESSION_BUSY',
      });
    }
  });

  test('THE PIN, REPLACED: every stop site passes the typed fourth argument', () => {
    // The old pin guarded the shim's TABLE against the throw-site file, because
    // the shim matched prose it did not own. Its own comment said to delete it
    // once the throw sites could set the reason — which they now do — and to
    // "delete it then, do not leave it passing against strings nothing writes".
    // Done, and this is what replaced it: the same file is read, and the claim
    // is now about the TYPED ARGUMENT, which is the only carrier.
    //
    // Read from the SOURCE rather than re-derived from a copy, for the same
    // reason the pin was: a test that builds the errors itself can only assert
    // the shape it already assumed.
    //
    // `break-the-guard`: delete the fourth argument from the `cancelled` arm of
    // `shellStopFailure`, and the first loop iteration below fails.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../daemon/shell-tasks.ts'), 'utf8');
    // The argument span is taken with `[\s\S]*?` rather than `[^;]*?` for two
    // measured reasons: the timeout message CONTAINS a `;`, and the
    // `daemon-stopped` site is `waiter.reject(new OrchestratorError(…, …));`,
    // so it ends in `))` and not `);`. A narrower pattern silently matches
    // three of the four sites and passes.
    const sites = [
      ...source.matchAll(/new OrchestratorError\(\s*'SESSION_BUSY'([\s\S]*?)\)\)?\s*;/g),
    ].map((m) => m[1] ?? '');
    expect(sites.length, 'every SESSION_BUSY construction in shell-tasks.ts').toBe(4);
    let carried = 0;
    for (const args of sites) {
      // The fallthrough: an engine outcome that is not one of the three stops is
      // not a reason the waiter stopped, so it legitimately sets none. Anything
      // else MUST name a reason, and the naming has to be one of the three.
      if (args.includes('the command finished as')) continue;
      // The last argument, with the trailing comma and indent off — the
      // multi-line constructions end `,\n    `, and a `$`-anchored pattern that
      // forgets that matches nothing rather than failing loudly.
      const last = args.replace(/[\s,]+$/, '');
      const reason = /'(timeout|cancelled|daemon-stopped)'$/.exec(last)?.[1];
      expect(reason, `a SESSION_BUSY site with no typed reason: new OrchestratorError(${args})`).not.toBeUndefined();
      carried += 1;
    }
    expect(carried, 'three sites carry a typed reason; one is the fallthrough').toBe(3);
    // And the reason → code map is TOTAL over the three literals, so a fourth
    // reason cannot be added to `ShellStopReason` without a code to report it
    // as — which would otherwise surface as `undefined` in `ack.detail`.
    expect(Object.values(SHELL_STOP_REASON_CODES).sort()).toEqual([
      'CANCELLED',
      'DAEMON_STOPPED',
      'TASK_TIMEOUT',
    ]);
    for (const [reason, code] of Object.entries(SHELL_STOP_REASON_CODES)) {
      expect(
        errorCodeFor(new OrchestratorError('SESSION_BUSY', true, 'x', reason as 'timeout')),
        reason,
      ).toBe(code);
    }
  });

  test('a stopped waiter NEVER rotates a key — the explicit arm is the guard', async () => {
    // `httpStatusOf` drives `Keyring.release`'s rotation, and the fallthrough to
    // `undefined` is correct — so the arm has to be load-bearing rather than
    // decorative, which means the test must construct the error the way the real
    // throw site does.
    //
    // IT USED TO BE WRONG HERE, and the break-guard is why it is stated. The
    // first version of this test built `OrchestratorError('TASK_TIMEOUT', …)`
    // and the implementation's arm tested `err.code`; the break-guard then
    // rewrote the arm to `return 401` and the suite stayed GREEN. A guard that
    // cannot fail is a description, and the reason it could not fail is that
    // `shell-tasks.ts` constructs `code: 'SESSION_BUSY'` with a stop REASON —
    // the re-coded literal never existed at any throw site. Both shapes are
    // asserted here now, and the implementation arms on `stopReasonOf`.
    for (const reason of ['timeout', 'cancelled', 'daemon-stopped'] as const) {
      // Shape 1 — what production throws: `SESSION_BUSY` plus a typed reason.
      expect(
        httpStatusOf(new OrchestratorError('SESSION_BUSY', false, 'x', reason)),
        `${reason} (SESSION_BUSY + stopReason) must not look like an auth fault`,
      ).toBeUndefined();
      // Shape 2 — what a caller holds once the code has been re-coded.
      for (const code of ['TASK_TIMEOUT', 'CANCELLED', 'DAEMON_STOPPED'] as const) {
        expect(httpStatusOf(new OrchestratorError(code, false, 'x')), `${code} must not rotate`).toBeUndefined();
      }
    }
    // The control: an actual auth fault still reports 401 and still rotates.
    expect(httpStatusOf(new OrchestratorError('BRAIN_AUTH', false, 'x'))).toBe(401);
    // …and an unrelated 429 still reports 429, so the stop arm did not swallow
    // the branches below it.
    expect(httpStatusOf(new OrchestratorError('RATE_LIMITED', true, 'x'))).toBe(429);
  });
});
