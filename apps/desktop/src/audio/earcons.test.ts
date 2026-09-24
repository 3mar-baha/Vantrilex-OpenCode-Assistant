import { describe, expect, test } from 'vitest';
import { earconRecipe, renderEarcon } from './earcons.js';

// G3 TDD — earcon DSP without hardware: a stub context proves the recipes
// render click-free envelopes of the contracted length.
function stubContext(sampleRate = 16000) {
  return {
    sampleRate,
    createBuffer: (_ch: number, len: number) => {
      const data = new Float32Array(len);
      return { getChannelData: () => data };
    },
  };
}

describe('earcon recipes', () => {
  test('abort is a low muted thud; arm/disarm are short clicks', () => {
    expect(earconRecipe('abort').frequency).toBeLessThan(200);
    expect(earconRecipe('abort').durationMs).toBeGreaterThanOrEqual(150);
    expect(earconRecipe('arm').durationMs).toBeLessThanOrEqual(60);
    expect(earconRecipe('disarm').endFrequency).toBeLessThan(earconRecipe('disarm').frequency);
  });

  test('kareem/nour chimes differ in pitch band', () => {
    expect(earconRecipe('kareem-done').frequency).toBeLessThan(earconRecipe('nour-done').frequency);
  });
});

describe('renderEarcon', () => {
  test('renders the contracted sample count with a click-free envelope', () => {
    const ctx = stubContext(16000);
    const buffer = renderEarcon(ctx, 'arm');
    const data = buffer.getChannelData(0);
    expect(data.length).toBe(Math.floor((16000 * 40) / 1000));
    expect(Math.abs(data[0]!)).toBeLessThan(0.01); // starts at silence
    expect(Math.abs(data[data.length - 1]!)).toBeLessThan(0.01); // ends at silence
    const peak = Math.max(...[...data].map((v) => Math.abs(v)));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(0.5);
  });

  test('triangle and sine waveshapes are audibly distinct (crest factor)', () => {
    const crest = (kind: 'arm' | 'abort'): number => {
      const data = renderEarcon(stubContext(16000), kind).getChannelData(0);
      const peak = Math.max(...[...data].map((v) => Math.abs(v)));
      const rms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
      return peak / rms;
    };
    const triangleCrest = crest('arm');
    const sineCrest = crest('abort');
    expect(triangleCrest).toBeGreaterThan(sineCrest + 0.15);
  });

  test('swept glide crosses zero at the expected rate (no aliasing jumps)', () => {
    const data = renderEarcon(stubContext(16000), 'kareem-done').getChannelData(0);
    let crossings = 0;
    for (let i = 1; i < data.length; i += 1) {
      if ((data[i - 1]! <= 0 && data[i]! > 0) || (data[i - 1]! >= 0 && data[i]! < 0)) crossings += 1;
    }
    // ~823 Hz mean over 220 ms ≈ 181 cycles ≈ 362 crossings (±15%).
    expect(crossings).toBeGreaterThan(300);
    expect(crossings).toBeLessThan(420);
  });
});
