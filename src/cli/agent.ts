import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';
import type { SessionActivity, ServeClient, TurnError, TurnRow } from '../runtime/client.js';
import { DEFAULT_SHELL_AGENT } from '../runtime/client.js';
import { openServeTarget, requirePassword, probeRoute, type PromptEnvelope } from './serve.js';
import * as out from './report.js';

// THE THREE THINGS A TURN NEEDS — switch, wait, speak.
//
// Each of the three verbs below exists because the obvious route for it was
// MEASURED not to work against opencode 1.18.32, and the measurement is recorded
// next to the code that replaced it. All of it was taken on 2026-10-01 against a
// live serve on 4096, reading the spec at `/doc` (162 paths, sha256
// 46db986090aae41846cd6dbe16225a1d883f0bbcb4c48814008d3f6ce140aa5c).
//
// WHAT MAKES THIS FILE DIFFERENT FROM A SCRATCH HARNESS. Every number it prints
// is read back out of a response serve produced, and three of the four claims it
// makes are the kind `res.ok` cannot support:
//
//   1. an agent switch is proven by `info.agent` / `info.mode` on the assistant
//      row — the server's own echo, never the string we asked to switch TO;
//   2. a turn is finished when `info.time.completed` is present, and NOT when the
//      assistant row exists (measured: the row appears ~3 s before the text);
//   3. the spoken text is concatenated from the row's `text` parts, so a status
//      report is the model's output and not an echo of the request.
//
// A 204 is not an outcome, a row is not a completion, and an acceptance is not an
// application. Those three sentences are the whole file.

// ── 1 · THE AGENT SWITCH ─────────────────────────────────────────────────────

/**
 * The evidence an agent switch must produce.
 *
 * `requested` is what the caller asked for and is NEVER sufficient on its own.
 * `confirmed` is set only when serve's own envelope says so, and the only fields
 * that can set it are `agent` and `mode` off an assistant row.
 */
export interface AgentSwitch {
  readonly sessionId: string;
  readonly requested: string;
  /** `info.agent` from the server's assistant row. `null` when no row appeared. */
  readonly observedAgent: string | null;
  /** `info.mode` from the same row. The second, independent server-side echo. */
  readonly observedMode: string | null;
  /** True only when the server's own `info.agent` equals `requested`. */
  readonly confirmed: boolean;
  readonly messageId: string;
  /** True when the turn ran with no model call (the `noReply` form). */
  readonly noReply: boolean;
  /** How long serve took to accept the send. Not the switch — the ACCEPTANCE. */
  readonly acceptMs: number;
}

/**
 * The one comparison that decides a switch, isolated so it can be broken.
 *
 * BREAK-THE-GUARD: replacing this with `return true` (report success without
 * reading `info.agent`) is the defect the whole verb exists to prevent, and
 * `agent-switch.test.ts` breaks it. A switch that only echoes the request would
 * pass a mocked transport and fail against every real server, because serve
 * accepts a 204 for an agent that does not exist.
 */
export function agentSwitchConfirmed(requested: string, observed: TurnRow | null): boolean {
  // `observed === null` is the common case for a bad agent name: measured, an
  // invalid `agent` is accepted with 204 and produces NO assistant row at all. So
  // "no row" can never read as a successful switch.
  if (observed === null) return false;
  if (observed.agent !== requested) return false;
  // `mode` is the second echo and it is what makes this an OBSERVATION rather
  // than a copy: the server classifies the turn from its own agent catalog. It is
  // required to be non-null, not to equal anything — measured `agent=plan`
  // / `mode=plan`, and the catalog at `GET /agent` declares `mode` per agent, so
  // the two are independent fields the server filled in separately.
  return observed.mode !== null;
}

/**
 * Switch a session's agent, and prove it from serve's own response.
 *
 * `text` is what makes the switch OBSERVABLE: with `noReply` the server records
 * the user row and sets the session's agent without calling a model, which is the
 * cheap form and the one a test battery wants. Measured on that path: 204, one
 * `user` row carrying `agent=plan`, and `GET /api/session/{id}` then reporting
 * `agent: "plan"`. The cost is that a `noReply` turn has no ASSISTANT row, so the
 * `info.agent` proof is only available on the paid form — which is why
 * `noReply` reports `confirmed: false` rather than borrowing the user row's
 * value, and why the caller is told which form it got.
 */
export async function switchAgent(
  client: ServeClient,
  sessionId: string,
  agent: string,
  options: { readonly text?: string; readonly noReply?: boolean } = {},
): Promise<AgentSwitch> {
  const at = Date.now();
  const noReply = options.noReply === true;
  const sent = await client.promptTurn(sessionId as SessionId, options.text ?? `switch to ${agent}`, {
    agent,
    ...(noReply ? { noReply: true } : {}),
  });
  // Read the row back. On the `noReply` path there is no assistant row, so this
  // is `null` and `confirmed` is false — stated rather than papered over with the
  // user row's own `agent`, which is a field the request also carried.
  const row = noReply ? null : await client.readTurn(sessionId as SessionId, sent.messageId);
  return {
    sessionId,
    requested: agent,
    observedAgent: row?.agent ?? null,
    observedMode: row?.mode ?? null,
    confirmed: agentSwitchConfirmed(agent, row),
    messageId: sent.messageId,
    noReply,
    acceptMs: Date.now() - at,
  };
}

// ── 2 · POLL A TURN TO COMPLETION ────────────────────────────────────────────

/**
 * The four outcomes a poll can report, and they are not the same thing.
 *
 *   `completed-with-text` — `time.completed` set AND at least one text part.
 *   `completed-empty`     — `time.completed` set AND no text. A real outcome:
 *                           the model finished and said nothing, which is NOT
 *                           the same as still running and NOT an error.
 *   `still-running`       — the row exists (or does not) and `time.completed`
 *                           is absent. The budget ran out.
 *   `errored`             — the row carries a provider error.
 */
export type TurnOutcome = 'completed-with-text' | 'completed-empty' | 'still-running' | 'errored';

export interface PollResult {
  readonly outcome: TurnOutcome;
  /** The row as serve last reported it. `null` when none ever appeared. */
  readonly row: TurnRow | null;
  readonly text: string;
  readonly error: TurnError | null;
  /** Serve's own liveness map, read once the budget is spent. */
  readonly activity: SessionActivity | null;
  readonly polls: number;
  readonly ms: number;
}

/**
 * Classify one observed row. The whole completion rule, in one function.
 *
 * BREAK-THE-GUARD: the defect this exists to prevent is treating ROW-PRESENCE as
 * completion, which is what a naive poller does and what the live server punishes
 * — measured, the row appears at t+1.5 s with `parts: []` and the text only
 * lands at t+4.5 s. A poller that returned `completed-with-text` here would
 * report an empty answer as the model's reply, and `poll-turn.test.ts` breaks it
 * with exactly that row.
 *
 * ERROR IS CHECKED BEFORE COMPLETION, deliberately. Measured, a rate-limited turn
 * carries BOTH `time.completed` AND an `error` object, 75 s into the turn. Reading
 * completion first would report a failed turn as a successful empty one.
 */
export function classifyTurn(row: TurnRow | null): TurnOutcome {
  if (row === null) return 'still-running';
  // A row that is not an ASSISTANT row is never a completion, whatever it
  // carries. Measured live: the user row holds the request text, and a poll that
  // accepted it reported `still-running` for 90 s on a turn that finished in 4 s
  // while echoing the prompt back as the answer. `UserMessage` has no
  // `time.completed` and no `mode`, so it would have failed the checks below
  // anyway — this makes the refusal structural instead of incidental.
  if (row.role !== 'assistant') return 'still-running';
  if (row.error !== null) return 'errored';
  // NOT `row.text.length > 0`, and NOT "a row exists". `time.completed` is the
  // field serve sets when the model has finished; the row itself exists from the
  // first second of the turn.
  if (row.completedAt === null) return 'still-running';
  return row.text.trim().length > 0 ? 'completed-with-text' : 'completed-empty';
}

/**
 * Poll until serve says the turn finished, or the budget runs out.
 *
 * `sleep` and `now` are injected so a test can drive the whole state machine
 * without spending 30 real seconds, and so a fake clock produces the SAME
 * decision a real one would. `onPoll` is what the command uses to report progress;
 * a poller that only returned its final state would make a 30 s wait look like a
 * hang.
 */
export async function pollTurn(
  client: ServeClient,
  sessionId: string,
  messageId: string,
  options: {
    readonly timeoutMs: number;
    readonly intervalMs: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
    readonly onPoll?: (row: TurnRow | null, attempt: number) => void;
  },
): Promise<PollResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const started = now();
  let row: TurnRow | null = null;
  let polls = 0;
  // At least one read happens even with a zero budget: "still running" has to be
  // an OBSERVATION, and a caller that passed `timeoutMs: 0` asked a question this
  // can answer. A loop that returned before reading would answer it with a
  // default.
  for (;;) {
    polls += 1;
    row = await client.readTurn(sessionId as SessionId, messageId);
    options.onPoll?.(row, polls);
    // Classified ONCE and bound. Calling it twice would be a second reading of a
    // pure function for no reason, and a decision that is read twice is a decision
    // someone can later make depend on how many times it was asked.
    const outcome = classifyTurn(row);
    if (outcome !== 'still-running') {
      return {
        outcome,
        row,
        text: row?.text ?? '',
        error: row?.error ?? null,
        activity: null,
        polls,
        ms: now() - started,
      };
    }
    if (now() - started >= options.timeoutMs) break;
    await sleep(options.intervalMs);
  }
  // Budget spent. Serve's liveness map is read ONCE here, and it is what turns a
  // bare "gave up" into an attributable one ("retry, attempt 5") — measured on a
  // rate-limited turn, where the status entry named the exact provider error that
  // the assistant row would not carry for another 10 s.
  return {
    outcome: 'still-running',
    row,
    text: row?.text ?? '',
    error: row?.error ?? null,
    activity: await client.sessionStatus(sessionId as SessionId).catch(() => null),
    polls,
    ms: now() - started,
  };
}

// ── 3 · THE ASSISTANT'S ARABIC TEXT ───────────────────────────────────────────

/**
 * The model's own words, for a spoken status line.
 *
 * WHAT THIS IS NOT. It is not the request text, and it is not a re-render of the
 * prompt. It is the concatenation of the assistant row's `type: "text"` parts,
 * in the order serve returned them, skipping parts that are blank. That is what
 * makes a spoken report real output: a status line that echoed the question would
 * be indistinguishable from one that read the answer, and a battery checking
 * "did the model answer" would pass on an echo.
 *
 * `NO NORMALIZATION OF ARABIC, deliberately.` The text is passed through byte for
 * byte. Diacritics, hamza forms and tatweel are the model's own output and
 * rewriting them would make the report disagree with the transcript the user
 * actually got. The one thing that IS applied is whitespace flattening at the
 * edges, because a speech line with a trailing newline reads as a truncated
 * sentence.
 */
export function assistantText(row: TurnRow | null): string {
  if (row === null) return '';
  // THE GUARD, and the defect it was written for. Found by RUNNING the live
  // proof, not by reading this code: the first `readTurn` matched the row whose
  // `id` was the message id, which is the USER row, and the very first live poll
  // printed the request back as though it were the model's reply. Two things stop
  // it now — `readTurn` only ever returns an assistant row, and this refuses one
  // if it is ever handed a row that is not the model's.
  if (row.role !== 'assistant') return '';
  return row.text.trim();
}

// ── THE COMMANDS ─────────────────────────────────────────────────────────────

/** `agent` — switch a session's agent and prove it from serve's envelope. */
export async function agentCommand(sessionId: string, agent: string, noReply: boolean, envelope: PromptEnvelope): Promise<number> {
  out.heading('agent — the v1 envelope `agent` field, proven from serve\'s own row');
  out.source('src/runtime/client.ts', 'promptTurn() → POST /session/{id}/prompt_async, then readTurn()');
  out.source('src/cli/agent.ts', 'agentSwitchConfirmed() — compares info.agent, never the request');
  const target = await openServeTarget({ promptEnvelope: envelope });
  requirePassword(target);
  out.field('session', sessionId);
  out.field('requested agent', agent);
  out.field('form', noReply ? 'noReply (records the turn, no model call)' : 'full turn (runs the model)');
  if (!target.healthy) {
    out.fail('serve unreachable — no agent was switched');
    return 1;
  }
  // The two routes that LOOK like the switch, reported before the switch so a
  // reader can see what was rejected and why the body field is the mechanism.
  out.heading('routes that are not the switch (measured 2026-10-01)');
  const v2 = await probeRoute(target.client, `/api/session/${sessionId}/agent`);
  out.field('POST /api/session/{id}/agent', `${v2.status} ${v2.kind} (${v2.contentType}) — 500 UnknownError, handler throws`);
  const v1 = await probeRoute(target.client, `/session/${sessionId}/agent`);
  out.field('POST /session/{id}/agent', `${v1.status} ${v1.kind} (${v1.contentType}) — SPA fallback, not a route`);

  let switched: AgentSwitch;
  try {
    switched = await switchAgent(target.client, sessionId, agent, { noReply });
  } catch (err) {
    const code = err instanceof OrchestratorError ? err.code : 'internal';
    out.field('switched', 'no — the request failed before an acceptance');
    out.field('code', code);
    out.field('message', err instanceof Error ? err.message : 'unknown');
    return 1;
  }
  out.heading('what serve said — read back, not echoed');
  out.field('accept', `HTTP 204 with no body in ${switched.acceptMs} ms`);
  out.field('messageID', switched.messageId);
  out.field('info.agent (server)', switched.observedAgent ?? 'no assistant row — nothing was applied');
  out.field('info.mode (server)', switched.observedMode ?? 'no assistant row — nothing was applied');
  if (noReply) {
    out.note('noReply records the user row and sets the session agent WITHOUT an assistant row,');
    out.note('so info.agent cannot be read back here. `agent` without --no-reply is the proven form.');
    const sess = await probeRoute(target.client, `/api/session/${sessionId}`);
    out.field('route check', `${sess.path} → ${sess.kind} exists=${sess.exists}`);
  }
  out.verdict(
    switched.confirmed,
    switched.confirmed
      ? `serve's own info.agent="${switched.observedAgent}" matches the request`
      : 'NOT confirmed — the server did not echo the requested agent on an assistant row',
  );
  if (!switched.confirmed) {
    out.warnLine('a 204 is an ACCEPTANCE, not an application: an invalid agent name is also answered 204 and simply produces no turn');
  }
  return switched.confirmed ? 0 : 1;
}

/** `wait` — poll one turn to completion and report which of the four it was. */
export async function waitCommand(sessionId: string, messageId: string, timeoutMs: number, envelope: PromptEnvelope): Promise<number> {
  out.heading('wait — poll a turn on time.completed, not on row-presence');
  out.source('src/runtime/client.ts', 'readTurn() → GET /session/{id}/message (v1), sessionStatus() → /session/status');
  out.source('src/cli/agent.ts', 'classifyTurn() — the four outcomes');
  const target = await openServeTarget({ promptEnvelope: envelope });
  requirePassword(target);
  out.field('session', sessionId);
  out.field('messageID', messageId);
  out.field('budget', `${timeoutMs} ms`);
  if (!target.healthy) {
    out.fail('serve unreachable — nothing was polled');
    return 1;
  }
  // The v1/v2 message projections disagree (measured 0 rows vs 2 rows on one
  // session), so the route actually used is printed rather than assumed.
  const route = await probeRoute(target.client, `/session/${sessionId}/message`);
  out.field('route check', `${route.path} → ${route.kind} exists=${route.exists}`);
  out.heading('polls — the assistant row appears BEFORE the text, and that is the trap');
  let result: PollResult;
  try {
    result = await pollTurn(target.client, sessionId, messageId, {
      timeoutMs,
      intervalMs: Math.max(250, Math.min(2_000, Math.floor(timeoutMs / 8))),
      onPoll: (row, attempt) => {
        out.note(
          `poll ${String(attempt).padStart(3)}  ${row === null ? 'no assistant row yet' : `parts=[${row.partTypes.join(',')}] textParts=${row.textParts} completed=${row.completedAt === null ? 'ABSENT' : 'set'} error=${row.error === null ? 'none' : row.error.name}`}`,
        );
      },
    });
  } catch (err) {
    const code = err instanceof OrchestratorError ? err.code : 'internal';
    out.field('outcome', 'unreadable');
    out.field('code', code);
    out.field('message', err instanceof Error ? err.message : 'unknown');
    return 1;
  }
  out.heading('outcome');
  out.field('classification', result.outcome);
  out.field('polls', `${result.polls} in ${result.ms} ms`);
  if (result.row !== null) {
    out.field('info.agent', result.row.agent ?? '(absent)');
    out.field('info.mode', result.row.mode ?? '(absent)');
    out.field('info.finish', result.row.finish ?? '(absent — the turn has not finished)');
  }
  if (result.error !== null) {
    out.field('error', `${result.error.name}${result.error.statusCode === null ? '' : ` (HTTP ${result.error.statusCode})`}`);
    out.field('error message', out.clip(result.error.message, 140));
    if (result.error.retryable !== null) out.field('provider says retryable', String(result.error.retryable));
  }
  if (result.activity !== null) {
    out.field('serve status', `${result.activity.kind} — ${out.clip(result.activity.detail, 90)}`);
    if (result.activity.attempt !== undefined) out.field('  attempt', String(result.activity.attempt));
  }
  const spoken = assistantText(result.row);
  out.heading("the assistant's own text — a spoken line, not an echo of the request");
  if (spoken.length === 0) {
    out.note('(none — a turn can complete with no text, and that is a distinct outcome from still-running)');
  } else {
    console.log(`  ${spoken}`);
    out.field('characters', String(spoken.length));
  }
  out.verdict(
    result.outcome !== 'errored' && result.outcome !== 'still-running',
    result.outcome === 'errored'
      ? 'the turn errored — serve reported a provider failure'
      : result.outcome === 'still-running'
        ? `NOT finished within ${timeoutMs} ms`
        : `the turn completed${result.outcome === 'completed-empty' ? ' with no text' : ` with ${spoken.length} characters`}`,
  );
  // `completed-empty` is a success for the POLL and a failure for a spoken report,
  // so it is 0 here and the empty line above says why. Exiting non-zero on it
  // would make "the model finished and chose to say nothing" indistinguishable
  // from "the model is still thinking" in any script that checks the code alone.
  return result.outcome === 'errored' || result.outcome === 'still-running' ? 1 : 0;
}

/** The default agent name, from the product, so this file never hardcodes one. */
export const DEFAULT_AGENT = DEFAULT_SHELL_AGENT;
