// The terminal drawer — collapsible, scrollable, and SILENT.
//
// ── THE PROP CONTRACT, RECONCILED AGAINST THE REAL FRAME ────────────────────
//
// The `output` frame now exists in `src/ipc/protocol.ts` (`OUTPUT_KIND`,
// `OutputFrameSchema`, `buildOutputFrame`), so this is no longer a guess. Its
// shape, and the two consequences for a renderer:
//
//   { type: 'output', seq: number, sessionId: 'ses_…', commandId: string,
//     command: string, status: 'completed'|'error'|'pending'|'running'|'unknown',
//     outcome: 'ok'|'failed'|'unknown', exitCode: number|null,
//     output: string, outputBytes: number, droppedBytes: number,
//     truncated: boolean, durationMs: number|null }
//
// CONSEQUENCE 1 — IT IS NOT A LINE STREAM. One frame carries ONE command result
// and a single `output` BLOB, already byte-capped (`MAX_OUTPUT_TEXT_BYTES` =
// 32 KiB) and TAIL-truncated by the producer's `OutputAssembler`. So "lines" are
// a RENDERER-SIDE PROJECTION: the drawer takes `TerminalLine[]`, and
// `linesFromOutputFrame` below is the projection. It is a pure function with its
// own tests, and it is the ONLY place the wire shape is interpreted — which is
// why a future change to the frame costs one function, not a component.
//
// CONSEQUENCE 2 — THE PRODUCER OWNS TRUNCATION, SO THE RENDERER MUST NOT OWN A
// SECOND ONE. `output` is already capped and `truncated` / `droppedBytes` say
// so. A renderer that silently re-clamped the text would assert a completeness
// the frame never claimed, and would be wrong in both directions: it would
// truncate output the producer deliberately kept, and it would hide the drop the
// producer reported. So the projection SURFACES `truncated` as a visible Arabic
// marker line — the same rule the task strip and the session tabs follow, and
// the same reason `totalSessions` exists: a silent trim reads as "that is all
// of it". `clampLine` survives only as a guard against a malformed frame
// arriving over the bridge boundary, and it is set ABOVE any legitimate single
// line so it fires on a hostile payload rather than on real output — and when
// it does fire it says so, so it is never silent either.
//
// CONSEQUENCE 3 — TWO FIELDS WERE CARRIED AND UNREAD, AND BOTH WERE LOSSES.
// `OutputFrameSchema` declares thirteen fields; this projection read eight, and
// the two it skipped were not decoration:
//
//   · `sessionId` said WHICH SESSION produced the line, and nothing read it. The
//     router really does carry `createSession` / `switchSession`, so a workspace
//     holds several sessions and a merged log with no attribution is not a log a
//     user can act on — "what did that build print" has no answer once two
//     sessions have both run a build. Every line now carries its session, as a
//     per-line chip. `sessionLabel` owns the abbreviation and says why the
//     abbreviation cannot make two sessions look alike.
//
//   · `outcome` is the producer's VERDICT, and the projection used to re-derive
//     it from `status` + `exitCode` instead of reading it. That is a second
//     opinion about one judgement, and two opinions drift: change the rule in
//     `deriveShellOutcome` and the drawer would keep showing the old verdict
//     while the frame carries the new one, with nothing on screen saying they
//     disagree. The frame's value is READ now. The re-derivation survives ONLY
//     as a fallback for a frame that arrives with no `outcome` at all
//     (`deriveShellOutcomeFallback`), and when it is used the log says so in
//     Arabic rather than passing a guess off as the producer's verdict.
//
// ONE RULE GOVERNS BOTH: A MISSING VALUE IS STATED, NEVER GUESSED.
// `outcome` and `sessionId` are REQUIRED by `OutputFrameSchema` and enforced by
// the bridge's `isOutputFrame`, so on the production path neither can be absent
// — which is exactly why the fallback must not be silent. If it ever fires, the
// user is looking at a frame that broke the contract, and the honest response is
// a visible `warn` line, not a plausible-looking verdict in the producer's name.
// Hence the fifth line kind below: a contract violation is not one more grey line
// in a wall of grey.
//
// WHY THE TYPES ARE STRUCTURAL AND NOT IMPORTED. The desktop renderer does not
// import from the root `src/` tree: that is outside the desktop tsconfig's
// `include`, and it would drag zod and the whole frame module into the Vite
// bundle for two string unions. `OutputFrameLike` below is satisfied by the real
// `OutputFrame` by construction, and the assignment is proven by a test.
//
// The ONE import this file now has is `import type { ShellOutputOutcome }` from
// `bridge/ws.js`, and it is a deliberate exception. That union is the renderer's
// copy of the frame's verdict vocabulary, and there was a second copy sitting in
// `bridge/ws.ts` already: a third declaration here would be a third place for the
// verdict to be spelled, which is the same drift this file was changed to remove.
// `import type` is erased at compile time, so it costs nothing at runtime and
// keeps this projection a pure function. The ROOT copy still cannot be imported
// from here, so the cross-check against `OutputFrameSchema` remains a
// transcription in the test file — which is where it was, and where it is
// checked, rather than in a comment.

//
// ── SILENT BY DESIGN, AND WHY THAT IS STRUCTURAL RATHER THAN A PROMISE ──────
//
// The drawer shows; it does not speak. The tempting implementation is a
// "speak the last line" affordance, and it is wrong here for a specific reason:
// this window is voice-first, so anything the drawer says enters the same
// audio pipeline as the assistant and competes with it for the user's ear — and
// streamed command output is machine text, not a confirmation. So:
//
//   · there is NO `onSpeak`, NO `onAnnounce` and NO TTS prop in the props
//     surface, at all;
//   · `TerminalDrawer` references no audio module, no `Audio`, no
//     `speechSynthesis` and no Tauri command.
//
// Those two facts are asserted in `TerminalDrawer.test.tsx`, because a comment
// saying "silent by design" is exactly the kind of claim that quietly stops
// being true. Silence here also means no `aria-live`: an assertive live region
// streaming build output would read every line aloud through a screen reader
// and make the app unusable, so the log is a `log` region the user navigates
// deliberately (`tabIndex={0}` so it is reachable and scrollable by keyboard).
//
// ── UNTRUSTED OUTPUT ─────────────────────────────────────────────────────────
//
// Streamed output is whatever the executed command printed, which means it can
// contain `<script>`, `<img onerror=…>`, RTL-override characters and ANSI
// escape sequences. React escapes text nodes by construction, so this component
// never needs `dangerouslySetInnerHTML` — and it does not have one, which the
// test suite asserts directly rather than trusting review. A test renders a
// line containing an injection payload and asserts the payload appears as
// TEXT and that no element node was created from it.
import { useEffect, useRef, useState } from 'react';
import type { ShellOutputOutcome } from '../../bridge/ws.js';

/**
 * `warn` is NOT command output and NOT a verdict. It is the drawer stating that
 * the FRAME is defective — a missing `outcome`, a missing `sessionId` — and it
 * exists so that statement cannot be mistaken for one more grey line in a log
 * that is mostly grey. Its own colour and glyph are the whole mechanism; the
 * prose in the text is the other half.
 */
export type TerminalLineKind = 'command' | 'output' | 'error' | 'system' | 'warn';

export interface TerminalLine {
  readonly id: string;
  /** UNTRUSTED — rendered as a text node, never as markup. */
  readonly text: string;
  readonly kind: TerminalLineKind;
  /** Optional; display only. Never used to order lines. */
  readonly at?: number;
  readonly stream?: 'stdout' | 'stderr';
  /**
   * The session that produced this line, when the frame carried one. DISPLAY
   * ONLY — the line id is what dedupes, and this is never used to order lines.
   *
   * Absent is not the same as blank, and the component treats them differently: a
   * line with no session renders NO chip at all, because a chip with nothing in
   * it would read as "this line belongs to a session" — which is the exact
   * ambiguity the chip exists to remove. The absence is stated once per frame by
   * `MISSING_SESSION_AR` instead.
   */
  readonly sessionId?: string | undefined;
}

/**
 * The retained cap. Bounded because this window has a 600 px MINIMUM and grows
 * only when the user drags it: a log that grows without limit is bounded by
 * nothing, and a user who opened the drawer once would be able to make the
 * window permanently tall. The dropped count is emitted as a visible marker,
 * because a silent trim reads as "that is all of it".
 */
export const MAX_TERMINAL_LINES = 500;

/** Rendered, untrusted text longer than this is clamped. See the header. */
export const MAX_LINE_CHARS = 8192;

// ── THE MAPPER: wire frame → rendered lines ──────────────────────────────────
//
// This is the whole integration surface. `OutputFrameLike` is structurally
// satisfied by the real `OutputFrame` from `src/ipc/protocol.ts` (asserted by a
// test), so the wiring wave calls `linesFromOutputFrame(frame)` and hands the
// result to `lines`. Nothing else in this file knows the wire exists.

/** The producer's status vocabulary, verbatim from `ShellOutputStatusSchema`. */
export type ShellOutputStatus = 'completed' | 'error' | 'pending' | 'running' | 'unknown';

/**
 * The subset of `OutputFrame` this projection reads. Declared structurally
 * rather than imported: the desktop tsconfig does not include the root `src/`
 * tree, and importing the real module would pull zod into the renderer bundle.
 * A field this projection does not read is simply absent here.
 */
export interface OutputFrameLike {
  readonly commandId: string;
  readonly command: string;
  readonly status: ShellOutputStatus;
  /**
   * The PRODUCER'S VERDICT, read rather than re-derived. See the header.
   *
   * Optional here, and only here, for one reason: a required field cannot be
   * absent in a type, so a required `outcome` would make the missing-verdict path
   * unrepresentable — untestable, and therefore unwarned. `OutputFrameSchema`
   * requires it (`ShellOutputOutcomeSchema`) and `bridge/ws.ts` `isOutputFrame`
   * rejects a frame without it, so every frame on the production path has one.
   */
  readonly outcome?: ShellOutputOutcome | undefined;
  /**
   * Which session produced the frame. Same optionality, same reason, and the
   * same note that it is a required field of the real frame.
   *
   * NOT re-validated against `^ses_[A-Za-z0-9_-]{1,120}$` here, deliberately. A
   * second check that REJECTED a frame would drop real output, and one that only
   * warned would duplicate a check the bridge already runs on every frame before
   * `onOutput` is ever called. The bridge owns that boundary; this file owns what
   * it says on screen.
   */
  readonly sessionId?: string | undefined;
  readonly exitCode: number | null;
  readonly output: string;
  readonly droppedBytes: number;
  readonly truncated: boolean;
  readonly durationMs: number | null;
}

// ── THE MISSING-VALUE PATH: loud, narrow, and transcribed ─────────────────────

/**
 * A frame with no usable exit code, sanitised for display and for the rule below.
 *
 * Mirrors `isIntOrNull` in `bridge/ws.ts`, and it carries NO LOWER BOUND on
 * purpose. `exitCode` is `z.number().int().nullable()` in the protocol: a signal
 * kill is negative (`-9`), a test in `bridge/ws-output.test.ts` asserts `-9` is
 * forwarded, and a `>= 0` filter anywhere in this projection would throw away a
 * real frame to satisfy an intuition about exit codes. So `-9` survives here, is
 * reported below as `failed` (which is what a signal kill is), and is printed as
 * `-9` rather than being dropped.
 */
function reportedExitCode(exitCode: number | null | undefined): number | null {
  return typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode : null;
}

/**
 * The daemon's rule, TRANSCRIBED — and it is a fallback, not a second rendering
 * of the frame's own verdict.
 *
 * `deriveShellOutcome` in `src/ipc/protocol.ts` is the authority and this must
 * not become a third rule. The transcription is pinned by a test over the WHOLE
 * (status × exitCode) matrix instead of by a comment, because a rule described in
 * prose is a rule nobody checks. It is, in the daemon's order:
 *
 *   1. `error` is a failure.
 *   2. A reported exit code decides `ok` vs `failed` — including a NEGATIVE one,
 *      because a signal is not `0`.
 *   3. Anything else is `unknown`, and that is the MEASURED common case: serve
 *      carries no exit code at all, so `completed` proves only that the tool ran.
 */
export function deriveShellOutcomeFallback(
  status: ShellOutputStatus,
  exitCode: number | null | undefined,
): ShellOutputOutcome {
  const code = reportedExitCode(exitCode);
  if (status === 'error') return 'failed';
  if (code !== null) return code === 0 ? 'ok' : 'failed';
  return 'unknown';
}

export interface ResolvedShellOutcome {
  readonly outcome: ShellOutputOutcome;
  /**
   * True when `outcome` was ABSENT and `deriveShellOutcomeFallback` was used.
   * The caller turns this into a visible `warn` line, which is the entire reason
   * it is reported rather than swallowed.
   */
  readonly derived: boolean;
}

/** Read the frame's verdict. Derive one only if the frame carries none. */
export function resolveShellOutcome(frame: OutputFrameLike): ResolvedShellOutcome {
  const carried = frame.outcome;
  if (carried === 'ok' || carried === 'failed' || carried === 'unknown') {
    return { outcome: carried, derived: false };
  }
  return { outcome: deriveShellOutcomeFallback(frame.status, frame.exitCode), derived: true };
}

/** The frame's session, or `null` when it carries none. */
export function sessionOf(frame: OutputFrameLike): string | null {
  const id = frame.sessionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

// ── THE SESSION LABEL: short enough for 440 px, distinct enough to trust ──────

/** Stripped before abbreviating: `ses_` is on every id and discriminates none. */
const SESSION_ID_PREFIX = 'ses_';

/** Characters kept from EACH end of the id body. */
export const SESSION_LABEL_EDGE_CHARS = 3;

/** A body this short is shown whole — abbreviating it would only lose characters. */
export const SESSION_LABEL_MAX = SESSION_LABEL_EDGE_CHARS * 2;

/**
 * NOT part of the id alphabet, and that is the point. `sessionId` matches
 * `[A-Za-z0-9_-]`, so a `·` in the middle can only ever be an abbreviation — the
 * eye can never mistake the chip for a fragment of a real id, which is what makes
 * a truncated label safe to show instead of a truncated *lie*. It is also the
 * drawer's existing `system` glyph, so the log speaks one visual language.
 */
export const SESSION_LABEL_SEPARATOR = '·';

/**
 * The chip text for a session id: `abc123` → `abc·123`.
 *
 * WHY BOTH ENDS AND NOT THE TAIL ALONE. A session id is an opaque token up to 124
 * characters, so any abbreviation is a guess about which part of it varies. Six
 * characters taken from the head alone collide the moment two ids share a suffix;
 * six from the tail alone collide the moment two share a prefix. Three from each
 * end gives the same 38^6 ≈ 3.0 × 10^9 distinct labels over the full id alphabet
 * and only collides when BOTH the first three and the last three characters match
 * — so "two sessions never look alike" is a property of the shape rather than a
 * hope about how the producer mints ids, and the property holds whichever end
 * happens to carry the entropy.
 *
 * WHY NOT THE FULL ID. It is up to 124 characters on a line that already has to
 * hold a command, a body and a verdict inside 440 px; a `shrink-0` chip that wide
 * would eat the output. The unabbreviated id is one hover away, on `title`, and
 * is also on `data-session` so nothing downstream has to guess it back.
 *
 * WHY NO NAME. A display name would be better and is not available here: the
 * daemon carries ids, and the renderer's name resolution lives in `SessionBar`'s
 * data, not in this write-set. Inventing a name from an id would be a fabrication
 * with a UI, which is worse than an honest id.
 */
export function sessionLabel(sessionId: string): string {
  // Total by construction, like `clampLine`: this is the untrusted boundary and
  // a throw here would lose the frame's output, not just its label.
  if (typeof sessionId !== 'string' || sessionId.length === 0) return '';
  const body = sessionId.startsWith(SESSION_ID_PREFIX) ? sessionId.slice(SESSION_ID_PREFIX.length) : sessionId;
  // `ses_` on its own cannot come from a conforming frame (`{1,120}` after the
  // prefix). Show what arrived rather than inventing a body for it.
  if (body.length === 0) return sessionId;
  if (body.length <= SESSION_LABEL_MAX) return body;
  const tail = body.slice(body.length - SESSION_LABEL_EDGE_CHARS);
  return `${body.slice(0, SESSION_LABEL_EDGE_CHARS)}${SESSION_LABEL_SEPARATOR}${tail}`;
}

/** The two contract statements, as text. Deliberately free of any other wording. */
const MISSING_OUTCOME_AR =
  'تحذير: الإطار لا يحمل حقل outcome — النتيجة أدناه مستنتجة من status و exitCode، وليست من المُنتِج';
const MISSING_SESSION_AR = 'تحذير: الإطار لا يحمل sessionId — لا يمكن تحديد الجلسة التي أنتجت هذه الأسطر';

/** `status` → the line kind the whole frame's body takes. */
const STATUS_KIND: Readonly<Record<ShellOutputStatus, TerminalLineKind>> = {
  running: 'command',
  pending: 'command',
  completed: 'output',
  error: 'error',
  unknown: 'output',
};

/**
 * The Arabic summary. TWO SOURCES, KEPT APART ON PURPOSE, because they answer
 * different questions and the previous version answered only the first while
 * claiming to answer both:
 *
 *   · `outcome` says what can be CONCLUDED. It is the frame's own value, read by
 *     `resolveShellOutcome` — not recomputed here.
 *   · `status` says where the command IS. Only the UNSETTLED statuses get a line
 *     of their own, because `الأمر قيد التنفيذ…` is a statement about the moment
 *     rather than a verdict, and folding it into the verdict would lose it.
 *
 * WHY THE `unknown` ARM IS WORDED THE WAY IT IS, since this is the whole point of
 * reading the field. `unknown` is the MEASURED common case — serve reports no
 * exit code, so a `completed` tool call proves only that the tool ran. The old
 * wording for that case was a bare `اكتمل الأمر`, which is an unqualified
 * completion notice: the daemon's own shell bridge refuses to send that alone
 * (`shell-tasks.ts` qualifies its notice with this same outcome, and says why
 * `خلص <command>` on its own "is a success report and in the common case it
 * would be one"). So the unknown arm says the command completed AND that the
 * result is unconfirmed. The exit-code clause is mutually exclusive with the
 * `null` clause by construction, so a frame that contradicts itself produces a
 * line that reports both facts rather than picking a side.
 */
function summaryLinesAr(frame: OutputFrameLike, outcome: ShellOutputOutcome): readonly string[] {
  const ms = frame.durationMs === null ? '' : ` خلال ${frame.durationMs} م.ث`;
  const code = reportedExitCode(frame.exitCode);
  const reported = code === null ? ' (لا يوجد رمز خروج مُبلَّغ)' : ` (رمز الخروج ${code})`;
  // Failure FIRST, exactly as before: a `failed` verdict outranks an unsettled
  // status, because a task that has already failed is not "still running".
  if (outcome === 'failed') return [`فشل الأمر${reported}${ms}`];
  if (frame.status === 'running') return ['الأمر قيد التنفيذ…'];
  if (frame.status === 'pending') return ['بانتظار التنفيذ…'];
  if (frame.status === 'unknown') return ['حالة الأمر غير معروفة'];
  if (outcome === 'ok') return [`اكتمل الأمر بنجاح${reported}${ms}`];
  return [`اكتمل الأمر — النتيجة غير مؤكدة${reported}${ms}`];
}

/**
 * Project one `output` frame into renderable lines.
 *
 * Order is: the COMMAND, then the body split on newlines, then any contract
 * warnings, then the summary, then the truncation marker if the producer dropped
 * bytes. That order is deliberate — the user asked for the command, so it reads
 * first, and the verdict reads last, where a transcript-style log puts it. The
 * warnings sit directly ABOVE the verdict they qualify, so a missing `outcome`
 * cannot be read as a verdict and the verdict is still the last thing on screen.
 *
 * Line ids are `${commandId}:${n}`, so a REPLAYED frame (the `seq > lastSeq`
 * filter exists precisely because frames can be re-delivered) dedupes cleanly
 * against `appendTerminalLines` instead of doubling the log. UNCHANGED by the
 * session work on purpose: `commandId` is a `randomUUID()` from the task queue
 * (`src/tasks/engine.ts`), so it is unique across sessions, and two files outside
 * this write-set — `App.tsx` and `App.bento.test.tsx` — document and assert this
 * exact id scheme. Qualifying it with the session would be defensible; it is not
 * done here because it would leave a false claim in a file this task may not
 * edit.
 */
export function linesFromOutputFrame(frame: OutputFrameLike): TerminalLine[] {
  const out: TerminalLine[] = [];
  const session = sessionOf(frame);
  // The session rides on every line so the renderer can label it. No session →
  // no chip (see `TerminalLine.sessionId`) and one stated violation instead.
  const attrs = session === null ? {} : { sessionId: session };
  const push = (text: string, kind: TerminalLineKind): void => {
    const id = `${frame.commandId}:${out.length}`;
    const clamped = clampLine(text);
    // A guard that fires is stated, never silent — see the header. The
    // producer's own cap is the one that matters, and it is reported below.
    if (clamped !== text) {
      out.push({ ...attrs, id, text: clamped, kind: 'system' });
    } else {
      out.push({ ...attrs, id, text, kind });
    }
  };

  if (frame.command.length > 0) push(frame.command, 'command');

  const bodyKind = STATUS_KIND[frame.status];
  // `split('\n')` and a filter: a trailing newline is normal command output and
  // must not become a phantom empty row.
  for (const raw of frame.output.split('\n')) {
    if (raw.length === 0) continue;
    push(raw, bodyKind);
  }

  // THE LOUD PART. Both of these are unreachable from a conforming producer,
  // which is exactly why they must be visible if they ever happen: a silent
  // fallback would put a guess on screen in the producer's name, and a blank
  // session chip would put an unattributed line in a log whose whole job is
  // attribution.
  if (session === null) push(MISSING_SESSION_AR, 'warn');
  const { outcome, derived } = resolveShellOutcome(frame);
  if (derived) push(MISSING_OUTCOME_AR, 'warn');

  for (const line of summaryLinesAr(frame, outcome)) push(line, 'system');

  if (frame.truncated || frame.droppedBytes > 0) {
    push(`… حُذف ${frame.droppedBytes} بايت من المخرجات (مقتطع من الطرفية)`, 'system');
  }
  return out;
}

export interface TerminalDrawerProps {
  readonly open: boolean;
  readonly onToggle: (next: boolean) => void;
  /** Pre-ordered by arrival. The drawer never re-sorts. */
  readonly lines: readonly TerminalLine[];
  /** Arabic. Defaults to a sensible Arabic label. */
  readonly title?: string;
  /** Lines to retain. `MAX_TERMINAL_LINES` by default. */
  readonly maxLines?: number;
  /**
   * Stick to the newest line as output arrives. Default true, because a log
   * that does not follow is a log the user has to re-scroll after every turn.
   */
  readonly follow?: boolean;
  /**
   * How many lines to show while collapsed — the drawer's fixed-height rail, so
   * a closed drawer costs the same height whatever is in the log.
   */
  readonly collapsedLines?: number;
}

/** Kind → class. `error` is the only arm with a danger colour. */
const LINE_CLASS: Readonly<Record<TerminalLineKind, string>> = {
  // A command is what the USER asked for, so it reads as prompt, not output.
  command: 'text-[#38bdf8]',
  output: 'text-[#a1a1aa]',
  error: 'text-[#f87171]',
  system: 'text-[#71717a]',
  // Amber, not grey: a contract violation has to be findable while scrolling.
  // Deliberately NOT red — red is `error`, and a broken frame is not a failed
  // command, and conflating the two would put a second meaning on one colour.
  warn: 'text-[#fbbf24]',
};

/** The shape channel for output, so a stderr line is not colour-only. */
const LINE_GLYPH: Readonly<Record<TerminalLineKind, string>> = {
  command: '❯',
  output: '',
  error: '✕',
  system: '·',
  warn: '⚠',
};

/**
 * Clamp one line's text. A single 2 MB line is its own overflow defect, and it
 * is reachable: `cat` a minified bundle into a shell hook and the terminal
 * holds the whole thing as one text node.
 */
export function clampLine(text: string, maxChars: number = MAX_LINE_CHARS): string {
  if (typeof text !== 'string') return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… (${text.length - maxChars} حرفاً محذوفاً)`;
}

/**
 * Append a batch, keeping the TAIL and reporting what was dropped.
 *
 * Pure, so the retention policy is unit-testable without a DOM and so a caller
 * can hold the log in whatever store it already uses. Ids already present are
 * dropped rather than duplicated, which is what makes a replayed frame
 * harmless instead of doubling the log.
 */
export function appendTerminalLines(
  current: readonly TerminalLine[],
  incoming: readonly TerminalLine[],
  maxLines: number = MAX_TERMINAL_LINES,
): readonly TerminalLine[] {
  if (!Array.isArray(incoming) || incoming.length === 0) return current;
  const cap = Math.max(1, maxLines);
  const seen = new Set(current.map((l) => l.id));
  const next = current.slice();
  for (const line of incoming) {
    if (line === null || typeof line !== 'object') continue;
    if (typeof line.id !== 'string' || line.id.length === 0) continue;
    if (seen.has(line.id)) continue;
    seen.add(line.id);
    next.push({ ...line, text: clampLine(line.text) });
  }
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function TerminalDrawer({
  open,
  onToggle,
  lines,
  title = 'طرفية المخرجات',
  maxLines = MAX_TERMINAL_LINES,
  follow = true,
  collapsedLines = 1,
}: TerminalDrawerProps): JSX.Element {
  const [logRef, setLogRef] = useState<HTMLDivElement | null>(null);
  const lastCount = useRef(lines.length);

  // FOLLOW, and only follow: an explicit scroll by the user is a claim on the
  // viewport, and yanking it back to the bottom mid-read is the single most
  // irritating thing a streaming log can do.
  useEffect(() => {
    if (!open || !follow) return;
    const grew = lines.length !== lastCount.current;
    lastCount.current = lines.length;
    if (!grew || logRef === null) return;
    logRef.scrollTop = logRef.scrollHeight;
  }, [lines.length, open, follow]);

  const cap = Math.max(1, maxLines);
  const dropped = Math.max(0, lines.length - cap);
  const visible = lines.length > cap ? lines.slice(lines.length - cap) : lines;
  // The collapsed rail shows a fixed number of lines so the drawer's height does
  // not depend on how much has been logged.
  const shown = open ? visible : visible.slice(Math.max(0, visible.length - collapsedLines));

  return (
    <section
      data-testid="terminal-drawer"
      data-open={String(open)}
      dir="rtl"
      aria-label={title}
      className="flex min-w-0 flex-col rounded-[6px] border border-[#26282e] bg-[#0e0f12]"
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-[#26282e] px-2 py-1">
        <button
          type="button"
          data-testid="terminal-toggle"
          aria-expanded={open}
          aria-controls="terminal-log"
          title={open ? 'طيّ الطرفية' : 'فتح الطرفية'}
          onClick={() => onToggle(!open)}
          className="flex min-w-0 items-center gap-2 text-start text-[11px] text-[#a1a1aa] hover:text-[#f4f4f5]"
        >
          {/* Shape, not just a chevron colour. */}
          <span aria-hidden className="shrink-0 text-[#71717a]">
            {open ? '▼' : '▶'}
          </span>
          <span className="min-w-0 truncate">{title}</span>
        </button>
        <span
          data-testid="terminal-line-count"
          title="عدد أسطر المخرجات المحتفظ بها"
          className="vx-mono-metric ms-auto shrink-0 text-[10px] text-[#71717a]"
        >
          {visible.length}
        </span>
      </header>

      {/* `log` + `tabIndex` is the accessible form of a terminal: reachable and
          scrollable by keyboard, and NOT a live region, because streaming
          output read aloud is unusable. See the silence note above. */}
      <div
        id="terminal-log"
        ref={setLogRef}
        data-testid="terminal-log"
        role="log"
        tabIndex={0}
        className={`vx-mono-metric min-w-0 overflow-y-auto break-words p-2 text-[11px] leading-[1.5] ${
          open ? 'max-h-[220px]' : 'max-h-[24px]'
        }`}
      >
        {dropped > 0 && (
          <div
            data-testid="terminal-dropped"
            className="mb-1 truncate text-[10px] text-[#71717a]"
          >
            … {dropped} سطراً سابقاً محذوفاً
          </div>
        )}
        {shown.map((line) => {
          // `sessionId` absent and `sessionId` blank are the same thing here, and
          // NEITHER renders a chip: an empty chip would look like a session, which
          // is the ambiguity the chip was added to remove. `linesFromOutputFrame`
          // states the absence once per frame instead.
          const session =
            typeof line.sessionId === 'string' && line.sessionId.length > 0 ? line.sessionId : null;
          const label = session === null ? null : sessionLabel(session);
          return (
            <div
              key={line.id}
              data-testid="terminal-line"
              data-kind={line.kind}
              data-session={session ?? undefined}
              className={`flex min-w-0 items-start gap-1 ${LINE_CLASS[line.kind]}`}
            >
              {/*
                THE SESSION COLUMN, per line rather than per block. A block header
                would only label the session that happened to be running when the
                drawer opened, and a divider would force the reader to remember
                which block they are in — and would fall apart the moment one line
                is copied out of the log on its own. On every line, attribution
                survives selection.

                `dir="ltr"` is not decoration: the row is RTL and the chip holds a
                machine token, so without an explicit direction the `·` separator
                and any leading digit reorder themselves. `title` carries the full
                id, and `data-session` carries it for anything downstream.
              */}
              {label !== null && (
                <span
                  data-testid="terminal-line-session"
                  dir="ltr"
                  title={`الجلسة: ${session}`}
                  className="vx-mono-metric shrink-0 select-none text-[9px] leading-[1.5] text-[#52525b]"
                >
                  {label}
                </span>
              )}
              {LINE_GLYPH[line.kind] !== '' && (
                <span aria-hidden className="shrink-0 select-none">
                  {LINE_GLYPH[line.kind]}
                </span>
              )}
              {/*
                `unicode-bidi: plaintext` is the whole RTL answer, and it is a
                deliberate choice over forcing one direction on the log. A terminal
                holds BOTH: an Arabic command line that must read right-to-left, and
                a `npm run build` or a file path that must read left-to-right. Forcing
                `rtl` on the container reorders the Latin runs and puts the trailing
                punctuation on the wrong side; forcing `ltr` breaks the Arabic.
                `plaintext` lays out each line from its OWN first strong character,
                which is the correct per-line answer, and `text-align: start` then
                aligns it to whichever direction that line turned out to be.
              */}
              <span
                dir="auto"
                className="min-w-0 flex-1 break-words whitespace-pre-wrap"
                style={{ unicodeBidi: 'plaintext', textAlign: 'start' }}
              >
                {line.text}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
