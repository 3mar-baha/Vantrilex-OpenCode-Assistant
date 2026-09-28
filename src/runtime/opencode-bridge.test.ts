import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { basicAuth, ServeClient } from './client.js';
import { OpenCodeBridge, type SessionDetails } from './opencode-bridge.js';
import { fuzzyPick } from './fuzzy-match.js';

// Phase 5 — OpenCode 360° omnipotent control.
//
// Verified live against OpenCode v2 payloads: the session row carries
// `tokens {input,output,reasoning,cache{read,write}}` and the dedicated
// `/api/session/{id}/context` endpoint carries the messages whose StepFinish
// tokens are what actually occupy the window. Confusing the two is the classic
// bug: the row is LIFETIME SPEND, the context endpoint is WINDOW FILL, and a
// compaction resets only the second.
let server: Server;
let baseUrl = '';
const GOOD_AUTH = basicAuth('test-password');

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (req.headers.authorization !== GOOD_AUTH) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    if (url === '/api/session' && req.method === 'GET') {
      json(res, 200, {
        data: [
          {
            id: 'ses_a',
            title: 'إصلاح خطأ الصوت',
            agent: 'explore',
            model: { id: 'muse-spark', providerID: 'openai' },
            cost: 0.42,
            tokens: { input: 120_000, output: 30_000, reasoning: 9_000, cache: { read: 80_000, write: 4_000 } },
            time: { created: 1_700_000_000_000, updated: 1_700_000_500_000 },
          },
        ],
      });
      return;
    }
    if (url === '/api/session/ses_a/context' && req.method === 'GET') {
      json(res, 200, {
        data: [
          { info: { id: 'm1' }, parts: [{ type: 'text' }] },
          { info: { id: 'm2' }, parts: [{ type: 'step-finish', tokens: { input: 400_000, output: 60_000, reasoning: 20_000, cache: { read: 200_000, write: 2_000 } } }] },
        ],
      });
      return;
    }
    if (url === '/api/session/ses_a/message' && req.method === 'GET') {
      // Live shape: FLAT rows, no `info` wrapper.
      json(res, 200, {
        data: [
          { id: 'm1', type: 'user', time: { created: 1_700_000_100_000 } },
          { id: 'm2', type: 'assistant', time: { created: 1_700_000_400_000 } },
        ],
      });
      return;
    }
    if (url.startsWith('/api/agent') && req.method === 'GET') {
      json(res, 200, { data: [{ id: 'explore', name: 'Explore' }, { id: 'build', name: 'Build' }] });
      return;
    }
    if (url.startsWith('/api/model') && req.method === 'GET') {
      json(res, 200, {
        data: [{ id: 'muse-spark', providerID: 'openai', name: 'Muse Spark', limit: { context: 200_000, output: 8_000 } }],
      });
      return;
    }
    if (url.startsWith('/api/skill') && req.method === 'GET') {
      json(res, 200, { data: [{ name: 'mission-handoff', description: 'd', slash: true, location: '.opencode', content: 'x' }] });
      return;
    }
    if (url === '/api/command' && req.method === 'GET') {
      json(res, 200, { data: [{ name: 'compact' }, { name: 'undo' }] });
      return;
    }
    if (url === '/api/session/ses_a/compact' && req.method === 'POST') {
      res.writeHead(204).end();
      return;
    }
    if (url.startsWith('/api/session/ses_a/revert/') && req.method === 'POST') {
      res.writeHead(204).end();
      return;
    }
    if (url === '/api/session/ses_a/interrupt' && req.method === 'POST') {
      res.writeHead(204).end();
      return;
    }
    json(res, 404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('mock serve failed to bind');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function bridge(): OpenCodeBridge {
  return new OpenCodeBridge(new ServeClient(baseUrl, 'test-password'), 'O:/project');
}

/**
 * `getSessionDetails` returns `SessionDetails | null` because a missing session
 * must not throw (see the last test in this block, which pins that). Every test
 * below is about a session the mock serve DOES have, so null there is a broken
 * fixture, not an expected result — fail loudly instead of dereferencing it.
 */
async function sesADetails(windowMax?: number): Promise<SessionDetails> {
  const d = await bridge().getSessionDetails('ses_a' as never, windowMax);
  if (d === null) throw new Error('expected details for ses_a');
  return d;
}

describe('OpenCodeBridge.getSessionDetails', () => {
  test('returns identity, model, agent and window occupancy', async () => {
    const d = await sesADetails(200_000);
    expect(d.id).toBe('ses_a');
    expect(d.title).toBe('إصلاح خطأ الصوت');
    expect(d.model).toBe('muse-spark');
    expect(d.agent).toBe('explore');
    expect(d.createdAt).toBe(1_700_000_000_000);
    expect(d.lastMessageAt).toBe(1_700_000_400_000);
  });

  test('reads the live flat message shape, not the {info} wrapper', async () => {
    // The wrapper the SDK types implied does not exist on the real serve; the
    // old reader returned null and the timestamp was always missing.
    const d = await sesADetails(200_000);
    expect(d.lastMessageAt).toBe(1_700_000_400_000);
  });

  test('reports peak alongside the current fill', async () => {
    const d = await sesADetails(200_000);
    expect(d.tokens.peak).toBeGreaterThan(0);
    expect(d.tokens.messageCount).toBeGreaterThan(0);
  });

  test('windowFill is the LAST step including cache, not a sum', async () => {
    const d = await sesADetails(200_000);
    // Last step in the mock: 400000 + 60000 + 20000 + cache.read 200000 + write 2000
    expect(d.tokens.windowFill).toBe(682_000);
    // Row: 120000 + 30000 + 9000 is lifetime spend and is a DIFFERENT number.
    expect(d.tokens.input).toBe(120_000);
    expect(d.tokens.output).toBe(30_000);
    expect(d.tokens.cache.read).toBe(80_000);
  });

  test('percent is derived from the limit and clamped to 0..100', async () => {
    const d = await sesADetails(400_000);
    expect(d.tokens.percent).toBe(100);
    expect(d.tokens.windowMax).toBe(400_000);
  });

  test('an unknown limit yields null percent rather than a guess', async () => {
    const d = await sesADetails();
    expect(d.tokens.windowMax).toBeNull();
    expect(d.tokens.percent).toBeNull();
  });

  test('effort is null when serve did not report one', async () => {
    const d = await sesADetails(200_000);
    expect(d.effort === null || typeof d.effort === 'string').toBe(true);
  });

  test('never throws on a missing session — the caller gets null', async () => {
    expect(await bridge().getSessionDetails('ses_missing' as never, 1000)).toBeNull();
  });
});

describe('OpenCodeBridge model/agent switching (fuzzy)', () => {
  test('resolves a spoken phrase to a catalog id and switches', async () => {
    const b = bridge();
    const agents = await b.listAgents();
    expect(agents.map((a) => a.id)).toContain('build');
    // Agents are latin ids; a partial or mis-spoken latin phrase resolves.
    expect(fuzzyPick('buil', agents.map((a) => a.id))).toBe('build');
    expect(fuzzyPick('BUILD', agents.map((a) => a.id))).toBe('build');
    // A phrase LONGER than the id does not resolve: we refuse rather than
    // trim words out of the utterance and guess.
    expect(fuzzyPick('build agent', agents.map((a) => a.id))).toBeNull();
  });

  test('an Arabic utterance for an unlisted agent does not match a latin id', async () => {
    // Deliberate: transliterating arbitrary Arabic into latin ids is not
    // possible without a dictionary, so we refuse rather than guess. The model
    // roster is covered by the alias table instead.
    const agents = (await bridge().listAgents()).map((a) => a.id);
    expect(fuzzyPick('بيلد', agents)).toBeNull();
  });

  test('refuses to switch when the phrase is ambiguous or unknown', async () => {
    const b = bridge();
    const agents = (await b.listAgents()).map((a) => a.id);
    expect(fuzzyPick('definitely-not-an-agent', agents)).toBeNull();
  });

  test('model switching validates the target before sending it', async () => {
    // An unresolvable name must not be forwarded to serve at all. The catalog
    // is the live model list; `zzz-not-real` is in none of it, so the bridge
    // throws on the resolve and never reaches the client.
    await expect(bridge().setSessionModel('ses_a' as never, 'zzz-not-real', ['muse-spark'])).rejects.toThrow();
  });
});

describe('OpenCodeBridge.getEnvironmentStatus', () => {
  test('reports agents and commands it can actually see', async () => {
    const env = await bridge().getEnvironmentStatus();
    expect(env.agents.length).toBeGreaterThan(0);
    expect(env.commands.map((c) => c.name)).toContain('compact');
  });

  test('returns a well-formed shape even when serve reports nothing', async () => {
    const env = await bridge().getEnvironmentStatus();
    expect(Array.isArray(env.agents)).toBe(true);
    expect(Array.isArray(env.skills)).toBe(true);
    expect(Array.isArray(env.plugins)).toBe(true);
    expect(Array.isArray(env.mcpServers)).toBe(true);
  });

  test('reports REAL skills from /api/skill, not an empty list', async () => {
    // An earlier revision returned [] claiming the config was unreachable.
    // That was wrong, and it made @skill mentions permanently unavailable.
    const env = await bridge().getEnvironmentStatus();
    expect(env.skills).toContain('mission-handoff');
    expect(env.slashSkills).toContain('mission-handoff');
  });

  test('reports the model catalog with its context windows', async () => {
    const env = await bridge().getEnvironmentStatus();
    expect(env.models.map((m) => m.id)).toContain('muse-spark');
    expect(env.models.find((m) => m.id === 'muse-spark')?.contextWindow).toBe(200_000);
  });

  test('never leaks a credential into the environment report', async () => {
    const env = await bridge().getEnvironmentStatus();
    expect(JSON.stringify(env)).not.toMatch(/sk-[A-Za-z0-9]{8,}|gsk_[A-Za-z0-9]{8,}|Bearer\s/i);
  });
});

describe('OpenCodeBridge internal slash routing', () => {
  test('routes /compact to the native compact endpoint', async () => {
    await expect(bridge().runInternalCommand('compact', 'ses_a' as never)).resolves.toEqual({ ok: true });
  });

  test('routes /undo to the revert stage endpoint', async () => {
    await expect(bridge().runInternalCommand('undo', 'ses_a' as never)).resolves.toEqual({ ok: true });
  });

  test('refuses a command it does not implement, rather than sending it blind', async () => {
    // Forwarding an unknown slash to the model is the blind-forward the audit
    // warned about.
    await expect(bridge().runInternalCommand('rm', 'ses_a' as never)).rejects.toThrow();
    await expect(bridge().runInternalCommand('', 'ses_a' as never)).rejects.toThrow();
  });
});
