import { describe, expect, test } from 'vitest';
import { AudioIngest, WINDOW_BYTES } from './ingest.js';

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