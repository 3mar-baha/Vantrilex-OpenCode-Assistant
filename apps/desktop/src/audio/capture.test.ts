import { describe, expect, test } from 'vitest';
import { downsample, encodeFrame, floatToInt16, TARGET_RATE } from './capture.js';

// P4 TDD — PCM math is pure and fully specified: clamp, resample, encode.
describe('capture DSP', () => {
  test('target rate is the 16 kHz contract', () => {
    expect(TARGET_RATE).toBe(16000);
  });

  test('floatToInt16 clamps and scales', () => {
    const out = floatToInt16(new Float32Array([-1.5, -1, -0.5, 0, 0.5, 1, 1.5]));
    expect([...out]).toEqual([-32767, -32767, -16383, 0, 16384, 32767, 32767]);
  });

  test('downsample halves 32 kHz to 16 kHz by linear interpolation', () => {
    const input = new Float32Array([0, 10, 20, 30]);
    const out = downsample(input, 32000, 16000);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(20, 5);
  });

  test('downsample rejects non-positive or sub-target rates', () => {
    expect(() => downsample(new Float32Array(4), 0)).toThrow();
    expect(() => downsample(new Float32Array(4), 8000)).toThrow();
  });

  test('downsample passes 16 kHz through (copied, not aliased)', () => {
    const input = new Float32Array([1, 2, 3]);
    const out = downsample(input, 16000, 16000);
    expect([...out]).toEqual([1, 2, 3]);
    expect(out).not.toBe(input);
  });

  test('encodeFrame emits little-endian bytes', () => {
    const bytes = encodeFrame(new Int16Array([0x0102, -2]));
    expect([...bytes]).toEqual([0x02, 0x01, 0xfe, 0xff]);
  });

  test('100 ms at 16 kHz is exactly one 3200-byte contract frame', () => {
    const samples = new Float32Array(1600).fill(0.25);
    const bytes = encodeFrame(floatToInt16(downsample(samples, 16000)));
    expect(bytes.byteLength).toBe(3200);
  });
});