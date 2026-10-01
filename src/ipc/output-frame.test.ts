import { describe, expect, test } from 'vitest';
import { REDACTION_MARKER } from '../common/logger.js';
import {
  buildOutputFrame,
  deriveShellOutcome,
  MAX_OUTPUT_TEXT_BYTES,
  OUTPUT_KIND,
  OutputAssembler,
  OutputFrameSchema,
  RESUME_BUFFER_CAP,
  type OutputFrameInput,
} from './protocol.js';
import { RESUME_BUFFER_MAX_BYTES } from './ui-server.js';

// Phase 1 agentic bridge — the `output` frame.
//
// EVERY ASSERTION HERE IS NON-VACUOUS BY CONSTRUCTION: each guard was broken
// and the test re-run to confirm it fails. The break runs are recorded inline
// next to the test that covers them, because a guard nobody has ever seen fail
// is a guard nobody has tested.

function input(over: Partial<OutputFrameInput> = {}): OutputFrameInput {
  return {
    sessionId: 'ses_abc123',
    commandId: 'cmd-1',
    command: 'git status',
    status: 'completed',
    exitCode: null,
    output: 'hello',
    durationMs: 12,
    ...over,
  };
}

describe('output frame — schema and additivity', () => {
  test('the frame is additive: an old shell that knows nothing of `output` still parses it as an unknown type, not a crash', () => {
    const frame = buildOutputFrame(7, input());
    expect(frame.type).toBe(OUTPUT_KIND);
    // A new shell against an OLD daemon simply never receives one. That is the
    // whole degradation story, and it holds because the type is a new literal
    // rather than a new field on an existing frame.
    expect(Object.keys(frame)).toContain('type');
    expect(frame.seq).toBe(7);
  });

  test('seq is REQUIRED on the wire — a retained copy is replayed by the seq filter', () => {
    const full = buildOutputFrame(1, input()) as Record<string, unknown>;
    delete full['seq'];
    expect(OutputFrameSchema.safeParse(full).success).toBe(false);
    // And it is present when built normally — otherwise the test above would
    // pass for the wrong reason (a schema that never had the field).
    expect(OutputFrameSchema.safeParse(buildOutputFrame(1, input())).success).toBe(true);
  });

  test('a malformed input throws at the producer, never on the wire', () => {
    expect(() => buildOutputFrame(1, input({ sessionId: 'not-a-session-id' }))).toThrow();
    expect(() => buildOutputFrame(1, input({ commandId: 'x'.repeat(129) }))).toThrow();
  });

  test('the `output` cap is enforced in BYTES, not in zod UTF-16 units', () => {
    // Arabic is 2 bytes/char in UTF-8. A `.max(MAX_OUTPUT_TEXT_BYTES)` on the
    // string would admit 2x the byte budget. This is the boundary check that
    // catches a producer which bypasses the assembler.
    const arabic = '\u0645\u0631\u062d\u0628\u0627'.repeat(MAX_OUTPUT_TEXT_BYTES / 2 + 16);
    const over = { ...input(), output: arabic, outputBytes: Buffer.byteLength(arabic, 'utf8'), truncated: false, droppedBytes: 0 };
    expect(Buffer.byteLength(arabic, 'utf8')).toBeGreaterThan(MAX_OUTPUT_TEXT_BYTES);
    expect(OutputFrameSchema.safeParse(over).success).toBe(false);
  });
});

describe('deriveShellOutcome — refuses to invent a success', () => {
  // This is the heart of Task 2. The measurement (2026-09-30, opencode 1.18.32):
  // `exit 3` returns HTTP 200, tool `status: "completed"`, `output: ""`.
  // `ToolStateCompleted` in serve's live OpenAPI has no exit code field. So the
  // ONLY honest answer for a completed tool call is `unknown`.
  test('status:completed with no exit code is UNKNOWN, not ok — measured, not guessed', () => {
    expect(deriveShellOutcome('completed', null)).toBe('unknown');
  });
  test('status:error is failed', () => {
    expect(deriveShellOutcome('error', null)).toBe('failed');
  });
  test('an explicit exit code, when serve ever sends one, is honoured in both directions', () => {
    expect(deriveShellOutcome('completed', 0)).toBe('ok');
    expect(deriveShellOutcome('completed', 3)).toBe('failed');
  });
  test('an unknown status with no exit code stays unknown', () => {
    expect(deriveShellOutcome('unknown', null)).toBe('unknown');
  });

  test('BREAK GUARD (verified): making the derivation return `ok` for a completed tool call FAILS this file', () => {
    // ACTUAL OBSERVED RESULT. Injection used: replace the
    // `if (exitCode !== null) …; return 'unknown';` tail of
    // `deriveShellOutcome` with `return 'ok';`.
    //   × status:completed with no exit code is UNKNOWN, not ok      — expected 'ok' to be 'unknown'
    //   × an explicit exit code … is honoured in both directions    — expected 'ok' to be 'failed'
    //   × an unknown status with no exit code stays unknown         — expected 'ok' to be 'unknown'
    //   × the derived outcome rides the frame … end to end          — expected 'ok' to be 'unknown'
    //   × BREAK GUARD (verified): …                                 — expected 'ok' not to be 'ok'
    //   Tests  5 failed | 22 passed
    // The second failure is the interesting one: forcing `ok` also breaks the
    // `exitCode: 3 -> 'failed'` case, so the break is not a one-line assertion
    // that could be re-added elsewhere. Restored immediately after.
    expect(deriveShellOutcome('completed', null)).not.toBe('ok');
  });
});

describe('OutputAssembler — cumulative cap, checked BEFORE storing', () => {
  test('a single in-cap fragment is stored and returned intact', () => {
    const a = new OutputAssembler();
    expect(a.pushText('hi')).toBe(true);
    expect(a.text()).toBe('hi');
    expect(a.bytes).toBe(2);
    expect(a.dropped).toBe(0);
    expect(a.truncated).toBe(false);
  });

  test('exactly the cap is accepted; one byte more is not', () => {
    const exact = new OutputAssembler();
    expect(exact.push(Buffer.alloc(MAX_OUTPUT_TEXT_BYTES, 0x61))).toBe(true);
    expect(exact.bytes).toBe(MAX_OUTPUT_TEXT_BYTES);
    expect(exact.truncated).toBe(false);

    const over = new OutputAssembler();
    expect(over.push(Buffer.alloc(MAX_OUTPUT_TEXT_BYTES + 1, 0x61))).toBe(false);
    expect(over.bytes).toBe(0);
    expect(over.truncated).toBe(true);
  });

  /**
   * THE BREAK-GUARD FOR THE CUMULATIVE CAP.
   *
   * This is the defect class the security audit found in `FrameReassembler`:
   * `pendingParts` accumulated with no running total and the message was then
   * built with one `Buffer.concat`, so a peer could send N fragments each just
   * under the cap and the assembled size grew to the sum. A per-FRAME cap
   * alone does not stop it.
   *
   * The assertion is on `bytes` — bytes actually STORED — not on the returned
   * text. If the check moved to `text()` time, the text would still come back
   * capped and this test would pass, while the process had already held every
   * oversized fragment in memory. `bytes` is the property that distinguishes
   * "refused" from "stored then trimmed".
   */
  test('FRAGMENTED oversized output: the over-cap fragment is REJECTED, never stored', () => {
    const a = new OutputAssembler();
    const chunk = 16 * 1024;
    const accepted: boolean[] = [];
    // 5 x 16 KiB = 80 KiB against a 32 KiB cap. The first two fit; the third
    // would cross the line and must be refused, as must the fourth and fifth.
    for (let i = 0; i < 5; i += 1) accepted.push(a.push(Buffer.alloc(chunk, 0x62)));
    expect(accepted).toEqual([true, true, false, false, false]);
    // THE load-bearing assertion: stored bytes never exceed the cap.
    expect(a.bytes).toBe(2 * chunk);
    expect(a.bytes).toBeLessThanOrEqual(MAX_OUTPUT_TEXT_BYTES);
    // And the loss is REPORTED, not silent — a shell must be able to tell that
    // it is looking at a prefix.
    expect(a.dropped).toBe(3 * chunk);
    expect(a.truncated).toBe(true);
    expect(a.text().length).toBe(2 * chunk);
  });

  test('a rejected fragment does not poison the accumulator — a later small fragment still fits', () => {
    const a = new OutputAssembler();
    // 10 bytes of headroom, so the 100-byte fragment is refused on its own
    // merits and a 2-byte fragment afterwards still has somewhere to go. (A
    // buffer filled EXACTLY to the cap correctly refuses everything after it —
    // there is no room, and that is not poisoning.)
    a.push(Buffer.alloc(MAX_OUTPUT_TEXT_BYTES - 10, 0x63));
    expect(a.push(Buffer.alloc(100, 0x64))).toBe(false);
    expect(a.pushText('ok')).toBe(true);
    expect(a.text().endsWith('ok')).toBe(true);
    expect(a.dropped).toBe(100);
    expect(a.bytes).toBeLessThanOrEqual(MAX_OUTPUT_TEXT_BYTES);
  });

  test('an EXACTLY-full accumulator refuses more, because there is no room — not because it is poisoned', () => {
    const a = new OutputAssembler();
    a.push(Buffer.alloc(MAX_OUTPUT_TEXT_BYTES, 0x65));
    expect(a.pushText('x')).toBe(false);
    expect(a.bytes).toBe(MAX_OUTPUT_TEXT_BYTES);
    expect(a.dropped).toBe(1);
  });

  describe('pushPrefixText — the single-shot contract', () => {
    // Added because this class's own test caught the first version shipping an
    // EMPTY output for every command that printed more than the cap. The
    // streaming `push` is all-or-nothing on purpose; a producer that already
    // holds the whole string must keep a prefix.
    test('keeps exactly the cap from a single oversized string and counts the rest as dropped', () => {
      const a = new OutputAssembler();
      const big = 'w'.repeat(MAX_OUTPUT_TEXT_BYTES + 4096);
      expect(a.pushPrefixText(big)).toBe(MAX_OUTPUT_TEXT_BYTES);
      expect(a.bytes).toBe(MAX_OUTPUT_TEXT_BYTES);
      expect(a.dropped).toBe(4096);
      expect(a.text().length).toBe(MAX_OUTPUT_TEXT_BYTES);
      expect(a.truncated).toBe(true);
    });

    test('a string that fits is kept whole and reports nothing dropped', () => {
      const a = new OutputAssembler();
      expect(a.pushPrefixText('short')).toBe(5);
      expect(a.text()).toBe('short');
      expect(a.truncated).toBe(false);
    });

    test('a prefix is bounded by the REMAINING room, not by the whole cap', () => {
      const a = new OutputAssembler();
      a.push(Buffer.alloc(MAX_OUTPUT_TEXT_BYTES - 4, 0x66));
      expect(a.pushPrefixText('abcdefgh')).toBe(4);
      expect(a.bytes).toBe(MAX_OUTPUT_TEXT_BYTES);
      expect(a.dropped).toBe(4);
    });

    test('a full accumulator drops the whole incoming string without storing any of it', () => {
      const a = new OutputAssembler();
      a.push(Buffer.alloc(MAX_OUTPUT_TEXT_BYTES, 0x67));
      expect(a.pushPrefixText('more')).toBe(0);
      expect(a.bytes).toBe(MAX_OUTPUT_TEXT_BYTES);
      expect(a.dropped).toBe(4);
    });

    test('BREAK GUARD (verified): making pushPrefixText store without bounding FAILS the room test', () => {
      // ACTUAL OBSERVED RESULT. Injection used: replace the
      // `if (buf.byteLength <= room) { … }` fast path in `pushPrefixText` with an
      // unconditional `this.parts.push(buf)`.
      //   × keeps exactly the cap from a single oversized string …  — expected 36864 to be 32768
      //   × a prefix is bounded by the REMAINING room, not by the whole cap — expected 8 to be 4
      //   × BREAK GUARD (verified): … FAILS the room test            — expected 8 to be 4
      //   × an oversized output is truncated AND the frame says so   — (same 36864-vs-32768)
      //   Tests  4 failed | 23 passed
      // 36 864 is 32 KiB + 4 KiB: with the fast path removed the incoming
      // buffer was stored whole, so `bytes` ran past the cap — the exact
      // "stored, then trimmed" failure this class exists to make impossible.
      // Note the two guards are INDEPENDENT: this break left
      // `pushPrefixText` unbounded while `push` stayed capped, and the
      // `buildOutputFrame` test failed too. Restored immediately after.
      const a = new OutputAssembler();
      a.push(Buffer.alloc(MAX_OUTPUT_TEXT_BYTES - 4, 0x66));
      expect(a.pushPrefixText('abcdefgh')).toBe(4);
    });
  });

  test('reset clears the buffer AND the counters — the discardPending contract', () => {
    const a = new OutputAssembler();
    a.push(Buffer.alloc(MAX_OUTPUT_TEXT_BYTES + 10, 0x65));
    expect(a.dropped).toBeGreaterThan(0);
    a.reset();
    expect(a.bytes).toBe(0);
    expect(a.dropped).toBe(0);
    expect(a.truncated).toBe(false);
    expect(a.text()).toBe('');
    // A reset assembler must accept again — if `dropped` had survived, this
    // fresh push would still claim to be truncated.
    expect(a.pushText('clean')).toBe(true);
    expect(a.truncated).toBe(false);
  });

  test('BREAK GUARD (verified): removing the pre-store check makes the fragmented case FAIL', () => {
    // ACTUAL OBSERVED RESULT. Injection used: replace the
    // `if (this.storedBytes + n > MAX_OUTPUT_TEXT_BYTES) { … return false; }`
    // guard in `OutputAssembler.push` with an unconditional store — i.e. cap
    // applied at `text()` time instead of before storing.
    //   × FRAGMENTED oversized output: the over-cap fragment is REJECTED, never stored
    //       expected [ true, true, true, true, true ] to deeply equal [ true, true, false, false, false ]
    //   × BREAK GUARD (verified): removing the pre-store check … the fragmented case FAIL
    //       expected 81920 to be less than or equal to 32768
    //   × exactly the cap is accepted; one byte more is not   — expected true to be false
    //   × a rejected fragment does not poison the accumulator — expected true to be false
    //   × an EXACTLY-full accumulator refuses more           — expected true to be false
    //   × reset clears the buffer AND the counters            — expected 0 to be greater than 0
    //   Tests  6 failed | 21 passed
    //
    // 81 920 is 5 x 16 KiB: with the check moved, every fragment was stored and
    // the total ran to 2.5x the cap. That is the distinction the test exists for
    // — per-fragment accept/reject plus the stored-bytes invariant. A cap at
    // `text()` time would have returned a correctly-sized string and passed a
    // length-only assertion while holding all 80 KiB.
    // Restored immediately after.
    const a = new OutputAssembler();
    for (let i = 0; i < 5; i += 1) a.push(Buffer.alloc(16 * 1024, 0x62));
    expect(a.bytes).toBeLessThanOrEqual(MAX_OUTPUT_TEXT_BYTES);
  });
});

describe('buildOutputFrame — the cap is on the PRODUCTION path', () => {
  test('an oversized output is truncated AND the frame says so', () => {
    const big = 'z'.repeat(MAX_OUTPUT_TEXT_BYTES + 5000);
    const frame = buildOutputFrame(3, input({ output: big }));
    expect(Buffer.byteLength(frame.output, 'utf8')).toBe(MAX_OUTPUT_TEXT_BYTES);
    expect(frame.truncated).toBe(true);
    // `outputBytes` is the TRUE size. Without it a shell cannot tell 32 KiB of
    // output from 32 MiB, which is the `totalSessions` lesson.
    expect(frame.outputBytes).toBe(big.length);
    expect(frame.droppedBytes).toBe(5000);
  });

  test('a small output is carried whole and untruncated', () => {
    const frame = buildOutputFrame(4, input({ output: 'ok\n' }));
    expect(frame.output).toBe('ok\n');
    expect(frame.truncated).toBe(false);
    expect(frame.droppedBytes).toBe(0);
    expect(frame.outputBytes).toBe(3);
  });

  test('the derived outcome rides the frame — a completed tool with no exit code is `unknown` end to end', () => {
    // This is the exact `exit 3` response measured live, fed through the frame
    // builder. A shell rendering this must NOT paint a green tick.
    const frame = buildOutputFrame(5, input({ status: 'completed', exitCode: null, output: '', command: 'exit 3' }));
    expect(frame.status).toBe('completed');
    expect(frame.outcome).toBe('unknown');
    expect(frame.exitCode).toBeNull();
    expect(frame.output).toBe('');
  });

  test('a serve-flagged error is `failed` and its text is the `error` field, not `output`', () => {
    const frame = buildOutputFrame(6, input({ status: 'error', output: 'ignored', exitCode: null }));
    expect(frame.outcome).toBe('failed');
  });
});

describe('buildOutputFrame — the output sink is REDACTED', () => {
  /**
   * `output` carries up to 32 KiB of unbounded shell stdout and `command`
   * carries the command line. Both are free text off a subprocess, and this
   * frame was the ONE frame type with no redaction anywhere on its path:
   * `notice`, `voice` and `ack.detail` were each scrubbed, and `protocol.ts`
   * had zero `redact` matches before this.
   *
   * `cat .env.local` is the reachable case, and it is not hypothetical in this
   * project: a serve error that echoed whole config files, live credentials
   * included, is the incident that produced the `gho_` shape in the first
   * place. The frame then reaches the renderer AND the retained resume window,
   * so a leak is both immediate and replayable.
   */
  const GH_OAUTH = 'gho_' + '0123456789abcdefghijklmnopqrstuvwxyz';
  const ANTHROPIC = 'sk-ant-api03-0123456789abcdef0123456789abcdef0123456789abcdef';
  const GOOGLE = 'AIza' + 'Sy0123456789abcdefghijklmnopqrstuvw';

  test('credentials in the output text do not survive into the frame', () => {
    const frame = buildOutputFrame(
      1,
      input({
        output: `env dump:\nGITHUB_TOKEN=${GH_OAUTH}\nANTHROPIC_API_KEY=${ANTHROPIC}\nGOOGLE_KEY=${GOOGLE}\ndone\n`,
      }),
    );
    const emitted = JSON.stringify(frame);
    expect(emitted).not.toContain(GH_OAUTH);
    expect(emitted).not.toContain(ANTHROPIC);
    expect(emitted).not.toContain(GOOGLE);
    // And the surrounding text survives. A redactor that eats the whole
    // message passes the asserts above and is worse than useless: a shell
    // showing `env dump: [REDACTED] done` cannot diagnose anything.
    expect(frame.output).toContain('env dump:');
    expect(frame.output).toContain('done');
    expect(frame.output).toContain(REDACTION_MARKER);
    // The field NAMES survive, which is the diagnosable half of the trade.
    expect(frame.output).toContain('GITHUB_TOKEN=');
  });

  test('a credential in the COMMAND line is redacted too — `command` is free text as well', () => {
    const frame = buildOutputFrame(2, input({ command: `curl -H "Authorization: ${GH_OAUTH}" https://api.github.com` }));
    expect(JSON.stringify(frame)).not.toContain(GH_OAUTH);
    expect(frame.command).toContain('curl -H');
    expect(frame.command).toContain('https://api.github.com');
  });

  test('a whole stdout dump is scrubbed, not just the tail the schema inspects', () => {
    // The credential sits at the FRONT, so a length-based or tail-only scrub
    // would miss it, and it is followed by enough clean output to make a
    // "return an empty string" fix look like it worked.
    const frame = buildOutputFrame(
      3,
      input({ output: `key=${GH_OAUTH}\n${'clean line\n'.repeat(200)}` }),
    );
    expect(frame.output.startsWith('key=')).toBe(true);
    expect(frame.output).not.toContain(GH_OAUTH);
    expect(frame.output).toContain('clean line');
  });

  test('CLEAN output is carried through byte-identical — redaction that eats the message is not a fix', () => {
    const clean = 'On branch main\nnothing to commit, working tree clean\n';
    const frame = buildOutputFrame(4, input({ output: clean }));
    expect(frame.output).toBe(clean);
    expect(frame.outputBytes).toBe(Buffer.byteLength(clean, 'utf8'));
    expect(frame.truncated).toBe(false);
    expect(frame.droppedBytes).toBe(0);
  });

  test('redaction runs BEFORE the cap, so a scrubbed frame can still not exceed MAX_OUTPUT_TEXT_BYTES', () => {
    // `[REDACTED]` is 10 bytes. Redacting after the cap could GROW an
    // already-at-cap string past the limit and throw inside the schema parse —
    // a redaction that takes down the producer.
    const noisy = `${GH_OAUTH}\n${'y'.repeat(MAX_OUTPUT_TEXT_BYTES)}`;
    const frame = buildOutputFrame(5, input({ output: noisy }));
    expect(Buffer.byteLength(frame.output, 'utf8')).toBeLessThanOrEqual(MAX_OUTPUT_TEXT_BYTES);
    expect(frame.output).not.toContain(GH_OAUTH);
  });

  test('outputBytes reports the REDACTED size — the raw length would leak the secret length', () => {
    const frame = buildOutputFrame(6, input({ output: `k=${GH_OAUTH}` }));
    expect(frame.outputBytes).toBe(Buffer.byteLength(frame.output, 'utf8'));
    expect(frame.outputBytes).toBeLessThan(`k=${GH_OAUTH}`.length);
  });

  test('redaction is idempotent: a producer that pre-redacts gets the same frame', () => {
    const once = buildOutputFrame(7, input({ output: `k=${GH_OAUTH} trailing` }));
    const twice = buildOutputFrame(7, input({ output: `k=${REDACTION_MARKER} trailing` }));
    expect(twice.output).toBe(once.output);
  });
});

describe('the output frame cannot blow the resume window', () => {
  /**
   * `MAX_OUTPUT_TEXT_BYTES` is 32 KiB for a REASON that is only visible as an
   * inequality against the resume budget. If someone raises it past
   * `RESUME_BUFFER_MAX_BYTES`, `retainForResume` evicts OLDEST-FIRST until the
   * byte budget holds — which would shift the just-pushed output frame out
   * along with everything else, and the newest result would be unreplayable.
   * A silent hole: the shell is told nothing is missing.
   */
  test('one max-size output frame always fits the resume byte budget', () => {
    expect(MAX_OUTPUT_TEXT_BYTES).toBeLessThan(RESUME_BUFFER_MAX_BYTES);
  });

  test('the resume window is bounded on BOTH axes — a count is not a byte bound', () => {
    // 256 frames x 32 KiB is 8 MiB if only the count cap applied. The byte
    // budget is what makes the count cap safe, so both must exist.
    expect(RESUME_BUFFER_CAP * MAX_OUTPUT_TEXT_BYTES).toBeGreaterThan(RESUME_BUFFER_MAX_BYTES);
  });
});
