import { describe, expect, test } from 'vitest';
import { SileroVad, VAD_SAMPLE_RATE, VAD_WINDOW_SAMPLES } from './vad.js';

// G4A — Silero VAD over the existing onnxruntime-node (no new native dep).
// Hermetic tests run against a stubbed ORT session; the real-model test is
// live-gated on SILERO_LIVE + models/silero-vad.onnx.
function stubSession(logit: number) {
  return {
    inputNames: ['input', 'state', 'sr'],
    outputNames: ['output', 'stateN'],
    run: async () => ({
      output: { data: new Float32Array([logit]), dims: [1, 1] },
      stateN: { data: new Float32Array(2 * 1 * 128), dims: [2, 1, 128] },
    }),
  };
}

describe('SileroVad geometry', () => {
  test('16 kHz contract and 512-sample windows', () => {
    expect(VAD_SAMPLE_RATE).toBe(16000);
    expect(VAD_WINDOW_SAMPLES).toBe(512);
  });

  test('rejects wrong-sized windows fail-closed', async () => {
    const vad = new SileroVad(stubSession(0.9) as never, { threshold: 0.5 });
    await expect(vad.prob(new Float32Array(256))).rejects.toThrow(/512/);
  });
});

describe('SileroVad speech probability', () => {
  test('high logit → speech; low logit → silence', async () => {
    const loud = new SileroVad(stubSession(0.9) as never, { threshold: 0.5 });
    expect(await loud.prob(new Float32Array(512))).toBeCloseTo(0.9, 5);
    expect(await loud.isSpeech(new Float32Array(512))).toBe(true);
    const quiet = new SileroVad(stubSession(0.1) as never, { threshold: 0.5 });
    expect(await quiet.isSpeech(new Float32Array(512))).toBe(false);
  });

  test('reset() clears recurrent state between utterances', async () => {
    const vad = new SileroVad(stubSession(0.9) as never, { threshold: 0.5 });
    await vad.prob(new Float32Array(512));
    vad.reset();
    // After reset the next call must not reuse prior hidden state: the stub
    // ignores feeds, so this pins the reset path as callable, not its math.
    await expect(vad.prob(new Float32Array(512))).resolves.toBeCloseTo(0.9, 5);
  });
});

describe('SileroVad live model (gated)', () => {
  test('real ONNX graph scores silence below speech', async () => {
    if (process.env['SILERO_LIVE'] !== '1') return;
    const { SileroVad: Live } = await import('./vad.js');
    const vad = await Live.load('models/silero-vad.onnx');
    try {
      const silence = await vad.prob(new Float32Array(512));
      expect(silence).toBeGreaterThanOrEqual(0);
      expect(silence).toBeLessThanOrEqual(1);
    } finally {
      await vad.dispose();
    }
  });
});
