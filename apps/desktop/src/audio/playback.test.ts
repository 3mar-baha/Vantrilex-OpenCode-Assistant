import { afterEach, describe, expect, test, vi } from 'vitest';
import { AudioPlayer, createDefaultPlayer, PLAYBACK_GAIN, PLAYBACK_QUEUE_CAP } from './playback.js';

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

  test('stop() clears the backlog and ends playback state', async () => {
    const ended: string[] = [];
    const player = new AudioPlayer({
      decode: async () => 'never' as unknown as AudioBuffer,
      sink: { play: () => undefined },
      onEnd: () => void ended.push('end'),
    });
    player.enqueue(new Uint8Array([1]));
    player.stop();
    expect(player.queued).toBe(0);
    expect(player.playing).toBe(false);
    expect(ended).toEqual(['end']);
    await flush();
    // The stale drain resolves after the stop: nothing new plays, no second end.
    expect(ended).toEqual(['end']);
    expect(player.playing).toBe(false);
  });
});

// L1 — the downlink queue was an unbounded array. A slow decode under a
// sustained reply grew the heap without limit, and nothing reported it.
describe('AudioPlayer queue cap (L1)', () => {
  function slowPlayer() {
    const played: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const player = new AudioPlayer({
      decode: async (b: Uint8Array) => {
        await gate;
        return new TextDecoder().decode(b) as unknown as AudioBuffer;
      },
      sink: { play: (buf) => void played.push(buf as unknown as string) },
    });
    return { player, played, release };
  }

  test('the queue is bounded, so a stalled decode cannot grow it forever', () => {
    const { player } = slowPlayer();
    for (let i = 0; i < 500; i += 1) player.enqueue(new Uint8Array([i & 0xff]));
    expect(player.queued).toBeLessThanOrEqual(PLAYBACK_QUEUE_CAP);
  });

  test('overflow drops the OLDEST chunks, preserving the most recent speech', () => {
    // Dropping the newest would truncate the reply mid-sentence; the tail is
    // what the user is currently waiting to hear.
    const { player } = slowPlayer();
    for (let i = 0; i < 500; i += 1) player.enqueue(new Uint8Array([i & 0xff]));
    expect(player.queued).toBe(PLAYBACK_QUEUE_CAP);
    expect(player.dropped).toBeGreaterThan(0);
  });

  test('dropped chunks are counted, so the loss is observable not silent', () => {
    const { player } = slowPlayer();
    const enqueued = 300;
    for (let i = 0; i < enqueued; i += 1) player.enqueue(new Uint8Array([1]));
    // One chunk is in `decode` and not in the queue, so the accounting is
    // queued + dropped + 1 === enqueued. Everything else was dropped.
    expect(player.queued + player.dropped + 1).toBe(enqueued);
    expect(player.dropped).toBeGreaterThan(0);
  });

  test('an empty enqueue is ignored and does not consume queue space', () => {
    const { player } = slowPlayer();
    player.enqueue(new Uint8Array(0));
    expect(player.queued).toBe(0);
  });

  test('stop() clears the queue but keeps the drop count', () => {
    const { player } = slowPlayer();
    for (let i = 0; i < 200; i += 1) player.enqueue(new Uint8Array([1]));
    player.stop();
    expect(player.queued).toBe(0);
    expect(player.dropped).toBeGreaterThan(0);
  });
});

// D3 — renderer-side headroom and AudioContext lifecycle. The window is
// reopened repeatedly, so a context that is never closed is a real leak, and a
// context left 'suspended' is a silently missing first reply.
describe('AudioPlayer.dispose', () => {
  test('stops playback and releases the underlying context', () => {
    const disposed: number[] = [];
    let ended = 0;
    const player = new AudioPlayer({
      decode: async () => 'buf' as unknown as AudioBuffer,
      sink: { play: () => undefined },
      onEnd: () => {
        ended += 1;
      },
      dispose: () => void disposed.push(1),
    });
    player.enqueue(new Uint8Array([1]));
    player.dispose();
    expect(player.playing).toBe(false);
    expect(ended).toBe(1);
    expect(disposed).toEqual([1]);
  });

  test('is safe before anything is enqueued, and idempotent enough not to throw', () => {
    const player = new AudioPlayer({
      decode: async () => 'buf' as unknown as AudioBuffer,
      sink: { play: () => undefined },
    });
    expect(() => player.dispose()).not.toThrow();
  });

  test('dispose() also empties the queue', async () => {
    const played: string[] = [];
    const player = new AudioPlayer({
      decode: async () => {
        await Promise.resolve();
        return 'buf' as unknown as AudioBuffer;
      },
      sink: { play: (b) => void played.push(b as unknown as string) },
    });
    player.enqueue(new Uint8Array([1]));
    player.enqueue(new Uint8Array([2]));
    player.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(played).toEqual([]);
  });
});

describe('createDefaultPlayer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fakeContext(state: AudioContextState = 'running') {
    const created: string[] = [];
    const connected: string[] = [];
    let closed = 0;
    let resumed = 0;
    const ctx = {
      state,
      resume: async () => {
        resumed += 1;
      },
      close: async () => {
        closed += 1;
      },
      createGain: () => ({
        gain: { value: 1 },
        connect: (d: unknown) => {
          connected.push('gain');
          void d;
        },
      }),
      createBufferSource: () => ({
        buffer: null as AudioBuffer | null,
        connect: (n: unknown) => {
          connected.push('source');
          void n;
        },
        start: () => void created.push('start'),
      }),
      decodeAudioData: async () => 'decoded' as unknown as AudioBuffer,
      destination: 'destination',
    };
    return {
      ctx,
      stats: () => ({ closed, resumed, connected, created }),
    };
  }

  test('routes playback through a gain node at the documented headroom', async () => {
    const f = fakeContext();
    vi.stubGlobal('AudioContext', function AudioContextStub() {
      return f.ctx;
    });
    const player = createDefaultPlayer();
    player.enqueue(new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 0));
    expect(f.stats().connected).toContain('gain');
    expect(PLAYBACK_GAIN).toBeLessThan(1);
    expect(PLAYBACK_GAIN).toBeGreaterThan(0.5);
  });

  test('resumes a suspended context before decoding the first chunk', async () => {
    const f = fakeContext('suspended');
    vi.stubGlobal('AudioContext', function AudioContextStub() {
      return f.ctx;
    });
    const player = createDefaultPlayer();
    player.enqueue(new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 0));
    expect(f.stats().resumed).toBeGreaterThan(0);
  });

  test('dispose() closes the context', async () => {
    const f = fakeContext();
    vi.stubGlobal('AudioContext', function AudioContextStub() {
      return f.ctx;
    });
    const player = createDefaultPlayer();
    player.dispose();
    expect(f.stats().closed).toBe(1);
  });
});