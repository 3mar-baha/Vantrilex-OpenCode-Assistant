import { describe, expect, test } from 'vitest';
import { bargePolicy, frameEnergyDb, isSpeechFrame } from './vad.js';

// Barge-in/ducking DSP: normalized RMS energy decides whether an uplink frame
// carries user speech while the assistant is talking.
describe('voice activity detection', () => {
  test('silence reads near -Infinity dBFS, full-scale sine near -3 dBFS', () => {
    expect(frameEnergyDb(new Int16Array(160))).toBeLessThan(-90);
    const sine = new Int16Array(160);
    for (let i = 0; i < sine.length; i += 1) sine[i] = Math.round(32767 * Math.sin((i / 16) * Math.PI * 2));
    const db = frameEnergyDb(sine);
    expect(db).toBeGreaterThan(-6);
    expect(db).toBeLessThan(0);
  });

  test('speech gate separates quiet room tone from a voice burst', () => {
    const room = new Int16Array(160).fill(40);
    const burst = new Int16Array(160).fill(4000);
    expect(isSpeechFrame(room)).toBe(false);
    expect(isSpeechFrame(burst)).toBe(true);
  });

  test('empty input is silence, never speech', () => {
    expect(isSpeechFrame(new Int16Array(0))).toBe(false);
  });

  test('barge policy: send when idle, duck quiet frames, barge on voice', () => {
    const quiet = new Uint8Array(new Int16Array(160).fill(40).buffer);
    const voice = new Uint8Array(new Int16Array(160).fill(6000).buffer);
    expect(bargePolicy(false, voice)).toBe('send');
    expect(bargePolicy(true, quiet)).toBe('duck');
    expect(bargePolicy(true, voice)).toBe('barge');
  });
});