import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';
import type { ServeClient } from '../runtime/client.js';
import { requestPathOf, spaFallbackContentType } from './serve.js';

// DRIVER TOOL READER — tool parts, at the fidelity a transcript needs.
//
// WHY THIS FILE EXISTS. `ServeClient.readTurn` (`runtime/client.ts:1487`) reads
// the SAME `GET /session/{id}/message` route and then throws almost all of it
// away: `parseTurnRow` keeps `partTypes: string[]` (`:303`, built at `:352-362`),
// joined text, and the info fields. It deliberately discards tool name, arguments,
// result and timing — which is correct for its job (it answers "did the turn
// finish, and what did it say") and useless for this one (a transcript that cannot
// say WHICH tool ran, with WHAT arguments, in HOW long is not an acceptance
// harness).
//
// THE ROUTE IS READ THROUGH THE PRODUCT'S OWN REQUEST PATH. `requestPathOf`
// (`cli/serve.ts:162`) reflectively binds `ServeClient`'s private `request`, so the
// Basic auth envelope, the 30 s abort and the `SERVE_UNREACHABLE` mapping are the
// same function object rather than a second HTTP client. No method was added to
// `ServeClient`: `src/runtime/client.ts` is outside this change's write-set, and a
// second client would be the defect this repo keeps finding.
//
// BE DEFENSIVE. The shape is NOT schema-validated here: it is `unknown`, it comes
// from a server this project does not own, and serve answers `200 text/html` with
// a 2 884-byte SPA page for ANY unknown path (`client.ts:471-482`). So every field
// is read through a guard, a non-JSON content type is treated as the fallback and
// not as a route, and a shape this parser cannot read produces `error` with a
// reason rather than an empty list that reads like "no tools ran".

/** One tool invocation, as much of it as the part actually carried. */
export interface ToolInvocation {
  readonly rowId: string;
  readonly callId: string;
  readonly name: string;
  /** `completed` | `error` | `running` | `pending` | `unknown`. */
  readonly status: string;
  /** The tool's declared input, verbatim and unredacted here. */
  readonly args: unknown;
  /** `state.output`, bounded. `null` when the part had none. */
  readonly output: string | null;
  /** `state.error` for a failed tool, `null` otherwise. */
  readonly error: string | null;
  readonly title: string | null;
  /** `state.time.end - state.time.start`, or `null` when serve sent no timing. */
  readonly ms: number | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

export interface ToolReadResult {
  readonly invocations: readonly ToolInvocation[];
  /** Rows the response carried, before any filtering. */
  readonly rows: number;
  /** Rows that matched `afterRowId` (or every row when it was `null`). */
  readonly matched: number;
  /** `true` only when the route answered JSON that parsed. */
  readonly ok: boolean;
  readonly error: string | null;
  /** How long this call spent, INCLUDING its polls. Not a tool's duration. */
  readonly waitedMs: number;
  readonly polls: number;
}

/** Output is bounded here so one `cat /dev/zero` cannot fill the transcript. */
const OUTPUT_BOUND = 4_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundOutput(text: string | null): string | null {
  if (text === null) return null;
  return text.length <= OUTPUT_BOUND ? text : `${text.slice(0, OUTPUT_BOUND)}…[+${text.length - OUTPUT_BOUND} chars]`;
}

const STATUSES: ReadonlySet<string> = new Set(['completed', 'error', 'running', 'pending']);

/**
 * Read one tool part.
 *
 * `output` and `error` are DISTINCT and not collapsed. `normalizeShellResult`
 * (`client.ts:576`) already learned this the hard way: `ToolStateError` puts the
 * failure text on `error`, so reading only `output` renders a failed command as
 * one that produced no output — a second way of saying nothing went wrong.
 */
function parseToolPart(part: unknown, rowId: string): ToolInvocation | null {
  const p = asRecord(part);
  if (p === null) return null;
  if (p['type'] !== 'tool') return null;
  const state = asRecord(p['state']) ?? {};
  const statusRaw = asString(state['status']);
  const status = statusRaw !== null && STATUSES.has(statusRaw) ? statusRaw : 'unknown';
  const time = asRecord(state['time']);
  const startedAt = time === null ? null : asNumber(time['start']);
  const endedAt = time === null ? null : asNumber(time['end']);
  const ms = startedAt !== null && endedAt !== null && endedAt >= startedAt ? endedAt - startedAt : null;
  return {
    rowId,
    callId: asString(p['callID']) ?? '',
    name: asString(p['tool']) ?? '(unnamed)',
    status,
    // `input` when present, `args` as the older spelling. An absent input is
    // `null`, which serialises as `null` — NOT as `{}`, because an empty object
    // would read as "the tool ran with no arguments" and a missing key reads as
    // "this parser did not find the arguments".
    args: state['input'] ?? state['args'] ?? null,
    output: boundOutput(asString(state['output'])),
    error: asString(state['error']),
    title: asString(state['title']),
    ms,
    startedAt,
    endedAt,
  };
}

/**
 * Turn one `{info, parts}` row into its tool invocations, in part order.
 *
 * Exported for the tests, and because a row shape is a thing worth testing
 * without a `Response` in the way.
 */
export function toolInvocationsOfRow(row: unknown): readonly ToolInvocation[] {
  const r = asRecord(row);
  if (r === null) return [];
  const info = asRecord(r['info']);
  const rowId = info === null ? '' : (asString(info['id']) ?? '');
  const parts = Array.isArray(r['parts']) ? r['parts'] : [];
  const out: ToolInvocation[] = [];
  for (const part of parts) {
    const parsed = parseToolPart(part, rowId);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/**
 * Which rows belong to the turn that was just dispatched.
 *
 * The SAME trap `readTurn` documents at length (`client.ts:1469-1485`), and it is
 * why `afterRowId` is a filter rather than a nicety: the message id the driver
 * holds is the USER row's, and the assistant row that carries the tool calls has
 * it as `parentID`. Filtering on `id === afterRowId` returns the question. When
 * `afterRowId` is `null` (no dispatch happened, so nothing to scope to) EVERY row
 * is returned and `matched` says how many — an unscoped read is labelled as
 * unscoped instead of looking like a scoped one that found nothing.
 */
export function rowsAfter(rows: readonly unknown[], afterRowId: string | null): readonly unknown[] {
  if (afterRowId === null) return rows;
  return rows.filter((row) => {
    const info = asRecord(asRecord(row)?.['info']);
    return info !== null && asString(info['parentID']) === afterRowId;
  });
}

/** The raw rows, or a thrown error explaining why there are none. */
async function readRows(client: ServeClient, sessionId: SessionId): Promise<readonly unknown[]> {
  const request = requestPathOf(client);
  const path = `/session/${sessionId}/message`;
  const res = await request(path, { method: 'GET' });
  if (res.status === 404) {
    throw new OrchestratorError('SESSION_NOT_FOUND', false, `session ${sessionId} not found`);
  }
  if (!res.ok) {
    throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.messages failed with HTTP ${res.status}`);
  }
  // THE SPA-FALLBACK RULE, applied here for the same reason `readTurn` applies it
  // (`client.ts:1491`): a 200 on this server is not evidence a route exists, and a
  // transcript that printed "0 tool calls" from the catch-all page would be
  // reporting a web page as a session.
  const fallback = spaFallbackContentType(res);
  if (fallback !== null) {
    throw new OrchestratorError(
      'CONTRACT_DRIFT',
      false,
      `session.messages: expected JSON, got ${fallback} (HTTP ${res.status}) — the request hit the SPA fallback, not a route`,
    );
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    throw new OrchestratorError(
      'CONTRACT_DRIFT',
      false,
      `session.messages: response was not JSON (${err instanceof Error ? err.message : 'unparseable'})`,
    );
  }
  // Measured: this route answers a BARE ARRAY (`client.ts:1457`), while the v2
  // projection answers `{data: []}`. Both are accepted because the file already
  // documents that neither is a superset of the other, and a reader that only
  // handled one would report a working session as empty.
  if (Array.isArray(raw)) return raw as readonly unknown[];
  const data = asRecord(raw)?.['data'];
  if (Array.isArray(data)) return data as readonly unknown[];
  return [];
}

/**
 * Read the tool invocations of a turn, polling a bounded number of times.
 *
 * WHY IT POLLS. `promptSession` returns an ADMISSION, not a completion
 * (`daemon.ts:250-265`): serve has accepted the prompt and OpenCode is
 * generating, so immediately after a dispatch the tool parts do not exist yet. A
 * single read would therefore report "no tools ran" for every turn that ran them,
 * which is the worst possible direction for an acceptance harness — it would pass
 * a broken agent and fail a working one.
 *
 * THE POLL IS BOUNDED AND ITS COST IS REPORTED. `waitedMs` and `polls` are on the
 * result so the caller can print how long it spent waiting, because a number the
 * reader cannot see is a number the reader cannot distrust. `deadlineMs: 0` reads
 * exactly once, which is what the hermetic tests use.
 */
export async function readToolInvocations(
  client: ServeClient,
  sessionId: SessionId,
  options: {
    /** The dispatch receipt, used as the `parentID` filter. `null` = unscoped. */
    readonly afterRowId?: string | null;
    readonly deadlineMs?: number;
    readonly intervalMs?: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<ToolReadResult> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadlineMs = options.deadlineMs ?? 0;
  const intervalMs = Math.max(0, options.intervalMs ?? 400);
  const afterRowId = options.afterRowId ?? null;
  const startedAt = now();

  let polls = 0;
  let last: ToolReadResult | null = null;
  // `do…while (true)` with an explicit break on every exit: a `while` condition
  // here would have to be re-evaluated after the throw, and the two exits (found,
  // deadline) are not the same condition.
  for (;;) {
    polls += 1;
    try {
      const rows = await readRows(client, sessionId);
      const matched = rowsAfter(rows, afterRowId);
      const invocations = matched.flatMap((row) => toolInvocationsOfRow(row));
      last = {
        invocations,
        rows: rows.length,
        matched: matched.length,
        ok: true,
        error: null,
        waitedMs: now() - startedAt,
        polls,
      };
      if (invocations.length > 0) return last;
    } catch (err) {
      last = {
        invocations: [],
        rows: 0,
        matched: 0,
        ok: false,
        error: `${errorCodeOf(err)}: ${messageOf(err)}`,
        waitedMs: now() - startedAt,
        polls,
      };
      // A refusal is not going to become a tool part by waiting. Returning the
      // failure immediately is the difference between "serve says the session is
      // gone" and "serve says the session is gone, 40 times".
      return last;
    }
    if (now() - startedAt >= deadlineMs) return last;
    await sleep(intervalMs);
  }
}

function messageOf(err: unknown): string {
  if (err instanceof OrchestratorError) return err.secretSafeMessage;
  if (err instanceof Error) return err.message;
  return 'non-error throw';
}

function errorCodeOf(err: unknown): string {
  return err instanceof OrchestratorError ? err.code : 'internal';
}