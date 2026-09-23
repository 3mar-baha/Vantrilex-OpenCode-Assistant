import { describe, expect, test } from 'vitest';
import type { LayaDecision } from '../runtime/laya/laya-engine.js';
import { LayaSpeechAdvisor, type AdvisorEngine } from './laya-advisor.js';

function engine(scores: Partial<Record<string, number>>): AdvisorEngine {
  return {
    decide: async (): Promise<LayaDecision> => ({
      scores: {
        should_speak: 0,
        is_destructive: 0,
        barge_in: 0,
        stuck_in_loop: 0,
        ...scores,
      } as LayaDecision['scores'],
      elapsedMs: 1,
      at: '2026-09-22T00:00:00.000Z',
    }),
  };
}

describe('LayaSpeechAdvisor', () => {
  test('votes to speak above threshold, destructive above threshold', async () => {
    const advisor = new LayaSpeechAdvisor(engine({ should_speak: 0.9, is_destructive: 0.2 }));
    expect(await advisor.shouldSpeak('done')).toBe(true);
    expect(await advisor.isDestructive('done')).toBe(false);
  });

  test('silences and flags destructive on a destructive-voted decision', async () => {
    const advisor = new LayaSpeechAdvisor(engine({ should_speak: 0.1, is_destructive: 0.9 }));
    expect(await advisor.shouldSpeak('rm -rf')).toBe(false);
    expect(await advisor.isDestructive('rm -rf')).toBe(true);
  });

  test('honors custom thresholds', async () => {
    const advisor = new LayaSpeechAdvisor(engine({ should_speak: 0.4 }), 0.3);
    expect(await advisor.shouldSpeak('maybe')).toBe(true);
  });

  test('exposes the raw destructive score', async () => {
    const advisor = new LayaSpeechAdvisor(engine({ is_destructive: 0.62 }));
    expect(await advisor.destructiveScore('maybe')).toBeCloseTo(0.62, 5);
  });
});