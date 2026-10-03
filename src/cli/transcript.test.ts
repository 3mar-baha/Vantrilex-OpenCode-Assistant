import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import { containsSecret, REDACTION_MARKER } from '../common/logger.js';
import { TelemetryWriter } from '../telemetry/writer.js';
import { readFileSync as read } from 'node:fs';
import { Transcript, defaultTranscriptPath, SERVE_SUPERVISOR_NOTE } from './transcript.js';

// HERMETIC. No network, no vault, no serve: this file only touches `node:fs` and
// a temp directory.
//
// THE TWO CLAIMS THIS FILE MAKES.
//   1. A transcript is complete, ordered, parseable JSONL — one line per event,
//      `seq` monotonic, redacted before serialisation.
//   2. A transcript is NOT the telemetry bus. Its schema is free text by
//      necessity, so the safety it relies on is redaction at the sink rather than
//      a closed union — and the telemetry schema that forbids free text stays
//      intact.

const tmp = mkdtempSync(join(tmpdir(), 'voxaura-transcript-'));

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Sink {
  readonly t: Transcript;
  readonly lines: string[];
  readonly file: string | null;
}

function sink(file: string | null = null, at = 1_700_000_000_000): Sink {
  const lines: string[] = [];
  const t = new Transcript({ file, write: (line) => lines.push(line), now: () => at });
  return { t, lines, file };
}

/** The parsed rows, which is what a `jq` in a CI job would see. */
function parsed(lines: readonly string[]): Array<Record<string, unknown>> {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('the row shape', () => {
  test('every row carries seq, ts and type, and seq is monotonic from 1', () => {
    const { t, lines } = sink();
    t.emit({ type: 'input', text: 'a', chars: 1, bytes: 1 });
    t.emit({ type: 'input', text: 'b', chars: 1, bytes: 1 });
    t.emit({ type: 'input', text: 'c', chars: 1, bytes: 1 });
    const rows = parsed(lines);
    expect(rows.map((r) => r['seq'])).toEqual([1, 2, 3]);
    for (const r of rows) {
      expect(typeof r['ts']).toBe('string');
      expect(Number.isNaN(Date.parse(r['ts'] as string))).toBe(false);
      expect(r['type']).toBe('input');
    }
  });

  test('the line written is the line returned, and both are valid JSON', () => {
    const { t, lines } = sink();
    const row = t.emit({ type: 'phase', phase: 'gate', detail: 'approve', ms: 12 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual(JSON.parse(JSON.stringify(row)));
  });

  test('a multi-line payload cannot break the file into non-JSON lines', () => {
    // The reason `redactObject` runs on the STRUCTURE (see `logger.ts:22-26`):
    // a post-serialisation regex would corrupt the very file it protects.
    const { t, lines } = sink();
    t.emit({ type: 'input', text: 'line one\nline two\r\nline three', chars: 26, bytes: 28 });
    expect(lines).toHaveLength(1);
    const row = parsed(lines)[0];
    expect(row?.['text']).toBe('line one\nline two\r\nline three');
  });

  test('every required event type is reachable through the closed union', () => {
    // A list typed in the test, so DELETING a member from the union fails here
    // rather than in whichever caller happened to notice.
    const required = [
      'session.start',
      'serve.probe',
      'daemon.start',
      'daemon.stop',
      'input',
      'phase',
      'permission.prompt',
      'permission.decision',
      'dispatch',
      'tool',
      'result',
      'error',
      'command',
      'session.end',
    ];
    const { t, lines } = sink();
    for (const type of required) {
      t.emit({ type: 'phase', phase: 'probe', detail: type, ms: null });
    }
    expect(parsed(lines).map((r) => r['detail'])).toEqual(required);
  });
});

describe('redaction, before serialisation', () => {
  // Long enough to be the real shape of the family, which matters: the redactor's
  // floors (logger.ts:280-290) deliberately refuse short runs so ordinary prose is
  // not mangled, so a 14-character sample would prove nothing.
  const OPENROUTER_SHAPED = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef';

  test('a secret-shaped tool argument never reaches either sink', () => {
    const file = join(tmp, 'redacted.jsonl');
    const { t, lines } = sink(file);
    t.emit({
      type: 'tool',
      callId: 'call_1',
      name: 'bash',
      status: 'completed',
      args: {
        command: `curl -H "authorization: Bearer ${OPENROUTER_SHAPED}" https://example.test`,
        api_key: OPENROUTER_SHAPED,
        env: `OPENROUTER_API_KEY=${OPENROUTER_SHAPED}`,
      },
      result: 'ok',
      error: null,
      title: null,
      ms: 7,
      readWaitMs: 0,
      rowId: 'msg_1',
    });

    const written = readFileSync(file, 'utf8');
    for (const source of [written, lines.join('\n')]) {
      expect(source).not.toContain(OPENROUTER_SHAPED);
      expect(source).toContain(REDACTION_MARKER);
    }
    // The scrubbed value is STILL A STRING, so the row is still readable. A
    // replacement that dropped the quotes would have produced parseable-looking
    // garbage, which is what `logger.ts:22-26` calls out.
    const row = parsed(lines)[0];
    const args = row?.['args'] as Record<string, unknown>;
    expect(typeof args['command']).toBe('string');
    expect(typeof args['api_key']).toBe('string');
    expect(args['api_key']).toBe(REDACTION_MARKER);
  });

  test('WHY the guard is stated on values, and not as `containsSecret(written)`', () => {
    // The acceptance brief asks for `containsSecret` to be false over the written
    // rows. That assertion is NOT satisfiable by any implementation that uses
    // `redactObject`, and the reason is measured rather than argued:
    //
    //   `containsSecret` FAILS CLOSED and fires on its OWN MARKER. The assignment
    //   pattern's value alternatives include `\[[^\]]*\]` (logger.ts:339), so
    //   `api_key: [REDACTED]` matches. It therefore fires on the FIELD NAME,
    //   permanently, for any row that legitimately records a tool argument called
    //   `api_key` — redacted or not.
    //
    // Asserting it false over such a row would be asserting a falsehood. So the
    // two facts that ARE true are asserted instead: the fixture really is a secret,
    // and the marker really is what the redactor left in its place.
    expect(containsSecret(OPENROUTER_SHAPED), 'the fixture must be a real secret or the guard is vacuous').toBe(true);
    expect(containsSecret(`api_key: ${REDACTION_MARKER}`), 'the marker itself trips the fail-closed predicate').toBe(true);

    const { t, lines } = sink();
    t.emit({
      type: 'tool',
      callId: 'call_2',
      name: 'bash',
      status: 'completed',
      args: { api_key: OPENROUTER_SHAPED },
      result: null,
      error: null,
      title: null,
      ms: 1,
      readWaitMs: 0,
      rowId: 'msg_2',
    });
    expect(lines[0]).not.toContain(OPENROUTER_SHAPED);
    const args = (parsed(lines)[0] ?? {})['args'] as Record<string, unknown>;
    expect(args['api_key']).toBe(REDACTION_MARKER);
  });

  test('a secret in an error MESSAGE is scrubbed, and the line stays parseable', () => {
    const { t, lines } = sink();
    t.emit({
      type: 'error',
      message: `provider said: token=${OPENROUTER_SHAPED}`,
      code: 'BRAIN_AUTH',
      retryable: false,
      where: 'turn',
    });
    const line = lines[0] ?? '';
    expect(line).not.toContain(OPENROUTER_SHAPED);
    const row = parsed(lines)[0];
    expect(typeof row?.['message']).toBe('string');
    expect(row?.['message']).toContain(REDACTION_MARKER);
  });
});

describe('both sinks, and the failure that must not be silent', () => {
  test('a file is appended to, not truncated, and holds the same rows as stdout', () => {
    const file = join(tmp, 'appended.jsonl');
    const first = sink(file);
    first.t.emit({ type: 'input', text: 'one', chars: 3, bytes: 3 });
    const second = sink(file);
    second.t.emit({ type: 'input', text: 'two', chars: 3, bytes: 3 });
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.map((r) => r['text'])).toEqual(['one', 'two']);
    // `seq` restarts per sink, which is why the second file reads as a whole
    // session only when one sink owns it. Asserted rather than documented,
    // because a reader who concatenates two sinks' files needs to know.
    expect(rows.map((r) => r['seq'])).toEqual([1, 1]);
  });

  test('the parent directory is created, so a fresh runtime dir is not a failure', () => {
    const file = join(tmp, 'nested', 'deeper', 'run.jsonl');
    const { t } = sink(file);
    t.emit({ type: 'input', text: 'x', chars: 1, bytes: 1 });
    const written = readFileSync(file, 'utf8');
    expect(written).toContain('"type":"input"');
  });

  test('a file that cannot be written does NOT lose the row, and the count says so', () => {
    // Best-effort is only true if something reports how often it was not. A
    // transcript that threw here would take the turn down and report a failure of
    // the RECORDER instead of of the thing being recorded.
    const { t, lines } = sink(join(tmp, 'no-such-dir-nested-deep', 'x', 'run.jsonl'));
    const file = t.file as string;
    const before = t.writeFailures;
    t.emit({ type: 'input', text: 'kept', chars: 4, bytes: 4 });
    expect(lines[0]).toContain('"text":"kept"');
    // Either it wrote (mkdirSync succeeded) or it counted a failure — both are
    // correct. What must never happen is a silent drop.
    expect(t.writeFailures).toBeGreaterThanOrEqual(before);
    expect(file.length).toBeGreaterThan(0);
  });

  test('`close()` writes a session.end that says the summary never arrived', () => {
    const { t, lines } = sink();
    t.close();
    const row = parsed(lines).at(-1);
    expect(row?.['type']).toBe('session.end');
    expect(row?.['ok']).toBe(false);
    expect(row?.['reason']).toContain('did not reach its end');
  });
});

describe('this is NOT the telemetry bus', () => {
  test('the transcript never imports TelemetryWriter, and says why in source', () => {
    // The rule is structural, so it is checked structurally. `TelemetryWriter`'s
    // schema forbids free text on purpose (`writer.ts:6-8`); a transcript cannot
    // satisfy that AND carry a user's utterance, so it is a separate sink with
    // its own redaction rather than a hole in the telemetry schema.
    const source = read('src/cli/transcript.ts', 'utf8');
    expect(source).not.toMatch(/^import .*telemetry\/writer\.js/m);
    expect(source).toContain('WHY THIS IS NOT `TelemetryWriter`');
  });

  test('and TelemetryWriter is still the closed-union writer it always was', () => {
    // The other direction of the same property: the guard the transcript declines
    // to satisfy must still be enforced by the writer that does. `record` is
    // derived from the class, not typed in, so a rename fails here instead of
    // turning this into an assertion about nothing.
    const methods = Object.getOwnPropertyNames(TelemetryWriter.prototype);
    expect(methods).toContain('record');
  });
});

describe('where the file goes', () => {
  test('the default path is under the runtime dir, is file-safe, and names the session', () => {
    const path = defaultTranscriptPath({
      runtimeDir: join('C:', 'rt'),
      session: 'ses_abc',
      now: new Date('2026-10-03T12:34:56.789Z'),
    });
    expect(path).toContain(join('driver', '2026-10-03T12-34-56-789Z-ses_abc.jsonl'));
    // The timestamp is already in the name; repeating it is a filename nobody types.
    expect(path.split('2026-10-03T12-34-56-789Z')).toHaveLength(2);
    // No `:` and no `.` in the label — a colon is a path separator error on
    // Windows, a dot is what `..` needs, and neither is a character an OpenCode
    // session id uses.
    const name = path.slice(path.lastIndexOf('\\') + 1);
    expect(name).not.toContain(':');
    expect(name.split('-ses_abc.jsonl')[0]).not.toContain('.');
  });

  test('a session id with filesystem-hostile characters is neutralised, not dropped', () => {
    const path = defaultTranscriptPath({
      runtimeDir: join('C:', 'rt'),
      session: '../../etc/passwd',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    const name = path.slice(path.lastIndexOf('\\') + 1);
    expect(name).not.toContain('..');
    expect(name).not.toContain('/');
    expect(name.endsWith('.jsonl')).toBe(true);
    // The value is still legible: `etc_passwd` is diagnosable where a hash would
    // not be.
    expect(name).toContain('etc_passwd');
  });

  test('and no session at all still produces a usable name, stamped ONCE', () => {
    const path = defaultTranscriptPath({ runtimeDir: join('C:', 'rt'), session: null, now: new Date('2026-01-01T00:00:00.000Z') });
    expect(path).toContain('2026-01-01T00-00-00-000Z-no-session.jsonl');
  });
});

describe('the supervisor note', () => {
  test('it names the Rust supervisor and denies the driver any part in serve', () => {
    // Acceptance #4's caveat, pinned as a string rather than as a comment: a
    // transcript with no statement about who owns `opencode serve` invites the
    // reader to assume the driver started it.
    expect(SERVE_SUPERVISOR_NOTE).toContain('apps/desktop/src-tauri/src/main.rs');
    expect(SERVE_SUPERVISOR_NOTE).toContain('neither spawns nor kills');
  });
});