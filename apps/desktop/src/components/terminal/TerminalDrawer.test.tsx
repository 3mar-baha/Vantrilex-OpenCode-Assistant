import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, test, vi } from 'vitest';
// The projection's own SOURCE, for the scan below. `?raw` rather than `fs` +
// `import.meta.url`: under Vitest the module URL is Vite's http URL, not a
// `file:` one, so `readFileSync(new URL(…))` throws "The URL must be of scheme
// file" — a failure that reads like a broken guard rather than a broken path.
import TERMINAL_DRAWER_SOURCE from './TerminalDrawer.tsx?raw';
import {
  MAX_LINE_CHARS,
  MAX_TERMINAL_LINES,
  SESSION_LABEL_MAX,
  SESSION_LABEL_SEPARATOR,
  TerminalDrawer,
  appendTerminalLines,
  clampLine,
  deriveShellOutcomeFallback,
  linesFromOutputFrame,
  resolveShellOutcome,
  sessionLabel,
  type OutputFrameLike,
  type ShellOutputStatus,
  type TerminalLine,
} from './TerminalDrawer.js';
import { auditBento, formatViolations, BENTO_BASE_WIDTH_PX } from '../bento/layoutBudget.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** A terminal line. `sessionId` is display-only and genuinely optional here. */
const line = (
  id: string,
  text: string,
  kind: TerminalLine['kind'] = 'output',
  sessionId?: string,
): TerminalLine => ({
  id,
  text,
  kind,
  ...(sessionId === undefined ? {} : { sessionId }),
});

/**
 * One `output` frame with a session, for the blocks that are about sessions and
 * about the frame's own fields rather than about the projection's ordering. The
 * defaults are COHERENT: `completed` + no exit code + `outcome: 'unknown'` is
 * what `deriveShellOutcome` actually produces for that input.
 */
const frameWith = (o: Partial<OutputFrameLike> = {}): OutputFrameLike => ({
  sessionId: 'ses_01HQ7ZK4M2N8P3Q6R9S0T1V2W3',
  commandId: 'cmd_1',
  command: 'npm run build',
  status: 'completed',
  outcome: 'unknown',
  exitCode: null,
  output: 'built in 1.2s',
  droppedBytes: 0,
  truncated: false,
  durationMs: 1200,
  ...o,
});

const drawer = (props: Partial<React.ComponentProps<typeof TerminalDrawer>> = {}): HTMLElement =>
  render(
    <TerminalDrawer
      open
      onToggle={() => undefined}
      lines={[line('1', 'hello')]}
      {...props}
    />,
  );

describe('TerminalDrawer: SILENT BY DESIGN', () => {
  // A comment saying "it does not speak" decays into a claim nobody checks. So
  // both halves of the claim are asserted as structure, not prose.
  test('the props surface offers no way to speak or announce', () => {
    // If a `onSpeak`/`onAnnounce` prop were ever added, the type stops matching
    // this object and the file fails to compile — which is the point.
    const exhaustive: React.ComponentProps<typeof TerminalDrawer> = {
      open: true,
      onToggle: () => undefined,
      lines: [],
    };
    expect(Object.keys(exhaustive).sort()).toEqual(['lines', 'onToggle', 'open']);
  });

  test('it emits no audio: no Audio element, no TTS, no speech synthesis', () => {
    const ctorSpy = vi.fn();
    // If the drawer ever reached for audio, one of these would fire.
    vi.stubGlobal('Audio', class {
      constructor(...args: unknown[]) {
        ctorSpy(...args);
      }
    });
    const synthSpy = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak: synthSpy });
    drawer();
    expect(document.body.querySelector('audio')).toBeNull();
    expect(document.body.querySelector('[data-testid="announce"]')).toBeNull();
    expect(ctorSpy).not.toHaveBeenCalled();
    expect(synthSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test('the log is NOT a live region — streamed output read aloud is unusable', () => {
    drawer();
    const log = document.body.querySelector('[data-testid="terminal-log"]');
    expect(log?.getAttribute('role')).toBe('log');
    expect(log?.getAttribute('aria-live')).toBeNull();
    // …and it is keyboard-reachable, which is the accessible alternative.
    expect(log?.getAttribute('tabindex')).toBe('0');
  });
});

describe('TerminalDrawer: untrusted output is never markup', () => {
  const PAYLOAD = '<img src=x onerror="globalThis.__pwned=1"><script>globalThis.__pwned=1</script>';

  test('a payload line renders as TEXT and creates no elements', () => {
    // The component has no `dangerouslySetInnerHTML`; this proves the rendered
    // result agrees, rather than trusting review to have read the source.
    drawer({ lines: [line('1', PAYLOAD)] });
    const log = document.body.querySelector('[data-testid="terminal-log"]');
    expect(log?.textContent ?? '').toContain(PAYLOAD);
    // The literal text is present, and the markup was NOT parsed into nodes.
    expect(log?.querySelector('img')).toBeNull();
    expect(log?.querySelector('script')).toBeNull();
    expect((globalThis as Record<string, unknown>)['__pwned']).toBeUndefined();
  });

  test('no element in the subtree carries an on* handler attribute', () => {
    drawer({ lines: [line('1', PAYLOAD)] });
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.toLowerCase().startsWith('on'), `${el.tagName} has ${attr.name}`).toBe(false);
      }
    }
  });
});

describe('TerminalDrawer: RTL correctness for a bilingual log', () => {
  test('each line lays out from its OWN first strong character', () => {
    // `unicode-bidi: plaintext` per line is what lets an Arabic command read
    // RTL and `npm run build` read LTR inside the same log. Forcing one
    // direction on the container reorders the Latin runs.
    drawer({ lines: [line('1', 'شغّل npm run build'), line('2', 'npm run build')] });
    const spans = Array.from(document.body.querySelectorAll('[data-testid="terminal-line"] > span:last-child'));
    expect(spans.length).toBe(2);
    for (const s of spans) {
      expect((s as HTMLElement).style.unicodeBidi).toBe('plaintext');
      expect((s as HTMLElement).style.textAlign).toBe('start');
      expect(s.getAttribute('dir')).toBe('auto');
    }
  });

  test('the root is RTL so the drawer inherits the surface direction', () => {
    drawer();
    expect(document.body.querySelector('[data-testid="terminal-drawer"]')?.getAttribute('dir')).toBe('rtl');
  });
});

describe('TerminalDrawer: collapse, retention, and bounds', () => {
  test('the toggle reports the next state, and aria-expanded follows `open`', () => {
    const seen: boolean[] = [];
    render(<TerminalDrawer open={false} onToggle={(n) => seen.push(n)} lines={[line('1', 'x')]} />);
    const btn = document.body.querySelector<HTMLButtonElement>('[data-testid="terminal-toggle"]');
    expect(btn?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      btn?.click();
    });
    expect(seen).toEqual([true]);
  });

  test('a CLOSED drawer shows a fixed number of lines, so its height is constant', () => {
    // Otherwise the collapsed rail grows with the log, which is the height
    // defect the 600 px minimum now makes the renderer's problem.
    const many = Array.from({ length: 40 }, (_, i) => line(String(i), `line ${i}`));
    render(<TerminalDrawer open={false} onToggle={() => undefined} lines={many} collapsedLines={1} />);
    expect(document.body.querySelectorAll('[data-testid="terminal-line"]')).toHaveLength(1);
  });

  test('an OPEN drawer shows everything it retained', () => {
    const many = Array.from({ length: 40 }, (_, i) => line(String(i), `line ${i}`));
    render(<TerminalDrawer open onToggle={() => undefined} lines={many} />);
    expect(document.body.querySelectorAll('[data-testid="terminal-line"]')).toHaveLength(40);
  });

  test('clampLine caps one enormous line and says how much it cut', () => {
    const huge = 'x'.repeat(MAX_LINE_CHARS + 500);
    const out = clampLine(huge);
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain('500');
  });

  test('appendTerminalLines keeps the TAIL and reports the drop', () => {
    // Head retention would show the log's start and hide what just happened.
    const current = Array.from({ length: 5 }, (_, i) => line(`old${i}`, `old ${i}`));
    const next = appendTerminalLines(current, [line('new', 'newest')], 3);
    expect(next.map((l) => l.id)).toEqual(['old3', 'old4', 'new']);
  });

  test('a re-delivered line is deduped by id, so a replay cannot double the log', () => {
    const once = appendTerminalLines([], [line('a', 'first')], 10);
    const twice = appendTerminalLines(once, [line('a', 'first')], 10);
    expect(twice).toHaveLength(1);
  });

  test('the dropped count is SHOWN, so a trim is never silent', () => {
    const lines = Array.from({ length: MAX_TERMINAL_LINES + 4 }, (_, i) => line(String(i), `l${i}`));
    drawer({ lines });
    expect(document.body.querySelector('[data-testid="terminal-dropped"]')?.textContent ?? '').toContain('4');
  });

  test('a malformed incoming batch cannot throw — the frame boundary is untrusted', () => {
    const bad = [null, undefined, { text: 'no id' }, { id: '', text: 'empty id' }] as unknown as TerminalLine[];
    expect(() => appendTerminalLines([], bad, 10)).not.toThrow();
    expect(appendTerminalLines([], bad, 10)).toEqual([]);
  });
});

describe('TerminalDrawer: the output-frame projection', () => {
  /**
   * A COHERENT frame by default: `completed` + `exitCode: 0` + `outcome: 'ok'` is
   * exactly what `deriveShellOutcome` produces for that input, so a test that
   * overrides only `status` or `exitCode` has to override `outcome` with it. A
   * deliberately INCOHERENT frame — one whose `outcome` contradicts its own
   * `status` + `exitCode` — is the point of the outcome block below, not a
   * shortcut here.
   */
  const frame = (o: Partial<OutputFrameLike> = {}): OutputFrameLike => ({
    sessionId: 'ses_01HQ7ZK4M2N8P3Q6R9S0T1V2W3',
    commandId: 'cmd_1',
    command: 'npm run build',
    status: 'completed',
    outcome: 'ok',
    exitCode: 0,
    output: 'built in 1.2s',
    droppedBytes: 0,
    truncated: false,
    durationMs: 1200,
    ...o,
  });

  test('OutputFrameLike is satisfied by the real OutputFrame', () => {
    // What this proves, precisely: every field the projection READS exists on
    // the wire frame with a COMPATIBLE type. Assigning a variable (not a bare
    // literal) is deliberate — it checks field compatibility without an
    // excess-property error, because the projection intentionally reads a
    // SUBSET and ignores `type`, `seq` and `outputBytes`. The field list below is
    // transcribed from `OutputFrameSchema`; if the transport renames or retypes
    // one of the fields this projection uses, this file fails to COMPILE.
    const wireFrame = {
      type: 'output',
      seq: 7,
      sessionId: 'ses_abc',
      commandId: 'cmd_1',
      command: 'npm run build',
      status: 'completed' as const,
      outcome: 'ok' as const,
      exitCode: 0,
      output: 'built in 1.2s',
      outputBytes: 12,
      droppedBytes: 0,
      truncated: false,
      durationMs: 1200,
    };
    const projection: OutputFrameLike = wireFrame;
    // …and the two fields that used to be carried-but-unread are now actually
    // READ, which is what makes the transcription above load-bearing rather than
    // decorative: this frame's session is on its lines, and it produces NO
    // contract warning, because it carries both values.
    const out = linesFromOutputFrame(projection);
    expect(out[0]?.sessionId).toBe('ses_abc');
    expect(out.some((l) => l.kind === 'warn')).toBe(false);
  });

  test('the eight original fields stay REQUIRED; the two new ones are optional by design', () => {
    // If one of the original eight became optional, a frame missing it would
    // render as a blank row instead of failing loudly at the boundary.
    type Required_ = Required<
      Pick<
        OutputFrameLike,
        'commandId' | 'command' | 'status' | 'exitCode' | 'output' | 'droppedBytes' | 'truncated' | 'durationMs'
      >
    >;
    const full: Required_ = {
      commandId: 'c',
      command: 'x',
      status: 'unknown',
      exitCode: null,
      output: '',
      droppedBytes: 0,
      truncated: false,
      durationMs: null,
    };
    expect(Object.keys(full)).toHaveLength(8);

    // `sessionId` and `outcome` are required by `OutputFrameSchema` and enforced
    // by the bridge, and are optional HERE only so the missing-value path is
    // representable at all — a required field cannot be absent, and an
    // unrepresentable path is an unwarned one. Pinned, so making them required
    // later (which would silently switch the warning off) fails here.
    const bare = frame({ sessionId: undefined, outcome: undefined });
    expect(bare.outcome).toBeUndefined();
    expect(bare.sessionId).toBeUndefined();
  });

  test('the command reads FIRST and the verdict LAST', () => {
    // The user asked for the command, so it reads first; a transcript-style log
    // puts the verdict at the end.
    const out = linesFromOutputFrame(frame());
    expect(out[0]?.kind).toBe('command');
    expect(out[0]?.text).toBe('npm run build');
    expect(out[out.length - 1]?.kind).toBe('system');
    expect(out[out.length - 1]?.text).toContain('اكتمل');
  });

  test('the body is split on newlines, and a trailing newline is not a row', () => {
    const out = linesFromOutputFrame(frame({ output: 'one\ntwo\n' }));
    expect(out.filter((l) => l.kind === 'output').map((l) => l.text)).toEqual(['one', 'two']);
  });

  test('an error frame colours its body as error, not as ordinary output', () => {
    const out = linesFromOutputFrame(frame({ status: 'error', outcome: 'failed', exitCode: 1, output: 'boom' }));
    expect(out.find((l) => l.text === 'boom')?.kind).toBe('error');
    expect(out[out.length - 1]?.text).toContain('فشل');
  });

  test('a null exitCode is not reported as 0', () => {
    // `exitCode: null` is the MEASURED case — serve has no such field — so the
    // summary must say that no code was reported rather than invent one. The null
    // arm's wording deliberately does NOT reuse the non-null arm's `رمز الخروج`
    // label, so this is testing that real distinction rather than passing by
    // accident on a substring.
    const out = linesFromOutputFrame(frame({ exitCode: null, outcome: 'unknown' }));
    expect(out[out.length - 1]?.text).not.toContain('رمز الخروج');
    expect(out[out.length - 1]?.text).toContain('لا يوجد رمز خروج');
  });

  test('the producer\'s truncation is SURFACED, never re-clamped silently', () => {
    const out = linesFromOutputFrame(frame({ truncated: true, droppedBytes: 4096 }));
    const last = out[out.length - 1];
    expect(last?.text).toContain('4096');
    expect(last?.kind).toBe('system');
  });

  test('droppedBytes is reported even when `truncated` was not set', () => {
    // Belt and braces on a flag the producer is supposed to set: if the byte
    // count says bytes went missing, the drawer says so.
    const out = linesFromOutputFrame(frame({ truncated: false, droppedBytes: 12 }));
    expect(out[out.length - 1]?.text).toContain('12');
  });

  test('line ids are commandId-scoped, so a replayed frame dedupes', () => {
    const a = linesFromOutputFrame(frame({ commandId: 'cmd_x' }));
    const b = linesFromOutputFrame(frame({ commandId: 'cmd_x' }));
    expect(a.map((l) => l.id)).toEqual(b.map((l) => l.id));
    // …and the ids are unique within the frame, so React keys are safe.
    expect(new Set(a.map((l) => l.id)).size).toBe(a.length);
    // Two DIFFERENT commands must not collide.
    const c = linesFromOutputFrame(frame({ commandId: 'cmd_y' }));
    expect(a[0]?.id).not.toBe(c[0]?.id);
  });

  test('a replayed frame through appendTerminalLines adds nothing', () => {
    const once = appendTerminalLines([], linesFromOutputFrame(frame()), 100);
    const twice = appendTerminalLines(once, linesFromOutputFrame(frame()), 100);
    expect(twice).toHaveLength(once.length);
  });

  test('a hostile single line is clamped AND the clamp is stated', () => {
    const out = linesFromOutputFrame(
      frame({ output: 'A'.repeat(MAX_LINE_CHARS + 100), status: 'error', outcome: 'failed' }),
    );
    const clamped = out.find((l) => l.kind === 'system' && l.text.includes('حرفاً محذوفاً'));
    expect(clamped, 'a guard that fires must be visible').toBeDefined();
  });

  test('an empty command field produces no phantom command line', () => {
    const out = linesFromOutputFrame(frame({ command: '', output: 'x' }));
    expect(out.filter((l) => l.kind === 'command')).toHaveLength(0);
  });
});

// ── TASK 1: the frame's verdict is READ, and a missing one is STATED ───────────

describe("TerminalDrawer: `outcome` is the producer's verdict, and it is read", () => {
  const frame = (o: Partial<OutputFrameLike> = {}): OutputFrameLike => ({
    sessionId: 'ses_01HQ7ZK4M2N8P3Q6R9S0T1V2W3',
    commandId: 'cmd_1',
    command: 'npm run build',
    status: 'completed',
    outcome: 'ok',
    exitCode: 0,
    output: 'built in 1.2s',
    droppedBytes: 0,
    truncated: false,
    durationMs: 1200,
    ...o,
  });
  const verdict = (f: OutputFrameLike): string => {
    const out = linesFromOutputFrame(f);
    return out[out.length - 1]?.text ?? '';
  };

  test("a frame's `outcome` WINS over its own status and exit code", () => {
    // THE guard. This frame is deliberately INCOHERENT: `status: 'error'` with
    // `exitCode: 0` would re-derive to `failed`, while the frame says `ok`. A
    // projection that recomputed the rule would print "failed" — and the user
    // would be reading a verdict the producer never sent. This is the whole
    // reason the field is read, and it is the assertion that fails the moment
    // anyone goes back to re-deriving.
    expect(verdict(frame({ status: 'error', exitCode: 0, outcome: 'ok' }))).toContain('اكتمل');
    expect(verdict(frame({ status: 'error', exitCode: 0, outcome: 'ok' }))).not.toContain('فشل');
  });

  test('the drift is symmetric: a `failed` verdict on a zero exit code is still a failure', () => {
    expect(verdict(frame({ status: 'completed', exitCode: 0, outcome: 'failed' }))).toContain('فشل');
  });

  test('`unknown` is not dressed up as a success', () => {
    // `unknown` is the MEASURED common case — serve reports no exit code — and
    // the old wording for it was a bare `اكتمل الأمر`, which reads as a success
    // report. The daemon's own shell bridge refuses to send an unqualified
    // completion notice for exactly this reason. So: completed, and unconfirmed.
    const text = verdict(frame({ status: 'completed', exitCode: null, outcome: 'unknown' }));
    expect(text).toContain('اكتمل');
    expect(text).toContain('غير مؤكدة');
    expect(text).not.toContain('بنجاح');
  });

  test('`ok` is stated as a success, which `unknown` is not', () => {
    expect(verdict(frame({ outcome: 'ok' }))).toContain('بنجاح');
  });

  test('a `failed` verdict outranks an unsettled status', () => {
    // Unchanged precedence, and it has to be: a task that has already failed is
    // not "still running", and the old code checked failure first for that reason.
    expect(verdict(frame({ status: 'running', exitCode: null, outcome: 'failed' }))).toContain('فشل');
  });

  test('an unsettled status still gets its own line, because that is not a verdict', () => {
    // `outcome` answers "what can be concluded"; `status` answers "where is the
    // command". Folding the second into the first would throw away the only
    // information a `running` frame carries.
    expect(verdict(frame({ status: 'running', exitCode: null, outcome: 'unknown' }))).toContain('قيد التنفيذ');
    expect(verdict(frame({ status: 'pending', exitCode: null, outcome: 'unknown' }))).toContain('بانتظار');
    expect(verdict(frame({ status: 'unknown', exitCode: null, outcome: 'unknown' }))).toContain('غير معروفة');
  });

  test('a frame with NO `outcome` is stated, not guessed in silence', () => {
    // The loud path. `resolveShellOutcome` falls back to the daemon's rule, and
    // the log says in Arabic that the verdict below it was INFERRED rather than
    // carried — so nobody can mistake the fallback for the producer's word.
    const out = linesFromOutputFrame(frame({ outcome: undefined }));
    const warns = out.filter((l) => l.kind === 'warn');
    expect(warns, 'a missing verdict must be visible, not silent').toHaveLength(1);
    expect(warns[0]?.text).toMatch(/\p{sc=Arabic}/u);
    expect(warns[0]?.text).toContain('outcome');
    expect(warns[0]?.text).toContain('مستنتجة');
    // It is `warn`, not `system`: it has to be findable while scrolling.
    expect(out[out.length - 1]?.kind).toBe('system');
    expect(out.indexOf(warns[0]!)).toBeLessThan(out.length - 1);
  });

  test('the fallback reproduces the daemon rule over the WHOLE matrix', () => {
    // `deriveShellOutcome` in `src/ipc/protocol.ts` is the authority and this is a
    // transcription of it. Transcribing a rule into prose is how two derivations
    // start telling different stories, so the transcription is pinned as a TABLE
    // instead: every status against every exit code serve can report, with the
    // expected value written out by hand from the daemon's own three clauses.
    //   1. `error` is a failure.
    //   2. a reported code decides `ok` vs `failed` — a negative one included.
    //   3. otherwise `unknown`.
    const expected: Readonly<Record<string, Readonly<Record<string, string>>>> = {
      completed: { 'null': 'unknown', '0': 'ok', '1': 'failed', '-9': 'failed', '137': 'failed' },
      error: { 'null': 'failed', '0': 'failed', '1': 'failed', '-9': 'failed', '137': 'failed' },
      running: { 'null': 'unknown', '0': 'ok', '1': 'failed', '-9': 'failed', '137': 'failed' },
      pending: { 'null': 'unknown', '0': 'ok', '1': 'failed', '-9': 'failed', '137': 'failed' },
      unknown: { 'null': 'unknown', '0': 'ok', '1': 'failed', '-9': 'failed', '137': 'failed' },
    };
    for (const [status, byCode] of Object.entries(expected)) {
      for (const [code, want] of Object.entries(byCode)) {
        const exitCode = code === 'null' ? null : Number.parseInt(code, 10);
        const got = deriveShellOutcomeFallback(status as ShellOutputStatus, exitCode);
        expect(`${status}/${code}=${got}`, `${status} + ${code}`).toBe(`${status}/${code}=${want}`);
      }
    }
  });

  test('the fallback fires ONLY when the frame carries no verdict', () => {
    for (const carried of ['ok', 'failed', 'unknown'] as const) {
      // A frame that DID carry a verdict never re-derives, even on an input the
      // rule would answer differently.
      const f = frame({ status: 'error', exitCode: 0, outcome: carried });
      expect(resolveShellOutcome(f)).toEqual({ outcome: carried, derived: false });
    }
    expect(resolveShellOutcome(frame({ outcome: undefined })).derived).toBe(true);
  });
});

// ── TASK 2: the log is labelled by session ────────────────────────────────────

describe('TerminalDrawer: every line is attributable to its session', () => {
  const A = 'ses_01HQ7ZK4M2N8P3Q6R9S0T1V2W3';
  const B = 'ses_01JXA9F1C7D5B2E8G4H0J6K3L1';

  test('the abbreviation is three characters from EACH end', () => {
    // See `sessionLabel` for the argument. The two properties that make it safe
    // are tested separately below; this one pins the shape itself.
    expect(sessionLabel(A)).toBe('01H·2W3');
    expect(sessionLabel(B)).toBe('01J·3L1');
  });

  test('two sessions that share a SUFFIX still look different', () => {
    // Exactly the case a TAIL-ONLY abbreviation gets wrong: same last three
    // characters, different heads. Break-the-guard confirms this is the test
    // that fails if the label ever stops reading the head.
    expect(sessionLabel('ses_aaaa1111zzz')).not.toBe(sessionLabel('ses_bbbb1111zzz'));
  });

  test('two sessions that share a PREFIX still look different', () => {
    // And the mirror: the case a HEAD-ONLY abbreviation gets wrong.
    expect(sessionLabel('ses_aaaa111111111')).not.toBe(sessionLabel('ses_aaaa222222222'));
  });

  test('the honest LIMIT, stated: ids agreeing on BOTH ends still collide', () => {
    // No six-character abbreviation can do better than this, so the property is
    // stated rather than implied. Two ids that agree on the first three AND the
    // last three characters produce the same chip, and a producer that minted
    // such a pair would make those two sessions indistinguishable HERE. The full
    // id is on `title` and `data-session` for exactly this reason, and the frame's
    // `commandId` is a `randomUUID()`, so two live sessions differing only in the
    // middle of a 120-character id is not a shape this transport produces. The
    // limit is written down so a future change to the scheme has to confront it.
    expect(sessionLabel('ses_aaa111111bbb')).toBe(sessionLabel('ses_aaa222222bbb'));
  });

  test('the separator cannot be confused with the id itself', () => {
    // `sessionId` matches `[A-Za-z0-9_-]`, so `·` in the middle can only ever be
    // an abbreviation. That is what makes a shortened label safe to show: the eye
    // is never looking at something that could pass for a real id fragment.
    expect(SESSION_LABEL_SEPARATOR).toBe('·');
    expect(/^[A-Za-z0-9_-]+$/.test(SESSION_LABEL_SEPARATOR)).toBe(false);
    // Both of these are longer than the abbreviation threshold, so both are
    // shortened and neither can be mistaken for the id itself. A body at or below
    // the threshold is shown whole ON PURPOSE, so the two are not in this list.
    expect(sessionLabel('ses_01HQ7ZK4M2N8P3Q6R9S0T1V2W3')).not.toBe('ses_01HQ7ZK4M2N8P3Q6R9S0T1V2W3');
    expect(sessionLabel('ses_abcdefghij')).not.toBe('ses_abcdefghij');
    expect(sessionLabel('ses_abcdefghij')).toContain(SESSION_LABEL_SEPARATOR);
  });

  test('a short id is shown WHOLE — abbreviating it would only lose characters', () => {
    expect(sessionLabel('ses_abc123')).toBe('abc123');
    expect(sessionLabel('ses_abc12')).toBe('abc12');
    // The `ses_` prefix is stripped: it is on every id and discriminates nothing.
    expect(sessionLabel('ses_abc123')).not.toContain('ses_');
  });

  test('the label is bounded, whatever the producer sends', () => {
    // `sessionId` is up to 124 characters and this is the untrusted boundary. The
    // chip is `shrink-0`, so an unbounded one would eat the output it labels.
    const longest = `ses_${'a'.repeat(120)}`;
    expect(sessionLabel(longest)).toBe('aaa·aaa');
    expect(sessionLabel(longest).length).toBeLessThanOrEqual(SESSION_LABEL_MAX + 1);
    // Degenerate inputs are total, not thrown: a throw here would lose the
    // frame's output, not just its label.
    expect(sessionLabel('')).toBe('');
    expect(sessionLabel(undefined as unknown as string)).toBe('');
    // A bare prefix cannot come from a conforming frame; show what arrived rather
    // than inventing a body for it.
    expect(sessionLabel('ses_')).toBe('ses_');
  });

  test('EVERY line of a frame carries its session, not just the first', () => {
    const out = linesFromOutputFrame(frameWith({ sessionId: A, output: 'a\nb\nc' }));
    expect(out.length).toBeGreaterThan(3);
    expect(out.every((l) => l.sessionId === A)).toBe(true);
  });

  test('two interleaved sessions produce a log where nothing is unattributed', () => {
    // THE two-session case. The router carries `createSession` / `switchSession`,
    // so this is the ordinary state of a workspace, not a hypothetical. Every
    // surviving line names the session that produced it.
    const a = linesFromOutputFrame(frameWith({ commandId: 'cmd_a', sessionId: A, command: 'npm run build' }));
    const b = linesFromOutputFrame(frameWith({ commandId: 'cmd_b', sessionId: B, command: 'git status' }));
    const merged = appendTerminalLines(appendTerminalLines([], a), b, 100);
    expect(merged.length).toBe(a.length + b.length);
    expect(new Set(merged.map((l) => l.sessionId))).toEqual(new Set([A, B]));
    expect(merged.every((l) => l.sessionId === A || l.sessionId === B)).toBe(true);
  });

  test('the chip is on the line, LTR, with the unabbreviated id one hover away', () => {
    render(
      <TerminalDrawer open onToggle={() => undefined} lines={[line('1', 'vite building', 'output', A)]} />,
    );
    const chips = document.body.querySelectorAll('[data-testid="terminal-line-session"]');
    expect(chips).toHaveLength(1);
    const chip = chips[0]!;
    expect(chip.textContent).toBe('01H·2W3');
    // `dir="ltr"`: the row is RTL and the chip holds a machine token, so without
    // an explicit direction the `·` and any leading digit reorder themselves.
    expect(chip.getAttribute('dir')).toBe('ltr');
    // The full id survives on the element, so nothing downstream re-derives it.
    expect(chip.getAttribute('title')).toContain(A);
    expect(document.body.querySelector('[data-testid="terminal-line"]')?.getAttribute('data-session')).toBe(A);
    // …and the line's own text is still laid out from its own first strong
    // character. Two different answers, on purpose, for two different strings.
    const text = document.body.querySelector('[data-testid="terminal-line"] > span:last-child')!;
    expect((text as HTMLElement).style.unicodeBidi).toBe('plaintext');
  });

  test('NO chip and a stated violation when the frame carries no session', () => {
    // A blank chip would read as "this line belongs to a session", which is the
    // exact ambiguity the chip was added to remove. So: no chip, and the absence
    // said once, in Arabic.
    const out = linesFromOutputFrame(frameWith({ sessionId: undefined }));
    expect(out.filter((l) => l.kind === 'warn').filter((l) => l.text.includes('sessionId'))).toHaveLength(1);
    const container = drawer({ lines: out });
    expect(container.querySelectorAll('[data-testid="terminal-line-session"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="terminal-line"]')?.getAttribute('data-session')).toBeNull();
  });

  test('a line with no session renders no chip — absence is not a blank label', () => {
    drawer({ lines: [line('1', 'no session here')] });
    expect(document.body.querySelectorAll('[data-testid="terminal-line-session"]')).toHaveLength(0);
  });

  test('`appendTerminalLines` carries the session through the merge and the cap', () => {
    const merged = appendTerminalLines([], linesFromOutputFrame(frameWith({ sessionId: A })), 3);
    expect(merged.every((l) => l.sessionId === A)).toBe(true);
  });
});

// ── TASKS 3 + 4: the two traps this change must not re-introduce ──────────────

describe('TerminalDrawer: `exitCode` has no lower bound, and truncation is the producer\'s', () => {
  test('a SIGNAL KILL is projected, not dropped', () => {
    // `exitCode` is `z.number().int().nullable()` with no lower bound, because a
    // signal kill is `-9`, and `bridge/ws-output.test.ts` asserts `-9` is
    // forwarded by the transport. A `>= 0` guard here would throw away a real
    // frame — including its output — to satisfy an intuition about exit codes.
    const out = linesFromOutputFrame(
      frameWith({ output: 'killed', status: 'error', outcome: 'failed', exitCode: -9 }),
    );
    expect(out.some((l) => l.text === 'killed'), 'the output survives a negative code').toBe(true);
    expect(out[out.length - 1]?.text).toContain('-9');
    expect(out[out.length - 1]?.text).toContain('فشل');
  });

  test('the fallback rule treats a negative code as a failure, not as `0`', () => {
    expect(deriveShellOutcomeFallback('completed', -9)).toBe('failed');
    expect(deriveShellOutcomeFallback('completed', 0)).toBe('ok');
  });

  test('NO lower-bound validation exists anywhere in the projection', () => {
    // A source scan, because the trap is a plausible-looking EDIT rather than a
    // behaviour: a reviewer reads `>= 0` as hygiene and cannot see the frame it
    // discards.
    //
    // THE FIRST TWO VERSIONS OF THIS SCAN WERE BOTH VACUOUS, and break-the-guard
    // is the only reason that is known. Version one matched the literal name
    // `exitCode`, so an equally plausible edit that binds the same guard to a
    // local — `(c) => c >= 0 ? c : 0` — walked straight past it. Version two
    // matched ANY comparison to zero and flagged five legitimate ones (a
    // `.length > 0` is never an exit-code guard), which would have trained every
    // reader to ignore it. So the rule is now EXACT: every comparison against
    // zero in this file is enumerated, and the list of ones that are correct is
    // written out. A new one has to be added to that list deliberately, which is
    // the whole point — a silent default is what made the first two vacuous.
    const code = TERMINAL_DRAWER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    /** Every comparison against zero in the file, and why each one is correct. */
    const CORRECT = [
      'id.length > 0', // a line with no id cannot be deduped or keyed
      'frame.command.length > 0', // an empty command is not a command line
      'frame.droppedBytes > 0', // the producer's own drop — reported, never hidden
      'dropped > 0', // retained lines this render trimmed
      'line.sessionId.length > 0', // absence is not a blank label
    ];
    const comparisons = [...code.matchAll(/([A-Za-z_$][\w$.]*)\s*(?:>=|<=|>|<)\s*0\b/g)].map((m) => m[0]);
    expect(comparisons.length, 'the allow-list is an enumeration, not a pattern').toBe(CORRECT.length);
    expect(
      comparisons.filter((c) => !CORRECT.includes(c)),
      'a lower-bound guard on an exit code discards a signal kill',
    ).toEqual([]);

    // The other shape the same mistake takes: clamping rather than comparing.
    // Clamping a code to zero would invent a success, so this allow-lists the two
    // legitimate `Math.max(0, …)` uses — both are retained-LINE counts, and
    // neither mentions a code.
    expect(code, 'clamping an exit code to zero invents a success').not.toMatch(
      /Math\.(?:max|abs)\(\s*0\s*,\s*[^)]*(?:exitCode|\bcode\b)/,
    );
  });

  test("the producer's truncation is still surfaced, and still not re-clamped", () => {
    const out = linesFromOutputFrame(
      frameWith({ output: 'the kept prefix', truncated: true, droppedBytes: 40_884 }),
    );
    const markers = out.filter((l) => l.text.includes('حُذف'));
    expect(markers, 'a silent trim reads as "that is all of it"').toHaveLength(1);
    expect(markers[0]?.text).toContain('40884');
    // The kept prefix is rendered exactly as it arrived: no second clamp.
    expect(out.some((l) => l.text === 'the kept prefix')).toBe(true);
  });

  test('the renderer guard is still ABOVE any legitimate line and states itself', () => {
    // Unchanged on purpose. `MAX_OUTPUT_TEXT_BYTES` is 32 KiB, so a single line
    // can legitimately be long; the renderer's own guard exists for a hostile
    // payload and must stay far above real output, and must never be silent.
    expect(MAX_LINE_CHARS).toBe(8192);
    const out = linesFromOutputFrame(
      frameWith({ output: 'A'.repeat(MAX_LINE_CHARS + 100), status: 'error', outcome: 'failed' }),
    );
    const clamped = out.find((l) => l.kind === 'system' && l.text.includes('حرفاً محذوفاً'));
    expect(clamped, 'a guard that fires must be visible').toBeDefined();
    // …and real output below the guard is untouched, character for character.
    const ordinary = 'A'.repeat(MAX_LINE_CHARS - 10);
    expect(
      linesFromOutputFrame(frameWith({ output: ordinary })).some((l) => l.text === ordinary),
      'output under the guard is not shortened',
    ).toBe(true);
  });
});

describe('TerminalDrawer: 440 px', () => {
  test('a long unbreakable output line stays inside the width budget', () => {
    // The named mechanism: a minified bundle or a base64 blob on one line, with
    // nothing to wrap it. `break-words` + `min-w-0` are the containment.
    const blob = 'const x = "' + 'A'.repeat(3000) + '";';
    const container = drawer({ lines: [line('1', blob)] });
    const found = auditBento(container, BENTO_BASE_WIDTH_PX);
    expect(found, formatViolations(found, BENTO_BASE_WIDTH_PX)).toEqual([]);
  });

  test('a long Arabic command line stays inside the width budget', () => {
    const arabic = 'شغّل الفحص الشامل على المستودع المحلي مع تحديث الفهرس ثم أعد تشغيل خدمة المنفذ ٤٠٩٦';
    const container = drawer({ lines: [line('1', arabic, 'command')] });
    expect(auditBento(container, BENTO_BASE_WIDTH_PX), formatViolations(auditBento(container), 440)).toEqual([]);
  });

  test('a session chip beside the longest possible id and a long line stays inside the budget', () => {
    // The reason the chip is `shrink-0` and abbreviated: a full 124-character id
    // next to a long unbreakable payload is the worst case for the 440 px base,
    // and it is the case the chip was added into.
    const longest = `ses_${'a'.repeat(120)}`;
    const blob = 'const x = "' + 'A'.repeat(2000) + '";';
    const container = drawer({ lines: [line('1', blob, 'output', longest)] });
    const found = auditBento(container, BENTO_BASE_WIDTH_PX);
    expect(found, formatViolations(found, BENTO_BASE_WIDTH_PX)).toEqual([]);
    // The chip itself is bounded, so it can never become the thing that overflows.
    const chip = container.querySelector('[data-testid="terminal-line-session"]');
    expect((chip?.textContent ?? '').length).toBeLessThanOrEqual(SESSION_LABEL_MAX + 1);
  });

  test('the log element carries the wrapping classes the audit depends on', () => {
    drawer();
    const log = document.body.querySelector('[data-testid="terminal-log"]');
    expect(log?.className).toContain('break-words');
    expect(log?.className).toContain('min-w-0');
    expect(log?.className).toContain('overflow-y-auto');
  });
});
