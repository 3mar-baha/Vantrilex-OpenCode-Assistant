import { describe, expect, test } from 'vitest';
import { AudioIngest, WINDOW_BYTES } from '../voice/ingest.js';
import { AudioPipeline } from './audio-pipeline.js';

// P4 TDD — ingest → transcribe → think → dispatch-if-active. Silence never
// spends a brain call; no active session means no dispatch (no fabrication).
function windowOf(fill: number): Uint8Array {
  return new Uint8Array(WINDOW_BYTES).fill(fill);
}

describe('AudioPipeline', () => {
  test('full loop: transcript → reply → dispatch receipt', async () => {
    const calls: string[] = [];
    const utterances: unknown[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async (pcm) => {
        calls.push(`transcribe:${pcm.byteLength}`);
        return 'live harness ping';
      },
      think: async (text) => {
        calls.push(`think:${text}`);
        return { reply: 'تمام' };
      },
      dispatch: async (text) => {
        calls.push(`dispatch:${text}`);
        return { receipt: 'msg_1' };
      },
      activeSessionId: () => 'ses_a' as never,
      onUtterance: (u) => void utterances.push(u),
    });
    await pipeline.pushChunk(windowOf(4));
    expect(calls).toEqual(['transcribe:160000', 'think:live harness ping', 'dispatch:live harness ping']);
    expect(utterances).toEqual([{ transcript: 'live harness ping', reply: 'تمام', receipt: 'msg_1' }]);
  });

  test('silence spends nothing downstream', async () => {
    const calls: string[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => {
        calls.push('transcribe');
        return '   ';
      },
      think: async () => {
        calls.push('think');
        return { reply: 'x' };
      },
      dispatch: async () => {
        calls.push('dispatch');
        return { receipt: 'x' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    await pipeline.pushChunk(windowOf(0));
    expect(calls).toEqual(['transcribe']);
  });

  test('no active session means think but no dispatch', async () => {
    const calls: string[] = [];
    const utterances: unknown[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'hello',
      think: async () => {
        calls.push('think');
        return { reply: 'hi' };
      },
      dispatch: async () => {
        calls.push('dispatch');
        return { receipt: 'x' };
      },
      activeSessionId: () => undefined,
      onUtterance: (u) => void utterances.push(u),
    });
    await pipeline.pushChunk(windowOf(2));
    expect(calls).toEqual(['think']);
    expect(utterances).toEqual([{ transcript: 'hello', reply: 'hi', receipt: null }]);
  });

  test('partial windows accumulate without downstream calls', async () => {
    let transcribes = 0;
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => {
        transcribes += 1;
        return 'x';
      },
      think: async () => ({ reply: 'x' }),
      dispatch: async () => ({ receipt: 'x' }),
      activeSessionId: () => undefined,
    });
    await pipeline.pushChunk(new Uint8Array(3200));
    expect(transcribes).toBe(0);
    expect(pipeline.bufferedBytes).toBe(3200);
  });

  test('downstream errors surface, later chunks still flow', async () => {
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'ok',
      think: async () => {
        throw new Error('brain down');
      },
      dispatch: async () => ({ receipt: 'x' }),
      activeSessionId: () => undefined,
    });
    await expect(pipeline.pushChunk(windowOf(1))).rejects.toThrow('brain down');
    expect(pipeline.bufferedBytes).toBe(0);
  });
});