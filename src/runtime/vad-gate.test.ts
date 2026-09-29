import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeVadGate, type VadModule } from './vad-gate.js';

// The speech gate decides whether a 5 s window reaches Whisper. Before M3-B.4
// `daemon.ts` owned it inline: a memoised dynamic `import('./runtime/vad.js')`,
// then a serial `for` loop of up to 156 `await vad.isSpeech(frame)` calls with
// NO timeout and no handler on the abandoned promise. Two defects:
//   1. a hung ONNX session (or a load that never settles) stalls the audio path
//      forever — STT has a 15 s timeout, the gate had none;
//   2. if the load or the loop rejected after the gate had already decided, the
//      rejection had no handler and Node raised `unhandledRejection`.
//
// Fake timers throughout: the timeout is the behaviour under test, and a real
// 2 s wait per test would make the suite slow for no extra signal.
const WINDOW = new Uint8Array(160_000); // one 5 s window at 16 kHz Int16 (WINDOW_BYTES)
const FRAMES = Math.floor(WINDOW.byteLength / 2 / 512); // 156 Silero frames

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test('with no model the gate answers from the fallback and arms no timer per window', async () => {
  const load = vi.fn(async (): Promise<VadModule | null> => null);
  const fallback = vi.fn((window: Uint8Array) => {
    void window;
    return true;
  });
  const gate = makeVadGate(load, fallback);

  await expect(gate(WINDOW)).resolves.toBe(true);
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(fallback.mock.calls[0]?.[0], 'the fallback sees the same window bytes').toBe(WINDOW);

  // The steady state, watched closely. `getTimerCount()` alone cannot see this:
  // a timer armed and cleared inside the same tick leaves nothing pending, so an
  // implementation that re-raced the (already settled) load on every window would
  // still read 0. The setTimeout spy is what actually pins it.
  const armed = vi.spyOn(globalThis, 'setTimeout');
  await expect(gate(WINDOW)).resolves.toBe(true);
  expect(fallback).toHaveBeenCalledTimes(2);
  expect(armed, 'a known-absent model must not arm a deadline per window').not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(load, 'and the load is not re-issued either').toHaveBeenCalledTimes(1);
  armed.mockRestore();
});

test('a load that never settles degrades to the fallback, not to false and not to a hang', async () => {
  // This window WOULD pass the gate, so resolving `false` on timeout would be
  // indistinguishable from a correct "no speech" verdict to the caller while
  // silently dropping every word the user said.
  const fallback = vi.fn(() => true);
  const gate = makeVadGate(() => new Promise<VadModule | null>(() => {}), fallback, 50);

  const decided = gate(WINDOW);
  let settled = false;
  void decided.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(50);

  await expect(decided).resolves.toBe(true);
  expect(fallback, 'the timeout must degrade to the gate that works today').toHaveBeenCalledTimes(1);

  // Not a hang: nothing more arrives, and the answer is already final.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settled, 'the gate decided at the timeout and did not wait for the model').toBe(true);
  expect(fallback).toHaveBeenCalledTimes(1);
});

test('a load that rejects before any deadline degrades to the fallback', async () => {
  // The other rejection shape: the failure is immediate, so the gate must not
  // propagate it either. `daemon.ts` swallows its own load failure, but the gate
  // must not depend on that — a propagating rejection here fails the whole turn.
  const fallback = vi.fn(() => true);
  const gate = makeVadGate(() => Promise.reject(new Error('onnxruntime missing')), fallback);

  await expect(gate(WINDOW)).resolves.toBe(true);
  expect(fallback).toHaveBeenCalledTimes(1);
});

test('a load that rejects after the gate gave up raises no unhandled rejection', async () => {
  const seen: unknown[] = [];
  const spy = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', spy);
  try {
    const failLoad: { reject?: (err: Error) => void } = {};
    const gate = makeVadGate(
      () =>
        new Promise<VadModule | null>((_resolve, reject) => {
          failLoad.reject = reject;
        }),
      () => true,
      50,
    );

    const decided = gate(WINDOW);
    await vi.advanceTimersByTimeAsync(50);
    await expect(decided).resolves.toBe(true);

    // The load finally fails, long after the only awaiter moved on. With no
    // handler attached to the loser this is a process-level unhandledRejection,
    // which is a crash class rather than hygiene: nothing is left to catch it.
    if (failLoad.reject === undefined) throw new Error('the load never captured its reject');
    failLoad.reject(new Error('onnxruntime never came up'));

    // Real timers for the flush — Node emits `unhandledRejection` off the
    // microtask checkpoint, and a faked setImmediate would never yield to it.
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen, 'the abandoned load must be handled, not merely awaited once').toEqual([]);
  } finally {
    process.off('unhandledRejection', spy);
    vi.useRealTimers();
  }
});

test('the fast path with a model present asks the model and leaves no timer pending', async () => {
  // The setTimeout spy is what keeps this test from being vacuous: an
  // implementation that never arms a timer at all would trivially satisfy
  // `getTimerCount() === 0` while still being the hang this fix removes.
  const armed = vi.spyOn(globalThis, 'setTimeout');
  const isSpeech = vi.fn(async () => false); // a loaded model, no speech in the window
  const gate = makeVadGate(async () => ({ isSpeech } satisfies VadModule), () => true);

  // `false` (the model's own verdict) and not `true` (the fallback's) proves the
  // model was really consulted rather than short-circuited.
  await expect(gate(WINDOW)).resolves.toBe(false);
  expect(isSpeech, 'a 5 s window is 156 serial Silero frames').toHaveBeenCalledTimes(FRAMES);

  expect(armed, 'a loaded model must be time-boxed').toHaveBeenCalled();
  expect(vi.getTimerCount(), 'the fast path must clear the timeout it armed').toBe(0);
  armed.mockRestore();
});

test('a never-settling load arms one deadline per window and never accumulates them', async () => {
  // Pins the bound the `settled` latch does NOT provide. A load that never
  // resolves leaves `settled` false forever, so every window re-enters the race.
  // One timer per inbound window, each cleared — bounded, not free. Without the
  // `getTimerCount()` assertion below, a version that never cleared them would
  // read as merely "slow" and pass every other test here.
  const armed = vi.spyOn(globalThis, 'setTimeout');
  const gate = makeVadGate(() => new Promise<VadModule | null>(() => {}), () => true, 50);

  for (let window = 0; window < 3; window += 1) {
    const decided = gate(WINDOW);
    await vi.advanceTimersByTimeAsync(50);
    await expect(decided).resolves.toBe(true);
    expect(vi.getTimerCount(), `after window ${window + 1}, nothing left pending`).toBe(0);
  }
  // One per window, three windows, and the load was still issued only ONCE — the
  // memoisation holds even though it never settles.
  expect(armed).toHaveBeenCalledTimes(3);
  armed.mockRestore();
});

test('a model whose isSpeech never resolves is time-boxed to the fallback', async () => {
  // The primary hang, and the one the other tests cannot reach: the model loads
  // fine and then a single `session.run` never returns. Before B.4 this awaited
  // 156 of those in a bare serial loop with no deadline at all.
  const isSpeech = vi.fn(() => new Promise<boolean>(() => {}));
  const fallback = vi.fn(() => true);
  const gate = makeVadGate(async () => ({ isSpeech } satisfies VadModule), fallback, 50);

  const decided = gate(WINDOW);
  await vi.advanceTimersByTimeAsync(50);

  await expect(decided, 'a stalled model must not become a silent "no speech"').resolves.toBe(true);
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(isSpeech).toHaveBeenCalledTimes(1); // stopped at the deadline, not 156 deep
  expect(vi.getTimerCount(), 'the fired deadline is not left pending').toBe(0);
});

test('a frame loop that rejects after the deadline raises no unhandled rejection', async () => {
  // The other loser: `Promise.race` settles the gate, but the abandoned frame
  // chain keeps awaiting and can still reject long afterwards.
  const seen: unknown[] = [];
  const spy = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', spy);
  try {
    const failFrame: { reject?: (err: Error) => void } = {};
    const isSpeech = vi.fn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          failFrame.reject = reject;
        }),
    );
    const gate = makeVadGate(async () => ({ isSpeech } satisfies VadModule), () => true, 50);

    const decided = gate(WINDOW);
    await vi.advanceTimersByTimeAsync(50);
    await expect(decided).resolves.toBe(true);

    if (failFrame.reject === undefined) throw new Error('the frame loop never captured its reject');
    failFrame.reject(new Error('onnxruntime session died mid-window'));
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen, 'the abandoned frame loop must be handled').toEqual([]);
  } finally {
    process.off('unhandledRejection', spy);
    vi.useRealTimers();
  }
});
