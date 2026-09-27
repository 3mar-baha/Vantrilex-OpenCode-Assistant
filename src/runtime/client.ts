import { randomUUID } from 'node:crypto';
import { nowIso } from '../common/brands.js';
import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';

// Typed serve client — docs/03 §3.4, docs/06 §6.2, docs/25 §25.2. Raw fetch with
// shape-normalizing parsers (the documented equivalent of @opencode/client calls);
// idempotency ids are reused on retry so create/prompt never double-apply.
//
// Contract (verified live + against @opencode/client 1.18.x, 2026-09-24):
//  - Auth: HTTP Basic `opencode:<password>` (Bearer is rejected).
//  - Sessions live at the /api/session family; envelopes are `{data:...}`.
//  - create/prompt return 200 with `{data}`; agent/model/skill/shell return 204.`
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
 * `used` is the true current context fill and is NOT the session's lifetime
 * `SessionInfo.tokens` — summing the two is the classic mistake, and would
 * report a bar that keeps climbing after a `/compact`. `limit` is the model's
 * context window; without it we report `percent: null` rather than guessing.
 */
export interface ContextUsage {
  readonly sessionId: SessionId;
  readonly used: number;
  readonly limit: number | null;
  readonly percent: number | null;
  readonly byMessage: MessageTokens;
  readonly messageCount: number;
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

/** A step-finish part inside a message from `/api/session/{id}/context`. */
function messageTokens(message: unknown): MessageTokens | null {
  if (typeof message !== 'object' || message === null) return null;
  const parts = (message as Record<string, unknown>)['parts'];
  if (!Array.isArray(parts)) return null;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let seen = false;
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) continue;
    const tokens = (part as Record<string, unknown>)['tokens'];
    if (typeof tokens !== 'object' || tokens === null) continue;
    const t = tokens as Record<string, unknown>;
    const cache = (typeof t['cache'] === 'object' && t['cache'] !== null ? t['cache'] : {}) as Record<string, unknown>;
    const i = num(t['input']);
    const o = num(t['output']);
    const rr = num(t['reasoning']);
    if (i === undefined && o === undefined && rr === undefined) continue;
    seen = true;
    input += i ?? 0;
    output += o ?? 0;
    reasoning += rr ?? 0;
    cacheRead += num(cache['read']) ?? 0;
    cacheWrite += num(cache['write']) ?? 0;
  }
  return seen ? { input, output, reasoning, cacheRead, cacheWrite } : null;
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

  private async promptWithKey(
    sessionId: SessionId,
    text: string,
    provenance: Provenance,
    key: string,
  ): Promise<{ state: string; receipt: string }> {
    // Envelope is server-generation dependent (see promptEnvelope).
    const payload =
      this.promptEnvelope === 'flat'
        ? { text, metadata: provenance, delivery: 'steer' }
        : { prompt: { text, metadata: provenance, delivery: 'steer' } };
    const res = await this.request(`/api/session/${sessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }, key);
    if (res.status === 404) throw new OrchestratorError('SESSION_NOT_FOUND', false, `session ${sessionId} not found`);
    if (res.status === 409) throw new OrchestratorError('SESSION_BUSY', true, `session ${sessionId} busy — backpressure`);
    if (!res.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.prompt failed with HTTP ${res.status}`);
    const data = unwrapData(await res.json());
    const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
    return {
      state: typeof d['state'] === 'string' ? d['state'] : 'running',
      receipt: typeof d['id'] === 'string' ? d['id'] : typeof d['receipt'] === 'string' ? d['receipt'] : key,
    };
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
   * non-retryable, other non-2xx transient. Canonical controls return
   * **204 No Content** — the body is never read.
   */
  private async control(
    method: string,
    path: string,
    body: unknown,
    key: string | undefined,
    what: string,
  ): Promise<void> {
    const res = await this.request(path, { method, body: JSON.stringify(body) }, key);
    if (res.status === 404) throw new OrchestratorError('SESSION_NOT_FOUND', false, `${what}: session not found`);
    if (res.status === 409) throw new OrchestratorError('SESSION_BUSY', true, `${what}: session busy — backpressure`);
    if (res.status === 401) throw new OrchestratorError('SERVE_UNREACHABLE', false, `${what}: rejected credentials (401)`);
    if (res.status !== 204 && !res.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `${what} failed with HTTP ${res.status}`);
    // 204 No Content (or a tolerated 2xx): nothing to parse.
    try {
      await res.body?.cancel();
    } catch {
      // body already consumed/absent — never fatal
    }
  }

  /** POST /api/session/{id}/agent {agent} → 204. Stable key per target+agent. */
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

  /** POST /api/session/{id}/model {model: ModelRef} → 204. Stable key per target+model. */
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
   * POST /api/experimental/session/{id}/skill {id, resume} → 204. Stable key
   * per target+skill+action. `attach` maps to resume:true, `detach` to false.
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
    );
    return { ok: true };
  }

  /**
   * POST /api/session/{id}/shell {id, command} → 204. Output is delivered
   * asynchronously over the session event stream, not in the response.
   * Fresh UUID per call (exec is not idempotent).
   */
  async execSessionShell(sessionId: SessionId, command: string): Promise<{ ok: true }> {
    await this.control(
      'POST',
      `/api/session/${sessionId}/shell`,
      { id: randomUUID(), command },
      randomUUID(),
      'session.shell',
    );
    return { ok: true };
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
    const messages = Array.isArray(data) ? data : [];
    // Mutable accumulator; the public shape stays readonly.
    const acc = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    let counted = 0;
    for (const message of messages) {
      const t = messageTokens(message);
      if (t === null) continue;
      acc.input += t.input;
      acc.output += t.output;
      acc.reasoning += t.reasoning;
      acc.cacheRead += t.cacheRead;
      acc.cacheWrite += t.cacheWrite;
      counted += 1;
    }
    const byMessage: MessageTokens = { ...acc };
    const used = byMessage.input + byMessage.output + byMessage.reasoning;
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
      const res = await this.request(`/api/session/${sessionId}/message`, { method: 'GET' });
      if (!res.ok) return [];
      const data = unwrapData(await res.json());
      if (!Array.isArray(data)) return [];
      const out: Array<{ createdAt: number }> = [];
      for (const row of data) {
        if (typeof row !== 'object' || row === null) continue;
        const info = (row as Record<string, unknown>)['info'];
        if (typeof info !== 'object' || info === null) continue;
        const time = (info as Record<string, unknown>)['time'];
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
