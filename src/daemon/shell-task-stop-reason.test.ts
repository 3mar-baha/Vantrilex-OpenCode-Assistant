import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  OrchestratorError,
  errorCodeFor,
  httpStatusOf,
  stopReasonOf,
  type ErrorCode,
} from '../common/errors.js';
import { MAX_CONCURRENCY, taskId as brandTaskId } from '../tasks/index.js';
import type { SessionId } from '../common/brands.js';
import { createShellTaskBridge, shellStopFailure } from './shell-tasks.js';
import type { SessionShellResult } from '../runtime/client.js';

// DEFECTS 2 AND 3.
//
// THE SHIM IS DELETED. `common/errors.ts` used to discriminate a stopped waiter by
// matching the EXACT `secretSafeMessage` prefix authored in `shell-tasks.ts` — a
// `SHELL_STOP_MESSAGE_PREFIXES` table plus a `startsWith` loop inside
// `stopReasonOf`. It existed only because the throw sites were in a file that
// change did not own, and its own comment said to delete it once they could set
// the reason themselves. They can, and they now do: every stop site passes
// `stopReason` as the fourth constructor argument, so `stopReasonOf` reads ONE
// typed field and no text at all. A user-facing code can no longer be changed by
// rewording a sentence in another file.
//
// `common/errors.ts` was rewritten outside this write-set, so the two tests that
// were ABOUT the shim — the prefix-match check and the whole-tree scan proving no
// third module writes the three messages — went with it. That is not uncovered
// ground, and the replacements are elsewhere and strictly stronger:
//
//   · `src/orchestrator/ack-truth.test.ts` carries the TOMBSTONE ('THE LEGACY
//     PREFIX TEXT IS NOW AN ORDINARY SESSION_BUSY'): an error carrying one of the
//     three legacy strings and NO reason is now reported as `SESSION_BUSY`, so
//     re-adding the loop fails the suite instead of working silently. It also
//     carries 'THE PIN, REPLACED' — the same read of this same file — and a
//     totality check over `SHELL_STOP_REASON_CODES`.
//   · The source-reading guard in the first describe block below SURVIVES, and it
//     is the only test that can tell "the field is set" from "the field is set and
//     nothing else quietly claims the reason". The tombstone is safe only because
//     that guard is green, so the pair stays.
//
// DEFECT 2 is the other half and it is behavioural: `publishFault` used to put
// `err.code` in the frame, so a task timeout was reported as `SESSION_BUSY` while
// the notice said `task-failed` and the ack said `TASK_TIMEOUT` — three surfaces,
// three answers, for one command.

const here = dirname(fileURLToPath(import.meta.url));
const SHELL_TASKS = resolve(here, 'shell-tasks.ts');

const unquote = (text: string): string => text.replace(/^['"`]|['"`]$/g, '').trim();

/**
 * Drop the closing paren the regex left behind.
 *
 * The match captures the text between `new OrchestratorError(` and `);`, so the
 * arguments still carry the call's own `)`. Without this every LAST argument
 * arrives with a paren glued to it and a three-argument construction reads as a
 * four-argument one with a reason of `daemon-stopped')`.
 */
function stripCloseParen(text: string): string {
  // Count the unbalanced closers from the left, which is the direction that works
  // for both shapes: a call with inner parens leaves them balanced, and a call
  // with none leaves exactly one surplus `)` at the end.
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] !== ')') continue;
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    return text.slice(0, i);
  }
  return text;
}

/**
 * Every `new OrchestratorError(...)` construction in the throw-site file, with its
 * arguments split at the top level.
 *
 * Read from the SOURCE, not re-derived from a copy. A test that constructs the
 * errors itself can only assert that the shape it already assumed is the shape it
 * already had; reading the file is what makes this a guard on the throw sites
 * rather than a description of them.
 */
function errorConstructions(source: string): Array<{ code: string; args: string[] }> {
  const out: Array<{ code: string; args: string[] }> = [];
  for (const m of source.matchAll(/new OrchestratorError\(([\s\S]*?)\);/g)) {
    const args: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of stripCloseParen(m[1] ?? '')) {
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      if (ch === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    args.push(current.trim());
    // A construction written across lines as `return new OrchestratorError(\n …\n);`
    // leaves a trailing empty argument: the captured span ends at the `)` that
    // closes the `return`, not at the call's own. Dropping trailing blanks is what
    // makes the arity assertion mean something; keeping them would make a
    // four-argument construction read as five.
    while (args.length > 0 && args[args.length - 1] === '') args.pop();
    out.push({ code: unquote(args[0] ?? ''), args });
  }
  return out;
}

describe('DEFECT 3a — the throw sites set stopReason, so the text shim decides nothing', () => {
  // `break-the-guard`: delete the fourth argument from the `cancelled` arm of
  // `shellStopFailure`. THIS test fails, on `expect(site.args.length).toBe(4)`.
  //
  // IT USED TO BE THE ONLY THING THAT FAILED, and the reason it was worth saying
  // is the reason it is now worth un-saying: `stopReasonOf` fell back to the
  // prefix table, so dropping the field left the classification intact and only a
  // source-reading guard could tell the two mechanisms apart. The table is gone, so
  // the same injection now takes the ack red too (`ack-truth.test.ts` reports
  // `SESSION_BUSY` where it expects `CANCELLED`). The two mechanisms are no longer
  // observationally identical — which is the entire point of having deleted one.
  test('every stop site in shell-tasks.ts passes a fourth argument', () => {
    const source = readFileSync(SHELL_TASKS, 'utf8');
    const sites = errorConstructions(source);
    // Scope: the constructions that could plausibly be a stop. `CONFIG_INVALID`
    // (a payload this file did not write) and `RATE_LIMITED` (a refused enqueue)
    // are not stops and must NOT claim a reason.
    const stops = sites.filter((s) => s.code === 'SESSION_BUSY');
    expect(stops.length, 'SESSION_BUSY constructions in the file').toBe(4);
    for (const site of stops) {
      const reason = unquote(site.args[3] ?? '');
      // The fallthrough arm is the ONE site that legitimately passes no reason: an
      // outcome code that is not a stop is not a stop, and claiming otherwise
      // would put a catch-all inside the taxonomy. It relies on the constructor
      // default, so it reads as three arguments.
      if ((site.args[2] ?? '').includes('the command finished as')) {
        expect(site.args.length, 'the fallthrough relies on the default reason').toBe(3);
        expect(errorCodeFor(
          new OrchestratorError(
            site.code as ErrorCode,
            site.args[1] === 'true',
            unquote(site.args[2] ?? ''),
          ),
        ), 'and it is not classified as a stop').toBe('SESSION_BUSY');
        continue;
      }
      expect(site.args.length, `${site.code}: a 3-arg construction`).toBe(4);
      expect(['timeout', 'cancelled', 'daemon-stopped'], `${site.code}: a typed reason`).toContain(reason);
    }
    for (const site of sites) {
      if (site.code === 'SESSION_BUSY') continue;
      expect(site.args.length, `${site.code}: a non-stop site that claims a reason`).toBe(3);
    }
  });
});

describe('DEFECT 3b — the codes a stopped waiter is reported as', () => {
  // `break-the-guard`: swap the `timeout` and `cancelled` arms in
  // `shellStopFailure`. Three tests below go red.
  test('each stop reason maps to its own code, and the code is the one the shell sees', () => {
    // Constructed by the REAL function the factory calls, so this is the production
    // object rather than a copy of its shape.
    expect(errorCodeFor(shellStopFailure('timeout'))).toBe('TASK_TIMEOUT');
    expect(errorCodeFor(shellStopFailure('cancelled'))).toBe('CANCELLED');
    // The `daemon-stopped` arm is built inside `close()` rather than in
    // `shellStopFailure`, and is asserted through a real teardown in DEFECT 2's
    // block below rather than through a copy of its literal.
  });

  test('the fallthrough is NOT a stop and does not claim to be one', () => {
    // `threw` with no executor error reaches the fallthrough. Filing it under one
    // of the three would put a catch-all inside the taxonomy; `SESSION_BUSY` is the
    // honest "the engine said something we have no code for".
    const err = shellStopFailure('threw');
    expect(err.stopReason).toBeNull();
    expect(stopReasonOf(err)).toBeNull();
    expect(errorCodeFor(err)).toBe('SESSION_BUSY');
  });

  test('a stopped waiter still never rotates a key', () => {
    // `httpStatusOf` arms on `stopReasonOf`, not on the code, so re-coding the
    // literal at the throw site cannot change this. Asserted because it is the one
    // property where a stop error and an auth error would look alike without it,
    // and because `common/errors.ts` records that a code-keyed arm was dead code
    // for the shape that actually exists.
    for (const reason of ['timeout', 'cancelled'] as const) {
      expect(httpStatusOf(shellStopFailure(reason)), reason).toBeUndefined();
    }
  });
});

// ── DEFECT 2 · THE FRAME AND THE ACK ARE ONE CLASSIFICATION ──────────────────

interface Run {
  readonly frames: Array<{ commandId: string; output: string; status: string }>;
  readonly notices: Array<{ code: string; level: string }>;
  readonly spoken: string[];
  readonly bridge: ReturnType<typeof createShellTaskBridge>;
}

const OK: SessionShellResult = {
  sessionId: 'ses_a',
  command: 'echo hi',
  status: 'completed',
  exitCode: null,
  output: 'hi',
  durationMs: 5,
  outcome: 'unknown',
  // The provenance serve reported. Unused by this bridge, which publishes the
  // shell's own text, but part of the shape the client returns.
  messageId: 'msg_1',
  partId: 'prt_1',
  tool: 'bash',
  startedAt: 1,
  endedAt: 6,
  outputBytes: 2,
};

type BridgeOptions = Parameters<typeof createShellTaskBridge>[0];

function harness(run: () => Promise<SessionShellResult>, over: Partial<BridgeOptions> = {}): Run {
  const frames: Run['frames'] = [];
  const notices: Run['notices'] = [];
  const spoken: string[] = [];
  const bridge = createShellTaskBridge({
    run: () => run(),
    emitOutput: (input) => {
      frames.push({ commandId: input.commandId, output: input.output, status: input.status });
    },
    emitNotice: (code, _detail, level) => {
      notices.push({ code, level });
    },
    speechAvailable: () => true,
    speak: (text) => {
      spoken.push(text);
    },
    ...over,
  });
  return { frames, notices, spoken, bridge };
}

describe('DEFECT 2 — publishFault reports the code the ack reports', () => {
  // `break-the-guard`: change `errorCodeFor(err)` back to
  // `err instanceof OrchestratorError ? err.code : 'internal'` in `publishFault`.
  // The two stop tests below go red; the 409 and `internal` tests stay green, which
  // is the evidence that they measure the DISCRIMINATION rather than the mere
  // existence of a frame.
  test('a transport 409 is still SESSION_BUSY, and the ack agrees', async () => {
    // The non-regression. Serve's own backpressure genuinely means "busy" and
    // genuinely is worth retrying; re-coding it would lose the only code that says
    // "wait". The error is the SAME OBJECT the frame and the ack read, so equality
    // here is not a coincidence of two lookups agreeing.
    const err = new OrchestratorError('SESSION_BUSY', true, 'session.shell: session ses_a busy — backpressure');
    const h = harness(() => Promise.reject(err));
    await expect(h.bridge.execSessionShell('ses_a' as SessionId, 'npm test', 'cmd-1')).rejects.toBe(err);
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]?.output).toBe('SESSION_BUSY');
    expect(errorCodeFor(err)).toBe('SESSION_BUSY');
  });

  test('a daemon-side stop reports TASK_TIMEOUT in the frame, not SESSION_BUSY', async () => {
    // THE DEFECT. `publishFault` read `err.code`, so an error carrying a stop
    // reason was labelled with the code it was CONSTRUCTED with — and the whole
    // point of `stopReason` is that the construction code is not the reportable
    // one. The notice said `task-failed` (from the record), the ack said
    // `TASK_TIMEOUT` (from `errorCodeFor`), and the frame said `SESSION_BUSY`.
    const err = new OrchestratorError('SESSION_BUSY', true, 'anything at all', 'timeout');
    const h = harness(() => Promise.reject(err));
    await expect(h.bridge.execSessionShell('ses_a' as SessionId, 'npm test', 'cmd-1')).rejects.toBe(err);
    expect(h.frames[0]?.output).toBe('TASK_TIMEOUT');
    // Frame and ack are the same value, and they come from the identical object.
    expect(h.frames[0]?.output).toBe(errorCodeFor(err));
  });

  test('a non-OrchestratorError is `internal` — never a provider string', async () => {
    // The redaction property, which `errorCodeFor` preserves: the frame's `output`
    // is a closed set of literals or the router's own `internal`, and never
    // `err.message`. `ui.notice` redacts; the output frame does not.
    const h = harness(() => Promise.reject(new Error('Authorization: Bearer sk-live-SECRET')));
    await expect(h.bridge.execSessionShell('ses_a' as SessionId, 'npm test', 'cmd-1')).rejects.toThrow();
    expect(h.frames[0]?.output).toBe('internal');
    expect(h.frames[0]?.output).not.toContain('sk-live-SECRET');
  });

  test('a stop the EXECUTOR did not produce still terminates the command with a frame', async () => {
    // The half that made the defect reachable. `TaskQueue` can settle a task on
    // its own — the deadline fires while `run` is still awaiting serve — and the
    // executor never returns, so nothing published a frame. The shell had a notice
    // and an ack naming the stop and no frame at all: the indefinite spinner the
    // `output` frame exists to end.
    //
    // Driven with a REAL deadline through the `timeoutMs`/`minTimeoutMs` seam, both
    // unset in production (`daemon.ts` passes neither), because the production
    // deadline is 15 minutes and a test that waits it out measures nothing.
    const h = harness(() => new Promise<SessionShellResult>(() => undefined), { timeoutMs: 25, minTimeoutMs: 5 });
    const pending = h.bridge.execSessionShell('ses_a' as SessionId, 'npm test', 'cmd-1');
    await expect(pending).rejects.toMatchObject({ stopReason: 'timeout' });
    expect(h.frames, 'a timeout with no result still gets a terminal frame').toHaveLength(1);
    expect(h.frames[0]?.output).toBe('TASK_TIMEOUT');
    expect(h.frames[0]?.commandId).toBe('cmd-1');
    expect(h.frames[0]?.status).toBe('error');
    // It agrees with the ack because both are the same constructed error.
    expect(errorCodeFor(shellStopFailure('timeout'))).toBe(h.frames[0]?.output);
  });

  test('a cancellation is CANCELLED in the frame, and only ONE frame is emitted', async () => {
    // Two properties in one, because they are the same line of code.
    //
    // FIRST: a stop the executor did not produce still terminates the command.
    // SECOND: the double-publish guard. An executor that returns LATE — after the
    // cancel settled the task — must not publish a second frame, or the shell
    // gets a success frame after a `CANCELLED` one and resolves the same spinner
    // twice. The engine refuses that second settlement and counts it
    // (`stats().lateSettlements`); the frame is the part it cannot refuse.
    let release: () => void = () => undefined;
    const h = harness(
      () =>
        new Promise<SessionShellResult>((res) => {
          release = () => res(OK);
        }),
    );
    const pending = h.bridge.execSessionShell('ses_a' as SessionId, 'npm test', 'cmd-1');
    // The task is RUNNING rather than queued, which is what makes `cancel` settle
    // it without the executor having returned.
    await Promise.resolve();
    const task = h.bridge.tasks.list().find((t) => t.state === 'running');
    expect(task, 'precondition: one running task').toBeDefined();
    expect(h.bridge.tasks.cancel(brandTaskId(task?.id ?? ''))).toBe(true);
    await expect(pending).rejects.toMatchObject({ stopReason: 'cancelled' });
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]?.output).toBe('CANCELLED');
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.frames, 'a late executor must not publish a second frame').toHaveLength(1);
    expect(h.bridge.tasks.stats().lateSettlements, 'and the engine refused the second settle').toBe(1);
  });

  test('the daemon stopping is DAEMON_STOPPED, through a real teardown', async () => {
    // The third stop, and the only one with no `settled` event: `TaskQueue.close()`
    // abandons in-flight tasks rather than settling them, so `close()` here is the
    // only path that can produce it. Asserted through the teardown rather than
    // through a copy of the literal, because a copied literal tests nothing.
    //
    // There is deliberately NO frame assertion: there is no `settled` event, so the
    // ack is the terminal signal and the socket is about to close anyway. That is
    // stated in the implementation rather than left as a gap.
    const h = harness(() => new Promise<SessionShellResult>(() => undefined));
    const pending = h.bridge.execSessionShell('ses_a' as SessionId, 'npm test', 'cmd-1');
    await Promise.resolve();
    h.bridge.close();
    await expect(pending).rejects.toMatchObject({ stopReason: 'daemon-stopped' });
    expect(errorCodeFor(await pending.catch((e: unknown) => e))).toBe('DAEMON_STOPPED');
    expect(h.frames, 'no settle event, so no frame — the ack is the signal').toHaveLength(0);
  });

  test('MAX_CONCURRENCY is why the cancellation test gets a running task', () => {
    // Stated so that test is not read as depending on a coincidence: the queue
    // starts up to two tasks, so the first enqueue is running rather than queued,
    // and `cancel` on a RUNNING task is the path that settles without the executor
    // returning. At zero concurrency the same test would deadlock on a queued task.
    expect(MAX_CONCURRENCY).toBeGreaterThanOrEqual(1);
  });
});
