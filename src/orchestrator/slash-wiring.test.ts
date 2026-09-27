import { describe, expect, test } from 'vitest';
import { parseSlashCommand, slashCommandError, describeSlashCommands, SLASH_COMMANDS } from './slash.js';

// `/slash` was written in "Phase 4" and documented as wired. It was not: nothing
// imported it, so a spoken "/compact" went to the model as prose. The module's
// own contract is that a leading `/` is NEVER forwarded as prose — forwarding
// `/rm -rf /` to a planning agent is how a typo becomes an incident.
//
// These tests pin the pure decision half. The daemon seam that consumes them is
// covered in daemon.test.ts.

const CONTROL_ANY = /[\u0000-\u001F\u007F]/;

describe('slash parsing is a hard boundary, not a convenience', () => {
  test('a leading slash is a command, never prose', () => {
    expect(parseSlashCommand('/compact')).toEqual({ name: 'compact', args: '' });
    expect(parseSlashCommand('  /help  ')).toEqual({ name: 'help', args: '' });
  });

  test('a slash mid-sentence is prose the user meant to send', () => {
    // Stripping this would silently delete half a sentence.
    expect(parseSlashCommand('شو صار بالبناء؟ راجع src/voice/brain.ts')).toBeNull();
    expect(parseSlashCommand('a/b')).toBeNull();
  });

  test('a bare slash or slash-spaces is not a command', () => {
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('/   ')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });

  test('an unknown command is rejected with the available list, never executed', () => {
    const err = slashCommandError('/rm -rf /');
    expect(err).not.toBeNull();
    // The message must name what IS available rather than echo the payload.
    expect(err).toContain('/compact');
    expect(err).toContain('/help');
  });

  test('a command that takes no arguments refuses them', () => {
    expect(slashCommandError('/compact now')).not.toBeNull();
    expect(slashCommandError('/compact')).toBeNull();
  });

  test('over-long arguments are rejected, not truncated', () => {
    expect(slashCommandError(`/new ${'x'.repeat(500)}`)).not.toBeNull();
  });

  test('no control character can survive into the arguments', () => {
    // Explicit escapes: a literal control char in source is invisible and gets
    // stripped by editors, which is how this assertion would pass vacuously.
    //
    // The invariant is "never forwarded", not "always rejected". JS trim()
    // treats U+000B and U+000C as whitespace, so those two are normalised away
    // by parseSlashCommand BEFORE CONTROL_RE can see them. That is benign — the
    // character is removed, not passed through — and demanding strict
    // rejection would ask for a guard that cannot exist at that seam.
    const codes = ['\u0000', '\u0007', '\u000b', '\u000c', '\u001f', '\u007f', '\t', '\n'];
    // Non-vacuity: an empty corpus would make this loop assert nothing at all.
    expect(codes.length, 'control-char corpus must not be empty').toBeGreaterThanOrEqual(8);
    for (const ch of codes) {
      const input = `/new ${ch}bad`;
      const parsed = parseSlashCommand(input);
      if (parsed === null) continue;
      if (slashCommandError(input) !== null) continue;
      // Accepted, so the character itself must be gone rather than forwarded.
      expect(parsed.args, `code ${ch.charCodeAt(0)}`).not.toMatch(CONTROL_ANY);
    }
  });

  test('a newline in the argument is rejected, not split', () => {
    // A newline could smuggle a second command past a line-oriented logger.
    expect(slashCommandError('/new a\nrm')).not.toBeNull();
  });

  test('every advertised command validates as itself', () => {
    for (const c of SLASH_COMMANDS) expect(slashCommandError(`/${c.name}`)).toBeNull();
  });

  test('the help line is available without a model call', () => {
    const lines = describeSlashCommands();
    expect(lines).toHaveLength(SLASH_COMMANDS.length);
    expect(lines.join(' ')).toContain('/compact');
  });
});
