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

/** Internal session contract (id, agent, model, state) — normalized from /api/session. */
export interface SessionInfo {
  readonly sessionId: string;
  readonly state: string;
  readonly agent?: string;
  readonly model?: string;
}

/** /api/session list/get envelope: { data: row | rows, cursor? }. */
function unwrapData(payload: unknown): unknown {
  if (typeof payload === 'object' && payload !== null && 'data' in payload) {
    return (payload as { data: unknown }).data;
  }
  return payload;
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
  const state = typeof r['state'] === 'string' && r['state'].length > 0 ? r['state'] : 'unknown';
  return {
    sessionId: id,
    state,
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
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
  ) {}

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
    // Canonical prompt envelope (server schema verified live): the body is
    // { prompt: PromptInput } where PromptInput carries text/metadata/delivery.
    // The transport key travels in the Idempotency-Key header.
    const res = await this.request(`/api/session/${sessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ prompt: { text, metadata: provenance, delivery: 'steer' } }),
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
      state: typeof r['state'] === 'string' ? r['state'] : 'unknown',
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

  async listSessions(): Promise<SessionInfo[]> {
    const res = await this.request('/api/session', { method: 'GET' });
    if (!res.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.list failed with HTTP ${res.status}`);
    const data = unwrapData(await res.json());
    if (!Array.isArray(data)) return [];
    return data
      .map((row) => normalizeSessionRow(row))
      .filter((row): row is SessionInfo => row !== null);
  }

  async probeContract(): Promise<string> {
    try {
      const res = await this.request('/openapi.json', { method: 'GET' });
      if (!res.ok) return 'unknown';
      const doc = (await res.json()) as { info?: { version?: string } };
      return doc.info?.version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
