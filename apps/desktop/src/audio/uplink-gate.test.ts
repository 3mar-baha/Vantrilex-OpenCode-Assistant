import { describe, expect, test } from 'vitest';
import { SPEECH_GATE_DB, UplinkGate, dbToWaveEnergy, uplinkVerdict } from './vad.js';

// A1 — the LOCAL UPLINK GATE.
//
// The microphone stays open. What changes is that a frame below the shared
// speech gate is dropped in the RENDERER, before `sendPcm`, so no byte of room
// tone reaches the socket.
//
// This is the SILENCE sibling of the B.3 backpressure watermark. They are not
// the same control and must never be conflated:
//   * B.3  — daemon-driven, congestion-triggered, `VoxauraBridge.uplinkPaused`.
//   * A1   — local, energy-triggered, `UplinkGate`. The daemon does not know
//            this gate exists and cannot observe it.
//
// S1 RED was written against a module that did not exist. Every test below
// fails on the missing behaviour, not on a missing class name.

const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz

/** A DC frame — `frameEnergyDb` reads its amplitude directly. */
function tone(amp: number): Uint8Array {
  return new Uint8Array(new Int16Array(FRAME_SAMPLES).fill(amp).buffer);
}

/** 40/32768 ≈ -58 dBFS: room tone, comfortably under the -30 gate. */
const SILENCE = tone(40);
/** 4000/32768 ≈ -18 dBFS: a voice burst, comfortably over it. */
const SPEECH = tone(4000);

describe('A1(a) — a silent window puts ZERO bytes on the wire', () => {
  test('a quiet frame while idle is dropped by the gate', () => {
    const v = uplinkVerdict(SILENCE, { speaking: false });
    expect(v.send).toBe(false);
    expect(v.droppedByGate).toBe(true);
  });

  test('a loud frame while idle is still sent (the gate is not a mute)', () => {
    expect(uplinkVerdict(SPEECH, { speaking: false }).send).toBe(true);
  });

  test('10 seconds of pure silence emits no bytes at all', () => {
    const gate = new UplinkGate();
    let sent = 0;
    // 100 frames == 10 s of microphone time at one 100 ms frame per step.
    for (let i = 0; i < 100; i += 1) if (gate.decide(SILENCE, { speaking: false }).send) sent += 1;
    expect(sent).toBe(0);
  });

  test('the dropped-frame counter is the observability the daemon cannot give us', () => {
    const gate = new UplinkGate();
    for (let i = 0; i < 7; i += 1) gate.decide(SILENCE, { speaking: false });
    expect(gate.droppedFrames).toBe(7);
    expect(gate.sentFrames).toBe(0);
  });
});

describe('A1(b) — an EXPLICIT user action always transmits, gate closed or not', () => {
  test('forced sends a below-gate frame', () => {
    const v = uplinkVerdict(SILENCE, { speaking: false, forced: true });
    expect(v.send).toBe(true);
    expect(v.droppedByGate).toBe(false);
  });

  test('forced transmits even while the assistant is speaking (no duck either)', () => {
    const v = uplinkVerdict(SILENCE, { speaking: true, forced: true });
    expect(v.send).toBe(true);
    expect(v.barge).toBe(false);
  });

  test('forced on a frame whose energy cannot be measured at all still transmits', () => {
    // Odd byteOffset — `Int16Array` views throw on it. A privacy gate that
    // throws on a malformed frame is a gate that can kill the microphone.
    const odd = new Uint8Array(FRAME_SAMPLES * 2 + 1);
    const misaligned = new Uint8Array(odd.buffer, 1, FRAME_SAMPLES * 2);
    const v = uplinkVerdict(misaligned, { speaking: false, forced: true });
    expect(v.send).toBe(true);
  });

  test('a barge burst is never gated, with or without `forced`', () => {
    // The barge arm runs BEFORE the silence gate, which is the ordering that
    // makes "talking over the assistant" survivable.
    const v = uplinkVerdict(SPEECH, { speaking: true });
    expect(v.send).toBe(true);
    expect(v.barge).toBe(true);
  });
});

describe('A1(c) — FAIL OPEN: an undecidable energy signal transmits', () => {
  test('a misaligned frame measures as undecidable and is transmitted', () => {
    const odd = new Uint8Array(FRAME_SAMPLES * 2 + 1);
    const misaligned = new Uint8Array(odd.buffer, 1, FRAME_SAMPLES * 2);
    const v = uplinkVerdict(misaligned, { speaking: false });
    expect(v.energyDb).toBeNull();
    expect(v.send).toBe(true);
    expect(v.droppedByGate).toBe(false);
  });

  test('undecidable frames do NOT arm the post-utterance tail', () => {
    // Fail-open must mean "send it", not "send it and start a 5.6 s tail of
    // room tone" — that would turn one malformed frame into a burst of noise.
    const gate = new UplinkGate();
    const odd = new Uint8Array(FRAME_SAMPLES * 2 + 1);
    const misaligned = new Uint8Array(odd.buffer, 1, FRAME_SAMPLES * 2);
    for (let i = 0; i < 200; i += 1) gate.decide(misaligned, { speaking: false });
    expect(gate.burstFrames).toBe(0);
  });

  test('a loud frame after an undecidable one is still gated normally', () => {
    const gate = new UplinkGate();
    const odd = new Uint8Array(FRAME_SAMPLES * 2 + 1);
    gate.decide(new Uint8Array(odd.buffer, 1, FRAME_SAMPLES * 2), { speaking: false });
    expect(gate.decide(SILENCE, { speaking: false }).send).toBe(false);
  });
});

describe('A1 — the 5 s window: speech, then a bounded tail, then silence again', () => {
  // THE ACCUMULATION PROBLEM, stated as a test.
  //
  // The daemon's `AudioIngest` emits only COMPLETE 160,000-byte windows
  // (`WINDOW_BYTES`), which is exactly 5 s of 16 kHz mono Int16, and there is
  // no partial-window flush anywhere on the path. A naive per-frame silence
  // drop therefore means a 3-second utterance NEVER reaches STT: the buffer
  // fills with speech only, and speech only, never completes a window.
  //
  // The tail is the fix and it is bounded. Post-utterance audio is transmitted
  // for at most WINDOW_TAIL_FRAMES so the daemon can close the window the
  // speech started, and then the wire goes quiet again.

  test('a tail long enough to close a 5 s window follows the last speech frame', () => {
    const gate = new UplinkGate();
    gate.decide(SPEECH, { speaking: false });
    let tail = 0;
    for (let i = 0; i < 400; i += 1) if (gate.decide(SILENCE, { speaking: false }).send) tail += 1;
    // 5 s of 16 kHz Int16 is 160,000 bytes; one frame is 3,200 bytes, so 50
    // frames is a full window. The tail must cover it with margin.
    expect(tail).toBeGreaterThanOrEqual(50);
  });

  test('the tail STOPS — it is bounded, not a re-open of the old leak', () => {
    const gate = new UplinkGate();
    gate.decide(SPEECH, { speaking: false });
    for (let i = 0; i < 400; i += 1) gate.decide(SILENCE, { speaking: false });
    expect(gate.decide(SILENCE, { speaking: false }).send).toBe(false);
    expect(gate.burstFrames).toBe(0);
  });

  test('speech during the tail re-arms it rather than letting the window stall', () => {
    const gate = new UplinkGate();
    gate.decide(SPEECH, { speaking: false });
    for (let i = 0; i < 10; i += 1) gate.decide(SILENCE, { speaking: false });
    gate.decide(SPEECH, { speaking: false });
    let tail = 0;
    for (let i = 0; i < 400; i += 1) if (gate.decide(SILENCE, { speaking: false }).send) tail += 1;
    expect(tail).toBeGreaterThanOrEqual(50);
  });

  test('total bytes on the wire for a 5 s utterance + 60 s of room tone', () => {
    // The privacy property stated as arithmetic: today EVERY frame is sent, so
    // this is 650 frames. With the gate it is the utterance plus one tail.
    const gate = new UplinkGate();
    let sent = 0;
    for (let i = 0; i < 50; i += 1) if (gate.decide(SPEECH, { speaking: false }).send) sent += 1;
    for (let i = 0; i < 600; i += 1) if (gate.decide(SILENCE, { speaking: false }).send) sent += 1;
    expect(sent).toBeLessThan(120);
    expect(sent).toBeGreaterThanOrEqual(100);
  });

  test('a barge re-arms the tail, so an interrupted turn still closes its window', () => {
    const gate = new UplinkGate();
    expect(gate.decide(SPEECH, { speaking: true }).barge).toBe(true);
    expect(gate.burstFrames).toBeGreaterThan(0);
  });

  test('ducked frames while the assistant speaks do not consume the tail', () => {
    const gate = new UplinkGate();
    gate.decide(SPEECH, { speaking: false });
    for (let i = 0; i < 20; i += 1) {
      // While speaking, quiet frames are DUCKED (pre-existing policy). If they
      // consumed tail budget, a 2 s echo would eat the window the speech needs.
      expect(gate.decide(SILENCE, { speaking: true }).send).toBe(false);
    }
    let tail = 0;
    for (let i = 0; i < 400; i += 1) if (gate.decide(SILENCE, { speaking: false }).send) tail += 1;
    expect(tail).toBeGreaterThanOrEqual(50);
  });
});

describe('A1 — one threshold, quoted from the daemon', () => {
  test('the renderer gate is the SAME number as src/voice/ingest.ts', () => {
    // A second literal would drift. This is the drift guard: the renderer
    // cannot import the daemon's constant (separate build roots, separate
    // tsconfigs), so the sharing is enforced by a test instead of an import.
    expect(SPEECH_GATE_DB).toBe(-30);
  });

  test('the calibration wizard and the uplink gate are one constant', async () => {
    const { GATE_DB } = await import('./calibration-meter.js');
    expect(GATE_DB).toBe(SPEECH_GATE_DB);
  });

  // The two tests above are VALUE checks, and a value check cannot see a
  // re-split: re-typing `GATE_DB = -30` keeps both green while undoing the
  // whole point, which is what the first break-guard of this phase proved.
  // This one reads the source, because the defect is structural.
  test('`-30` is spelled exactly ONCE in the renderer audio modules', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    // Comments are stripped first: `calibration-meter.ts` NAMES the -30 in
    // three comments explaining why it is the shared gate, and prose that
    // mentions a number is not a second gate. The `[^:]` before `//` keeps a
    // URL from being eaten as a comment.
    const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const offenders: string[] = [];
    let total = 0;
    for (const f of readdirSync(here)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const src = stripComments(readFileSync(join(here, f), 'utf8'));
      const hits = src.match(/(?<![\w-])-30(?![\d])/g) ?? [];
      // `vad.ts` is allowed ONE: the definition itself.
      const counted = f === 'vad.ts' ? Math.max(0, hits.length - 1) : hits.length;
      if (counted > 0) offenders.push(`${f} (${counted})`);
      total += counted;
    }
    expect(offenders).toEqual([]);
    expect(total).toBe(0);
    expect(resolve(here)).toContain('apps');
  });

  test('the daemon side still declares exactly one SPEECH_GATE_DB = -30', async () => {
    // Read across the build boundary by path rather than by import: the
    // renderer cannot compile a `src/` import, but a TEST can read the text.
    const { readFileSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../../../../src/voice/ingest.ts'), 'utf8');
    const decls = src.match(/export const SPEECH_GATE_DB = -?\d+;/g) ?? [];
    expect(decls).toEqual(['export const SPEECH_GATE_DB = -30;']);
  });
});

describe('A2 — wave energy is measured in the SAME domain as the gate', () => {
  test('silence maps to 0 and full scale maps to 1', () => {
    expect(dbToWaveEnergy(-100)).toBe(0);
    expect(dbToWaveEnergy(0)).toBe(1);
  });

  test('a frame AT the gate maps to the documented knee value', () => {
    expect(dbToWaveEnergy(SPEECH_GATE_DB)).toBeCloseTo(0.4, 6);
  });

  test('room tone below the gate stays low, speech above it is clearly larger', () => {
    const room = dbToWaveEnergy(-58);
    const speech = dbToWaveEnergy(-18);
    expect(room).toBeLessThan(0.3);
    expect(speech).toBeGreaterThan(0.5);
    expect(speech).toBeGreaterThan(room * 2);
  });

  test('the mapping is monotone across the whole usable range', () => {
    let prev = -1;
    for (let db = -100; db <= 0; db += 1) {
      const v = dbToWaveEnergy(db);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  test('a non-finite reading degrades to silence rather than NaN on the canvas', () => {
    expect(dbToWaveEnergy(Number.NaN)).toBe(0);
    expect(dbToWaveEnergy(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test('the value is clamped to 0..1 so the canvas cannot be handed garbage', () => {
    for (const db of [-1000, -100, -30, 0, 40]) {
      const v = dbToWaveEnergy(db);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
