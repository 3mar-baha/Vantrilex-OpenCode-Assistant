import { connect } from 'node:net';

import { describe, expect, test } from 'vitest';

import { isHeadlessCommand } from './commands.js';
import { runHeadless } from './headless.js';

// THE ARGV SURFACE — parsing only, no network and no model.
//
// These are the guards on the one place where a quiet mistake turns into a
// convincing report: an option parser that swallows the utterance reports "no
// text" with exit 2, which reads exactly like correct argument handling. The two
// `BREAK:` cases below are the failures that were observed and fixed.
//
// ── HERMETICITY, AND WHY THE TWO `not.toBe(2)` CASES NEEDED A SEAM ────────────
//
// Those two cases establish one thing: the invocation got PAST argument
// validation. They used to establish it by reaching serve, which meant the
// result depended on machine state this repository does not own:
//
//   1. `resolveServePassword` reads `OPENCODE_SERVER_PASSWORD`, then the
//      supervisor's `serve.pass` in the runtime directory. With neither — which
//      is a FRESH CLONE, and what `VOICE_RUNTIME_DIR` pointed at an empty
//      directory reproduces — `requirePassword` THROWS
//      (`serve.ts:112`). The throw escaped `runHeadless` and both tests failed
//      with `OrchestratorError: no serve password`. The suite was not
//      hermetic; it was a measurement of whoever last ran the installer.
//   2. Even with a password, the exit code past this point is a function of
//      whether serve happens to be listening. On the machine this was fixed on,
//      4096 was LIVE, so any literal exit code would have been an assertion
//      about that machine.
//
// The fix sets both values the product itself reads, in the test, for the
// duration of the call, and restores them. That is not a mock of `ServeClient`:
// the real `openServeTarget` → `requirePassword` → health-probe path runs, so the
// assertion still describes the shipped wiring.

// A TEST FIXTURE, not a credential. It is never logged, never printed and never
// leaves the process; its only job is to be non-empty so `requirePassword` is
// satisfied. It is spelled out rather than sourced from the environment so a run
// can never pick up a real key by accident.
const FIXTURE_SERVE_PASSWORD = 'hermetic-fixture-not-a-credential';

/**
 * A port nothing is listening on, so the health probe is deterministically
 * `false` and the command takes its documented "serve unreachable" branch.
 *
 * PROVEN IN THE TEST, NOT ASSUMED. An assumed-dead port is the same class of
 * machine-state dependency this file just had. If something is listening here the
 * test says so and fails, instead of comparing against an exit code that would
 * have been wrong for an unrelated reason.
 */
const DEAD_SERVE_PORT = 1;

function isClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1_500);
    const settle = (closed: boolean) => {
      socket.destroy();
      resolve(closed);
    };
    socket.once('connect', () => settle(false));
    socket.once('timeout', () => settle(true));
    socket.once('error', () => settle(true));
  });
}

/**
 * Run `fn` with a serve surface that exists entirely in this file, then put the
 * environment back exactly as it was. A leaked `OPENCODE_PORT` would silently
 * repoint every later test in the run, so the restore is in a `finally`.
 */
async function withHermeticServe<T>(fn: () => Promise<T>): Promise<T> {
  const before = {
    password: process.env['OPENCODE_SERVER_PASSWORD'],
    port: process.env['OPENCODE_PORT'],
  };
  process.env['OPENCODE_SERVER_PASSWORD'] = FIXTURE_SERVE_PASSWORD;
  process.env['OPENCODE_PORT'] = String(DEAD_SERVE_PORT);
  try {
    return await fn();
  } finally {
    if (before.password === undefined) delete process.env['OPENCODE_SERVER_PASSWORD'];
    else process.env['OPENCODE_SERVER_PASSWORD'] = before.password;
    if (before.port === undefined) delete process.env['OPENCODE_PORT'];
    else process.env['OPENCODE_PORT'] = before.port;
  }
}

/** The command surface `cli.ts` routes to, and the usage it can print. */
async function run(args: string[]): Promise<number> {
  return runHeadless('gate', ['gate', ...args]);
}

describe('the command guard and the usage', () => {
  test('`gate` is a headless command and `doctor` is not', () => {
    expect(isHeadlessCommand('gate')).toBe(true);
    expect(isHeadlessCommand('doctor')).toBe(false);
  });

  test('`gate --help`-shaped invocation still measures and exits 0', async () => {
    // The default path. `--help` is not a declared option, so it is ignored and
    // the invariant is measured — which is what a reader who typed it wanted.
    expect(await run(['--help'])).toBe(0);
  });
});

describe('positional extraction', () => {
  // These exercise `runHeadless`'s argument handling through the observable
  // behaviour of a command that needs a positional. Each was a real defect.
  test('BREAK: a boolean flag before the text does not swallow the text', async () => {
    // Observed failure: `reason --replay "شوف لي الجلسات"` printed
    // `FAIL no text` and exited 2. The parser assumed every `--flag` consumed the
    // next token, which it must not — `--replay` and `--approve` are boolean.
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      const code = await runHeadless('reason', ['reason', '--replay']);
      expect(lines.join('\n'), 'with no text at all it must say so').toContain('no text');
      expect(code).toBe(2);
    } finally {
      console.log = original;
    }
  });

  test('BREAK: `--session <id>` DOES consume its value, and the text survives', async () => {
    // The mirror of the case above. If value-taking options were not recognised,
    // `--session ses_x "do the thing"` would treat the id as the utterance and
    // drop the real text. Pinned by the usage-error shape: the reported text is
    // the FIRST positional only, so a correct parse with a missing text is what
    // distinguishes the two.
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      // `prompt` takes two positionals and reports "usage:" when either is absent.
      const code = await runHeadless('prompt', ['prompt', 'ses_x', '--session', 'ses_y']);
      // `ses_x` is present, `--session ses_y` is consumed, so the text is missing.
      expect(lines.join('\n')).toContain('usage: opencode-voice prompt <sessionId> <text>');
      expect(code).toBe(2);
    } finally {
      console.log = original;
    }
  });

  test('`--name=value` does not consume the next token', async () => {
    // With `=` the value is inline, so `ses_y` is the TEXT and the parse is
    // complete — the call proceeds past argument validation and fails later, on
    // serve, not on usage.
    //
    // WHAT IS ASSERTED, AND WHY IT IS NOT `not.toBe(2)`. `not.toBe(2)` asserts
    // the ABSENCE of one value: `0`, `1`, `3` and `NaN` all satisfy it, so the
    // test never established that the command ran at all. What the test's own
    // name claims is a claim about the PARSE, and the parse has a positive
    // observable: `promptCommand` prints the session and the text it received
    // (`bridge.ts:210-211`) before the health check, so those two lines ARE the
    // parse result. If `--session` had consumed `ses_y`, the text would be
    // missing and the usage branch would have answered instead.
    //
    // The exit code is pinned too, and pinned POSITIVELY, because the serve
    // surface is hermetic here: nothing listens on `DEAD_SERVE_PORT`, so
    // `bridge.ts:215-218` is the branch that runs and `1` is what it returns.
    expect(await isClosed(DEAD_SERVE_PORT), `port ${DEAD_SERVE_PORT} answered — this run would not be hermetic`).toBe(true);
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      const code = await withHermeticServe(() =>
        runHeadless('prompt', ['prompt', 'ses_x', '--session=ses_y', 'do the thing']),
      );
      const printed = lines.join('\n');
      expect(printed, 'the first positional is the session').toContain('ses_x');
      expect(printed, 'the inline value was not consumed, so the text survived').toContain('do the thing');
      expect(printed, 'and it was not a usage error').not.toContain('usage: opencode-voice prompt');
      expect(printed, 'the documented serve-unreachable branch is the one that ran').toContain(
        'serve unreachable — nothing was sent',
      );
      expect(code).toBe(1);
    } finally {
      console.log = original;
    }
  });
});

describe('usage errors exit 2, distinct from a failure', () => {
  test('`prompt` with no arguments', async () => {
    expect(await runHeadless('prompt', ['prompt'])).toBe(2);
  });

  test('`shell` with no command', async () => {
    expect(await runHeadless('shell', ['shell', 'ses_x'])).toBe(2);
  });

  test('`intents --case <unknown>` names the cases it knows', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      expect(await runHeadless('intents', ['intents', '--case', 'nope'])).toBe(2);
      expect(lines.join('\n')).toContain('task-needs-opencode');
    } finally {
      console.log = original;
    }
  });
});

describe('`agent` and `wait` — the two new verbs, at the argv surface', () => {
  // The value-taking options below are the ones that can SWALLOW the next token,
  // which is the failure this file exists for. `--agent plan` used to be
  // ambiguous with the command's own positional name, and `--timeout 30000` had
  // to be declared or the budget would be read as the message id.
  test('`agent` with a session but no agent name is a usage error', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      expect(await runHeadless('agent', ['agent', 'ses_x'])).toBe(2);
      expect(lines.join('\n')).toContain('usage: opencode-voice agent <sessionId> <agentName>');
    } finally {
      console.log = original;
    }
  });

  test('BREAK: `--no-reply` is boolean and does not eat the agent name', async () => {
    // `--no-reply` is deliberately NOT in VALUE_OPTIONS. If it were, then
    // `agent ses_x --no-reply plan` would consume `plan` as the flag's value and
    // report "no agent name" — a correct-looking usage error for a command that
    // was fully specified.
    //
    // The same two-part assertion as the `--name=value` case, for the same two
    // reasons: the OPERANDS are the positive observable (`agentCommand` prints
    // the session, the agent it was handed and the form it chose, at
    // `agent.ts:283-285`, before the health check), and the exit code is pinned
    // to the documented serve-unreachable branch rather than merely "not 2".
    // `requested agent: plan` is the assertion that discriminates: a swallowing
    // parser leaves it absent, because it reports a usage error instead.
    expect(await isClosed(DEAD_SERVE_PORT), `port ${DEAD_SERVE_PORT} answered — this run would not be hermetic`).toBe(true);
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      const code = await withHermeticServe(() =>
        runHeadless('agent', ['agent', 'ses_x', '--no-reply', 'plan']),
      );
      const printed = lines.join('\n');
      expect(printed, 'the second positional is the agent, not the flag\'s value').toContain('plan');
      // The boolean itself, not just its absence from the operand list: a parser
      // that ignored `--no-reply` entirely would still print `plan` here.
      expect(printed, 'and the flag was read as boolean, not as taking a value').toContain(
        'noReply (records the turn, no model call)',
      );
      expect(printed).not.toContain('usage: opencode-voice agent');
      expect(printed, 'the documented serve-unreachable branch is the one that ran').toContain(
        'serve unreachable — no agent was switched',
      );
      expect(code).toBe(1);
    } finally {
      console.log = original;
    }
  });

  test('`wait` with no message id is a usage error', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      expect(await runHeadless('wait', ['wait', 'ses_x'])).toBe(2);
      expect(lines.join('\n')).toContain('usage: opencode-voice wait <sessionId> <messageId>');
    } finally {
      console.log = original;
    }
  });

  test('BREAK: a non-numeric `--timeout` is refused, not silently defaulted', async () => {
    // The budget IS the question this verb answers. Substituting 30 000 for a
    // typo would answer "did it finish within 30 s?" when the caller asked
    // "within 5 s?" — a different measurement wearing the same report.
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      expect(await runHeadless('wait', ['wait', 'ses_x', 'msg_1', '--timeout', 'soon'])).toBe(2);
      expect(lines.join('\n')).toContain('--timeout must be a non-negative integer');
    } finally {
      console.log = original;
    }
  });

  test('BREAK: `--timeout` DOES consume its value, so the message id survives', async () => {
    // The mirror of the `--no-reply` case. If `timeout` were not a value option,
    // `wait ses_x msg_1 --timeout 5000` would take `5000` as the message id and
    // poll the wrong turn.
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      expect(await runHeadless('wait', ['wait', 'ses_x', '--timeout', 'soon'])).toBe(2);
      // `ses_x` present, `--timeout` consumed `soon`; the missing message id is
      // therefore the reported problem, which is what proves the consumption.
      expect(lines.join('\n')).toContain('usage: opencode-voice wait <sessionId> <messageId>');
    } finally {
      console.log = original;
    }
  });

  test('both verbs are reachable from the ladder and the usage line names them', () => {
    expect(isHeadlessCommand('agent')).toBe(true);
    expect(isHeadlessCommand('wait')).toBe(true);
  });
});

describe('`gate --source` — the break-verification seam', () => {
  test('an unreadable source is a loud failure, not a fallback to 1', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      const code = await run(['--source', 'C:/definitely-not-a-file-coordinator.ts']);
      expect(lines.join('\n')).toContain('unreadable');
      expect(code).toBe(1);
    } finally {
      console.log = original;
    }
  });
});
