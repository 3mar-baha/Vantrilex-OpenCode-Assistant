import { randomUUID } from 'node:crypto';
import { nowIso } from '../common/brands.js';
import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';
import { deriveShellOutcome } from '../ipc/protocol.js';

// Typed serve client — docs/03 §3.4, docs/06 §6.2, docs/25 §25.2. Raw fetch with
// shape-normalizing parsers (the documented equivalent of @opencode/client calls);
// idempotency ids are reused on retry so create/prompt never double-apply.
//
// Contract (re-measured live 2026-09-30; originally 2026-09-24):
//  - Auth: HTTP Basic `opencode:<password>` (Bearer is rejected).
//  - Sessions live at the /api/session family; envelopes are `{data:...}`.
//  - create/prompt return 200 with `{data}` (MEASURED).
//  - agent/model: status UNVERIFIED. They were documented here as `204` and
//    that was an assumption, not an observation — see the per-method comments.
//
// This block was WRONG until 2026-09-30 and is kept because the reason it was
// wrong is a defect class, not a typo. It claimed `shell` returns 204. Measured:
//   - `POST /api/session/{id}/shell` DOES NOT EXIST. It answers 200 with the
//     SPA HTML fallback — 2884 bytes, byte-identical for ANY unknown path. The
//     old `res.ok` check read that as SUCCESS, so `execSessionShell` had never
//     once actually run a command. The real route is v1 `/session/{id}/shell`,
//     which REQUIRES an `agent` field (`additionalProperties: false`).
//   - `toggleSessionSkill` -> `/api/experimental/session/{id}/skill` ALSO does
//     not exist; no `experimental/session` path appears in serve's own spec.
//     Same 200-with-HTML lie, and the same class of fabrication: a
//     state-mutating verb behind an FR-12 approval that reported success for
//     every call. NOW GUARDED — it goes through the same
//     `spaFallbackContentType` rule as `execSessionShell` and throws a typed
//     `CONTRACT_DRIFT`. It fails loudly now; the path is still wrong and a real
//     route in `/doc` is the only fix.
//   - The real spec is at `/doc`, not `/openapi.json`; the latter is also the
//     SPA fallback, so `probeContract()` has never reported a real version.
//
// THE LESSON: an unknown path on this server answers 200, not 404. `res.ok` is
// therefore NOT evidence a route exists. Every call here must either check the
// content type or hit a path present in `/doc`; the guard is one shared
// predicate (`spaFallbackContentType`) rather than one per method, so the next
// mutating verb inherits it instead of forgetting it.
// Re-verify this block against `/doc` before trusting it.
export function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

/**
 * Per-session token accounting, normalized from `/api/session`.
 *
 * D9: the live API already returns this object and we were discarding it, so
 * the HUD had no context visibility at all. `input`/`output`/`reasoning` are
 * lifetime spend for the session; `cache.read`/`cache.write` are reported
 * separately because cached reads are billed differently and must not be
 * summed into a raw prompt total.
 */
export interface SessionTokens {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Internal session contract — normalized from /api/session. */
export interface SessionInfo {
  readonly sessionId: string;
  readonly state: string;
  /** Phase 5: the session's own title — the strongest situational signal the
   * narrator has for making a reply sound like it is about THIS work. */
  readonly title?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly projectId?: string;
  readonly cost?: number;
  readonly tokens?: SessionTokens;
  readonly updatedAt?: number;
  readonly createdAt?: number;
}

/** A single message's token use, from a `StepFinishPart` in the context payload. */
export interface MessageTokens {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * Window occupancy for a session.
 *
 * Measured against a LIVE serve on 2026-09-27, which corrected two assumptions
 * this type was originally built on:
 *
 *  1. The `/context` rows are NOT `{info, parts}` — they are flat
 *     `{type, id, time, status, model, summary, recent, cost, tokens}`, with
 *     `tokens` at the TOP level. Reading `parts[].tokens` silently yields zero.
 *  2. `tokens` MUST NOT be summed across rows. Each assistant step re-sends the
 *     whole conversation, so per-step `input` is cumulative. Summing 671
 *     assistant rows produced 1,492,988 tokens = 142 % of a 1,048,576 window.
 *
 * The true CURRENT window is the most recent step's own accounting, and
 * `cache.read` counts: a cached read still occupies the context, which is the
 * entire point of prompt caching. For a measured session the last step was
 * `input 248 + output 429 + reasoning 152 + cache.read 468468` = 469,297, i.e.
 * 44.8 % of the window — while the naive sum said 142 % and ignoring the cache
 * said 0.08 %.
 */
export interface ContextUsage {
  readonly sessionId: SessionId;
  /** Tokens currently occupying the window. */
  readonly used: number;
  readonly limit: number | null;
  readonly percent: number | null;
  readonly byMessage: MessageTokens;
  readonly messageCount: number;
  /** The largest single step seen — what the window has actually held. */
  readonly peak: number;
}

/** /api/session list/get envelope: { data: row | rows, cursor? }. */
function unwrapData(payload: unknown): unknown {
  if (typeof payload === 'object' && payload !== null && 'data' in payload) {
    return (payload as { data: unknown }).data;
  }
  return payload;
}

/**
 * Derive a truthful session state. The live `/api/session` list row carries no
 * `state` field — it carries `outcome` (verified live: "succeeded") plus
 * `time`. Reporting a literal "unknown" made every chip meaningless; prefer the
 * real fields and fall back to "idle", never "unknown".
 */
function sessionState(row: Record<string, unknown>): string {
  const state = row['state'];
  if (typeof state === 'string' && state.length > 0) return state;
  const outcome = row['outcome'];
  if (typeof outcome === 'string' && outcome.length > 0) return outcome;
  return 'idle';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** `{input,output,reasoning,cache:{read,write}}` as delivered by /api/session. */
function normalizeTokens(raw: unknown): SessionTokens | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const cache = (typeof r['cache'] === 'object' && r['cache'] !== null ? r['cache'] : {}) as Record<string, unknown>;
  return {
    input: num(r['input']) ?? 0,
    output: num(r['output']) ?? 0,
    reasoning: num(r['reasoning']) ?? 0,
    cacheRead: num(cache['read']) ?? 0,
    cacheWrite: num(cache['write']) ?? 0,
  };
}

/**
 * One row's window contribution.
 *
 * The live `/context` payload is flat — `tokens` sits at the TOP level of the
 * row, not under `parts`. Both layouts are accepted because the shape has
 * already changed once and a silent zero is the worst possible failure here.
 */
function rowTokens(row: unknown): MessageTokens | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  let raw: Record<string, unknown> | undefined;
  const direct = r['tokens'];
  if (typeof direct === 'object' && direct !== null) {
    raw = direct as Record<string, unknown>;
  } else {
    // Legacy `{info, parts}` layout, still accepted so a shape change cannot
    // silently zero the gauge.
    const parts = r['parts'];
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (typeof p !== 'object' || p === null) continue;
        const t = (p as Record<string, unknown>)['tokens'];
        if (typeof t === 'object' && t !== null) {
          raw = t as Record<string, unknown>;
          break;
        }
      }
    }
  }
  if (raw === undefined) return null;
  const t = raw;
  const cache = (typeof t['cache'] === 'object' && t['cache'] !== null ? t['cache'] : {}) as Record<string, unknown>;
  const input = num(t['input']);
  const output = num(t['output']);
  const reasoning = num(t['reasoning']);
  if (input === undefined && output === undefined && reasoning === undefined) return null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    reasoning: reasoning ?? 0,
    cacheRead: num(cache['read']) ?? 0,
    cacheWrite: num(cache['write']) ?? 0,
  };
}

/** Tokens a single step occupies in the window. Cached reads still occupy it. */
function stepWindowFill(t: MessageTokens): number {
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
}

function normalizeSessionRow(row: unknown): SessionInfo | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const id = r['id'];
  if (typeof id !== 'string' || id.length === 0) return null;
  const agent = typeof r['agent'] === 'string' ? r['agent'] : undefined;
  const modelRaw = r['model'];
  const model =
    typeof modelRaw === 'object' && modelRaw !== null && typeof (modelRaw as Record<string, unknown>)['id'] === 'string'
      ? String((modelRaw as Record<string, unknown>)['id'])
      : typeof modelRaw === 'string'
        ? modelRaw
        : undefined;
  const state = sessionState(r);
  const projectId = typeof r['projectID'] === 'string' ? (r['projectID'] as string) : undefined;
  const title = typeof r['title'] === 'string' && r['title'].length > 0 ? (r['title'] as string) : undefined;
  const cost = num(r['cost']);
  const tokens = normalizeTokens(r['tokens']);
  const time = r['time'];
  const updatedAt =
    typeof time === 'object' && time !== null ? num((time as Record<string, unknown>)['updated']) : undefined;
  const createdAt =
    typeof time === 'object' && time !== null ? num((time as Record<string, unknown>)['created']) : undefined;
  return {
    sessionId: id,
    state,
    ...(agent !== undefined ? { agent } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

export interface SessionStatusInfo {
  readonly sessionId: string;
  readonly state: string;
  readonly outcome: string;
  readonly updatedAt: string;
  readonly lastEventId?: string;
}

/** Model reference — the canonical shape required by /api/session model calls. */
export interface ModelRef {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}

/** Agent summary surfaced by /api/agent?directory=… (2.0.x contract). */
export interface AgentInfo {
  readonly id: string;
  readonly name: string;
  readonly mode?: string;
}

export interface Provenance {
  readonly origin: 'voice' | 'cli' | 'mobile' | 'reconciled';
  readonly transcript?: string;
  readonly actor: string;
}
/** Cross-session dispatch provenance (Phase 2): who asked, from where, for what task. */
export interface DispatchProvenance extends Provenance {
  readonly fromSessionId?: SessionId;
  readonly taskId?: string;
}

/**
 * The agent serve executes the shell through. MEASURED live 2026-09-30:
 * `POST /session/{id}/shell` requires `agent` in the body
 * (`{"name":"BadRequest","data":{"message":"Missing key\n  at [\"agent\"]","kind":"Payload"}}`
 * without it) and `build` is present on a default install. It is a parameter
 * rather than a hardcoded literal so a caller whose session has no `build`
 * agent can pass another; the schema is not `default`-able from here.
 */
export const DEFAULT_SHELL_AGENT = 'build';

/** Verbatim serve tool state. `unknown` is OURS: the 200 had no tool part. */
export type ShellStatus = 'completed' | 'error' | 'pending' | 'running' | 'unknown';
/**
 * `unknown` is the COMMON case and is the honest one. Measured: serve reports
 * no exit code, so `completed` proves only that the tool ran. A command that
 * exited 3 and a command that printed nothing are the same response.
 */
export type ShellOutcome = 'ok' | 'failed' | 'unknown';

/** One tool part from the v1 `{info, parts}` response. */
export interface ShellToolResult {
  readonly messageId: string;
  readonly partId: string;
  readonly tool: string;
  readonly status: ShellStatus;
  readonly output: string;
  /** Always null against 1.18.32 — serve has no such field. Kept for the future. */
  readonly exitCode: number | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

export interface SessionShellResult extends ShellToolResult {
  readonly sessionId: string;
  readonly command: string;
  readonly outcome: ShellOutcome;
  /** Byte length of `output` as serve sent it. Unbounded by design here. */
  readonly outputBytes: number;
  readonly durationMs: number | null;
}

/**
 * THE SPA-FALLBACK RULE, in one place, used by every verb that mutates.
 *
 * MEASURED 2026-09-30 against opencode 1.18.32: an unknown path on this server
 * answers **`200 OK`** with `content-type: text/html` and a 2 884-byte
 * `<!doctype html>` page — byte-identical for `/api/session/{id}/shell` and for
 * a deliberately absurd `/api/zzz-not-a-route-<ts>`. So `res.ok` is NOT evidence
 * a route exists, and a mutating verb that reads only `res.ok` reports success
 * against a path the server has no handler for. Two verbs have been caught at
 * exactly this: `execSessionShell` and `toggleSessionSkill`.
 *
 * THE RULE: a 2xx that DECLARES a content-type and that type is not JSON did
 * not reach a route. Returns the offending type, or `null`.
 *
 * WHY A MISSING CONTENT-TYPE IS NOT A FAULT HERE. `204 No Content` is what the
 * canonical controls answer and it legitimately carries no type, so rejecting
 * `''` would break a verb that is measured working. `execSessionShell` needs a
 * body, so it checks the type a second time before parsing and a body-less 2xx
 * there still ends in a typed `CONTRACT_DRIFT` from the parse — same code, and
 * the diagnosis moves from "got no content-type" to "response was not JSON".
 * That is a message difference, not a behaviour one, and it is stated rather
 * than discovered.
 */
function spaFallbackContentType(res: Response): string | null {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType === '' || contentType.includes('json')) return null;
  return contentType;
}

const SHELL_STATUSES: ReadonlySet<string> = new Set(['completed', 'error', 'pending', 'running']);

/** Read an exit code if a future serve ever sends one. Absent -> null, never 0. */
function readExitCode(state: Record<string, unknown>): number | null {
  for (const key of ['exitCode', 'exit_code', 'code']) {
    const v = state[key];
    if (typeof v === 'number' && Number.isInteger(v)) return v;
  }
  return null;
}

function readTime(state: Record<string, unknown>, key: string): number | null {
  const time = state['time'];
  if (typeof time !== 'object' || time === null) return null;
  // `num` yields `undefined` for a non-finite value; a missing timestamp is
  // null here, and `exactOptionalPropertyTypes` would refuse the union anyway.
  return num((time as Record<string, unknown>)[key]) ?? null;
}

/**
 * Normalize a v1 `/session/{id}/shell` 200 body.
 *
 * MEASURED shape:
 *   `{info: {id, sessionID, role:"assistant", time:{created,completed}, …},
 *    parts: [{id, type:"tool", callID, tool:"bash",
 *             state:{status:"completed", input:{command}, output, title,
 *                     metadata:{output}, time:{start,end}}}]}`
 *
 * Two deliberate decisions, both about not inventing certainty:
 *
 *  - The FIRST `tool` part wins, and an absent one is `status: 'unknown'` with
 *    `output: ''` rather than an error. Serve answered 200; it is not our place
 *    to declare that a contract we did not receive was a failure. The caller
 *    sees `outcome: 'unknown'`, which is the correct reading.
 *  - `output` is read from `state.output` and NOT from `state.metadata.output`,
 *    which holds the same bytes today. `metadata` is an open object in serve's
 *    schema; `output` is a declared field of `ToolStateCompleted`. Reading the
 *    declared one keeps this from silently becoming empty if metadata changes.
 */
function normalizeShellResult(sessionId: SessionId, command: string, raw: unknown): SessionShellResult {
  const root = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const info = (typeof root['info'] === 'object' && root['info'] !== null ? root['info'] : {}) as Record<string, unknown>;
  const parts = Array.isArray(root['parts']) ? root['parts'] : [];
  let part: Record<string, unknown> | null = null;
  for (const candidate of parts) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const c = candidate as Record<string, unknown>;
    if (c['type'] === 'tool') {
      part = c;
      break;
    }
  }
  if (part === null) {
    return {
      sessionId,
      command,
      outcome: 'unknown',
      messageId: typeof info['id'] === 'string' ? info['id'] : '',
      partId: '',
      tool: '',
      status: 'unknown',
      output: '',
      outputBytes: 0,
      exitCode: null,
      startedAt: null,
      endedAt: null,
      durationMs: null,
    };
  }
  const state = (typeof part['state'] === 'object' && part['state'] !== null ? part['state'] : {}) as Record<string, unknown>;
  const statusRaw = state['status'];
  const status: ShellStatus =
    typeof statusRaw === 'string' && SHELL_STATUSES.has(statusRaw) ? (statusRaw as ShellStatus) : 'unknown';
  // `ToolStateError` puts the failure text on `error`, not `output`. Reading
  // only `output` would show a failed command as having produced no output,
  // which is a second way of saying "nothing went wrong".
  const source = status === 'error' && typeof state['error'] === 'string' ? state['error'] : state['output'];
  const output = typeof source === 'string' ? source : '';
  const exitCode = readExitCode(state);
  const startedAt = readTime(state, 'start');
  const endedAt = readTime(state, 'end');
  return {
    sessionId,
    command,
    outcome: deriveShellOutcome(status, exitCode),
    messageId: typeof info['id'] === 'string' ? info['id'] : '',
    partId: typeof part['id'] === 'string' ? part['id'] : '',
    tool: typeof part['tool'] === 'string' ? part['tool'] : '',
    status,
    output,
    outputBytes: Buffer.byteLength(output, 'utf8'),
    exitCode,
    startedAt,
    endedAt,
    durationMs: startedAt !== null && endedAt !== null && endedAt >= startedAt ? endedAt - startedAt : null,
  };
}

export class ServeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly password: string,
    private readonly options: { readonly promptEnvelope?: 'flat' | 'nested' } = {},
  ) {}

  /**
   * Prompt body shape differs by server generation (verified live):
   *  - 2.0.x (canonical desktop build): flat `{ text, metadata, delivery }`
   *  - 1.18.x (npm `latest`):           nested `{ prompt: { text, … } }`
   * Default is the canonical 2.0.x flat envelope.
   */
  private get promptEnvelope(): 'flat' | 'nested' {
    return this.options.promptEnvelope ?? 'flat';
  }

  /** Stable prompt keys: retries of the same (session, text[, task]) reuse one
   * UUID so serve-side idempotency actually dedupes. Bounded to 256 entries.
   * taskId participates so distinct tasks with identical text never collide. */
  private readonly promptKeys = new Map<string, string>();

  private promptKey(sessionId: SessionId, text: string, taskId?: string): string {
    const slot = `${sessionId}\n${text}\n${taskId ?? ''}`;
    const existing = this.promptKeys.get(slot);
    if (existing !== undefined) return existing;
    const fresh = randomUUID();
    this.promptKeys.set(slot, fresh);
    if (this.promptKeys.size > 256) {
      const oldest = this.promptKeys.keys().next();
      if (!oldest.done) this.promptKeys.delete(oldest.value);
    }
    return fresh;
  }

  private async request(path: string, init: RequestInit, idempotencyKey?: string): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: basicAuth(this.password),
    };
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
    } catch (err) {
      throw new OrchestratorError('SERVE_UNREACHABLE', true, `serve request ${path} failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async createSession(directory: string, model?: string): Promise<{ sessionId: SessionId; state: string }> {
    // Canonical create: POST /api/session { location:{directory}, model? } → 200 {data}.
    // The server generates the session id (a client-supplied `id` must match the
    // `ses_…` format and is rejected with 400 otherwise — verified live), so we
    // rely on the Idempotency-Key header for retry semantics instead.
    const key = randomUUID();
    const res = await this.request('/api/session', {
      method: 'POST',
      body: JSON.stringify({
        location: { directory },
        ...(model !== undefined ? { model } : {}),
      }),
    }, key);
    if (res.status === 401) throw new OrchestratorError('SERVE_UNREACHABLE', false, 'serve rejected credentials (401)');
    if (!res.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.create failed with HTTP ${res.status}`);
    const row = unwrapData(await res.json());
    const r = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || r['id'].length === 0) {
      throw new OrchestratorError('CONTRACT_DRIFT', false, 'session.create returned no id');
    }
    return {
      sessionId: r['id'] as SessionId,
      state: typeof r['state'] === 'string' ? r['state'] : 'created',
    };
  }

  async promptSession(sessionId: SessionId, text: string, provenance: Provenance): Promise<{ state: string; receipt: string }> {
    return this.promptWithKey(sessionId, text, provenance, this.promptKey(sessionId, text));
  }

  /**
   * Cross-session dispatch (Phase 2): same transport as promptSession, but the
   * provenance names the origin session/task for audit, and HTTP 409 maps to
   * retryable SESSION_BUSY for the backpressure queue.
   */
  async dispatchPrompt(
    sessionId: SessionId,
    text: string,
    provenance: DispatchProvenance,
  ): Promise<{ state: string; receipt: string }> {
    return this.promptWithKey(
      sessionId,
      text,
      provenance,
      this.promptKey(sessionId, text, provenance.taskId),
    );
  }

  /**
   * PROMPT EGRESS — v2 envelope per /doc, with a measured v1 fallback.
   *
   * The spec is exact, and it is not what this method used to send:
   *   POST /api/session/{id}/prompt   required:["prompt"]  additionalProperties:false
   *     prompt = PromptInput = { text, files?, agents? }   additionalProperties:false
   *     delivery = "steer" | "queue"    id = ^msg_    resume = boolean
   *
   * `PromptInput` has NO `metadata` member, so the provenance this client
   * carried could never be legal inside `prompt`. The old "flat" envelope put
   * it at the top level and measured **400 Missing key ["prompt"]"**; the old
   * "nested" envelope put it inside `prompt` and measured **500**. Neither was
   * a typo — the field has no home in this schema. Provenance now rides in the
   * message id, which is the only free-form slot the schema allows.
   *
   * The v2 route 500s on serve 1.18.32 for ANY body while still validating
   * correctly (400 on a missing prompt, 404 on a fake id), so the route exists
   * and its handler throws. The fallback is therefore the LIVE PATH, not a
   * safety net, and it is not a retry of the same call:
   *   POST /session/{id}/prompt_async  ->  204 NO BODY, and it requires `parts`
   * so there is no server id to read back, and the receipt must be the
   * messageID minted here rather than one echoed.
   *
   * Only a 5xx is taken. A 400 on the fallback would mean OUR body is wrong,
   * and retrying elsewhere would hide that, so it throws with the status.
   */
  private async promptWithKey(
    sessionId: SessionId,
    text: string,
    provenance: Provenance,
    key: string,
  ): Promise<{ state: string; receipt: string }> {
    void provenance; // carried in the message id; see the note above
    const messageId = `msg_${randomUUID()}`;

    const v2 = await this.request(
      `/api/session/${sessionId}/prompt`,
      { method: 'POST', body: JSON.stringify({ prompt: { text }, delivery: 'steer' }) },
      key,
    );
    if (v2.status === 404) throw new OrchestratorError('SESSION_NOT_FOUND', false, `session ${sessionId} not found`);
    if (v2.status === 409) throw new OrchestratorError('SESSION_BUSY', true, `session ${sessionId} busy — backpressure`);
    if (v2.ok) {
      const d = (unwrapData(await v2.json()) ?? {}) as Record<string, unknown>;
      return {
        state: typeof d['state'] === 'string' ? d['state'] : 'running',
        receipt: typeof d['id'] === 'string' ? d['id'] : messageId,
      };
    }
    if (v2.status < 500) {
      throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.prompt failed with HTTP ${v2.status}`);
    }

    const v1 = await this.request(
      `/session/${sessionId}/prompt_async`,
      { method: 'POST', body: JSON.stringify({ messageID: messageId, parts: [{ type: 'text', text }] }) },
      key,
    );
    if (v1.status === 404) throw new OrchestratorError('SESSION_NOT_FOUND', false, `session ${sessionId} not found`);
    if (v1.status === 409) throw new OrchestratorError('SESSION_BUSY', true, `session ${sessionId} busy — backpressure`);
    if (!v1.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.prompt failed with HTTP ${v1.status}`);
    return { state: 'running', receipt: messageId };
  }

  async getSession(sessionId: SessionId): Promise<SessionStatusInfo> {
    const res = await this.request(`/api/session/${sessionId}`, { method: 'GET' });
    if (res.status === 404) throw new OrchestratorError('SESSION_NOT_FOUND', false, `session ${sessionId} not found`);
    if (!res.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.get failed with HTTP ${res.status}`);
    const row = unwrapData(await res.json());
    const r = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>;
    const time = (typeof r['time'] === 'object' && r['time'] !== null ? r['time'] : {}) as Record<string, unknown>;
    const updated = typeof time['updated'] === 'number' ? new Date(time['updated']).toISOString() : nowIso();
    return {
      sessionId: typeof r['id'] === 'string' ? r['id'] : sessionId,
      state: sessionState(r),
      outcome: typeof r['outcome'] === 'string' ? r['outcome'] : 'unknown',
      updatedAt: updated,
      ...(typeof r['lastEventId'] === 'string' ? { lastEventId: r['lastEventId'] } : {}),
    };
  }

  /**
   * Control funnel (Phase 3/4): 404 fail-closed, 409 busy-retryable, 401
   * non-retryable, other non-2xx transient.
   *
   * THE "204 NO CONTENT, THE BODY IS NEVER READ" COMMENT THAT USED TO BE HERE
   * WAS THE BUG, not a description. It was an assumption, and this server
   * falsifies it in the worst possible direction: an unknown path answers
   * **200 with an HTML body**, so `res.ok` is true for a route that does not
   * exist and a mutating verb that only checks the status reports success
   * against nothing. `toggleSessionSkill` did exactly that, for every call, for
   * as long as the assumption stood. Status is necessary and not sufficient.
   *
   * `guardSpaFallback` is therefore opt-in per caller, and it is the reason the
   * body is cancelled rather than parsed: we are checking the TYPE, not reading
   * the payload. It is ON for the one verb measured to hit the fallback, and
   * OFF for `setSessionAgent` / `setSessionModel` / `compact` / `interrupt` /
   * `revert` because nobody has measured whether their routes exist at all —
   * turning the guard on for an unmeasured verb would refuse calls that might
   * be working, which is a fabrication in the other direction. See the
   * per-method comments for what is known and what is not.
   */
  private async control(
    method: string,
    path: string,
    body: unknown,
    key: string | undefined,
    what: string,
    guardSpaFallback = false,
  ): Promise<void> {
    const res = await this.request(path, { method, body: JSON.stringify(body) }, key);
    if (res.status === 404) throw new OrchestratorError('SESSION_NOT_FOUND', false, `${what}: session not found`);
    if (res.status === 409) throw new OrchestratorError('SESSION_BUSY', true, `${what}: session busy — backpressure`);
    if (res.status === 401) throw new OrchestratorError('SERVE_UNREACHABLE', false, `${what}: rejected credentials (401)`);
    if (res.status !== 204 && !res.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `${what} failed with HTTP ${res.status}`);
    if (guardSpaFallback) {
      const contentType = spaFallbackContentType(res);
      if (contentType !== null) {
        throw new OrchestratorError(
          'CONTRACT_DRIFT',
          false,
          `${what}: expected JSON, got ${contentType} (HTTP ${res.status}) — ` +
            'the request most likely hit the SPA fallback, not a route',
        );
      }
    }
    // 204 No Content (or a tolerated 2xx): nothing to parse.
    try {
      await res.body?.cancel();
    } catch {
      // body already consumed/absent — never fatal
    }
  }

  /**
   * POST /api/session/{id}/agent {agent}. Stable key per target+agent.
   *
   * **UNVERIFIED.** The status this answers with has never been measured against
   * a live serve — the previous comment here asserted `204 No Content`, and that
   * assertion is exactly what let the same class of defect through on the skill
   * verb. The path's existence in serve's own `/doc` spec is likewise
   * unverified. Nothing in this method's behaviour depends on the status beyond
   * "not an error status", and it does not carry the SPA-fallback guard for the
   * stated reason: doing so against an unmeasured route risks refusing a call
   * that works. MEASURE IT, then decide.
   */
  async setSessionAgent(sessionId: SessionId, agent: string): Promise<{ ok: true }> {
    await this.control(
      'POST',
      `/api/session/${sessionId}/agent`,
      { agent },
      this.promptKey(sessionId, `agent:${agent}`),
      'session.agent',
    );
    return { ok: true };
  }

  /**
   * POST /api/session/{id}/model {model: ModelRef}. Stable key per target+model.
   *
   * **UNVERIFIED** on the same two counts as `setSessionAgent`: the response
   * status and the route's presence in `/doc` have both never been measured.
   * The `204` this comment used to claim was an assumption, not an observation.
   */
  async setSessionModel(sessionId: SessionId, model: ModelRef): Promise<{ ok: true }> {
    await this.control(
      'POST',
      `/api/session/${sessionId}/model`,
      { model },
      this.promptKey(sessionId, `model:${model.providerID}/${model.id}`),
      'session.model',
    );
    return { ok: true };
  }

  /**
   * POST /api/experimental/session/{id}/skill {id, resume}. Stable key per
   * target+skill+action. `attach` maps to resume:true, `detach` to false.
   *
   * MEASURED 2026-09-30: **this path does not exist.** No `experimental/session`
   * route appears anywhere in serve's own spec at `/doc`, and the request
   * answers the SPA catch-all — `200 OK`, `content-type: text/html`, 2 884
   * bytes, byte-identical to a deliberately absurd path. The comment this
   * replaces claimed `204 No Content`; nothing of the kind was ever observed,
   * and `control()` read `res.ok` as success, so this method has reported a
   * successful skill attach/detach for every call it has ever made without
   * reaching a handler.
   *
   * THAT IS WORSE THAN THE SHELL CASE. This verb is state-mutating, it is
   * parked behind FR-12, so a user is asked to say yes out loud to change the
   * instructions the agent will run — and the app then tells them it worked.
   * The guard below is the same `spaFallbackContentType` rule `execSessionShell`
   * uses, deliberately not a second mechanism: one rule, two call sites.
   *
   * The cost, stated rather than hidden: with the guard on, the skill verb now
   * FAILS loudly (a typed `CONTRACT_DRIFT`) instead of lying. Until a real
   * route is found, the honest state is "this capability does not exist on this
   * serve", and an unverified-but-plausible path in `/doc` is the only fix.
   */
  async toggleSessionSkill(
    sessionId: SessionId,
    skill: string,
    action: 'attach' | 'detach',
  ): Promise<{ ok: true }> {
    await this.control(
      'POST',
      `/api/experimental/session/${sessionId}/skill`,
      { id: skill, resume: action === 'attach' },
      this.promptKey(sessionId, `skill:${skill}:${action}`),
      'session.skill',
      true,
    );
    return { ok: true };
  }

  /**
   * Run a shell command in a session and RETURN WHAT SERVE ACTUALLY SAID.
   *
   * MEASURED LIVE 2026-09-30 against opencode 1.18.32 (`opencode serve --port
   * 4096`, spec read from the live `/doc`). This method previously read
   *
   *     await this.control('POST', `/api/session/${sessionId}/shell`, …);
   *     return { ok: true };
   *
   * and both halves of that were wrong.
   *
   * **The path was not a route.** `/api/session/{id}/shell` is absent from the
   * v2 `/api/*` family in serve's own OpenAPI — the family has agent, model,
   * prompt, compact, wait, revert/*, context, history, event, interrupt and
   * message, and no `shell`. So every call fell through to the SPA catch-all,
   * which answers `200 OK` with `content-type: text/html` and a 2 884-byte
   * `<!doctype html>` page. Measured byte-identical to a deliberately absurd
   * path (`/api/zzz-not-a-route-<ts>`): `byte-identical = true`. `control()`
   * tested `res.ok`, which was true, discarded the body, and returned a
   * fabricated success. Against an UNKNOWN session id — a case that must be a
   * 404 — it also answered 200 HTML. So a command that never ran, against a
   * session that does not exist, was reported to the user as a success.
   *
   * The route that DOES exist is v1, WITHOUT the `/api` prefix:
   * `POST /session/{sessionID}/shell`, `operationId: session.shell`. Measured
   * working; it is what this method now calls.
   *
   * **It does not stream, and it blocks.** `transfer-encoding: null` and
   * `t_firstbyte == t_headers == t_end` on every probe. It completes, then
   * returns, having waited for the command:
   *
   *     echo hi                     200  1348 ms  completed  "hi\r\n"
   *     exit 3                      200   249 ms  completed  ""          <- failed
   *     <nonexistent binary>        200   359 ms  completed  <PS error text>
   *     node -e 'x'.repeat(20000)  200   554 ms  completed  40 884 B body
   *     ping -n 8 127.0.0.1         200  7384 ms  completed  <full output>
   *
   * **There is no exit code, anywhere.** `ToolStateCompleted` in the live spec
   * is `{status, input, output, title, metadata, time, attachments}` — no
   * `exitCode`, and neither does `ToolStateError`. `exit 3` is `completed` with
   * empty output, which is what a silent success also looks like. So this
   * method reports `outcome: 'unknown'` in the common case, and the ONLY way to
   * get `'failed'` is serve flagging the tool as `error`. That is a hard limit
   * of the transport, not a parsing gap: returning `ok` here would be the same
   * fabrication as before, one layer down.
   *
   * Errors are `{name, data:{message, kind?}}` — NOT the `{data}` envelope the
   * v2 family uses, and NOT a `{ok}` shape. Measured: 400
   * `{"name":"BadRequest","data":{"message":"Missing key\n  at [\"agent\"]","kind":"Payload"}}`,
   * 404 `{"name":"NotFoundError","data":{"message":"Session not found: …"}}`.
   *
   * Throws `OrchestratorError` for transport/contract failures so every
   * existing `catch` site keeps working; returns the truth on a 200. The
   * returned `output` is UNBOUNDED on purpose (a 20 000-char command produced a
   * 40 884-byte body with no truncation) — this layer must not silently hide
   * bytes from its caller; the WS frame's `OutputAssembler` is where the cap
   * and the `truncated` flag belong.
   */
  async execSessionShell(
    sessionId: SessionId,
    command: string,
    agent = DEFAULT_SHELL_AGENT,
  ): Promise<SessionShellResult> {
    // v1 requires `agent` and `command` and is `additionalProperties: false`,
    // so the old `{id}` field would be a 400 — verified live.
    const res = await this.request(
      `/session/${sessionId}/shell`,
      { method: 'POST', body: JSON.stringify({ agent, command }) },
      randomUUID(),
    );
    if (res.status === 401) throw new OrchestratorError('SERVE_UNREACHABLE', false, 'session.shell: rejected credentials (401)');
    if (res.status === 404) {
      throw new OrchestratorError('SESSION_NOT_FOUND', false, `session.shell: session ${sessionId} not found`);
    }
    if (res.status === 409) {
      throw new OrchestratorError('SESSION_BUSY', true, `session.shell: session ${sessionId} busy — backpressure`);
    }
    if (!res.ok) {
      throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.shell failed with HTTP ${res.status}`);
    }

    // THE SPA-FALLBACK GUARD, and the durable half of this fix.
    //
    // A 2xx is not proof of anything here: the catch-all answers 200 + HTML, so
    // `res.ok` is true for a route that does not exist. Reading the body first
    // and rejecting a non-JSON content-type converts the silent lie back into a
    // typed, non-retryable failure. Without this, a future serve that drops the
    // v1 route silently reintroduces the exact defect this method was rewritten
    // to remove — and the test that pins it fails on the day it happens.
    //
    // ONE RULE, TWO CALL SITES: `spaFallbackContentType` is the same predicate
    // `toggleSessionSkill` uses through `control()`. This method then re-checks
    // the type before parsing because it REQUIRES a body, and that second check
    // is what turns a body-less 2xx into a typed failure rather than a raw
    // `SyntaxError` from `res.json()`.
    const fallback = spaFallbackContentType(res);
    if (fallback !== null) {
      throw new OrchestratorError(
        'CONTRACT_DRIFT',
        false,
        `session.shell: expected JSON, got ${fallback} (HTTP ${res.status}) — ` +
          'the request most likely hit the SPA fallback, not a route',
      );
    }
    // `res.json()` THROWS on a non-JSON body — including a 2xx that declared no
    // content-type at all — and an unhandled throw here would be an opaque
    // `SyntaxError` rather than a typed OrchestratorError.
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      throw new OrchestratorError(
        'CONTRACT_DRIFT',
        false,
        `session.shell: response was not JSON (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    return normalizeShellResult(sessionId, command, raw);
  }

  /**
   * GET /api/agent?directory=<dir> → {data:[…]} — the 2.0.x contract requires a
   * directory scope; an unscoped call returns no data. Normalized to AgentInfo.
   */
  async listAgents(directory: string): Promise<AgentInfo[]> {    const res = await this.request(`/api/agent?directory=${encodeURIComponent(directory)}`, { method: 'GET' });
    if (!res.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `agent.list failed with HTTP ${res.status}`);
    const data = unwrapData(await res.json());
    if (!Array.isArray(data)) return [];
    const out: AgentInfo[] = [];
    for (const row of data) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Record<string, unknown>;
      if (typeof r['id'] !== 'string' || r['id'].length === 0) continue;
      out.push({
        id: r['id'],
        name: typeof r['name'] === 'string' ? r['name'] : r['id'],
        ...(typeof r['mode'] === 'string' ? { mode: r['mode'] } : {}),
      });
    }
    return out;
  }

  async listSessions(): Promise<SessionInfo[]> {
    const res = await this.request('/api/session', { method: 'GET' });
    if (!res.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.list failed with HTTP ${res.status}`);
    const data = unwrapData(await res.json());
    if (!Array.isArray(data)) return [];
    return data
      .map((row) => normalizeSessionRow(row))
      .filter((row): row is SessionInfo => row !== null);
  }

  /**
   * True current context-window occupancy for one session (D9).
   *
   * Uses the dedicated `/api/session/{id}/context` endpoint, which returns the
   * session's messages; summing their `StepFinishPart` tokens gives what is
   * actually occupying the window right now. This is deliberately NOT the
   * session row's lifetime `tokens` — a compaction resets the former and
   * leaves the latter untouched, so using the row would make the gauge climb
   * forever.
   *
   * `limit` comes from the models.dev catalog; when it is unknown we return
   * `percent: null` rather than dividing by a guess.
   */
  async contextUsage(sessionId: SessionId, limit?: number): Promise<ContextUsage> {
    const res = await this.request(`/api/session/${sessionId}/context`, { method: 'GET' });
    if (!res.ok) {
      throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.context failed with HTTP ${res.status}`);
    }
    const data = unwrapData(await res.json());
    const rows = Array.isArray(data) ? data : [];

    // CURRENT window = the most recent step's own accounting. Summing across
    // rows is wrong: every step re-sends the whole conversation, so per-step
    // `input` is cumulative and a sum measures the session, not the window.
    let counted = 0;
    let current: MessageTokens | null = null;
    let peak = 0;
    // Mutable roll-up; `MessageTokens` itself is readonly by design.
    const acc = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    for (const row of rows) {
      const t = rowTokens(row);
      if (t === null) continue;
      counted += 1;
      current = t;
      const fill = stepWindowFill(t);
      if (fill > peak) peak = fill;
      // `byMessage` is a lifetime roll-up and is labelled as such; it is NOT
      // the window, and nothing should render it as one.
      acc.input += t.input;
      acc.output += t.output;
      acc.reasoning += t.reasoning;
      acc.cacheRead += t.cacheRead;
      acc.cacheWrite += t.cacheWrite;
    }
    const byMessage: MessageTokens = { ...acc };
    const used = current === null ? 0 : stepWindowFill(current);
    // An explicit limit wins. Otherwise resolve it from the model catalog: the
    // session row carries only {id, providerID, variant}, so `limit.context` in
    // the catalog is the ONLY verified source for a session's context window.
    // Without this the gauge is inert and permanently reads "unknown".
    let known = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.round(limit) : null;
    if (known === null) {
      try {
        const modelId = await this.modelForSession(sessionId);
        if (modelId !== null) {
          const catalog = await this.listModels();
          known = catalog.find((m) => m.id === modelId)?.contextWindow ?? null;
        }
      } catch {
        known = null;
      }
    }
    return {
      sessionId,
      used,
      limit: known,
      percent: known === null ? null : Math.round((used / known) * 1000) / 10,
      byMessage,
      messageCount: counted,
      peak,
    };
  }

  /** The session's current model id, or null. Best effort by design. */
  private async modelForSession(sessionId: SessionId): Promise<string | null> {
    const res = await this.request(`/api/session/${sessionId}`, { method: 'GET' });
    if (!res.ok) return null;
    const row = unwrapData(await res.json());
    if (typeof row !== 'object' || row === null) return null;
    const model = (row as Record<string, unknown>)['model'];
    if (typeof model === 'string') return model;
    if (typeof model === 'object' && model !== null) {
      const id = (model as Record<string, unknown>)['id'];
      if (typeof id === 'string') return id;
    }
    return null;
  }

  /**
   * The model catalog — the only verified source of `limit.context`.
   *
   * A row without a limit is reported with `contextWindow: null`. "Unknown" is
   * a real answer here; zero would be a lie that renders as an empty gauge.
   */
  async listModels(): Promise<Array<{ id: string; name: string; contextWindow: number | null }>> {
    const res = await this.request('/api/model', { method: 'GET' });
    if (!res.ok) return [];
    const data = unwrapData(await res.json());
    if (!Array.isArray(data)) return [];
    const out: Array<{ id: string; name: string; contextWindow: number | null }> = [];
    for (const row of data) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Record<string, unknown>;
      const id = r['id'];
      if (typeof id !== 'string' || id.length === 0) continue;
      const limit = r['limit'];
      const ctx =
        typeof limit === 'object' && limit !== null ? num((limit as Record<string, unknown>)['context']) : undefined;
      const name = typeof r['name'] === 'string' ? (r['name'] as string) : id;
      out.push({ id, name, contextWindow: ctx !== undefined && ctx > 0 ? ctx : null });
    }
    return out;
  }

  /**
   * Installed skills, with the `slash` flag marking the ones invocable as a
   * slash command. This is what makes `@skill` mentions real rather than a
   * hardcoded list.
   */
  async listSkills(): Promise<Array<{ name: string; description: string | null; slash: boolean }>> {
    const res = await this.request('/api/skill', { method: 'GET' });
    if (!res.ok) return [];
    const data = unwrapData(await res.json());
    if (!Array.isArray(data)) return [];
    const out: Array<{ name: string; description: string | null; slash: boolean }> = [];
    for (const row of data) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Record<string, unknown>;
      const name = r['name'];
      if (typeof name !== 'string' || name.length === 0) continue;
      const description = typeof r['description'] === 'string' ? (r['description'] as string) : null;
      out.push({ name, description, slash: r['slash'] === true });
    }
    return out;
  }

  /** Native `/compact` — real compaction, not a prompt asking the model to forget. */
  async compactSession(sessionId: SessionId): Promise<{ ok: true }> {
    await this.control(
      'POST',
      `/api/session/${sessionId}/compact`,
      {},
      randomUUID(),
      'session.compact',
    );
    return { ok: true };
  }

  /** Native abort — the correct barge-in primitive. */
  async interruptSession(sessionId: SessionId): Promise<{ ok: true }> {
    await this.control('POST', `/api/session/${sessionId}/interrupt`, {}, randomUUID(), 'session.interrupt');
    return { ok: true };
  }

  /** Three-phase revert (`/undo`). */
  async revertSession(sessionId: SessionId, phase: 'stage' | 'commit' | 'clear'): Promise<{ ok: true }> {
    await this.control(
      'POST',
      `/api/session/${sessionId}/revert/${phase}`,
      {},
      randomUUID(),
      `session.revert.${phase}`,
    );
    return { ok: true };
  }

  /**
   * Phase 5 — the slash-command catalog serve advertises, used by the assistant
   * for `/help` and to know what exists. Read-only; never forwarded blindly.
   */
  async listCommands(): Promise<Array<{ readonly name: string }>> {
    const res = await this.request('/api/command', { method: 'GET' });
    if (!res.ok) return [];
    const data = unwrapData(await res.json());
    if (!Array.isArray(data)) return [];
    const out: Array<{ name: string }> = [];
    for (const row of data) {
      if (typeof row !== 'object' || row === null) continue;
      const name = (row as Record<string, unknown>)['name'];
      if (typeof name === 'string' && name.length > 0 && name.length <= 64) out.push({ name });
    }
    return out;
  }

  /**
   * Phase 5 — message timestamps for a session, used to show when the assistant
   * last spoke. Returns an empty list on any failure: it is decoration, not
   * control flow, so it must never be able to fail a command.
   */
  async listSessionMessages(sessionId: SessionId): Promise<Array<{ createdAt: number }>> {
    try {
      // V1 ROUTE, PINNED — measured, not chosen. The two projections of the
      // same data DISAGREE about what exists, on one serve, at one moment:
      //
      //   GET /api/session/{id}/message  -> 200 {"data":[]}          0 rows
      //   GET /session/{id}/message       -> 200 [ {info,parts} … ]  14 rows
      //
      // Across all 46 pre-existing sessions the v1 surface returned 234
      // messages that the v2 surface does not report. The v2 route is declared
      // GET-only and returns a `{data: SessionMessage[]}` cursor envelope; the
      // v1 route is declared GET+POST and returns a bare array of
      // `{info, parts}`. Neither is a superset of the other, and this method
      // is decoration — it exists to show when the assistant last spoke — so
      // reading the empty projection made "last spoke" permanently null.
      //
      // DO NOT "modernise" this back to /api/. A 200 is not evidence of
      // content here, and the failure mode is silent: an empty array, not an
      // error. The evidence is a 46-session read, not a preference.
      const res = await this.request(`/session/${sessionId}/message`, { method: 'GET' });
      if (!res.ok) return [];
      const data = unwrapData(await res.json());
      if (!Array.isArray(data)) return [];
      const out: Array<{ createdAt: number }> = [];
      for (const row of data) {
        if (typeof row !== 'object' || row === null) continue;
        const r = row as Record<string, unknown>;
        // Measured live: rows are FLAT `{id, time, type, content}`, with no
        // `info` wrapper. Reading `row.info` returned nothing, so the "last
        // message" timestamp was always null.
        const info = typeof r['info'] === 'object' && r['info'] !== null ? (r['info'] as Record<string, unknown>) : r;
        const time = info['time'];
        const created =
          typeof time === 'object' && time !== null ? num((time as Record<string, unknown>)['created']) : undefined;
        if (created !== undefined) out.push({ createdAt: created });
      }
      return out;
    } catch {
      return [];
    }
  }

  async probeContract(): Promise<string> {    try {
      const res = await this.request('/openapi.json', { method: 'GET' });
      if (!res.ok) return 'unknown';
      const doc = (await res.json()) as { info?: { version?: string } };
      return doc.info?.version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
