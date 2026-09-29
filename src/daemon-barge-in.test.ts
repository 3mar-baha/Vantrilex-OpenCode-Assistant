import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { SessionId } from './common/brands.js';
import type { UiCommand } from './ipc/protocol.js';
import { AudioPipeline, type Utterance } from './orchestrator/audio-pipeline.js';
import { createCommandHandler, type CommandClient } from './orchestrator/command-router.js';
import { abortTurn, startDaemon } from './daemon.js';
import { AudioIngest, WINDOW_BYTES } from './voice/ingest.js';
import { isSpeakable, SpeechGate, splitSentences, stripSpeechText } from './voice/tts.js';

// C4: what an `abort` command actually does, end to end.
//
// The shipped code was `onAbort: () => speechGate.abort()`. That is a TTS gate:
// it stops sentences being synthesised and does nothing at all to the turn
// already inside the planner. So a cancelled turn ran to completion, its reply
// was discarded by the pipeline's post-await generation check, and the user
// paid for a free-tier planning call whose answer was never spoken.
//
// Everything below is the production wiring: the real `createCommandHandler`,
// the real `abortTurn`, a real `SpeechGate` and a real `AudioPipeline`. Only
// the model and the TTS transport are faked, because those are network calls.
// The narration chain is wired exactly as `daemon.ts` wires it, so "never
// narrated" is asserted at the synthesizer and at the broadcast, not merely at
// the pipeline's callback.

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

/** Let real microtask turns elapse, so the pipeline is genuinely parked. */
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const noopClient: CommandClient = {
  setSessionAgent: async () => undefined,
  setSessionModel: async () => undefined,
  toggleSessionSkill: async () => undefined,
  execSessionShell: async () => undefined,
};

interface Rig {
  /** Mutable so a test can swap the model and the synthesizer between turns. */
  think: (transcript: string) => Promise<{ reply: string }>;
  /** Overridable so a test can hold a sentence mid-synthesis. */
  synthesize: (sentence: string, seq: number) => Promise<number>;
  pipeline: AudioPipeline;
  gate: SpeechGate;
  handle: (cmd: UiCommand) => Promise<{ ok: boolean; detail?: string }>;
  readonly utterances: Utterance[];
  /** Every sentence handed to the (faked) TTS provider. */
  readonly synthesized: string[];
  /** Every audio frame pushed at the shell. */
  readonly broadcast: number[];
}

/**
 * The production chain with the two network calls faked:
 *   pushChunk → think → (generation gate) → onUtterance → splitSentences →
 *   fish.synthesize per sentence → ui.broadcastAudio
 */
function rig(): Rig {
  const utterances: Utterance[] = [];
  const synthesized: string[] = [];
  const broadcast: number[] = [];
  const gate = new SpeechGate();
  let mp3Seq = 0;

  const state: Rig = {
    think: async () => ({ reply: 'تمام.' }),
    // The default synthesizer: instant, and returns a distinct id per call.
    synthesize: async (_sentence: string, seq: number) => seq,
    pipeline: undefined as unknown as AudioPipeline,
    gate,
    handle: undefined as unknown as Rig['handle'],
    utterances,
    synthesized,
    broadcast,
  };

  state.pipeline = new AudioPipeline({
    ingest: new AudioIngest(),
    transcribe: async () => 'شوف السير',
    // Indirected through `state` so a test can swap the model between turns.
    think: (t) => state.think(t),
    activeSessionId: () => 'ses_a' as SessionId,
    onUtterance: (utterance) => {
      utterances.push(utterance);
      void (async () => {
        // Mirrors `daemon.ts` `onUtterance`, gate check included on both sides
        // of the synthesize await.
        const text = stripSpeechText(utterance.reply);
        if (!isSpeakable(text)) return;
        const gen = gate.capture();
        for (const sentence of splitSentences(text)) {
          if (!gate.isCurrent(gen)) return;
          synthesized.push(sentence);
          const mp3 = await state.synthesize(sentence, ++mp3Seq);
          if (!gate.isCurrent(gen)) return;
          broadcast.push(mp3);
        }
      })();
    },
  });

  state.handle = createCommandHandler({
    client: noopClient,
    switchSession: () => undefined,
    activeSessionId: () => 'ses_a' as SessionId,
    projectDirectory: () => process.cwd(),
    onAbort: () => abortTurn(gate, () => state.pipeline),
    // M2 Pattern 2: exactly what `startDaemon` wires — a bare gate trip.
    onStopSpeech: () => gate.abort(),
  });

  return state;
}

describe('abort cancels the turn, not just the audio (C4)', () => {
  test('a reply already being planned when abort lands is never narrated', async () => {
    const planner = deferred<{ reply: string }>();
    const r = rig();
    r.think = () => planner.promise;
    const pushed = r.pipeline.pushChunk(speechWindow());
    await settle();

    const genBefore = r.gate.capture();
    const outcome = await r.handle({ id: 'cmd-1', kind: 'abort' });
    expect(outcome.ok).toBe(true);
    expect(r.gate.isCurrent(genBefore), 'the TTS generation must move too').toBe(false);

    // The planner finishes anyway — a dispatched provider call cannot be
    // recalled — and its answer must die here rather than reach the synthesizer.
    planner.resolve({ reply: 'السير شغّال. قلت لك إيه بالظبط؟ كله تمام.' });
    await pushed;
    await settle();

    expect(r.utterances, 'onUtterance is the narration entry point').toEqual([]);
    expect(r.synthesized, 'not one sentence may reach the TTS provider').toEqual([]);
    expect(r.broadcast, 'no audio frame may reach the shell').toEqual([]);
  });

  test('the control: with no abort the same turn is narrated', async () => {
    // Without this, the test above would also pass on a pipeline that narrates
    // nothing at all.
    const planner = deferred<{ reply: string }>();
    const r = rig();
    r.think = () => planner.promise;
    const pushed = r.pipeline.pushChunk(speechWindow());
    await settle();
    planner.resolve({ reply: 'السير شغّال. كله تمام.' });
    await pushed;
    await settle();
    expect(r.utterances).toHaveLength(1);
    expect(r.synthesized.length).toBeGreaterThan(0);
    expect(r.broadcast.length).toBe(r.synthesized.length);
  });

  test('a cancelled turn is not deduped away when the user says it again', async () => {
    // The repeat-memory half. `remember()` runs before `think`, so a cancelled
    // transcript is still in the dedupe window; without the cancel clearing it,
    // the retry the user makes after a barge-in is dropped as a duplicate and
    // they get silence for asking again.
    const r = rig();
    const first = deferred<{ reply: string }>();
    r.think = () => first.promise;
    const firstPush = r.pipeline.pushChunk(speechWindow());
    await settle();
    await r.handle({ id: 'cmd-1', kind: 'abort' });
    first.resolve({ reply: 'ملغى' });
    await firstPush;
    await settle();
    expect(r.utterances).toEqual([]);

    const second = deferred<{ reply: string }>();
    r.think = () => second.promise;
    const retry = r.pipeline.pushChunk(speechWindow());
    await settle();
    second.resolve({ reply: 'تمام، فهمت' });
    await retry;
    await settle();
    expect(r.utterances).toHaveLength(1);
    expect(r.utterances[0]?.transcript).toBe('شوف السير');
  });

  test('an abort mid-narration stops the sentence in flight and the ones after', async () => {
    // The half that already worked, pinned so the C4 change did not weaken it.
    // A three-sentence reply is mid-synthesis when the abort lands: sentence 1
    // has been broadcast, sentence 2 is inside the provider, sentence 3 must
    // never be requested. This is `daemon.ts:611-617` exactly.
    const r = rig();
    r.think = async () => ({ reply: 'الجملة الأولى. الجملة الثانية. الجملة الثالثة.' });
    const held = deferred<number>();
    r.synthesize = async (_sentence, seq) => (seq === 2 ? held.promise : seq);

    const pushed = r.pipeline.pushChunk(speechWindow());
    // Run until the second sentence is genuinely parked inside the provider.
    for (let i = 0; i < 40 && r.synthesized.length < 2; i += 1) await settle(2);
    expect(r.synthesized, 'precondition: two sentences reached the provider').toHaveLength(2);
    expect(r.broadcast, 'precondition: only the first was broadcast').toEqual([1]);

    await r.handle({ id: 'cmd-2', kind: 'abort' });
    held.resolve(2);
    await settle(20);

    expect(r.broadcast, 'the sentence in flight must not be broadcast after the abort').toEqual([1]);
    expect(r.synthesized, 'no sentence may be requested after the abort').toHaveLength(2);
    void pushed;
  });

  test('abort on a keyless daemon (no pipeline) is still ok', async () => {
    // `rebuildVoice` leaves `audio === null` without keys. An abort must not
    // throw there: the router's catch would turn the stop button into an error
    // frame.
    const gate = new SpeechGate();
    const handle = createCommandHandler({
      client: noopClient,
      switchSession: () => undefined,
      activeSessionId: () => undefined,
      projectDirectory: () => process.cwd(),
      onAbort: () => abortTurn(gate, () => null),
    });
    const gen = gate.capture();
    const outcome = await handle({ id: 'cmd-3', kind: 'abort' });
    expect(outcome).toEqual({ ok: true });
    expect(gate.isCurrent(gen), 'the gate still trips with no voice pipeline').toBe(false);
  });

  test('a rejected planner call after an abort still surfaces', async () => {
    // Cancelling the turn must not swallow the error path: a failed model call
    // is the daemon's signal to emit `brain-failed`, and barge-in should not
    // silence a real fault by turning it into a clean no-op.
    const planner = deferred<{ reply: string }>();
    const r = rig();
    r.think = () => planner.promise;
    const pushed = r.pipeline.pushChunk(speechWindow());
    await settle();
    await r.handle({ id: 'cmd-4', kind: 'abort' });
    planner.reject(new Error('provider down'));
    await expect(pushed).rejects.toThrow('provider down');
  });

  test('startDaemon hands abortTurn the LIVE pipeline, not a stub', () => {
    // STRUCTURAL, and deliberately labelled as such. The rig above calls
    // `abortTurn` directly, so it proves the function cancels the turn; it cannot
    // prove that `startDaemon` passes a real pipeline, because `audio` is private
    // to that function and reaching it would need a booted daemon with a voice
    // pipeline (i.e. real vault keys and real provider calls).
    //
    // So the wiring is pinned by reading the call site instead. Narrow on
    // purpose: it is the exact mistake this test exists to catch — reverting to
    // the audio-only handler. Verified non-vacuous: changing the argument to
    // `() => null` fails this test.
    const src = readFileSync('src/daemon.ts', 'utf8');
    const lines = src.split('\n').filter((l) => /^\s*onAbort:/.test(l));
    expect(lines, 'startDaemon must wire an onAbort into the command handler').toHaveLength(1);
    const wiring = lines[0] ?? '';
    expect(wiring, `the abort handler must reach the turn pipeline: ${wiring.trim()}`).toMatch(
      /abortTurn\(speechGate,\s*\(\)\s*=>\s*audio\)/,
    );
    expect(wiring, 'a null pipeline is the pre-C4 bug in disguise').not.toMatch(/\(\)\s*=>\s*null/);
  });

  // M2 Pattern 2 — speech-only barge-in. A voice burst must stop the AUDIO and
  // let the turn finish; the button keeps the full cancel. Measured cost of
  // conflating them: the planner call (p50 1,950 ms on the free tier) is paid
  // for and its answer is thrown away, every single time the user talks over
  // the assistant — which is the normal way a voice product gets used.
  test('M2-P2: startDaemon wires stopSpeech to the speech gate, not to abortTurn', () => {
    // STRUCTURAL, labelled as such, for the same reason as the test above:
    // `audio` is private to `startDaemon`, so the real handler cannot be
    // reached without a booted daemon. The behaviour is pinned by the rig tests;
    // this pins the call site. Non-vacuous — passing `abortTurn(speechGate, …)`
    // here fails it.
    const src = readFileSync('src/daemon.ts', 'utf8');
    const lines = src.split('\n').filter((l) => /^\s*onStopSpeech:/.test(l));
    expect(lines, 'startDaemon must wire an onStopSpeech into the command handler').toHaveLength(1);
    const wiring = lines[0] ?? '';
    expect(wiring, `speech-only barge-in must be a bare gate trip: ${wiring.trim()}`).toMatch(
      /onStopSpeech:\s*\(\)\s*=>\s*speechGate\.abort\(\)/,
    );
    expect(wiring, 'stopSpeech must never cancel the turn').not.toMatch(/abortTurn/);
    expect(wiring, 'stopSpeech must never reach the pipeline').not.toMatch(/audio/);
  });

  test('M2-P2: an executed stopSpeech is never narrated back to the user', () => {
    // STRUCTURAL, same rationale: `onExecuted` is an inline closure in
    // `startDaemon`, so the skip itself is pinned here while the rig tests pin
    // the behaviour around it. Without the early return, every barge would
    // pull session details, spend an Inkling call, and speak over the
    // still-running turn — the exact waste this split exists to remove.
    // Non-vacuous — deleting the `if` line fails both asserts below.
    const src = readFileSync('src/daemon.ts', 'utf8');
    const start = src.indexOf('onExecuted: (executed, outcome)');
    expect(start, 'the executed-narration closure must exist').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('},', start));
    expect(body.length, 'the closure must terminate').toBeGreaterThan(0);
    expect(
      body,
      'a barge is not an outcome to speak: stopSpeech must return before narrateOutcome',
    ).toMatch(/if\s*\(\s*executed\.kind\s*===\s*['"]stopSpeech['"]\s*\)\s*return;/);
  });

  test('M2-P2: the utterance loop hands the barge to the PROVIDER, and does not bill it as a failure', () => {
    // STRUCTURAL again, and for the same two reasons as above: the utterance
    // closure is private to `startDaemon`. Two properties that are otherwise
    // invisible, and both were wrong when this shipped:
    //   1. without `signalFor(gen)` the barge stops the broadcast but Fish keeps
    //      synthesising audio nobody hears (wasted free-tier credit);
    //   2. without the catch's gate check the deliberate cancel raises
    //      `TTS_FAILED` + a red `تعذّر توليد الصوت` notice at a user who did
    //      nothing but talk over the reply.
    const src = readFileSync('src/daemon.ts', 'utf8');
    const start = src.indexOf('onUtterance: (utterance)');
    expect(start, 'the onUtterance handler must still exist').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n      });', start));
    expect(body, 'the barge must reach the provider').toMatch(/signal:\s*speechGate\.signalFor\(gen\)/);
    const catchAt = body.indexOf('} catch (err) {');
    expect(catchAt).toBeGreaterThan(-1);
    // The window has to clear the explanatory comment, or the guard is invisible
    // to the check — which is exactly how a source-reading test goes vacuous.
    const tail = body.slice(catchAt);
    const guardAt = tail.indexOf('if (!speechGate.isCurrent(gen)');
    expect(guardAt, 'the catch must bail on a cancelled utterance').toBeGreaterThan(-1);
    expect(
      tail.indexOf("errorCode: 'TTS_FAILED'") ,
      'the bail must come BEFORE any TTS_FAILED telemetry, or a barge is billed as a failure',
    ).toBeGreaterThan(guardAt);
    expect(tail, 'a credit fault must survive the barge guard — it is the actionable one').toMatch(
      /!speechGate\.isCurrent\(gen\) && !\(err instanceof FishCreditError\) && abortedByBarge/,
    );
    // Peer review: the guard must ALSO be shaped by the error, not only the
    // generation — a genuine 401/403 or timeout arriving after any barge must
    // still bill and notify. Only a caller abort (AbortError) goes quiet.
    expect(
      tail,
      'abortedByBarge must mean AbortError, so real errors still bill after a barge',
    ).toMatch(/\.name === 'AbortError'/);
    // Ordering, as the roadmap states it: abort → idle → notify. The `finally`
    // that publishes `idle` is what notifies the shell, and it must still run.
    expect(body.slice(catchAt)).toMatch(/finally\s*\{\s*setVoicePhase\('idle'\);/);
  });

  test('M2-P2: a parked plan survives a speech-only barge and is delivered', async () => {
    const planner = deferred<{ reply: string }>();
    const r = rig();
    r.think = () => planner.promise;
    const pushed = r.pipeline.pushChunk(speechWindow());
    await settle();

    const genBefore = r.gate.capture();
    expect(await r.handle({ id: 'cmd-barge', kind: 'stopSpeech' })).toEqual({ ok: true });
    expect(r.gate.isCurrent(genBefore), 'the audio must stop').toBe(false);

    // The planner is NOT cancelled: it is a dispatched provider call, and it
    // completes. Its answer must now reach the user.
    planner.resolve({ reply: 'السير شغّال. كله تمام.' });
    await pushed;
    await settle(20);

    expect(r.utterances, 'the parked plan must still be delivered').toHaveLength(1);
    expect(r.synthesized.length, 'and spoken').toBeGreaterThan(0);
    expect(r.broadcast, 'and broadcast').toHaveLength(r.synthesized.length);
  });

  test('M2-P2: speech-only barge-in does not trip the turn generation', async () => {
    // The non-interference claim from the roadmap, asserted directly: the barge
    // handler is `speechGate.abort()` and nothing else, so the pipeline's own
    // generation cannot move. A pipeline that also aborted here would silently
    // reinstate the paid-and-discarded plan — the exact bug being fixed.
    const planner = deferred<{ reply: string }>();
    const r = rig();
    r.think = () => planner.promise;
    let cancelled = 0;
    const spy = r.pipeline.cancel.bind(r.pipeline);
    r.pipeline.cancel = (): void => {
      cancelled += 1;
      spy();
    };
    const pushed = r.pipeline.pushChunk(speechWindow());
    await settle();
    await r.handle({ id: 'cmd-barge2', kind: 'stopSpeech' });
    expect(cancelled, 'stopSpeech must not cancel the voice pipeline').toBe(0);
    planner.resolve({ reply: 'تمام.' });
    await pushed;
    await settle(20);
  });

  test('M2-P2: the abort button still cancels a parked plan that a barge left running', async () => {
    // The pair, in sequence — the realistic user action: talk over the
    // assistant (audio stops, plan survives), then hit stop. The second command
    // must still be the full cancel, or the first change would have quietly
    // downgraded the button into another speech-only barge.
    const planner = deferred<{ reply: string }>();
    const r = rig();
    r.think = () => planner.promise;
    const pushed = r.pipeline.pushChunk(speechWindow());
    await settle();
    expect(await r.handle({ id: 'cmd-barge3', kind: 'stopSpeech' })).toEqual({ ok: true });
    expect(await r.handle({ id: 'cmd-btn', kind: 'abort' })).toEqual({ ok: true });
    planner.resolve({ reply: 'ملغى' });
    await pushed;
    await settle(20);
    expect(r.utterances, 'the button is still a real cancel').toEqual([]);
    expect(r.broadcast).toEqual([]);
  });

  test('M2-P2: speech-only barge-in mid-narration stops the audio in flight', async () => {
    // The barge case the abort test above covers, re-run through `stopSpeech`:
    // the sentence inside the provider and every sentence after it must be
    // dropped, while the TURN that produced them was never a participant.
    const r = rig();
    r.think = async () => ({ reply: 'الجملة الأولى. الجملة الثانية. الجملة الثالثة.' });
    const held = deferred<number>();
    r.synthesize = async (_sentence, seq) => (seq === 2 ? held.promise : seq);

    const pushed = r.pipeline.pushChunk(speechWindow());
    for (let i = 0; i < 40 && r.synthesized.length < 2; i += 1) await settle(2);
    expect(r.synthesized, 'precondition: two sentences reached the provider').toHaveLength(2);
    expect(r.broadcast, 'precondition: only the first was broadcast').toEqual([1]);

    await r.handle({ id: 'cmd-barge4', kind: 'stopSpeech' });
    held.resolve(2);
    await settle(20);

    expect(r.broadcast, 'the in-flight sentence must not be broadcast').toEqual([1]);
    expect(r.synthesized, 'no sentence may be requested after the barge').toHaveLength(2);
    void pushed;
  });

  test('M2-P2: stopSpeech on a keyless daemon (no pipeline) is still ok', async () => {
    const gate = new SpeechGate();
    const handle = createCommandHandler({
      client: noopClient,
      switchSession: () => undefined,
      activeSessionId: () => undefined,
      projectDirectory: () => process.cwd(),
      onStopSpeech: () => gate.abort(),
    });
    const gen = gate.capture();
    expect(await handle({ id: 'cmd-keyless', kind: 'stopSpeech' })).toEqual({ ok: true });
    expect(gate.isCurrent(gen)).toBe(false);
  });

  test('startDaemon is importable without a live serve (module-load sanity)', () => {
    // `abortTurn` lives in `daemon.ts`, which pulls in the whole composition
    // root. If a static import anywhere in that graph ever became fatal again,
    // this file would fail to load rather than fail a production launch.
    expect(typeof startDaemon).toBe('function');
    expect(typeof abortTurn).toBe('function');
  });
});
