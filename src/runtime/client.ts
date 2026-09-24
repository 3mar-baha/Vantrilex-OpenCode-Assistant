import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';

// Typed serve client — docs/03 §3.4, docs/06 §6.2, docs/25 §25.2. Raw fetch with
// zod-validated responses (the documented equivalent of @opencode/client calls);
// idempotency keys are reused on retry so create/prompt never double-apply.
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

const SessionStatus = z.object({
  sessionId: z.string().min(1),
  state: z.string(),
  outcome: z.string(),
  updatedAt: z.string().datetime(),
  lastEventId: z.string().optional(),
});

const SessionList = z.object({
  sessions: z.array(z.object({ sessionId: z.string().min(1), state: z.string() })),
});

export interface Provenance {
  readonly origin: 'voice' | 'cli' | 'mobile' | 'reconciled';
  readonly transcript?: string;
  readonly actor: string;
}

export class ServeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly password: string,
  ) {}

  /** Stable prompt keys: retries of the same (session, text) reuse one UUID so
   * serve-side idempotency actually dedupes. Bounded to 256 entries. */
  private readonly promptKeys = new Map<string, string>();

  private promptKey(sessionId: SessionId, text: string): string {
    const slot = `${sessionId}\n${text}`;
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
      Authorization: `Bearer ${this.password}`,
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
    const res = await this.request(`/session/${sessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text, provenance }),
    }, this.promptKey(sessionId, text));
    if (res.status === 404) throw new OrchestratorError('SESSION_NOT_FOUND', false, `session ${sessionId} not found`);
    if (!res.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.prompt failed with HTTP ${res.status}`);
    const parsed = PromptResponse.parse(await res.json());
    return { state: parsed.state, receipt: parsed.receipt };
  }

  async getSession(sessionId: SessionId): Promise<z.infer<typeof SessionStatus>> {
    const res = await this.request(`/session/${sessionId}`, { method: 'GET' });
    if (res.status === 404) throw new OrchestratorError('SESSION_NOT_FOUND', false, `session ${sessionId} not found`);
    if (!res.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.get failed with HTTP ${res.status}`);
    return SessionStatus.parse(await res.json());
  }

  async listSessions(): Promise<Array<{ sessionId: string; state: string }>> {
    const res = await this.request('/session', { method: 'GET' });
    if (!res.ok) throw new OrchestratorError('SERVE_UNREACHABLE', true, `session.list failed with HTTP ${res.status}`);
    return SessionList.parse(await res.json()).sessions;
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
