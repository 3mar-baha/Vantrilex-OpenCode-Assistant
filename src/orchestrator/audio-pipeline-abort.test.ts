import { describe, expect, test } from 'vitest';
import { AudioIngest, WINDOW_BYTES } from '../voice/ingest.js';
import { AudioPipeline, type Utterance } from './audio-pipeline.js';

// C4: `abort` (barge-in) trips the daemon's SpeechGate and NOTHING else.
//
// The SpeechGate is a TTS gate. It stops sentences being synthesised and
// broadcast — but by the time it fires, the turn is usually already inside the
// planner, and a planner that nobody stops runs to completion and costs a real
// free-tier model call whose answer is then thrown away. Cancelling means the
// request, not the playback, so `AudioPipeline.cancel()` bumps the same
// generation `reset()` does.
//
// `cancel()` is deliberately NOT `reset()`: reset() also forgets the repeat
// history, and a re-spoken phrase after a barge-in is a real new utterance, not
// a repeat of the abandoned one. The pair of tests at the bottom pins that
// difference, because collapsing them back into one method would silently make
// barge-in swallow speech.

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

describe('a cancel abandons the turn in flight (C4)', () => {
  test('without a cancel the turn completes normally', async () => {
    // The control. A generation check that fires on every push is worse than
    // none: it would break live speech and still pass every stale case.
    const utterances: Utterance[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'شوف السير',
      think: async (t) => ({ reply: `re:${t}` }),
      activeSessionId: () => undefined,
      onUtterance: (u) => utterances.push(u),
    });
    await pipeline.pushChunk(speechWindow());
    expect(utterances).toHaveLength(1);
  });

  test('a cancel while the planner is in flight never narrates the reply', async () => {
    // The defect, exactly as it shipped: the abort lands, the planner keeps
    // going, and its answer arrives for a turn the user already stopped.
    const planner = deferred<{ reply: string }>();
    const dispatched: string[] = [];
    const utterances: Utterance[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'شوف السير',
      think: () => planner.promise,
      activeSessionId: () => 'ses_a' as never,
      dispatch: async (t) => {
        dispatched.push(t);
        return { receipt: 'r1' };
      },
      onUtterance: (u) => utterances.push(u),
    });
    const pushed = pipeline.pushChunk(speechWindow());
    // Let STT resolve so we are genuinely parked inside think, not inside STT.
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    pipeline.cancel();
    planner.resolve({ reply: 'ردّ قديم' });
    await pushed;

    // `onUtterance` is what the daemon narrates (TTS + the on-screen line), so
    // an empty array here IS "the stale reply is never narrated".
    expect(utterances).toEqual([]);
    // The raw-text fallback must not resurrect the turn either.
    expect(dispatched).toEqual([]);
  });

  test('a cancel while STT is in flight never reaches the planner', async () => {
    const stt = deferred<string>();
    const thought: string[] = [];
    const utterances: Utterance[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: () => stt.promise,
      think: async (t) => {
        thought.push(t);
        return { reply: `re:${t}` };
      },
      activeSessionId: () => undefined,
      onUtterance: (u) => utterances.push(u),
    });
    const pushed = pipeline.pushChunk(speechWindow());
    pipeline.cancel();
    stt.resolve('شوف السير');
    await expect(pushed).resolves.toBeUndefined();
    expect(thought).toEqual([]);
    expect(utterances).toEqual([]);
  });

  test('a cancel drops the buffered audio of the cancelled turn', async () => {
    // Half a window is not a turn. Feeding the tail of it to the STT provider
    // after a barge-in spends quota on audio the user retracted — and the window
    // only becomes a window when the LAST bytes arrive, so this is the only way
    // to observe the difference: 15 000 buffered bytes, cancel, then the final
    // 1 000. With the buffer retained they complete a 16 000-byte window and the
    // provider is called.
    const stt = deferred<string>();
    const transcribed: number[] = [];
    const utterances: Utterance[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: (pcm) => {
        transcribed.push(pcm.byteLength);
        return stt.promise;
      },
      think: async (t) => ({ reply: t }),
      activeSessionId: () => undefined,
      onUtterance: (u) => utterances.push(u),
    });
    const window = speechWindow();
    const partial = window.slice(0, WINDOW_BYTES - 1000);
    const tail = window.slice(WINDOW_BYTES - 1000);

    const first = pipeline.pushChunk(partial);
    expect(pipeline.bufferedBytes, "precondition: a partial window is buffered, not transcribed").toBe(
      WINDOW_BYTES - 1000,
    );
    pipeline.cancel();
    expect(pipeline.bufferedBytes, "cancel must drop the buffered audio").toBe(0);

    const second = pipeline.pushChunk(tail);
    stt.resolve('مقطوع');
    await Promise.all([first, second]);
    expect(transcribed, "a cancelled turn's audio must never reach the STT provider").toEqual([]);
    expect(utterances).toEqual([]);

    // And the pipeline is still usable afterwards: cancel is not poison.
    const live = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'جديد',
      think: async (t) => ({ reply: t }),
      activeSessionId: () => undefined,
      onUtterance: (u) => utterances.push(u),
    });
    await live.pushChunk(speechWindow());
    expect(utterances).toHaveLength(1);
  });

  test('a cancel forgets the retracted turn so re-speaking it works', async () => {
    // `remember()` runs BEFORE `think`, so a cancelled turn's transcript is in
    // the repeat memory. If cancel left it there, the user re-speaking the same
    // phrase after the barge-in would be dropped as a duplicate — the answer
    // they were trying to get, swallowed, with no error anywhere.
    const utterances: Utterance[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'نفس الجملة',
      think: async (t) => ({ reply: t }),
      activeSessionId: () => undefined,
      onUtterance: (u) => utterances.push(u),
    });
    await pipeline.pushChunk(speechWindow());
    pipeline.cancel();
    await pipeline.pushChunk(speechWindow());
    expect(utterances).toHaveLength(2);

    // And the repeat memory is still a repeat memory: two identical utterances
    // with no cancel between them ARE deduped. Cancel must not have disabled
    // the gate.
    const seen: string[] = [];
    const dedup = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'نفس الجملة',
      think: async (t) => ({ reply: t }),
      activeSessionId: () => undefined,
      onUtterance: (u) => seen.push(u.transcript),
    });
    await dedup.pushChunk(speechWindow());
    await dedup.pushChunk(speechWindow());
    expect(seen).toHaveLength(1);
    expect(dedup.repeatDrops).toBe(1);
  });

  test('a cancel and a reset are the same operation', async () => {
    // One behaviour, two names: `reset` is what a session switch calls, `cancel`
    // is what barge-in calls. If they ever diverge again, barge-in silently
    // regains a defect.
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'x',
      think: async (t) => ({ reply: t }),
      activeSessionId: () => undefined,
    });
    const before = pipeline.turnGeneration;
    pipeline.reset();
    expect(pipeline.turnGeneration).toBe(before + 1);
    expect(pipeline.bufferedBytes).toBe(0);
    pipeline.cancel();
    expect(pipeline.turnGeneration).toBe(before + 2);
    expect(pipeline.bufferedBytes).toBe(0);
  });

  test('a cancel advances the generation that pushChunk captures', async () => {
    // The mechanism itself, so a future refactor that forgets to bump it is
    // caught here rather than in a barge-in that mysteriously still talks.
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => '',
      think: async () => ({ reply: '' }),
      activeSessionId: () => undefined,
    });
    const before = pipeline.turnGeneration;
    pipeline.cancel();
    expect(pipeline.turnGeneration).toBe(before + 1);
    pipeline.cancel();
    expect(pipeline.turnGeneration).toBe(before + 2);
    pipeline.reset();
    expect(pipeline.turnGeneration).toBe(before + 3);
  });

  test('a rejected STT call after a cancel still propagates', async () => {
    // The gate is about not NARRATING a stale turn, not about swallowing
    // errors: the caller's own error handling has to keep working.
    const stt = deferred<string>();
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: () => stt.promise,
      think: async (t) => ({ reply: t }),
      activeSessionId: () => undefined,
    });
    const pushed = pipeline.pushChunk(speechWindow());
    pipeline.cancel();
    stt.reject(new Error('provider down'));
    await expect(pushed).rejects.toThrow('provider down');
  });

  test('a cancel reaches the CURRENT pipeline and does not leak backwards', async () => {
    // `rebuildVoice` swaps the pipeline when keys are saved, which is why the
    // daemon hands `abortTurn` a getter. The cancel must land on the live
    // pipeline; a turn in the replaced one is not cancelled by it (nothing
    // asked it to be), and this pins that so the two generations cannot be
    // conflated.
    const oldPlanner = deferred<{ reply: string }>();
    const oldUtterances: Utterance[] = [];
    const old = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'قديم',
      think: () => oldPlanner.promise,
      activeSessionId: () => undefined,
      onUtterance: (u) => oldUtterances.push(u),
    });
    const oldPush = old.pushChunk(speechWindow());
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    const freshUtterances: Utterance[] = [];
    const currentPlanner = deferred<{ reply: string }>();
    const current = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'جديد',
      think: () => currentPlanner.promise,
      activeSessionId: () => undefined,
      onUtterance: (u) => freshUtterances.push(u),
    });
    const currentPush = current.pushChunk(speechWindow());
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    // This is what the daemon's `abortTurn` does: cancel the CURRENT one.
    current.cancel();
    currentPlanner.resolve({ reply: 'ملغى' });
    await currentPush;
    expect(freshUtterances, "the live pipeline's turn must be abandoned").toEqual([]);

    // The replaced pipeline was never cancelled, so its turn finishes — the
    // cancel did not reach across and kill an unrelated pipeline.
    oldPlanner.resolve({ reply: 'قديم" reply' });
    await oldPush;
    expect(oldUtterances).toHaveLength(1);
  });
});
