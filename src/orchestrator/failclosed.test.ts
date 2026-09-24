import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { ServeClient } from '../runtime/client.js';
import type { SessionId } from '../common/brands.js';
import { Orchestrator, type SpeechAdvisor } from './orchestrator.js';
import type { EventEnvelope } from './events.js';

// G4A — abort/purge contract + fail-closed safety gate. All behavior asserted
// here is new; the legacy fail-open path for generic scorer errors is pinned
// in fr12.test.ts and must keep passing unchanged.
function envelope(id: string, summaryText: string): EventEnvelope {
  return {
    id,
    cursor: id,
    sessionId: 'ses_g4a',
    type: 'session:complete',
    at: new Date().toISOString(),
    payload: { outcome: 'green', summaryText },
  };
}

function harness(advisor?: SpeechAdvisor): {
  orch: Orchestrator;
  spoken: string[];
  aborted: number;
} {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-g4a-'));
  const spoken: string[] = [];
  let aborted = 0;
  const client = { listSessions: async () => [] } as unknown as ServeClient;
  const orch = new Orchestrator(
    client,
    dir,
    {
      speak: async (t: string) => {
        spoken.push(t);
      },
      abort: async () => {
        aborted += 1;
      },
    },
    advisor,
  );
  return {
    orch,
    spoken,
    get aborted() {
      return aborted;
    },
  };
}

const silentAdvisor: SpeechAdvisor = {
  shouldSpeak: async () => true,
  isDestructive: async () => false,
};

describe('queue purge + orchestrator abort', () => {
  test('purge() drops pending jobs and reports the count', async () => {
    const { orch } = harness(silentAdvisor);
    orch.speechQueue.enqueue({ sessionId: 'ses_g4a' as SessionId, eventId: 'e-1', tier: 'T1', outcome: 'green', text: 'one' });
    orch.speechQueue.enqueue({ sessionId: 'ses_g4a' as SessionId, eventId: 'e-2', tier: 'T1', outcome: 'green', text: 'two' });
    expect(orch.speechQueue.depth).toBe(2);
    const dropped = await orch.abort('operator abort');
    expect(dropped).toBe(2);
    expect(orch.speechQueue.depth).toBe(0);
    expect(orch.speechQueue.dequeue()).toBeNull();
  });

  test('abort() invokes the speaker abort hook even when nothing is queued', async () => {
    const h = harness(silentAdvisor);
    const dropped = await h.orch.abort('operator abort');
    expect(dropped).toBe(0);
    expect(h.aborted).toBe(1);
  });
});

describe('fail-closed safety gate (G4A)', () => {
  test('concurrency-shed scorer error → T2 degraded-gate confirmation, never T1', async () => {
    const shedder: SpeechAdvisor & { destructiveScore: (text: string) => Promise<number> } = {
      shouldSpeak: async () => true,
      isDestructive: async () => false,
      destructiveScore: async () => {
        throw new Error('LAYA_CONCURRENCY_LIMIT: 4 in flight (max 4)');
      },
    };
    const h = harness(shedder);
    await h.orch.handleEnvelope(envelope('evt-shed', 'routine status update'), false);
    expect(h.spoken).toHaveLength(1);
    expect(h.spoken[0]).toContain('Confirm before acting');
    expect(h.spoken[0]).toContain('safety gate degraded');
    expect(h.spoken[0]).not.toBe('routine status update');
  });

  test('lexical backstop: generic scorer failure + high-stakes text → T2', async () => {
    const broken: SpeechAdvisor & { destructiveScore: (text: string) => Promise<number> } = {
      shouldSpeak: async () => true,
      isDestructive: async () => false,
      destructiveScore: async () => {
        throw new Error('model down');
      },
    };
    const h = harness(broken);
    await h.orch.handleEnvelope(envelope('evt-lex', 'please deploy the stack now'), false);
    expect(h.spoken).toHaveLength(1);
    expect(h.spoken[0]).toContain('Confirm before acting');
  });

  test('lexical backstop stays silent on benign text (fail-open preserved)', async () => {
    const broken: SpeechAdvisor & { destructiveScore: (text: string) => Promise<number> } = {
      shouldSpeak: async () => true,
      isDestructive: async () => false,
      destructiveScore: async () => {
        throw new Error('model down');
      },
    };
    const h = harness(broken);
    await h.orch.handleEnvelope(envelope('evt-benign', 'all tests green'), false);
    expect(h.spoken).toEqual(['all tests green']);
  });
});
