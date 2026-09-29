import { describe, expect, test } from 'vitest';
import {
  AudioIngest,
  bytesToFloat32,
  isLoudWindow,
  MAX_BUFFERED_BYTES,
  PAUSE_BYTES,
  RESUME_BYTES,
  WINDOW_BYTES,
  SPEECH_GATE_DB,
  windowRmsDb,
} from './ingest.js';

// P4 TDD — PCM windowing: 100 ms Int16 chunks accumulate into exact 5 s
// windows; remainder is kept; overflow is dropped (bounded memory).
describe('AudioIngest', () => {
  test('window size matches 5 s of 16 kHz mono Int16', () => {
    expect(WINDOW_BYTES).toBe(160_000);
  });

  test('fifty 3200-byte chunks emit exactly one window', () => {
    const ingest = new AudioIngest();
    const emitted: Uint8Array[] = [];
    for (let i = 0; i < 50; i += 1) {
      const chunk = new Uint8Array(3200).fill(i % 256);
      for (const w of ingest.push(chunk)) emitted.push(w);
    }
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.byteLength).toBe(WINDOW_BYTES);
    // First bytes come from the first chunk.
    expect(emitted[0]![0]).toBe(0);
    expect(emitted[0]![3200]).toBe(1);
  });

  test('remainder is kept across pushes and completes the next window', () => {
    const ingest = new AudioIngest();
    const first = ingest.push(new Uint8Array(100_000).fill(9));
    expect(first).toHaveLength(0);
    const second = ingest.push(new Uint8Array(100_000).fill(7));
    expect(second).toHaveLength(1);
    expect(second[0]!.byteLength).toBe(WINDOW_BYTES);
    // 40_000 bytes remain buffered; 120_000 more completes window two.
    const third = ingest.push(new Uint8Array(120_000).fill(3));
    expect(third).toHaveLength(1);
  });

  test('overflow beyond the buffer cap is dropped and counted', () => {
    const ingest = new AudioIngest();
    const windows: Uint8Array[] = [];
    // 8 windows worth at once: 6 windows + remainder, 2 windows dropped.
    for (const w of ingest.push(new Uint8Array(WINDOW_BYTES * 8))) windows.push(w);
    expect(windows).toHaveLength(6);
    expect(ingest.droppedWindows).toBe(2);
    expect(ingest.bufferedBytes).toBeLessThanOrEqual(WINDOW_BYTES * 6 + WINDOW_BYTES);
  });

  test('empty and odd-sized chunks are tolerated', () => {
    const ingest = new AudioIngest();
    expect(ingest.push(new Uint8Array(0))).toHaveLength(0);
    expect(ingest.push(new Uint8Array(7))).toHaveLength(0);
    expect(ingest.bufferedBytes).toBe(7);
  });
});

// D1 TDD — the silence gate. Room tone must never reach the STT provider:
// Whisper hallucinates on ambient noise, the brain reasons about the invented
// text, and the assistant answers it. Energy is the cheap, model-free gate;
// Silero (src/runtime/vad.ts) is the optional upgrade injected by the daemon.

/** A 5 s window of a 440 Hz tone at a speech-like level (-12 dBFS). */
function toneWindow(amplitude: number): Uint8Array {
  const samples = new Int16Array(WINDOW_BYTES / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 16_000));
  }
  return new Uint8Array(samples.buffer);
}

describe('windowRmsDb', () => {
  test('digital silence floors at -100 dBFS', () => {
    expect(windowRmsDb(new Uint8Array(WINDOW_BYTES))).toBe(-100);
    expect(windowRmsDb(new Uint8Array(0))).toBe(-100);
  });

  test('a full-scale square is 0 dBFS, not NaN', () => {
    const loud = new Int16Array(1000).fill(32767);
    expect(windowRmsDb(new Uint8Array(loud.buffer))).toBeCloseTo(0, 3);
  });

  test('a sine measures 3.01 dB below its own peak amplitude', () => {
    // A full-scale sine peaks at 0 dBFS but its RMS is peak/√2 = -3.01 dBFS.
    // This pins the measurement against a closed-form answer, not a fudge band.
    const db = windowRmsDb(toneWindow(32_767));
    expect(db).toBeCloseTo(-3.0103, 2);
  });

  test('halving the peak amplitude drops the RMS by 6.02 dB', () => {
    const loud = windowRmsDb(toneWindow(16_000));
    const quiet = windowRmsDb(toneWindow(8_000));
    expect(loud - quiet).toBeCloseTo(6.0206, 2);
  });

  test('odd byte lengths are tolerated (no exception, no NaN)', () => {
    expect(Number.isFinite(windowRmsDb(new Uint8Array(7)))).toBe(true);
  });
});

describe('isLoudWindow', () => {
  test('digital silence is gated out', () => {
    expect(isLoudWindow(new Uint8Array(WINDOW_BYTES))).toBe(false);
  });

  test('room tone below the gate is gated out', () => {
    // -45 dBFS: audible background hiss, not speech.
    expect(isLoudWindow(toneWindow(Math.round(32768 * 0.0056)))).toBe(false);
  });

  test('speech-level audio passes', () => {
    expect(isLoudWindow(toneWindow(Math.round(32768 * 0.25)))).toBe(true);
  });

  test('the gate matches the renderer barge-in threshold (-30 dBFS)', () => {
    expect(SPEECH_GATE_DB).toBe(-30);
  });
});

describe('L7 bufferedBytes is exact', () => {
  test('reports the true pending byte count at every step', () => {
    // L7: the accumulator reported a stale high-water mark, so
    // `bufferedBytes` was not a usable backpressure signal.
    const ingest = new AudioIngest();
    expect(ingest.bufferedBytes).toBe(0);
    ingest.push(new Uint8Array(1000));
    expect(ingest.bufferedBytes).toBe(1000);
    ingest.push(new Uint8Array(2000));
    expect(ingest.bufferedBytes).toBe(3000);
    const windows = ingest.push(new Uint8Array(WINDOW_BYTES - 3000));
    expect(windows).toHaveLength(1);
    expect(ingest.bufferedBytes).toBe(0);
  });

  test('incremental 100 ms chunks never shed; only a burst past the cap does', () => {
    // L7: the accumulator copied the whole buffer on every push. The contract
    // that matters is (a) memory stays bounded and (b) the pending count stays
    // truthful. Incremental chunks complete windows promptly, so the shed path
    // is reserved for a burst that would otherwise exceed the cap.
    const incremental = new AudioIngest();
    for (let i = 0; i < 400; i += 1) incremental.push(new Uint8Array(3200));
    expect(incremental.droppedWindows).toBe(0);
    expect(incremental.bufferedBytes).toBeLessThan(WINDOW_BYTES);

    const burst = new AudioIngest();
    const emitted = burst.push(new Uint8Array(WINDOW_BYTES * 8));
    expect(emitted).toHaveLength(6);
    expect(burst.droppedWindows).toBe(2);
    expect(burst.bufferedBytes).toBeLessThanOrEqual(WINDOW_BYTES);
  });

  test('window boundaries survive the chunked path unchanged', () => {
    // Same geometry as before, so the 5 s STT window contract is preserved.
    const a = new AudioIngest();
    for (let i = 0; i < 50; i += 1) for (const w of a.push(new Uint8Array(3200).fill(7))) void w;
    expect(a.bufferedBytes).toBe(0);

    const b = new AudioIngest();
    const emitted: Uint8Array[] = [];
    for (let i = 0; i < 50; i += 1) for (const w of b.push(new Uint8Array(3200).fill(i % 256))) emitted.push(w);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]![0]).toBe(0);
    expect(emitted[0]![3200]).toBe(1);
  });

  test('reset() empties the buffer and its counters', () => {
    const ingest = new AudioIngest();
    ingest.push(new Uint8Array(5000));
    ingest.reset();
    expect(ingest.bufferedBytes).toBe(0);
  });
});

// M3 B.3 — backpressure watermarks. `PAUSE_BYTES`/`RESUME_BYTES` are the
// transport-blind signal that the shell stops sending PCM; the accumulator never
// learns what the transport did with it. The four guards below exist because a
// bug in this state machine DEADLOCKS the uplink: a shell that is paused and
// never told to resume sends nothing, and a daemon that is paused and never
// told to stop is buffering audio nobody transcribes.
//
// Reverting the `paused` flag in `push` (level-triggered, or no flag at all)
// fails guard 1. Collapsing the two thresholds into one fails guard 2. Removing
// the `paused = false` on `reset` fails guard 3. Raising PAUSE_BYTES to the shed
// cap fails guard 4.
describe('M3 B.3 backpressure watermarks', () => {
  /** Records the callback's arguments; transport-blind, no frame types here. */
  function watermarked(): { ingest: AudioIngest; events: string[] } {
    const events: string[] = [];
    const ingest = new AudioIngest({ onWatermark: (state) => void events.push(state) });
    return { ingest, events };
  }

  /**
   * Bytes needed to complete the window a `PAUSE_BYTES` push left pending, so
   * the level lands on exactly 0. Expressed from the geometry rather than a
   * literal so it stays correct if either constant moves.
   */
  const DRAIN = WINDOW_BYTES - (PAUSE_BYTES % WINDOW_BYTES);

  test('crossing PAUSE fires once; further chunks above it fire nothing (no thrash)', () => {
    // The anti-thrash assertion, and the reason the two thresholds differ: a
    // level-triggered callback re-announces on EVERY chunk while the level sits
    // at the boundary, and the shell would drop and resume in lockstep with the
    // accumulator forever. Edge-triggered means the transition is the event.
    const { ingest, events } = watermarked();
    ingest.push(new Uint8Array(PAUSE_BYTES)); // exactly PAUSE → one 'pause'
    expect(events).toEqual(['pause']);
    // Five more chunks of exactly one window. Each one takes the level back to
    // exactly PAUSE_BYTES (102_144 pending + 160_000), so the threshold is
    // re-touched on EVERY push and the callback still says nothing — that is the
    // latch doing its job, and the level never reaches RESUME_BYTES either.
    for (let i = 0; i < 5; i += 1) ingest.push(new Uint8Array(WINDOW_BYTES));
    expect(events, 'the level re-touches PAUSE on every push; only the edge speaks').toEqual([
      'pause',
    ]);
  });

  test('hysteresis: only draining under RESUME resumes, and re-crossing PAUSE re-pauses', () => {
    // Proves it is not one-shot, and that the gap between the thresholds is what
    // makes the pair safe: a push that leaves the level between the two
    // watermarks announces nothing, so a level oscillating near a single
    // threshold cannot storm the wire.
    const { ingest, events } = watermarked();
    ingest.push(new Uint8Array(PAUSE_BYTES));
    expect(events).toEqual(['pause']);

    // A whole window: the level re-touches PAUSE (latched, silent) and settles
    // back at 102_144 — above RESUME_BYTES, so still no edge.
    ingest.push(new Uint8Array(WINDOW_BYTES));
    expect(events, 'between the watermarks nothing is announced').toEqual(['pause']);

    // Drain: this completes the pending window, so the level reaches 0 and the
    // down-edge is observable.
    ingest.push(new Uint8Array(DRAIN));
    expect(events).toEqual(['pause', 'resume']);

    // A second cycle must be identical to the first, edge for edge.
    ingest.push(new Uint8Array(PAUSE_BYTES));
    expect(events).toEqual(['pause', 'resume', 'pause']);
    ingest.push(new Uint8Array(WINDOW_BYTES));
    expect(events).toEqual(['pause', 'resume', 'pause']);
    ingest.push(new Uint8Array(DRAIN));
    expect(events).toEqual(['pause', 'resume', 'pause', 'resume']);
  });

  test('the deadlock guard: reset() clears paused, and the next push works normally', () => {
    // THE test for this item. `reset()` runs on barge-in (AudioPipeline.cancel)
    // and on a session switch. If it emptied the buffer but left `paused` true,
    // the accumulator would hold ~0 bytes FOREVER: no bytes arrive to cross
    // RESUME_BYTES, so the down-edge can never be observed and `onWatermark`
    // never fires 'resume'. The shell would then drop every chunk of every
    // utterance for the rest of the session — the uplink is paused, the buffer
    // is empty, and nothing in the system is capable of un-pausing it.
    //
    // Asserted through the CALLBACK, not by reading a private: a complete
    // pause→resume cycle after the reset is the behaviour, whatever the field is
    // called. A reset that left the latch stuck produces neither the 'resume'
    // nor the second 'pause' below, so this cannot pass vacuously.
    const { ingest, events } = watermarked();
    ingest.push(new Uint8Array(PAUSE_BYTES));
    expect(events).toEqual(['pause']);

    ingest.reset(); // barge-in / session switch mid-pause

    // The next push must behave exactly as a fresh accumulator: crossing PAUSE
    // announces 'pause' again.
    ingest.push(new Uint8Array(PAUSE_BYTES));
    expect(events, 'reset() must clear paused, or no later edge is observable').toEqual([
      'pause',
      'resume',
      'pause',
    ]);
    // And the cycle still closes.
    ingest.push(new Uint8Array(DRAIN));
    expect(events).toEqual(['pause', 'resume', 'pause', 'resume']);
  });

  test('PAUSE sits strictly below the shed cap, so a paused stream never drops audio', () => {
    // The ordering that makes this safe: the pause is announced at 256 KiB,
    // shedding does not begin until 960 KiB, and the shell drops on the FIRST
    // pause frame. The headroom absorbs what was already on the wire when that
    // frame was written. If PAUSE ever rose to the cap, the first audio a paused
    // stream gave up would be shed at the daemon instead of dropped at the
    // shell, where nothing reports it.
    expect(PAUSE_BYTES).toBeLessThan(MAX_BUFFERED_BYTES);
    expect(RESUME_BYTES).toBeLessThan(PAUSE_BYTES);
    // And the constants agree with the window geometry: PAUSE is 1.64 windows,
    // RESUME is a fifth of one — a resume needs less than one window of drain,
    // while the pause band is wide enough to absorb a burst.
    expect(PAUSE_BYTES / WINDOW_BYTES).toBeCloseTo(1.6384, 4);
    expect(RESUME_BYTES).toBeLessThan(WINDOW_BYTES);

    // Behavioural half: the edge is announced at a level where nothing has been
    // discarded yet, so "paused" and "shedding" are never both true.
    const { ingest, events } = watermarked();
    ingest.push(new Uint8Array(PAUSE_BYTES + 1));
    expect(events).toEqual(['pause']);
    expect(ingest.droppedWindows).toBe(0);
    expect(ingest.bufferedBytes).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
  });
});

describe('bytesToFloat32', () => {
  test('normalises Int16LE to the -1..1 range Silero expects', () => {
    const pcm = new Int16Array([0, 16384, -16384, 32767]);
    const f = bytesToFloat32(new Uint8Array(pcm.buffer), 0, 4);
    expect(f[0]).toBe(0);
    expect(f[1]).toBeCloseTo(0.5, 4);
    expect(f[2]).toBeCloseTo(-0.5, 4);
    expect(f[3]).toBeGreaterThan(0.99);
  });

  test('honours a byte offset into a larger buffer', () => {
    const pcm = new Int16Array([1000, 2000, 3000, 4000]);
    const f = bytesToFloat32(new Uint8Array(pcm.buffer), 4, 2);
    expect(f).toHaveLength(2);
    expect(f[0]).toBeCloseTo(3000 / 32768, 6);
    expect(f[1]).toBeCloseTo(4000 / 32768, 6);
  });

  test('a truncated window yields zeros instead of throwing', () => {
    const pcm = new Int16Array([1, 2]);
    const f = bytesToFloat32(new Uint8Array(pcm.buffer), 0, 512);
    expect(f).toHaveLength(512);
    expect(f[100]).toBe(0);
  });

  test('a negative offset clamps rather than reading out of bounds', () => {
    const pcm = new Int16Array([7, 8]);
    const f = bytesToFloat32(new Uint8Array(pcm.buffer), -8, 1);
    expect(f).toHaveLength(1);
    expect(f[0]).toBeCloseTo(7 / 32768, 6);
  });
});