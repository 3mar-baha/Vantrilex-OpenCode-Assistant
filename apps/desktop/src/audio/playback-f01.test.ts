import { describe, expect, test, vi } from 'vitest';
import { AudioPlayer } from './playback.js';

// F-01: `drain()` is invoked as a floating promise, and its `finally` block
// called the caller-supplied `onEnd` with nothing able to catch a throw from it.
// A consumer callback that threw therefore rejected a promise nobody awaited,
// surfacing as a global `unhandledrejection` in the WebView2 renderer.
//
// The shipped app passes a bare `window.setTimeout` for `onEnd`, so this was not
// reachable. It becomes reachable the moment a second consumer is added that can
// throw — a state update after unmount, an unguarded accessor — and nothing in
// the `readonly onEnd?: () => void` signature says the callback sits on a
// rejection path.

/** Captures unhandled rejections for the duration of `fn`. */
async function withUnhandledRejectionCapture<T>(fn: () => Promise<T>): Promise<{ result?: T; rejections: unknown[] }> {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  try {
    const result = await fn();
    // Give the microtask queue a chance to surface a rejection before asserting.
    await new Promise((r) => setTimeout(r, 20));
    return { result, rejections };
  } finally {
    process.off('unhandledRejection', onRejection);
  }
}

function makePlayer(onEnd?: () => void): AudioPlayer {
  return new AudioPlayer({
    // The real decode path returns an AudioBuffer from the Web Audio API. This
    // test never inspects it - `sink.play` is a no-op - so a structural stand-in
    // is enough and avoids standing up an AudioContext in happy-dom.
    decode: async () => ({}) as unknown as AudioBuffer,
    sink: { play: () => undefined },
    ...(onEnd !== undefined ? { onEnd } : {}),
  });
}

describe('a throwing onEnd cannot reject the floating drain promise (F-01)', () => {
  test('no unhandled rejection is raised when onEnd throws', async () => {
    const player = makePlayer(() => {
      throw new Error('consumer blew up');
    });
    const { rejections } = await withUnhandledRejectionCapture(async () => {
      player.enqueue(new Uint8Array([1, 2, 3]));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(rejections).toEqual([]);
    player.dispose();
  });

  test('the player is not wedged - a later enqueue still plays', async () => {
    // The important half. Swallowing the throw is only safe because `draining` is
    // reset before the try; if it were not, the second enqueue would be dropped
    // and the player would be dead for the rest of the session.
    const onEnd = vi.fn(() => {
      throw new Error('consumer blew up');
    });
    const player = makePlayer(onEnd);
    await withUnhandledRejectionCapture(async () => {
      player.enqueue(new Uint8Array([1, 2, 3]));
      await new Promise((r) => setTimeout(r, 30));
      player.enqueue(new Uint8Array([4, 5, 6]));
      await new Promise((r) => setTimeout(r, 30));
    });
    // It was called twice, i.e. the second enqueue drained rather than returning
    // early on a stuck `draining` flag.
    expect(onEnd).toHaveBeenCalledTimes(2);
    player.dispose();
  });

  test('a normal onEnd still fires exactly once', async () => {
    // The control. A fix that swallowed everything would pass the two tests above
    // and break the actual feature.
    const onEnd = vi.fn();
    const player = makePlayer(onEnd);
    player.enqueue(new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 30));
    expect(onEnd).toHaveBeenCalledTimes(1);
    player.dispose();
  });

  test('onEnd is optional and its absence is not an error', async () => {
    const player = makePlayer();
    const { rejections } = await withUnhandledRejectionCapture(async () => {
      player.enqueue(new Uint8Array([1, 2, 3]));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(rejections).toEqual([]);
    player.dispose();
  });
});
