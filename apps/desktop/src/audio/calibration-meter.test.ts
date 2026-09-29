import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { frameEnergyDb, isSpeechFrame } from './vad.js';
import {
  GATE_DB,
  MIN_SAMPLES,
  QUIET_MARGIN_DB,
  bandForFloorDb,
  calibrationVerdict,
} from './calibration-meter.js';

// M4 C.6 — the microphone calibration METER, RED FIRST. Pure, zero I/O, no
// timers, no `getUserMedia`, no DOM. The roadmap's `CalibrationMeter({samples})`
// is `calibrationVerdict(samples)` in `./calibration-meter.ts`; this file is the
// half that can be decided without a microphone, a browser or a clock, which is
// the whole reason the split exists.
//
// The three boundaries that matter, and why each is pinned at all:
//
//  1. THE GATE LINE ITSELF. The shared gate is `isSpeechFrame(frame, -30)`,
//     which is `energyDb > -30` — STRICT. So a room floor sitting exactly on
//     -30 dBFS does NOT trip it, and calling that room "noisy" would
//     contradict the function the number was borrowed from. The `>` here is the
//     same `>` there, deliberately.
//  2. THE QUIET LINE, gate - QUIET_MARGIN_DB. A boundary that rounds is a
//     boundary that rots, so it is probed one ulp-ish step either side rather
//     than only on the line.
//  3. THE UNMEASURED CASE. No samples, or fewer than MIN_SAMPLES, must never
//     be reported as a quiet room. Absence of evidence is not a clean
//     measurement, and `quiet` is the one band whose copy would tell a user
//     their microphone is fine.
//
// EVERY GUARD HERE HAS BEEN BROKEN BY HAND AND WATCHED FAIL. The band table,
// both boundaries, `MIN_SAMPLES`, the conservative unmeasured arm, the
// shared-`frameEnergyDb` identity and the source scan were each inverted or
// removed individually; see the report.

/** A constant-amplitude mono frame whose energy sits near `db` dBFS. */
function toneFrame(db: number, length = 1600): Int16Array {
  return new Int16Array(length).fill(Math.round(10 ** (db / 20) * 32768));
}

function frames(db: number, count: number): Int16Array[] {
  return Array.from({ length: count }, () => toneFrame(db));
}

function silence(count: number): Int16Array[] {
  return Array.from({ length: count }, () => new Int16Array(1600));
}

describe('bandForFloorDb — three outcomes, probed at both boundaries', () => {
  test('the gate number IS the shared -30 dB default, not a second one', () => {
    // If this ever drifts from `isSpeechFrame`'s default the wizard starts
    // comparing the room against a gate the gate does not use.
    expect(GATE_DB).toBe(-30);
    // …and the gate really is strict at that line, which is the reason the
    // meter's `>` is strict too. Proved against the REAL function, not a
    // restatement of the constant.
    expect(isSpeechFrame(toneFrame(-29.5))).toBe(true);
    expect(isSpeechFrame(toneFrame(-30.5))).toBe(false);
  });

  test('at the -30 dB line the room is BORDERLINE, not noisy', () => {
    // Exactly on the line. `>` is strict, so the shared gate would not trip.
    expect(bandForFloorDb(-30)).toBe('borderline');
    expect(bandForFloorDb(GATE_DB)).toBe('borderline');
  });

  test('just below the line stays borderline, just above it is noisy', () => {
    expect(bandForFloorDb(GATE_DB - 1e-9)).toBe('borderline');
    expect(bandForFloorDb(GATE_DB + 1e-9)).toBe('noisy');
    expect(bandForFloorDb(-29.9)).toBe('noisy');
  });

  test('the quiet line is gate - QUIET_MARGIN_DB, and it is inclusive', () => {
    const quietLine = GATE_DB - QUIET_MARGIN_DB; // -45
    expect(quietLine).toBe(-45);
    expect(bandForFloorDb(quietLine)).toBe('quiet');
    expect(bandForFloorDb(quietLine - 1e-9)).toBe('quiet');
    expect(bandForFloorDb(quietLine + 1e-9)).toBe('borderline');
    // Digital silence — the floor `frameEnergyDb` reports for a zero frame.
    expect(bandForFloorDb(-100)).toBe('quiet');
  });
});

describe('calibrationVerdict — the three outcomes on real frames', () => {
  test('a quiet room is quiet, and no sample of it trips the shared gate', () => {
    const sample = frames(-60, 30);
    const v = calibrationVerdict(sample);
    expect(v.band).toBe('quiet');
    expect(v.measured).toBe(true);
    expect(v.sampleCount).toBe(30);
    expect(v.gateDb).toBe(GATE_DB);
    // The floor is computed by the SHARED function, not a re-derived dB. An
    // identity check, not a tolerance: two implementations of the same
    // formula drift, and this is where that drift would show.
    expect(v.floorDb).toBe(frameEnergyDb(sample[0] as Int16Array));
    for (const f of sample) expect(isSpeechFrame(f)).toBe(false);
  });

  test('a room near the gate is borderline and still under it', () => {
    const sample = frames(-35, 30);
    const v = calibrationVerdict(sample);
    expect(v.band).toBe('borderline');
    expect(v.measured).toBe(true);
    expect(v.floorDb).toBe(frameEnergyDb(sample[0] as Int16Array));
    // The distinction that earns this band its name: under the gate, but with
    // less than QUIET_MARGIN_DB of headroom.
    for (const f of sample) expect(isSpeechFrame(f)).toBe(false);
  });

  test('a room above the gate is noisy, and every sample really does trip it', () => {
    const sample = frames(-20, 30);
    const v = calibrationVerdict(sample);
    expect(v.band).toBe('noisy');
    expect(v.measured).toBe(true);
    expect(v.floorDb).toBe(frameEnergyDb(sample[0] as Int16Array));
    // The guard that keeps the band and the gate from becoming two opinions:
    // `noisy` must mean the shared gate would open on this room's own tone.
    for (const f of sample) expect(isSpeechFrame(f)).toBe(true);
  });

  test('the floor is a high percentile, so one loud frame is not the verdict', () => {
    // 29 quiet frames and ONE slammed door. A max or a median would both call
    // this room quiet; the point of a p90 is that a single transient is one
    // sample out of thirty, not the level of the room.
    const sample = frames(-70, 29);
    sample.push(toneFrame(-5));
    const v = calibrationVerdict(sample);
    expect(v.band).toBe('quiet');
    expect(v.floorDb).toBe(frameEnergyDb(sample[0] as Int16Array));
  });
});

describe('calibrationVerdict — the degenerate inputs', () => {
  test('an EMPTY sample set measures nothing and does not call the room quiet', () => {
    const v = calibrationVerdict([]);
    expect(v.measured).toBe(false);
    expect(v.floorDb).toBeNull();
    expect(v.sampleCount).toBe(0);
    // The conservative arm. There is no evidence the room is quiet, and
    // `quiet` is the only band whose copy would vouch for the microphone.
    expect(v.band).toBe('noisy');
  });

  test('a sample set under MIN_SAMPLES is not yet a measurement', () => {
    // 0.9 s of audio is a fraction of a breath; presenting it as a room
    // verdict would be a measurement nobody took.
    const few = frames(-60, MIN_SAMPLES - 1);
    expect(calibrationVerdict(few).measured).toBe(false);
    expect(calibrationVerdict(few).floorDb).toBeNull();
    expect(calibrationVerdict(few).band).toBe('noisy');
    // One more frame crosses the line and the floor appears.
    const enough = frames(-60, MIN_SAMPLES);
    expect(calibrationVerdict(enough).measured).toBe(true);
    expect(calibrationVerdict(enough).floorDb).toBe(frameEnergyDb(enough[0] as Int16Array));
  });

  test('ALL SILENCE measures a floor of -100 and is quiet', () => {
    // Not an error arm. A digitally silent room is the best case, and the
    // number it reports is the same -100 dBFS floor `frameEnergyDb` documents.
    const sample = silence(30);
    const v = calibrationVerdict(sample);
    expect(v.measured).toBe(true);
    expect(v.sampleCount).toBe(30);
    expect(v.floorDb).toBe(-100);
    expect(v.band).toBe('quiet');
    for (const f of sample) expect(frameEnergyDb(f)).toBe(-100);
  });
});

describe('calibrationVerdict — purity is the testability requirement, not a style', () => {
  test('it does not mutate its input and is deterministic', () => {
    const sample = frames(-45, 30);
    const before = Array.from(sample, (f) => Array.from(f));
    const first = calibrationVerdict(sample);
    const second = calibrationVerdict(sample);
    expect(second).toEqual(first);
    expect(Array.from(sample, (f) => Array.from(f))).toEqual(before);
  });

  test('the source reaches no microphone, no clock and no DOM', () => {
    // Resolved from the suite's working directory, the way
    // `src/daemon-persona-wiring.test.ts` reads `src/daemon.ts` — this suite
    // runs with `apps/desktop` as its root, so the path is stable.
    const src = readFileSync(join(process.cwd(), 'src', 'audio', 'calibration-meter.ts'), 'utf8');
    for (const forbidden of ['getUserMedia', 'AudioContext', 'setTimeout', 'setInterval', 'document', 'window', 'fetch', 'localStorage']) {
      expect(src, `the meter must not mention ${forbidden}`).not.toContain(forbidden);
    }
  });

  test('it runs with no microphone and no device API present at all', () => {
    // The structural proof behind the source scan: happy-dom exposes no
    // `mediaDevices`, so a meter that reached for one would throw rather than
    // return a verdict.
    expect((navigator as { mediaDevices?: unknown }).mediaDevices).toBeUndefined();
    expect(() => calibrationVerdict(frames(-60, 30))).not.toThrow();
  });
});
