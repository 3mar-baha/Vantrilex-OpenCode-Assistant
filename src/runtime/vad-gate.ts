// M3-B.4 — the speech gate, extracted from `daemon.ts` so it can be time-boxed.
//
// Before this, `daemon.ts` owned the gate inline: a memoised dynamic
// `import('./runtime/vad.js')`, then up to 156 serial `await vad.isSpeech(frame)`
// calls with no timeout anywhere. Two defects, both real:
//
//   1. A hung ONNX session — or a `load` that never settles — stalled the audio
//      path forever. STT has a 15 s timeout (`stt.ts:135`); the gate had none, so
//      the one component with no bound was the one every window depends on.
//   2. If the load or the frame loop rejected after the gate had already decided,
//      nothing was awaiting it and the rejection was unhandled. That is a
//      process-level crash class, not hygiene.
//
// Two rules that are easy to get backwards, so they are stated here:
//
//   * A timeout degrades to `fallback(window)`, never to `false`. `false` means
//     "no speech" to the caller, and this gate's whole reason to exist is that
//     room tone must not reach Whisper — answering `false` on a stall would
//     silently drop the user's actual words while looking like a correct verdict.
//   * The timer is armed only when a model is actually loaded. A timer per window
//     on the absent-model path is pure overhead, and would make the fallback
//     slower than the code it replaces.
//
// Transport-blind by construction: no UI, WS or audio-pipeline imports. It knows
// PCM bytes, a model, a fallback, and a deadline.

import { bytesToFloat32 } from '../voice/ingest.js';

/**
 * Deadline for one window's VAD decision.
 *
 * WHY 2000: a 5 s window is 156 serial `isSpeech` awaits (160000 B / 2 / 512,
 * asserted in `vad-gate.test.ts`), each one an ONNX `session.run` on a CPU-only
 * runtime with no GPU and no batching. 2000 ms is ~12.8 ms per frame, which is
 * generous for Silero v4/v5 at 512 samples and still short enough that a stalled
 * window costs a fraction of the 15 s STT timeout sitting behind it — the
 * user-visible cost of a timeout is one gate degradation, not a dropped turn.
 *
 * This is a reasoned ceiling, not a measured one: **Silero has never shipped.**
 * `models/*.onnx` is gitignored and `tauri.conf.json` bundles only the sidecar,
 * so every installed build runs the RMS fallback and the model path is untimed in
 * the field. Re-measure this number when an ONNX model actually ships, and treat
 * a measured p99 well under it as the new value.
 */
export const VAD_GATE_TIMEOUT_MS = 2000;

/**
 * Mirrored from `runtime/vad.ts:9` deliberately: that module imports
 * `onnxruntime-node`, a native package the sidecar does not bundle, so importing
 * the constant from there would turn a missing package into a hard module-load
 * failure — the exact bug the daemon's dynamic import exists to avoid. 512
 * samples @ 16 kHz is 32 ms, the geometry Silero is exported for.
 */
const VAD_WINDOW_SAMPLES = 512;

/** The subset of `SileroVad` the gate uses. Structural: tests stub it. */
export interface VadModule {
  isSpeech(frame: Float32Array): Promise<boolean>;
}

/** Resolves `null` when the model is absent or unloadable — never rejects. */
export type VadLoad = () => Promise<VadModule | null>;

/** The RMS energy gate in `voice/ingest.ts`. The behaviour that works today. */
export type VadFallback = (window: Uint8Array) => boolean;

/** What `AudioPipeline` consumes (`audio-pipeline.ts:38`). */
export type VadGate = (window: Uint8Array) => Promise<boolean>;

export function makeVadGate(
  load: VadLoad,
  fallback: VadFallback,
  timeoutMs: number = VAD_GATE_TIMEOUT_MS,
): VadGate {
  // The settled state of `load`, kept separately from the promise so the steady
  // state needs no await and no timer: once we know there is no model, every
  // later window is a straight call to `fallback`.
  let model: VadModule | null = null;
  let settled = false;
  let inflight: Promise<VadModule | null> | null = null;

  /**
   * A 5 s window is 156 Silero frames; any speech frame admits the window. Kept
   * serial and unchanged: the model carries recurrent state across frames, so
   * running them concurrently would corrupt it.
   */
  const scanFrames = async (vad: VadModule, window: Uint8Array): Promise<boolean> => {
    const frames = Math.floor(window.byteLength / 2 / VAD_WINDOW_SAMPLES);
    for (let f = 0; f < frames; f += 1) {
      const frame = bytesToFloat32(window, f * VAD_WINDOW_SAMPLES * 2, VAD_WINDOW_SAMPLES);
      if (await vad.isSpeech(frame)) return true;
    }
    return false;
  };

  /**
   * Race `work` against the deadline, degrading to `fallback(window)`. The timer
   * is always cleared — on the fast path it has not fired, and leaving it armed
   * would keep the event loop (and every later assertion about pending timers)
   * alive for `timeoutMs` after a decision nobody is waiting for.
   */
  const decide = async (work: Promise<boolean>, window: Uint8Array): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>((resolve) => {
      // A THROW inside a `setTimeout` callback is an uncaughtException, which
      // takes the process down — strictly worse than the rejected promise this
      // deadline exists to replace. `isLoudWindow` is arithmetic and cannot
      // throw, but `VadFallback` is a public type and the next caller need not
      // be. A fallback that cannot answer resolves `true` (admit the window),
      // which keeps this file's one invariant total: a stall must never become
      // "the user said nothing". (Peer review.)
      timer = setTimeout(() => {
        try {
          resolve(fallback(window));
        } catch {
          resolve(true);
        }
      }, timeoutMs);
    });
    // The loser keeps running after the deadline and can still reject long after
    // this gate returned. `Promise.race` below already subscribes to both sides,
    // so the rejection is handled without this line — measured, and honest to
    // say so. What the line buys is that the property lives at the statement
    // that ABANDONS the work: a future edit replacing the race with a manual
    // settle would reintroduce the crash class, and this would survive it. The
    // tests pin the property, not this line — deleting it keeps them green.
    work.catch(() => undefined);
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /**
   * Resolve the model, bounding the wait. A `load` that never settles is
   * indistinguishable from "no model" as far as the caller is concerned, so both
   * land on the fallback.
   *
   * The `settled` latch makes the STEADY state free: once the load has resolved
   * either way, `model` is known and this returns it without awaiting or arming
   * anything. It does NOT make a never-settling load free — that promise never
   * settles, so `settled` stays false and every subsequent window re-enters the
   * race and arms one deadline of its own. Bounded, not free: one timer per
   * inbound 5 s window, each cleared in the `finally` below, so it cannot
   * accumulate. (An earlier version of this comment claimed "at most once per
   * gate", which is false for a hung load; pinned by the consecutive-window test
   * in `vad-gate.test.ts`.)
   */
  const resolveModel = async (): Promise<VadModule | null> => {
    if (settled) return model;
    inflight ??= load().then(
      (m) => {
        model = m;
        settled = true;
        return m;
      },
      () => {
        // A rejected load is a missing model, not a failed turn. `daemon.ts`
        // already swallows its own, but the gate must not depend on that.
        model = null;
        settled = true;
        return null;
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      return await Promise.race([inflight, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return async (window: Uint8Array): Promise<boolean> => {
    const vad = await resolveModel();
    // No model: no deadline. A timer here would be armed and cleared on every
    // window to guard a path that cannot hang.
    if (vad === null) return fallback(window);
    return decide(scanFrames(vad, window), window);
  };
}
