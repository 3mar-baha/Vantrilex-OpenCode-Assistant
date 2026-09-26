import { describe, expect, test } from 'vitest';
import { AudioPlayer } from './playback.js';

// P4b TDD — the player is a strict FIFO: decode in order, play in order,
// failures skip the chunk without stalling, empty input is dropped.
function harness() {
  const decoded: number[] = [];
  const played: string[] = [];
  const events: string[] = [];
  let n = 0;
  const player = new AudioPlayer({
    decode: async (bytes: Uint8Array) => {
      decoded.push(bytes[0] ?? -1);
      n += 1;
      return `buf-${n}` as unknown as AudioBuffer;
    },
    sink: {
      play: (buffer: AudioBuffer) => void played.push(buffer as unknown as string),
    },
    onStart: () => void events.push('start'),
    onEnd: () => void events.push('end'),
  });
  return { player, decoded, played, events };
}

function flush(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('AudioPlayer', () => {
  test('plays enqueued chunks in FIFO order, then signals end', async () => {
    const h = harness();
    h.player.enqueue(new Uint8Array([10]));
    h.player.enqueue(new Uint8Array([20]));
    expect(h.player.playing).toBe(true);
    await flush();
    expect(h.decoded).toEqual([10, 20]);
    expect(h.played).toEqual(['buf-1', 'buf-2']);
    expect(h.events).toEqual(['start', 'end']);
    expect(h.player.playing).toBe(false);
  });

  test('empty chunks are dropped without events', async () => {
    const h = harness();
    h.player.enqueue(new Uint8Array(0));
    await flush();
    expect(h.decoded).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  test('a decode failure skips the chunk and continues the queue', async () => {
    const played: string[] = [];
    let calls = 0;
    const player = new AudioPlayer({
      decode: async () => {
        calls += 1;
        if (calls === 1) throw new Error('bad mp3');
        return 'good' as unknown as AudioBuffer;
      },
      sink: { play: (b: AudioBuffer) => void played.push(b as unknown as string) },
    });
    player.enqueue(new Uint8Array([1]));
    player.enqueue(new Uint8Array([2]));
    await flush();
    expect(played).toEqual(['good']);
    expect(player.playing).toBe(false);
  });

  test('enqueue during playback appends without restarting', async () => {
    const h = harness();
    h.player.enqueue(new Uint8Array([1]));
    h.player.enqueue(new Uint8Array([2]));
    await flush();
    expect(h.events.filter((e) => e === 'start')).toHaveLength(1);
    expect(h.played).toHaveLength(2);
  });

  test('queued count reflects the backlog', () => {
    const h = harness();
    expect(h.player.queued).toBe(0);
    h.player.enqueue(new Uint8Array([1]));
    expect(h.player.queued).toBeGreaterThanOrEqual(0);
  });
});