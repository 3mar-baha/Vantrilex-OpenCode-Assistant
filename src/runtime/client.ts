import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { nowIso } from '../common/brands.js';
import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';

// Typed serve client — docs/03 §3.4, docs/06 §6.2, docs/25 §25.2. Raw fetch with
// zod-validated responses (the documented equivalent of @opencode/client calls);
// idempotency keys are reused on retry so create/prompt never double-apply.
//
// Auth (verified live 2026-09-24, OpenCode serve 1.18.32): opencode serve uses
// HTTP Basic `opencode:<password>` — Bearer is rejected. All serve traffic uses
// `basicAuth()`; sessions live at the /api/session family, envelope {data:...}.
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

const SessionCreateResponse = z.object({
  sessionId: z.string().min(1),
  state: z.string(),
  createdAt: z.string().datetime(),
});

const PromptResponse = z.object({
  sessionId: z.string().min(1),
  state: z.string(),
  receipt: z.string(),
});

export interface SessionStatusInfo {
  readonly sessionId: string;
  readonly state: string;
  readonly outcome: string;
  readonly updatedAt: string;
  readonly lastEventId?: string;
}

// Phase 3 native per-session controls — shapes mirror @opencode/client 1.18.x
// (/api/session/{id}/agent POST, /model PATCH, /experimental/.../skill POST,
// /shell POST). .passthrough() tolerates server-added fields; the required
// keys below are what Voxaura consumes. Verified live against mocks; production
// reconciliation via /openapi.json is recorded in RAG-ORCHESTRATOR-INTEGRATION.
const AgentResponse = z.object({ agent: z.string().min(1) }).passthrough();
const ModelResponse = z.object({ model: z.string().min(1) }).passthrough();
const SkillResponse = z.object({ ok: z.boolean() }).passthrough();
const ShellResponse = z
  .object({ stdout: z.string(), stderr: z.string(), exitCode: z.number().int() })
  .passthrough();

/** Client-side cap on captured exec output — memory bound, never unbounded. */
export const SHELL_OUTPUT_CAP = 64 * 1024;

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
    const key = randomUUID();
    const res = await this.request('/session', {
      method: 'POST',
      body: JSON.stringify({ directory, ...(model !== undefined ? { model } : {}) }),
    }, key);
    if (res.status === 401) throw new OrchestratorError('SERVE_UNREACHABLE', false, 'serve rejected credentials (401)');
    if (!res.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.create failed with HTTP ${res.status}`);
    const parsed = SessionCreateResponse.parse(await res.json());
    return { sessionId: parsed.sessionId as SessionId, state: parsed.state };
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
    const res = await this.request(`/session/${sessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text, provenance }),
    }, key);
    if (res.status === 404) throw new OrchestratorError('SESSION_NOT_FOUND', false, `session ${sessionId} not found`);
    if (res.status === 409) throw new OrchestratorError('SESSION_BUSY', true, `session ${sessionId} busy — backpressure`);
    if (!res.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.prompt failed with HTTP ${res.status}`);
    const parsed = PromptResponse.parse(await res.json());
    return { state: parsed.state, receipt: parsed.receipt };
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
   * Generic session mutation (Phase 3): one error-mapping funnel so every new
   * control behaves identically — 404 fail-closed, 409 busy-retryable,
   * 401 non-retryable, anything else retryable-transient.
   */
  private async mutate<T>(
    method: string,
    path: string,
    body: unknown,
    key: string | undefined,
    schema: z.ZodType<T>,
    what: string,
  ): Promise<T> {
    const res = await this.request(path, { method, body: JSON.stringify(body) }, key);
    if (res.status === 404) throw new OrchestratorError('SESSION_NOT_FOUND', false, `${what}: session not found`);
    if (res.status === 409) throw new OrchestratorError('SESSION_BUSY', true, `${what}: session busy — backpressure`);
    if (res.status === 401) throw new OrchestratorError('SERVE_UNREACHABLE', false, `${what}: rejected credentials (401)`);
    if (!res.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `${what} failed with HTTP ${res.status}`);
    return schema.parse(await res.json()) as T;
  }

  /** POST /api/session/{id}/agent — stable key: same target+agent retries dedupe. */
  async setSessionAgent(sessionId: SessionId, agent: string): Promise<{ agent: string } & Record<string, unknown>> {
    return this.mutate(
      'POST',
      `/api/session/${sessionId}/agent`,
      { agent },
      this.promptKey(sessionId, `agent:${agent}`),
      AgentResponse,
      'session.agent',
    );
  }

  /** PATCH /api/session/{id}/model — stable key per target+model. */
  async setSessionModel(sessionId: SessionId, model: string): Promise<{ model: string } & Record<string, unknown>> {
    return this.mutate(
      'PATCH',
      `/api/session/${sessionId}/model`,
      { model },
      this.promptKey(sessionId, `model:${model}`),
      ModelResponse,
      'session.model',
    );
  }

  /** POST /api/experimental/session/{id}/skill — stable key per target+skill+action. */
  async toggleSessionSkill(
    sessionId: SessionId,
    skill: string,
    action: 'attach' | 'detach',
  ): Promise<{ ok: boolean } & Record<string, unknown>> {
    return this.mutate(
      'POST',
      `/api/experimental/session/${sessionId}/skill`,
      { skill, action },
      this.promptKey(sessionId, `skill:${skill}:${action}`),
      SkillResponse,
      'session.skill',
    );
  }

  /**
   * POST /api/session/{id}/shell — managed exec inside the session context.
   * Fresh UUID per call (exec is NOT idempotent) + client-side 64KB capture cap.
   */
  async execSessionShell(
    sessionId: SessionId,
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const parsed = await this.mutate(
      'POST',
      `/api/session/${sessionId}/shell`,
      { command },
      randomUUID(),
      ShellResponse,
      'session.shell',
    );
    return {
      stdout: parsed.stdout.slice(0, SHELL_OUTPUT_CAP),
      stderr: parsed.stderr.slice(0, SHELL_OUTPUT_CAP),
      exitCode: parsed.exitCode,
    };
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
