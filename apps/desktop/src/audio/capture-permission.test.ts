import { describe, expect, test, vi, afterEach } from 'vitest';
import { AudioCapture } from './capture.js';
import { micFailureNotice } from './vad.js';

// SEC-7 — the reason a microphone failed must survive the trip out of
// `getUserMedia`.
//
// `AudioCapture.start()` wraps the rejection in a `new Error(...)` to give a
// uniform message. That silently set `name` to "Error", which collapsed
// NotAllowedError / NotFoundError / NotReadableError into one indistinguishable
// failure — so the user-facing notice could never say which it was, and a
// report of "voice is dead" carried no information. This pins the `name`.

const realNavigator = globalThis.navigator;

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { value: realNavigator, configurable: true, writable: true });
  vi.unstubAllGlobals();
});

/** Make `getUserMedia` reject with a DOMException-shaped error. */
function stubGetUserMedia(name: string): void {
  const domException = Object.assign(new Error(`${name}: permission blocked`), { name });
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(domException) } },
    configurable: true,
    writable: true,
  });
  // happy-dom supplies AudioContext; stub only what start() touches.
  vi.stubGlobal(
    'AudioContext',
    class {
      createMediaStreamSource(): never {
        throw new Error('unreachable in this test');
      }
    },
  );
}

describe('microphone failure preserves the DOMException name (SEC-7)', () => {
  for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError']) {
    test(`${name} survives the wrap and reaches the notice`, async () => {
      stubGetUserMedia(name);
      const capture = new AudioCapture();
      let thrown: unknown;
      try {
        await capture.start({ onFrame: () => undefined });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      // The name is the whole point.
      expect((thrown as Error).name).toBe(name);
      // The original is retained rather than discarded.
      expect((thrown as Error).cause).toBeInstanceOf(Error);
      // And the reason survives all the way to what the user reads.
      expect(micFailureNotice(thrown)).not.toBe('تعذّر الوصول إلى الميكروفون');
    });
  }

  test('the three causes still map to three different instructions', async () => {
    const notices = new Set<string>();
    for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError']) {
      stubGetUserMedia(name);
      try {
        await new AudioCapture().start({ onFrame: () => undefined });
      } catch (err) {
        notices.add(micFailureNotice(err));
      }
    }
    expect(notices.size).toBe(3);
  });

  test('start() is idempotent, so a visibility restore cannot double-open the mic', async () => {
    // The L19 handler calls start() on every return to a visible window. If
    // start() were not guarded, a spurious visibilitychange would open a second
    // capture graph and leak a hardware track.
    const capture = new AudioCapture();
    (capture as unknown as { running: boolean }).running = true;
    // No getUserMedia stub needed: a guarded start returns before touching it,
    // so reaching the media layer at all would mean the guard is gone.
    await expect(capture.start({ onFrame: () => undefined })).resolves.toBeUndefined();
  });
});
