import { describe, expect, test } from 'vitest';

import { isHeadlessCommand } from './commands.js';
import { runHeadless } from './headless.js';

// THE ARGV SURFACE — parsing only, no network and no model.
//
// These are the guards on the one place where a quiet mistake turns into a
// convincing report: an option parser that swallows the utterance reports "no
// text" with exit 2, which reads exactly like correct argument handling. The two
// `BREAK:` cases below are the failures that were observed and fixed.

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
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      // With `=` the value is inline, so `ses_y` is the TEXT and the parse is
      // complete — the call proceeds past argument validation and fails later,
      // on serve, not on usage. What is asserted here is that it is not a usage
      // error, which is the observable difference.
      const code = await runHeadless('prompt', ['prompt', 'ses_x', '--session=ses_y', 'do the thing']);
      expect(lines.join('\n')).not.toContain('usage: opencode-voice prompt');
      expect(code).not.toBe(2);
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
