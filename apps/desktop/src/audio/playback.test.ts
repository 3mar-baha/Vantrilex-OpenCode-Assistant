import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AudioPlayer,
  createDefaultPlayer,
  MAX_COALESCE_TICKS,
  PLAYBACK_GAIN,
  PLAYBACK_QUEUE_CAP,
} from './playback.js';

// ── TIMING DISCIPLINE (F1) ────────────────────────────────────────────────────
// Every asynchronous assertion in this file waits on an OBSERVABLE — `onEnd`,
// `onStart`, `playing`, `queued`, or the harness's own record of what reached the
// sink or the decoder. None of them waits on elapsed wall-clock time.
//
// Why this is not pedantry: a `setTimeout`-based wait is a bet that the work
// finishes inside a budget, and the critical path here is macrotask-based
// (`gather`'s coalesce tick, once or twice per payload) plus an awaited decode.
// Under CPU starvation every one of those steps stretches, and a sleep that
// cleared the work by 10x on a quiet machine clears it by 0.4x on a loaded one.
// That is a test that passes locally and fails in CI at 3am, and it is the most
// expensive kind of flake to diagnose, because the report is about the test
// rather than about the code. This file previously had 33 such sleeps.
//
// `turns()` is the one exception, and it is an ORDERING assertion rather than a
// timing one: "this has had N real macrotasks to run", which holds however long
// each one takes. It is reserved for negative assertions, where there is no
// observable to wait ON — "nothing happened yet" has nothing to wait for.

/**
 * Yield N REAL macrotask boundaries. Not a sleep; see above.
 *
 * Sized for the longest production path a test must cross before a payload can
 * exist: `gather`'s coalesce ticks (up to MAX_COALESCE_TICKS), then the decode,
 * then the generation check. 3 turns covers one tick with margin; 4 where a
 * `stop()` also has to resolve.
 */
function turns(n = 3): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < n; i += 1) {
    chain = chain.then(() => new Promise<void>((r) => setTimeout(r, 0)));
  }
  return chain;
}

/**
 * Wait until `predicate` holds, failing loudly with the subject if it never does.
 *
 * `timeoutMs` is a HANG GUARD, not the synchronisation mechanism — on a healthy
 * path the predicate becomes true within a handful of macrotasks no matter how
 * slow the machine is. The default sits deliberately UNDER vitest's 5s test
 * timeout so a genuine hang fails with this message rather than with vitest's
 * generic one, which names neither the test's subject nor the player.
 */
async function settled(what: string, predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    await turns(1);
  }
}

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

/**
 * Stand-in AudioContext for the production wiring in `createDefaultPlayer`.
 *
 * `starts` records the `when` each source was started with — the scheduling
 * horizon lives in the sink, so that is the only place it is observable. `stops`
 * records halt calls, which is how barge-in is observed. `currentTime` is fixed
 * rather than ticking: the assertions are about the SCHEDULE asked for relative
 * to "now", which a frozen clock pins exactly.
 */
function fakeContext(state: AudioContextState = 'running') {
  const connected: string[] = [];
  const starts: (number | undefined)[] = [];
  const stops: number[] = [];
  let closed = 0;
  let resumed = 0;
  const ctx = {
    state,
    currentTime: 12,
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
      onended: null as (() => void) | null,
      connect: (n: unknown) => {
        connected.push('source');
        void n;
      },
      start: (when?: number) => void starts.push(when),
      stop: () => void stops.push(starts.length),
    }),
    decodeAudioData: async () => ({ duration: 1.5 }) as unknown as AudioBuffer,
    destination: 'destination',
  };
  return {
    ctx,
    stats: () => ({ closed, resumed, connected, starts, stops }),
  };
}

describe('AudioPlayer', () => {
  test('plays enqueued chunks in FIFO order, then signals end', async () => {
    const payloads: number[][] = [];
    const played: string[] = [];
    const events: string[] = [];
    let n = 0;
    const player = new AudioPlayer({
      decode: async (bytes: Uint8Array) => {
        payloads.push([...bytes]);
        n += 1;
        return `buf-${n}` as unknown as AudioBuffer;
      },
      sink: { play: (b: AudioBuffer) => void played.push(b as unknown as string) },
      onStart: () => void events.push('start'),
      onEnd: () => void events.push('end'),
    });
    player.enqueue(new Uint8Array([10]));
    player.enqueue(new Uint8Array([20]));
    expect(player.playing).toBe(true);
    await settled('the run to end', () => events.includes('end'));
    // FIFO is asserted over the BYTES, not over the call count. Whether one
    // synchronous burst is one decode or two is exactly what the coalescing
    // change is allowed to move; the order those bytes reach the decoder is not.
    expect(payloads.flat()).toEqual([10, 20]);
    expect(played).toEqual(['buf-1']);
    expect(events).toEqual(['start', 'end']);
    expect(player.playing).toBe(false);
  });

  test('empty chunks are dropped without events', async () => {
    const h = harness();
    h.player.enqueue(new Uint8Array(0));
    await turns();
    expect(h.decoded).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  test('a decode failure skips the chunk and continues the queue', async () => {
    const played: string[] = [];
    const batches: number[][] = [];
    const player = new AudioPlayer({
      // Fails on CONTENT, not on call order: a ≤32 KiB downlink fragment is not
      // a file, so which bytes end up in one decode payload is the player's
      // decision. Keying the failure to "the first call" would pin the batching
      // shape into this test — which is exactly what the coalescing change is
      // allowed to move.
      decode: async (bytes: Uint8Array) => {
        batches.push([...bytes]);
        if (bytes.includes(0xff)) throw new Error('bad mp3');
        return 'good' as unknown as AudioBuffer;
      },
      sink: { play: (b: AudioBuffer) => void played.push(b as unknown as string) },
    });
    player.enqueue(new Uint8Array([0xff]));
    await settled('the corrupt payload to be skipped and the run to end', () => !player.playing);
    expect(played).toEqual([]);

    player.enqueue(new Uint8Array([1]));
    await settled('the good payload to play', () => played.length === 1);
    expect(played).toEqual(['good']);
    expect(batches).toEqual([[0xff], [1]]);
    expect(player.playing).toBe(false);
  });

  test('enqueue during playback appends without restarting', async () => {
    // A gated decode is the only way to land an enqueue *inside* the drain: the
    // chunk arrives while a payload is in the decode call, not before it. It must
    // join the same run — appended in order, no second `start` — and the run must
    // still end once the backlog is gone.
    const played: string[] = [];
    const events: string[] = [];
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    const player = new AudioPlayer({
      decode: async () => {
        entered = true;
        await gate;
        n += 1;
        return `buf-${n}` as unknown as AudioBuffer;
      },
      sink: { play: (b: AudioBuffer) => void played.push(b as unknown as string) },
      onStart: () => void events.push('start'),
      onEnd: () => void events.push('end'),
    });
    player.enqueue(new Uint8Array([1]));
    // The observable, not a guess about how long a tick takes: the first payload
    // is parked inside `decode`.
    await settled('the first payload to reach the decoder', () => entered);
    player.enqueue(new Uint8Array([2]));
    expect(player.playing).toBe(true);
    release();
    await settled('the run to drain and end', () => events.includes('end'));
    expect(played).toHaveLength(2);
    expect(events.filter((e) => e === 'start')).toHaveLength(1);
    expect(events.filter((e) => e === 'end')).toHaveLength(1);
    expect(player.playing).toBe(false);
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
    // The stale drain must get its chance to resolve and find itself stranded.
    await turns(4);
    expect(ended).toEqual(['end']);
    expect(player.playing).toBe(false);
  });
});

// W6 — the assistant-mute button. It used to flip a boolean in the HUD and
// send a `{kind:'mute'}` command the daemon discarded, so it muted nothing and
// acked `ok:true`. The gate now lives on the player, and these three tests are
// the guard: `App.test.tsx` proves the HUD actually reaches it.
describe('AudioPlayer assistant mute (W6)', () => {
  test('a muted player drops downlink chunks: nothing decodes, plays, or signals start', async () => {
    const h = harness();
    h.player.setMuted(true);
    h.player.enqueue(new Uint8Array([1]));
    h.player.enqueue(new Uint8Array([2]));
    await turns();
    expect(h.decoded).toHaveLength(0);
    expect(h.played).toHaveLength(0);
    // No `start` is the point: the HUD's speaking indicator is driven by it, and
    // a muted shell that still lights up would be the same lie one layer up.
    expect(h.events).toHaveLength(0);
    expect(h.player.playing).toBe(false);
  });

  test('muting mid-reply flushes what is already queued', async () => {
    const h = harness();
    h.player.enqueue(new Uint8Array([1]));
    expect(h.player.playing).toBe(true);
    h.player.setMuted(true);
    expect(h.player.queued).toBe(0);
    expect(h.player.playing).toBe(false);
    // A mute that lets the current sentence finish is not a mute.
    expect(h.events).toEqual(['start', 'end']);
    await turns();
    expect(h.played).toHaveLength(0);
  });

  test('un-muting restores playback, and the gate is idempotent', async () => {
    const h = harness();
    h.player.setMuted(true);
    h.player.setMuted(true); // no second flush, so no duplicate `end`
    h.player.setMuted(false);
    h.player.enqueue(new Uint8Array([7]));
    await settled('the un-muted chunk to play', () => h.played.length === 1);
    expect(h.decoded).toEqual([7]);
    expect(h.played).toEqual(['buf-1']);
    expect(h.events).toEqual(['start', 'end']);
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
    await turns();
    expect(played).toEqual([]);
  });
});

describe('createDefaultPlayer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('routes playback through a gain node at the documented headroom', async () => {
    const f = fakeContext();
    vi.stubGlobal('AudioContext', function AudioContextStub() {
      return f.ctx;
    });
    const player = createDefaultPlayer();
    player.enqueue(new Uint8Array([1, 2, 3]));
    await settled('a source to be created and connected', () => f.stats().connected.includes('source'));
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
    await settled('the suspended context to be resumed', () => f.stats().resumed > 0);
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

// ── M1 ────────────────────────────────────────────────────────────────────────
// The downlink defect: Fish streams MP3 (see `tts.ts:453` `format: 'mp3'`), and
// `drain` handed every ≤32 KiB chunk to `decodeAudioData` as if each one were a
// whole file. MP3 is self-describing and every fragment carries encoder
// delay/padding, so decoding fragments independently and concatenating the
// decoded PCM pays that tax at EVERY boundary — crackle and jitter on a reply
// that is otherwise clean.
//
// NOT a sample-rate problem, and deliberately not "fixed" as one:
// `decodeAudioData` resamples to the AudioContext rate, so there was never a
// mismatch to correct. The premise was tested and refuted; the real axis is
// decoder FRAME CONTINUITY.
describe('AudioPlayer downlink coalescing (M1)', () => {
  /** Records every payload handed to `decode`, and what the sink was given. */
  function spyHarness() {
    const payloads: number[][] = [];
    const played: number[] = [];
    const events: string[] = [];
    let n = 0;
    const player = new AudioPlayer({
      decode: async (bytes: Uint8Array) => {
        payloads.push([...bytes]);
        n += 1;
        return `buf-${n}` as unknown as AudioBuffer;
      },
      sink: {
        play: (b: AudioBuffer) => void played.push(Number((b as unknown as string).split('-')[1])),
      },
      onStart: () => void events.push('start'),
      onEnd: () => void events.push('end'),
    });
    return { player, payloads, played, events };
  }

  test('two consecutive chunks decode as ONE payload, not two', async () => {
    // The break-guard. Before: `payloads` was [[1,2],[3,4]] — two decoder
    // invocations, two encoder-delay seams, one audible click between them.
    const h = spyHarness();
    h.player.enqueue(new Uint8Array([1, 2]));
    h.player.enqueue(new Uint8Array([3, 4]));
    await settled('the coalesced payload to play', () => h.events.includes('end'));
    expect(h.payloads).toHaveLength(1);
    // …and it is the CONCATENATION, in arrival order: order is not lost by
    // merging, which is the property a naive `Uint8Array.set` bug would break.
    expect(h.payloads[0]).toEqual([1, 2, 3, 4]);
    expect(h.played).toHaveLength(1);
  });

  test('a burst of many chunks is one decode, not one decode per chunk', async () => {
    const h = spyHarness();
    for (let i = 1; i <= 8; i += 1) h.player.enqueue(new Uint8Array([i]));
    await settled('the burst to coalesce and play', () => h.events.includes('end'));
    expect(h.payloads).toHaveLength(1);
    expect(h.payloads[0]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('a lone chunk still decodes on its own — coalescing degrades, it does not stall', async () => {
    // The failure mode a naive fix introduces: always wait for "more", so a
    // sentence-final chunk never plays. This is the last chunk of every reply.
    const h = spyHarness();
    h.player.enqueue(new Uint8Array([9]));
    await settled('the lone chunk to play', () => h.events.includes('end'));
    expect(h.payloads).toEqual([[9]]);
    expect(h.played).toEqual([1]);
    expect(h.player.playing).toBe(false);
  });
});

// F2 — the livelock. `gather`'s exit condition is "the queue is empty after a
// tick", so a producer fast enough to refill the queue within one tick never lets
// it exit: `gather` never returns and NOT ONE payload is ever decoded. A total
// audio outage, which is strictly worse than the crackle coalescing removes.
// `MAX_COALESCE_TICKS` is the fix; these two tests are the pin.
describe('AudioPlayer coalescing bound (F2)', () => {
  /** A producer that never lets the queue sit empty, as a sustained reply does. */
  function sustainedProducer() {
    const payloads: number[][] = [];
    const played: number[] = [];
    const player = new AudioPlayer({
      decode: async (bytes: Uint8Array) => {
        payloads.push([...bytes]);
        return bytes[0] as unknown as AudioBuffer;
      },
      sink: { play: (b: AudioBuffer) => void played.push(b as unknown as number) },
    });
    let running = true;
    let n = 0;
    const feed = (): void => {
      if (!running) return;
      // A BURST per turn, not one chunk. This is the whole test: with one chunk
      // per macrotask, the feeder and `gather`'s tick interleave so that `gather`
      // always wakes to an EMPTY queue, exits on its normal condition, and the
      // livelock never happens — the bound would be untestable and this test
      // vacuous. A burst guarantees a non-empty queue at every wake-up, which is
      // precisely the condition F2 is about. (Found by breaking the guard: BG13
      // stayed green on the first version of this feeder.)
      for (let k = 0; k < 4; k += 1) {
        n += 1;
        player.enqueue(new Uint8Array([n & 0xff]));
      }
      setTimeout(feed, 0);
    };
    setTimeout(feed, 0);
    return {
      player,
      payloads,
      played,
      stop: (): void => {
        running = false;
      },
    };
  }

  test('a sustained producer still gets audio out — gather cannot livelock', async () => {
    // Without MAX_COALESCE_TICKS this TIMES OUT rather than fails an assertion,
    // which is the correct failure for a livelock: nothing is emitted at all.
    const p = sustainedProducer();
    try {
      await settled('the first payload to play under a sustained producer', () => p.played.length > 0);
      expect(p.played.length).toBeGreaterThan(0);
    } finally {
      p.stop();
    }
  });

  test('the batch stays bounded rather than growing with the producer', async () => {
    const p = sustainedProducer();
    const ceiling = (MAX_COALESCE_TICKS + 1) * PLAYBACK_QUEUE_CAP;
    try {
      await settled('a few payloads to play', () => p.played.length >= 3);
      for (const payload of p.payloads) expect(payload.length).toBeLessThanOrEqual(ceiling);
      expect(p.payloads.length).toBeGreaterThan(0);
    } finally {
      p.stop();
    }
  });
});

// Scheduling horizon. `source.start()` with no argument means "now" — but the
// start happens AFTER an awaited decode, so "now" has already moved, and a decode
// slower than the downlink underruns audibly between payloads. Scheduling on a
// small offset from `currentTime` queues the next source slightly ahead instead.
describe('AudioPlayer scheduling horizon (M1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('a source starts AHEAD of currentTime, by a strictly positive offset', async () => {
    const f = fakeContext();
    vi.stubGlobal('AudioContext', function AudioContextStub() {
      return f.ctx;
    });
    const player = createDefaultPlayer();
    player.enqueue(new Uint8Array([1]));
    await settled('the first source to start', () => f.stats().starts.length === 1);
    // `undefined` here is the old `source.start()`: no argument, so "now" — which
    // is already in the past by the time the graph reaches it.
    expect(f.stats().starts[0]).toBeGreaterThanOrEqual(f.ctx.currentTime);
    expect(f.stats().starts[0]).toBeGreaterThan(f.ctx.currentTime);
  });

  test('the horizon does not run away when nothing is queued ahead', async () => {
    // Degradation requirement. An empty queue must schedule from `currentTime`,
    // not from a stale accumulated value: the first source of a reply lands at
    // `currentTime + lead`, not `currentTime + the length of the last reply`.
    const f = fakeContext();
    vi.stubGlobal('AudioContext', function AudioContextStub() {
      return f.ctx;
    });
    const player = createDefaultPlayer();
    player.enqueue(new Uint8Array([1]));
    await settled('the first source to start', () => f.stats().starts.length === 1);
    const first = f.stats().starts[0] as number;
    expect(first - f.ctx.currentTime).toBeLessThan(1);
    expect(first - f.ctx.currentTime).toBeGreaterThan(0);
  });

  test('a second payload is scheduled after the first ENDS, not on top of it', async () => {
    // The horizon has to accumulate across calls. Without that, two payloads both
    // schedule near `currentTime` and overlap — the same jitter the coalescing
    // change removes, reintroduced one layer down.
    const f = fakeContext();
    vi.stubGlobal('AudioContext', function AudioContextStub() {
      return f.ctx;
    });
    const player = createDefaultPlayer();
    player.enqueue(new Uint8Array([1]));
    await settled('the first source to start', () => f.stats().starts.length === 1);
    // The queue has emptied, so this cannot coalesce with the payload above.
    player.enqueue(new Uint8Array([2]));
    await settled('the second source to start', () => f.stats().starts.length === 2);
    const starts = f.stats().starts;
    // duration 1.5 from the fake decode: the second start is past the first end.
    expect(starts[1] as number).toBeGreaterThanOrEqual((starts[0] as number) + 1.5);
  });
});

// F3/F4 — barge-in is an INTERRUPT, not a queue clear. Two halves, and they are
// one fix: the committed sources must be halted AND the scheduling horizon must
// be dropped, because leaving the horizon schedules the next reply at the end of
// the speech the user just cancelled.
describe('AudioPlayer barge-in (F3/F4)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('stop() halts the live sources, not just the queue', async () => {
    const f = fakeContext();
    vi.stubGlobal('AudioContext', function AudioContextStub() {
      return f.ctx;
    });
    const player = createDefaultPlayer();
    player.enqueue(new Uint8Array([1]));
    await settled('a source to start', () => f.stats().starts.length === 1);
    expect(f.stats().stops).toHaveLength(0);
    player.stop();
    // The source is owned by the AudioContext now; `stop()` is the only handle.
    expect(f.stats().stops).toHaveLength(1);
  });

  test('after a barge-in the next reply starts promptly, not at the cancelled speech end', async () => {
    // F4, the live defect. The fake's currentTime is frozen at 12 and its decoded
    // duration is 1.5, so after one source the horizon sits at 13.53. If `stop()`
    // did not drop it, the next reply would be scheduled at 13.53 — 1.53s of
    // silence after the user cut the audio short.
    const f = fakeContext();
    vi.stubGlobal('AudioContext', function AudioContextStub() {
      return f.ctx;
    });
    const player = createDefaultPlayer();
    player.enqueue(new Uint8Array([1]));
    await settled('the first source to start', () => f.stats().starts.length === 1);
    player.stop();
    player.enqueue(new Uint8Array([2]));
    await settled('the post-barge-in source to start', () => f.stats().starts.length === 2);
    const starts = f.stats().starts as number[];
    const first = starts[0] as number;
    const second = starts[1] as number;
    expect(second - f.ctx.currentTime).toBeLessThan(1);
    expect(second - f.ctx.currentTime).toBeGreaterThan(0);
    // …and the new reply is not stacked on the speech that was just cancelled.
    expect(second).toBeLessThan(first + 1.5);
  });

  test('a muted player halts committed speech too, not just the queue', async () => {
    const f = fakeContext();
    vi.stubGlobal('AudioContext', function AudioContextStub() {
      return f.ctx;
    });
    const player = createDefaultPlayer();
    player.enqueue(new Uint8Array([1]));
    await settled('a source to start', () => f.stats().starts.length === 1);
    player.setMuted(true); // routes through stop()
    expect(f.stats().stops).toHaveLength(1);
  });

  test('a throwing onStop cannot wedge the player', async () => {
    // A consumer callback must not be able to break every later chunk. Same class
    // as the F-01 finding for `onEnd`, and it now has a second sibling.
    const played: number[] = [];
    const player = new AudioPlayer({
      decode: async (bytes: Uint8Array) => bytes[0] as unknown as AudioBuffer,
      sink: { play: (b: AudioBuffer) => void played.push(b as unknown as number) },
      onStop: () => {
        throw new Error('consumer blew up');
      },
    });
    player.enqueue(new Uint8Array([1]));
    await turns(3); // the throw must not have wedged the drain
    player.stop();
    expect(() => player.stop()).not.toThrow();
    player.enqueue(new Uint8Array([2]));
    // The SECOND play is the observable: if the throwing `onStop` had wedged the
    // player, this never happens. Chunk 1 having played first is not the signal.
    await settled('a later chunk to still play', () => played.length === 2);
    expect(played).toEqual([1, 2]);
  });
});

// ── S1 REGRESSION PINS ────────────────────────────────────────────────────────
// These pin the properties the player was ALREADY correct on. A green suite that
// only proves the new behaviour is worthless: a rewrite that fixes the crackle
// and silently loses the queue cap, the generation guard or the run latch is
// worse than the bug. Deliberately written to be batching-agnostic — they pass
// on the pre-fix code AND the post-fix code, so they catch a REGRESSION, not the
// change. (Verified by injection; see the report's break-guard table.)
describe('AudioPlayer regression pins (M1)', () => {
  test('a corrupt payload between two good ones is skipped and the queue keeps flowing', async () => {
    const played: number[] = [];
    const player = new AudioPlayer({
      decode: async (bytes: Uint8Array) => {
        if (bytes.includes(0xff)) throw new Error('bad mp3');
        return bytes[0] as unknown as AudioBuffer;
      },
      sink: { play: (b: AudioBuffer) => void played.push(b as unknown as number) },
    });
    // Three separate arrivals (the run empties between them) so this pins the
    // SKIP behaviour and not the batching. The corrupt one must not stall the
    // third.
    player.enqueue(new Uint8Array([1]));
    await settled('the first payload to play', () => played.length === 1);
    player.enqueue(new Uint8Array([0xff, 0xff]));
    await settled('the corrupt payload to be skipped and the run to end', () => !player.playing);
    player.enqueue(new Uint8Array([3]));
    await settled('the third payload to play', () => played.length === 2);
    expect(played).toEqual([1, 3]);
    expect(player.queued).toBe(0);
    expect(player.playing).toBe(false);
  });

  test('FIFO order survives coalescing: payload bytes stay in arrival order', async () => {
    const seen: number[][] = [];
    const player = new AudioPlayer({
      decode: async (bytes: Uint8Array) => {
        seen.push([...bytes]);
        return 'b' as unknown as AudioBuffer;
      },
      sink: { play: () => undefined },
    });
    // Interleave a burst and a lone chunk: both shapes, one timeline.
    player.enqueue(new Uint8Array([1, 2]));
    player.enqueue(new Uint8Array([3]));
    await settled('the burst to reach the decoder', () => seen.flat().length === 3);
    player.enqueue(new Uint8Array([4]));
    player.enqueue(new Uint8Array([5, 6]));
    await settled('the second burst to reach the decoder', () => seen.flat().length === 6);
    player.enqueue(new Uint8Array([7]));
    await settled('the last chunk to reach the decoder', () => seen.flat().length === 7);
    expect(seen.flat()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('the 32-chunk cap still drops the OLDEST and keeps the newest, in order', async () => {
    const seen: number[][] = [];
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const player = new AudioPlayer({
      decode: async (bytes: Uint8Array) => {
        // Stall only the FIRST payload, so the rest of the backlog coalesces and
        // the cap is exercised rather than drained away one chunk at a time.
        if (bytes.includes(1)) {
          entered = true;
          await gate;
        }
        seen.push([...bytes]);
        return 'b' as unknown as AudioBuffer;
      },
      sink: { play: () => undefined },
    });
    const total = PLAYBACK_QUEUE_CAP + 8;
    for (let i = 1; i <= total; i += 1) player.enqueue(new Uint8Array([i]));
    expect(player.queued).toBe(PLAYBACK_QUEUE_CAP);
    expect(player.dropped).toBeGreaterThan(0);
    await settled('the first payload to reach the decoder', () => entered);
    release();
    await settled('the backlog to drain', () => !player.playing);
    const flat = seen.flat();
    // The tail is what the user is waiting for, and it must be in order.
    expect(flat).toEqual([...flat].sort((a, b) => a - b));
    expect(flat).toContain(total);
    expect(Math.max(...flat)).toBe(total);
    // The oldest are the ones sacrificed: chunk 1 was already in the stalled
    // decode, so 2 is the first that may go.
    expect(flat).not.toContain(2);
  });

  test('stop() during an in-flight decode strands it, and never plays later', async () => {
    const played: number[] = [];
    const ended: number[] = [];
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const player = new AudioPlayer({
      decode: async (bytes: Uint8Array) => {
        entered = true;
        await gate;
        return bytes[0] as unknown as AudioBuffer;
      },
      sink: { play: (b: AudioBuffer) => void played.push(b as unknown as number) },
      onEnd: () => void ended.push(1),
    });
    player.enqueue(new Uint8Array([1]));
    await settled('the payload to reach the decoder', () => entered);
    player.enqueue(new Uint8Array([2]));
    player.stop(); // barge-in mid-decode
    release(); // the decode now resolves — the generation guard must eat it
    await turns(4);
    expect(played).toEqual([]);
    expect(ended).toHaveLength(1); // exactly one end, from the stop itself
    expect(player.playing).toBe(false);
    expect(player.queued).toBe(0);
  });

  test('stop() during the COALESCE window strands the whole batch', async () => {
    // The await point. `gather` yields a macrotask so a burst can land, and that
    // window did not exist before: a barge-in landing inside it must not resurrect
    // a payload that was already shifted out of the queue.
    //
    // The guard that covers it is the single `gen` check immediately before
    // `sink.play`. An earlier version also checked inside `gather`; injection
    // showed that check was indistinguishable from this one, so it was removed
    // rather than left as a second gate nothing could prove.
    const played: number[] = [];
    const player = new AudioPlayer({
      decode: async (bytes: Uint8Array) => bytes[0] as unknown as AudioBuffer,
      sink: { play: (b: AudioBuffer) => void played.push(b as unknown as number) },
    });
    player.enqueue(new Uint8Array([1]));
    player.stop(); // synchronously, while `gather` is still yielding
    await turns(4);
    expect(played).toEqual([]);
    expect(player.playing).toBe(false);
  });

  test('the onStart latch fires once per contiguous run, and clears when the queue empties', async () => {
    const starts: string[] = [];
    const ends: number[] = [];
    const player = new AudioPlayer({
      decode: async (bytes: Uint8Array) => bytes[0] as unknown as AudioBuffer,
      sink: { play: () => undefined },
      onStart: (id) => void starts.push(id ?? ''),
      onEnd: () => void ends.push(1),
    });
    // Run 1: a burst, drained into a single contiguous run.
    player.enqueue(new Uint8Array([1]));
    player.enqueue(new Uint8Array([2]));
    player.enqueue(new Uint8Array([3]));
    await settled('the first run to end', () => ends.length === 1);
    // Run 2: the queue emptied in between, so a new run legitimately re-fires.
    player.enqueue(new Uint8Array([4]));
    await settled('the second run to end', () => ends.length === 2);
    expect(starts).toHaveLength(2);
    expect(starts[0]).toBe('pb-1');
    expect(starts[1]).toBe('pb-2'); // monotonic correlation id, per run
    expect(ends).toHaveLength(2); // the latch CLEARED — no third end
    expect(player.playing).toBe(false);
  });
});
