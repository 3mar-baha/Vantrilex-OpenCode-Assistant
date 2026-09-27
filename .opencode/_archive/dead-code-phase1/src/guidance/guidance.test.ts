import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { injectAgentsMd } from './agents.js';
import { buildBluf, capExcerpt, countWords } from './bluf.js';
import { resolveGuildSkills } from './guildskills.js';
import { SessionOverseer } from './overseer.js';

describe('BLUF builder', () => {
  test('failure shape carries state, modules, count, logs, next step', () => {
    const { lead, body } = buildBluf({
      sessionLabel: 'payments-refactor',
      outcome: 'red',
      changeClauses: [],
      nextAction: 'Start fixing auth failures?',
      failure: { modules: ['auth', 'billing'], failureCount: 14, logsSaved: true },
    });
    expect(countWords(lead)).toBeLessThanOrEqual(15);
    expect(body).toContain('14');
    expect(body).toContain('auth');
    expect(body).toContain('log');
  });

  test('excerpt cap enforces 40 words', () => {
    const long = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
    expect(countWords(capExcerpt(long))).toBe(40);
    expect(countWords(capExcerpt('short text'))).toBe(2);
  });
});

describe('AGENTS.md injection', () => {
  test('writes project-local file with pre-auth classes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-'));
    const path = injectAgentsMd(dir, {
      repoCase: 'legacy',
      preApproved: ['tests', 'linting'],
      heldForApproval: ['migrations', 'deploys'],
      overseerNote: 'Advance milestones; halt + suggest /prompt-master when done.',
    });
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('Project case: legacy');
    expect(content).toContain('migrations');
    expect(content).toContain('FR-12');
  });
});

describe('session overseer', () => {
  test('advances milestones, halts with /prompt-master at completion', () => {
    const overseer = new SessionOverseer([
      { id: 'm1', title: 'scaffold', status: 'pending' },
      { id: 'm2', title: 'voice', status: 'pending' },
    ]);
    const first = overseer.step();
    expect(first.action).toBe('advance');
    if (first.action === 'advance') {
      const after = overseer.completeMilestone(first.milestone.id, 'green');
      expect(after.action).toBe('advance');
    }
    overseer.completeMilestone('m2', 'green');
    const done = overseer.step();
    expect(done.action).toBe('halt');
    if (done.action === 'halt') expect(done.suggestion).toContain('/prompt-master');
  });

  test('circuit breaker halts at 5 consecutive failures', () => {
    const overseer = new SessionOverseer([{ id: 'm1', title: 'loop', status: 'active' }]);
    let decision = overseer.completeMilestone('m1', 'red');
    for (let i = 1; i < 5 && decision.action === 'advance'; i += 1) {
      decision = overseer.completeMilestone('m1', 'red');
    }
    expect(decision.action).toBe('halt');
    if (decision.action === 'halt') expect(decision.reason).toContain('circuit breaker');
  });
});

describe('guildskills resolver', () => {
  let server: Server;
  let url = '';

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          skills: [
            { id: 'plan-pro', name: 'Planner', repoCase: ['legacy'], milestone: ['voice'], defaultSelected: false },
            { id: 'random-tool', name: 'Random', repoCase: ['greenfield'], milestone: ['other'], defaultSelected: false },
          ],
        }));
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr === null || typeof addr === 'string') {
          reject(new Error('mock catalog failed to bind'));
          return;
        }
        url = `http://127.0.0.1:${addr.port}/guildskills.json`;
        resolve();
      });
    });
  });

  test('scores, filters, and writes tool contracts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-'));
    const resolved = await resolveGuildSkills(url, { repoCase: 'legacy', milestone: 'voice', denied: [] }, dir);
    expect(resolved.map((r) => r.id)).toEqual(['plan-pro']);
    expect(resolved[0]?.score).toBe(5);
    const contract = readFileSync(join(dir, 'tool--plan-pro.md'), 'utf8');
    expect(contract).toContain('invocation contract');
  });
});
