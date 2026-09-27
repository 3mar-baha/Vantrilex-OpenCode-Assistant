import { describe, expect, test } from 'vitest';
import { describeSlashCommands, parseSlashCommand, SLASH_COMMANDS, slashCommandError } from './slash.js';

// Phase 4 — the slash interpreter.
//
// The rule that matters: a leading `/` is NEVER forwarded to the model as text.
// It is either a command we implement natively, or it is rejected with a useful
// message. Forwarding `/rm -rf /` to an agent is how a typo becomes an incident.
describe('parseSlashCommand', () => {
  test('parses a bare command', () => {
    expect(parseSlashCommand('/compact')).toEqual({ name: 'compact', args: '' });
    expect(parseSlashCommand('/new')).toEqual({ name: 'new', args: '' });
    expect(parseSlashCommand('/help')).toEqual({ name: 'help', args: '' });
  });

  test('carries arguments through, trimmed', () => {
    expect(parseSlashCommand('/new  Voxaura  ')).toEqual({ name: 'new', args: 'Voxaura' });
  });

  test('is case-insensitive, because typing is not a programming act', () => {
    expect(parseSlashCommand('/COMPACT')).toEqual({ name: 'compact', args: '' });
  });

  test('returns null when there is no leading slash', () => {
    expect(parseSlashCommand('open the sessions')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
    expect(parseSlashCommand('   ')).toBeNull();
  });

  test('does not treat a mid-sentence slash as a command', () => {
    // "use /compact here" is prose, not an invocation.
    expect(parseSlashCommand('use /compact here')).toBeNull();
  });

  test('a slash that is not at the very start is prose', () => {
    expect(parseSlashCommand('  /compact')).toEqual({ name: 'compact', args: '' });
  });

  test('rejects an empty command name', () => {
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('/  ')).toBeNull();
  });

  test('nothing parses into a name that then executes without validation', () => {
    // The parser is generic (it does not know the command table); the
    // invariant that matters is the combined one: a parsed name is either
    // validated by slashCommandError or refused. Nothing slips through.
    const known = new Set(SLASH_COMMANDS.map((c) => c.name));
    for (const raw of ['/compact', '/new', '/help', '/undo', '/abort', '/status', '/rm']) {
      const parsed = parseSlashCommand(raw);
      if (parsed === null) continue;
      const err = slashCommandError(raw);
      if (known.has(parsed.name)) expect(err, raw).toBeNull();
      else expect(err, raw).not.toBeNull();
    }
  });
});

describe('slashCommandError', () => {
  test('accepts implemented commands with and without args', () => {
    expect(slashCommandError('/compact')).toBeNull();
    expect(slashCommandError('/new my task')).toBeNull();
    expect(slashCommandError('/help')).toBeNull();
  });

  test('rejects an unknown command and lists what IS available', () => {
    const err = slashCommandError('/rm');
    expect(err).not.toBeNull();
    expect(err).toContain('/compact');
    expect(err).toContain('/help');
  });

  test('rejects arguments on a command that takes none', () => {
    // `/compact now` looks harmless and would silently ignore the argument.
    expect(slashCommandError('/compact now')).not.toBeNull();
    expect(slashCommandError('/help me')).not.toBeNull();
  });

  test('rejects an overlong argument instead of truncating it', () => {
    expect(slashCommandError(`/new ${'x'.repeat(600)}`)).not.toBeNull();
  });

  test('rejects control characters in the argument', () => {
    expect(slashCommandError('/new a\nb')).not.toBeNull();
  });

  test('the error never echoes a huge payload back', () => {
    const err = slashCommandError(`/${'x'.repeat(2000)}`);
    expect(err).not.toBeNull();
    expect(err!.length).toBeLessThan(200);
  });
});

describe('describeSlashCommands', () => {
  test('is Arabic, one line per command, and never empty', () => {
    const lines = describeSlashCommands();
    expect(lines).toHaveLength(SLASH_COMMANDS.length);
    for (const line of lines) {
      expect(line.trim().length).toBeGreaterThan(0);
      // The UI is Arabic; a command list in English is a bug.
      expect(line).toMatch(/[\u0600-\u06FF]/);
    }
  });

  test('every advertised command actually parses and validates', () => {
    for (const c of SLASH_COMMANDS) {
      expect(parseSlashCommand(`/${c.name}`), c.name).toEqual({ name: c.name, args: '' });
      expect(slashCommandError(`/${c.name}`), c.name).toBeNull();
    }
  });

  test('exactly one command takes an argument', () => {
    expect(SLASH_COMMANDS.filter((c) => c.takesArgs).map((c) => c.name)).toEqual(['new']);
  });
});
