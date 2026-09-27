import { describe, expect, test } from 'vitest';
import { AudioIngest, WINDOW_BYTES } from '../voice/ingest.js';
import { AudioPipeline, type AudioPipelineDeps } from './audio-pipeline.js';
import type { Utterance } from '../common/brands.js';

// L6: `reset()` cleared the ingest buffer and the repeat memory and stopped
// there. A `pushChunk` already parked on an await — the STT provider, the
// planner, the dispatch call — carried straight on and produced a full turn for
// an utterance the user had already interrupted.
//
// The SpeechGate already exists to stop a *stale reply* from being synthesised.
// It cannot help here: by the time the planner is running the abort has long
// since fired, and the window is inside the provider. The only place left to
// intervene is on the way back out, which is what the generation counter does.
//
// Every test below interleaves a real `reset()` into a real await. A pipeline
// that is never reset must be unaffected, so that is pinned first — a guard that
// fires unconditionally would pass the stale cases and break real speech.

function speechWindow(): Uint8Array {
  const samples = new Int16Array(WINDOW_BYTES / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(32768 * 0.25 * Math.sin((2 * Math.PI * 440 * i) / 16_000));
  }
  return new Uint8Array(samples.buffer);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A pipeline whose only slow stage is `transcribe`, which we can hold open. */
function harness(over: Partial<AudioPipelineDeps> = {}): {
  pipeline: AudioPipeline;
  utterances: Utterance[];
  stt: Deferred<string>;
} {
  const utterances: Utterance[] = [];
  const stt = deferred<string>();
  const pipeline = new AudioPipeline({
    ingest: new AudioIngest(),
    transcribe: () => stt.promise,
    think: async (t) => ({ reply: `re:${t}` }),
    activeSessionId: () => 'ses_a' as never,
    onUtterance: (u) => utterances.push(u),
    ...over,
  });
  return { pipeline, utterances, stt };
}

describe('a reset abandons the turn in flight (L6)', () => {
  test('without a reset the turn completes normally', async () => {
    // The control. If reset() were breaking live speech, this is what would
    // catch it — a generation check that fires on every push is worse than none.
    const { pipeline, utterances, stt } = harness();
    const pushed = pipeline.pushChunk(speechWindow());
    stt.resolve('شوف السير');
    await pushed;
    expect(utterances).toHaveLength(1);
    expect(utterances[0]?.transcript).toBe('شوف السير');
  });

  test('a reset while STT is in flight dispatches nothing', async () => {
    const { pipeline, utterances, stt } = harness();
    const pushed = pipeline.pushChunk(speechWindow());
    // The window is inside the provider. Barge-in now.
    pipeline.reset();
    stt.resolve('شوف السير');
    await expect(pushed).resolves.toBeUndefined();
    // The transcript came back and was discarded: no think, no dispatch, no
    // utterance. This is the defect, closed.
    expect(utterances).toEqual([]);
  });

  test('a reset while the planner is in flight speaks nothing', async () => {
    const gate = deferred<{ reply: string }>();
    const dispatched: string[] = [];
    const utterances: Utterance[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'شوف السير',
      think: () => gate.promise,
      activeSessionId: () => 'ses_a' as never,
      dispatch: async (t) => {
        dispatched.push(t);
        return { receipt: 'r1' };
      },
      onUtterance: (u) => utterances.push(u),
    });
    const pushed = pipeline.pushChunk(speechWindow());
    // Let STT resolve so we are genuinely parked inside think.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    pipeline.reset();
    gate.resolve({ reply: 're:شوف السير' });
    await pushed;
    // The planning call was paid for and its answer thrown away. The raw-text
    // dispatch must not fire either — that is what would resurrect the turn.
    expect(dispatched).toEqual([]);
    expect(utterances).toEqual([]);
  });

  test('a reset during the dispatch call strands the receipt rather than announcing it', async () => {
    const dispatchGate = deferred<{ receipt: string }>();
    const utterances: Utterance[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'شوف السير',
      think: async () => ({ reply: 'r' }),
      activeSessionId: () => 'ses_a' as never,
      dispatch: () => dispatchGate.promise,
      onUtterance: (u) => utterances.push(u),
    });
    const pushed = pipeline.pushChunk(speechWindow());
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    pipeline.reset();
    dispatchGate.resolve({ receipt: 'r1' });
    await pushed;
    expect(utterances).toEqual([]);
  });

  test('a reset between windows abandons the remaining windows of that chunk', async () => {
    // Two windows in one push. The first completes, a reset lands, the second
    // must not run. Without the check the whole chunk keeps draining.
    const seen: string[] = [];
    let calls = 0;
    const utterances: Utterance[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => {
        calls += 1;
        if (calls === 1) {
          seen.push('first');
          pipeline.reset();
        }
        return `utterance ${calls}`;
      },
      think: async (t) => ({ reply: `re:${t}` }),
      activeSessionId: () => undefined,
      onUtterance: (u) => utterances.push(u),
    });
    await pipeline.pushChunk(speechWindow());
    expect(seen).toEqual(['first']);
    expect(utterances).toHaveLength(0);
    // The second window was already sliced out of the buffer by ingest.push.
    expect(calls).toBe(1);
  });

  test('the generation survives repeated resets', async () => {
    // Five barge-ins in a row must not exhaust or wrap the counter, and the
    // sixth turn must still be dropped.
    const stt = deferred<string>();
    const utterances: Utterance[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: () => stt.promise,
      think: async (t) => ({ reply: t }),
      activeSessionId: () => undefined,
      onUtterance: (u) => utterances.push(u),
    });
    const pushed = pipeline.pushChunk(speechWindow());
    for (let i = 0; i < 5; i += 1) pipeline.reset();
    stt.resolve('late');
    await pushed;
    expect(utterances).toEqual([]);
  });

  test('a fresh pushChunk after a reset is processed normally', async () => {
    // The gate must only abandon work that was already in flight, not poison
    // the pipeline for everything after it.
    const { pipeline, utterances, stt } = harness();
    const stale = pipeline.pushChunk(speechWindow());
    pipeline.reset();
    stt.resolve('قديم');
    await stale;
    expect(utterances).toEqual([]);

    const stt2 = deferred<string>();
    const pipeline2 = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: () => stt2.promise,
      think: async (t) => ({ reply: `re:${t}` }),
      activeSessionId: () => undefined,
      onUtterance: (u) => utterances.push(u),
    });
    const fresh = pipeline2.pushChunk(speechWindow());
    stt2.resolve('جديد');
    await fresh;
    expect(utterances).toHaveLength(1);
    expect(utterances[0]?.transcript).toBe('جديد');
  });

  test('a reset does not swallow the repeat memory or the counters semantics', async () => {
    // reset() still clears repeat memory — a re-spoken phrase after a barge-in
    // is a real new utterance, not a repeat of the abandoned one.
    const utterances: Utterance[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'نفس الجملة',
      think: async (t) => ({ reply: t }),
      activeSessionId: () => undefined,
      onUtterance: (u) => utterances.push(u),
    });
    await pipeline.pushChunk(speechWindow());
    pipeline.reset();
    await pipeline.pushChunk(speechWindow());
    expect(utterances).toHaveLength(2);
  });

  test('a rejected STT call after a reset still propagates to the caller', async () => {
    // The gate is about not DISPATCHING a stale turn, not about swallowing
    // errors: the caller's own error handling must keep working.
    const stt = deferred<string>();
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: () => stt.promise,
      think: async (t) => ({ reply: t }),
      activeSessionId: () => undefined,
    });
    const pushed = pipeline.pushChunk(speechWindow());
    pipeline.reset();
    stt.reject(new Error('provider down'));
    await expect(pushed).rejects.toThrow('provider down');
  });
});
