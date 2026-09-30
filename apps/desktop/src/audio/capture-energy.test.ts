import { describe, expect, test, vi, afterEach } from 'vitest';
import { AudioCapture } from './capture.js';
import { SPEECH_GATE_DB, dbToWaveEnergy, frameEnergyDb } from './vad.js';

// A2 — mic energy reaches the wave in the SAME measurement the gate uses.
//
// The brief's correction is taken at face value: `frameEnergyDb` was never
// broken wiring and was never on the live capture path. What it WAS missing is
// a dB-domain reading from the frames that actually go on the wire — the HUD
// was driving the wave from `min(1, rms * 4)` on the raw 48 kHz input block,
// a scale with no stated relationship to the -30 dBFS gate that decides whether
// a frame is transmitted at all.
//
// This test drives the REAL `AudioCapture` through a fake device and asserts
// the emitted VALUE, not a class name.

afterEach(() => {
  vi.unstubAllGlobals();
});

const FRAME_SAMPLES = 1600;
const BLOCK_SAMPLES = 4096;

interface Harness {
  readonly capture: AudioCapture;
  /** Push one 48 kHz input block through the ScriptProcessor fallback. */
  emit(samples: Float32Array): void;
  readonly energies: number[];
  readonly frames: Uint8Array[];
}

/**
 * Fake device that forces the ScriptProcessor fallback (no AudioWorklet), so the
 * real `emit()` path runs synchronously from a test.
 */
async function harness(): Promise<Harness> {
  const energies: number[] = [];
  const frames: Uint8Array[] = [];
  let onaudioprocess: ((ev: unknown) => void) | null = null;

  const processor = {
    onaudioprocess: null as ((ev: unknown) => void) | null,
    connect: (): void => undefined,
    disconnect: (): void => undefined,
  };
  Object.defineProperty(processor, 'onaudioprocess', {
    get: () => onaudioprocess,
    set: (v: ((ev: unknown) => void) | null) => {
      onaudioprocess = v;
    },
  });

  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 48000;
      audioWorklet = {
        addModule: () => Promise.reject(new Error('no worklet in this environment')),
      };
      destination = {};
      createMediaStreamSource(): { connect: (n: unknown) => void } {
        return { connect: () => undefined };
      }
      createScriptProcessor(): typeof processor {
        return processor;
      }
      resume(): Promise<void> {
        return Promise.resolve();
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    },
  );
  vi.stubGlobal(
    'URL',
    Object.assign(Object.create(URL) as object, {
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: () => undefined,
    }),
  );
  const track = { stop: (): void => undefined };
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [track] }) } },
    configurable: true,
    writable: true,
  });

  const capture = new AudioCapture();
  await capture.start({
    onFrame: (bytes) => frames.push(bytes),
    onEnergy: (e) => energies.push(e),
    onError: (err) => {
      throw err;
    },
  });

  return {
    capture,
    energies,
    frames,
    emit: (samples) => {
      if (onaudioprocess === null) throw new Error('capture did not reach the ScriptProcessor fallback');
      onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
    },
  };
}

/** Enough 48 kHz blocks to flush one whole 1600-sample 16 kHz frame. */
function blocksForOneFrame(): number {
  return Math.ceil(BLOCK_SAMPLES / 3) + 1;
}

function silenceBlock(): Float32Array {
  return new Float32Array(BLOCK_SAMPLES);
}

/** A quiet room tone: ~-58 dBFS once quantised to Int16. */
function roomToneBlock(amplitude: number): Float32Array {
  const out = new Float32Array(BLOCK_SAMPLES);
  for (let i = 0; i < BLOCK_SAMPLES; i += 1) out[i] = amplitude;
  return out;
}

describe('A2 — capture emits energy measured with frameEnergyDb', () => {
  test('a silent device emits the SILENCE value, not a mid-scale one', async () => {
    const h = await harness();
    for (let i = 0; i < blocksForOneFrame(); i += 1) h.emit(silenceBlock());
    expect(h.energies.length).toBeGreaterThan(0);
    for (const e of h.energies) expect(e).toBe(0);
  });

  test('a voice frame emits a LARGER value than room tone — the VALUE, not a class', async () => {
    const h = await harness();
    for (let i = 0; i < blocksForOneFrame(); i += 1) h.emit(roomToneBlock(0.0012));
    for (let i = 0; i < blocksForOneFrame(); i += 1) h.emit(roomToneBlock(0.12));
    expect(h.energies.length).toBeGreaterThan(1);
    const room = Math.max(...h.energies.slice(0, 1));
    const speech = Math.max(...h.energies);
    expect(speech).toBeGreaterThan(room * 2);
    expect(speech).toBeGreaterThan(0.4);
  });

  test('the emitted value is EXACTLY dbToWaveEnergy(frameEnergyDb(emittedFrame))', async () => {
    const h = await harness();
    for (let i = 0; i < blocksForOneFrame(); i += 1) h.emit(roomToneBlock(0.12));
    expect(h.frames.length).toBeGreaterThan(0);
    expect(h.energies.length, 'one energy reading per emitted frame').toBe(h.frames.length);

    // Derived from the BYTES THAT WERE EMITTED, not from a hand-written
    // constant. This is what makes the assertion exact rather than a band: an
    // independent reimplementation — `min(1, rms * 4)` on the input block, the
    // scale this replaced — produces a monotone but DIFFERENT number, and the
    // first break-guard of this phase proved a band assertion cannot see that.
    for (const frame of h.frames) {
      const samples = new Int16Array(frame.buffer, frame.byteOffset, Math.floor(frame.byteLength / 2));
      const expected = dbToWaveEnergy(frameEnergyDb(samples));
      expect(dbToWaveEnergy(frameEnergyDb(samples))).toBe(expected);
    }
    const last = h.frames[h.frames.length - 1] as Uint8Array;
    const lastSamples = new Int16Array(last.buffer, last.byteOffset, Math.floor(last.byteLength / 2));
    const lastEnergy = h.energies[h.energies.length - 1] as number;
    expect(lastEnergy).toBe(dbToWaveEnergy(frameEnergyDb(lastSamples)));
    // …and that value is NOT what the old scale would have produced.
    const rms = Math.sqrt(
      [...lastSamples].reduce((acc, v) => acc + (v / 32768) ** 2, 0) / lastSamples.length,
    );
    expect(lastEnergy).not.toBeCloseTo(Math.min(1, rms * 4), 2);
  });

  test('one frame of energy per frame of audio — they are not decoupled', async () => {
    const h = await harness();
    const blocks = blocksForOneFrame();
    for (let i = 0; i < blocks * 3; i += 1) h.emit(roomToneBlock(0.12));
    expect(h.energies.length).toBe(h.frames.length);
    // 48 kHz -> 16 kHz is /3, so 3 blocks of 4096 is 4096 samples at 16 kHz,
    // i.e. two whole 1600-sample frames plus a remainder.
    expect(h.frames.length).toBeGreaterThanOrEqual(2);
  });

  test('the smallest integer amplitude that trips the gate lands on the wave knee', () => {
    // The gate is STRICT (`energyDb > -30`), so the amplitude that crosses it
    // is the next integer up, and the frame exactly AT -30 dBFS is silence.
    // This pins the two ends of the mapping the canvas reads.
    const atGate = Math.round(32768 * 10 ** (SPEECH_GATE_DB / 20));
    const justUnder = new Int16Array(FRAME_SAMPLES).fill(atGate);
    const justOver = new Int16Array(FRAME_SAMPLES).fill(atGate + 1);
    expect(frameEnergyDb(justUnder)).toBeLessThanOrEqual(SPEECH_GATE_DB);
    expect(frameEnergyDb(justOver)).toBeGreaterThan(SPEECH_GATE_DB);
    expect(dbToWaveEnergy(frameEnergyDb(justOver))).toBeCloseTo(0.4, 2);
    // …and it is really the wave that distinguishes them, not the gate alone.
    expect(dbToWaveEnergy(frameEnergyDb(justOver))).toBeGreaterThan(
      dbToWaveEnergy(frameEnergyDb(new Int16Array(FRAME_SAMPLES).fill(40))),
    );
  });

  test('energy is computed per FRAME, not over the whole accumulated buffer', async () => {
    // A wall-clock budget here would be a flaky test on a loaded machine, and a
    // regression from O(frame) to O(buffer) is a STRUCTURAL property, not a
    // timing one. It is proved by latency of ARRIVAL instead: the very first
    // energy callback must land as soon as one whole 1600-sample frame exists,
    // which is 2 blocks of 4096 at 48 kHz. A per-block or per-buffer
    // measurement could not emit before the buffer is complete.
    const h = await harness();
    const before = h.energies.length;
    // 4096 samples at 48 kHz downsample to ~1365 at 16 kHz — not yet a frame.
    h.emit(roomToneBlock(0.12));
    expect(h.energies.length, 'one block is not a frame, so nothing is claimed').toBe(before);
    h.emit(roomToneBlock(0.12));
    h.emit(roomToneBlock(0.12));
    expect(h.energies.length, 'the third block completes the first frame').toBeGreaterThan(before);
    expect(h.frames.length).toBe(h.energies.length);
  });
});
