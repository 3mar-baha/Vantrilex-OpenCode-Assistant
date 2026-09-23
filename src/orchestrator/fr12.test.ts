import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { ServeClient } from '../runtime/client.js';
import { Orchestrator, type SpeechAdvisor } from './orchestrator.js';
import type { EventEnvelope } from './events.js';

// FR-12 regression: ambiguous [0.35, 0.70) and destructive [0.70, 1] scores must
// escalate to a T2 confirmation briefing — never routine T1 speech.
function advisorWithScore(score: number | null): SpeechAdvisor & { destructiveScore?: (text: string) => Promise<number> } {
  const base: SpeechAdvisor = {
    shouldSpeak: async () => true,
    isDestructive: async () => (score ?? 0) >= 0.5,
  };
  if (score === null) return base;
  return { ...base, destructiveScore: async () => score };
}

function envelope(id: string, summaryText: string): EventEnvelope {
  return {
    id,
    cursor: id,
    sessionId: 'ses_fr12',
    type: 'session:complete',
    at: new Date().toISOString(),
    payload: { outcome: 'green', summaryText },
  };
}

async function spokenFor(advisor: SpeechAdvisor | undefined, text: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-fr12-'));
  const spoken: string[] = [];
  const client = { listSessions: async () => [] } as unknown as ServeClient;
  const orch = new Orchestrator(client, dir, { speak: async (t: string) => { spoken.push(t); } }, advisor);
  await orch.handleEnvelope(envelope(`evt-${text.length}-${spoken.length}`, text), false);
  return spoken;
}

describe('FR-12 confirmation gate', () => {
  test('ambiguous score 0.50 → T2 confirmation briefing, not routine text', async () => {
    const spoken = await spokenFor(advisorWithScore(0.5), 'review the cache');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain('Confirm before acting');
    expect(spoken[0]).toContain('ambiguous');
    expect(spoken[0]).not.toBe('review the cache');
  });

  test('band edges: 0.35 escalates, 0.70 uses the destructive phrasing', async () => {
    const low = await spokenFor(advisorWithScore(0.35), 'edge low');
    expect(low[0]).toContain('Confirm before acting');
    const high = await spokenFor(advisorWithScore(0.7), 'edge high');
    expect(high[0]).toContain('destructive intent detected');
  });

  test('destructive score 0.95 → destructive confirmation briefing', async () => {
    const spoken = await spokenFor(advisorWithScore(0.95), 'rm -rf storage');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain('destructive intent detected');
    expect(spoken[0]).toContain('rm -rf storage');
  });

  test('clear score 0.10 → routine T1 speech unchanged', async () => {
    const spoken = await spokenFor(advisorWithScore(0.1), 'tests green');
    expect(spoken).toEqual(['tests green']);
  });

  test('boolean-only advisor → legacy behavior unchanged', async () => {
    const spoken = await spokenFor(advisorWithScore(null), 'plain briefing');
    expect(spoken).toEqual(['plain briefing']);
  });

  test('no advisor → legacy behavior unchanged', async () => {
    const spoken = await spokenFor(undefined, 'plain briefing');
    expect(spoken).toEqual(['plain briefing']);
  });

  test('scorer failure → fail-open routine speech', async () => {
    const broken: SpeechAdvisor & { destructiveScore: (text: string) => Promise<number> } = {
      shouldSpeak: async () => true,
      isDestructive: async () => false,
      destructiveScore: async () => { throw new Error('model down'); },
    };
    const spoken = await spokenFor(broken, 'still spoken');
    expect(spoken).toEqual(['still spoken']);
  });
});
