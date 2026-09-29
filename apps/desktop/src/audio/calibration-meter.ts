import { frameEnergyDb } from './vad.js';

// M4 C.6 — the calibration METER. Pure: samples in, verdict out.
//
// The split from the wizard is the item's testability requirement, not a style.
// This file reaches no device, no clock and no markup, so the whole band table
// can be decided in milliseconds under a DOM test environment. The wizard
// (../components/portals/CalibrationWizard.js) owns the hardware, the elapsed
// time and the Arabic, and hands the samples here.
//
// THE GATE IS THE SHARED ONE. `GATE_DB` is the same -30 dBFS that
// `isSpeechFrame(frame, -30)` compares against, and the per-sample energy is
// computed by that module's own `frameEnergyDb` rather than by a second
// implementation of the same formula. A wizard that reported a room "noisy"
// while the gate that decides what reaches the daemon stayed quiet would be two
// opinions about one room, and the one the user sees is the one that has to be
// the same number.
//
// WHY THE COMPARISON IS STRICT, exactly as the gate's is. `isSpeechFrame` is
// `energyDb > -30`, so a floor sitting exactly ON the line does not trip it.
// Putting that same value in `borderline` keeps the two functions in agreement
// rather than one being off by the width of a comparison operator.
//
// WHY p90 AND NOT THE MEDIAN. A room with a fan or an air conditioner cycles:
// its tone is quiet and then loud, repeatedly. A median calls that room quiet
// and a max calls it as loud as a slammed door. The number that competes with
// quiet speech is the loud part of a quiet period, so the floor is read at the
// 90th percentile — which also means one transient (a door, a cough) is one
// sample out of thirty rather than the level of the room.
//
// THREE OUTCOMES, and no fourth. The absence of a measurement is NOT a fourth
// band: below `MIN_SAMPLES` there is no floor to name, so `floorDb` is null and
// the band falls to the conservative arm. `quiet` is the one band whose copy
// would tell a user their microphone is fine, and a wizard that says that from
// no evidence is worse than a wizard that says nothing.
//
// NO THRESHOLD IS STORED OR PROPOSED, and the copy says so. A measured floor
// affects barge-in ducking only, and nobody has measured that effect, so a
// "save this" affordance would claim a consequence that has not been observed.
// The renderer also has nowhere durable to put a value: no storage API is used
// anywhere in this tree and the webview exposes no file capability.

/**
 * The speech gate, in dBFS. The same number `isSpeechFrame` defaults to; a
 * wizard that drifted from it would compare the room against a gate the gate
 * itself does not use.
 */
export const GATE_DB = -30;

/**
 * Headroom below the gate that a room must clear before it is called quiet.
 * Fifteen decibels is a JUDGEMENT, stated here so it is visible rather than
 * buried in a comparison — it is not derived from a measurement.
 */
export const QUIET_MARGIN_DB = 15;

/**
 * Frames required before a floor is claimed at all. Uplink frames are 100 ms
 * (`capture.ts`), so ten of them is one second — a fraction of a breath, and
 * not a room.
 */
export const MIN_SAMPLES = 10;

/** The percentile the room floor is read at. See the header. */
export const FLOOR_PERCENTILE = 90;

/** Exactly three bands. The unmeasured case reuses `noisy`; see the header. */
export type CalibrationBand = 'quiet' | 'borderline' | 'noisy';

export interface CalibrationVerdict {
  /**
   * `quiet`      — the floor clears the gate by `QUIET_MARGIN_DB` or more.
   * `borderline` — under the gate, but with little headroom.
   * `noisy`      — at or above the gate, OR nothing was measured.
   */
  readonly band: CalibrationBand;
  /** The measured floor in dBFS, or null when nothing was measured. */
  readonly floorDb: number | null;
  /** False below `MIN_SAMPLES`. The copy branches on this, not on the band. */
  readonly measured: boolean;
  readonly sampleCount: number;
  readonly gateDb: number;
}

/**
 * The band table, as a function of a floor in dBFS.
 *
 * Exported so the boundaries can be probed at the exact values they turn on —
 * a table buried inside `calibrationVerdict` can only be tested with frames,
 * and a frame's dB is a float, so "exactly on the line" is not reachable from
 * outside.
 */
export function bandForFloorDb(floorDb: number, gateDb: number = GATE_DB): CalibrationBand {
  if (floorDb <= gateDb - QUIET_MARGIN_DB) return 'quiet';
  if (floorDb <= gateDb) return 'borderline';
  return 'noisy';
}

/** Nearest-rank percentile. Deterministic and allocation-light. */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
}

/**
 * Judge a room from a set of captured frames.
 *
 * Every sample is read with the shared `frameEnergyDb`, so a frame the gate
 * would call speech and a sample the wizard calls noise are the same
 * measurement. The input is never mutated and the result depends on nothing
 * but the input.
 *
 * @param samples captured mono Int16 frames; empty and short sets are allowed
 *        and return `measured: false` with no floor.
 */
export function calibrationVerdict(
  samples: readonly Int16Array[],
  gateDb: number = GATE_DB,
): CalibrationVerdict {
  const sampleCount = samples.length;
  if (sampleCount < MIN_SAMPLES) {
    return { band: 'noisy', floorDb: null, measured: false, sampleCount, gateDb };
  }
  const energies = samples.map((frame) => frameEnergyDb(frame));
  const floorDb = percentile(energies, FLOOR_PERCENTILE);
  return { band: bandForFloorDb(floorDb, gateDb), floorDb, measured: true, sampleCount, gateDb };
}
