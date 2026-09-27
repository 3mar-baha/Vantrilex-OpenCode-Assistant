import { describe, expect, test } from 'vitest';
import {
  AudioIngest,
  bytesToFloat32,
  isLoudWindow,
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