import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';

// W6 — the assistant-mute button end to end.
//
// The HUD's `bot-toggle` used to flip a boolean and send `{kind:'mute'}`, which
// `src/orchestrator/command-router.ts:227-230` answers `ok:true` without doing
// anything, and which then cost an Inkling narration about a microphone that
// was never silenced. `playback.test.ts` guards the gate on `AudioPlayer`; THIS
// file is the guard that the HUD actually reaches it, because a correct gate
// that nothing calls is the same green lie in a new place.
//
// Reverting either half must turn these red:
//   - `playerRef.current.setMuted(...)` in App.tsx  -> chunk 2 still plays
//   - `if (this.muted) return;` in playback.ts     -> chunk 2 also plays
// Both were verified by hand; the transcript is in .opencode/_audit/70-w6-phantom-ui.md.

/** Chunks the fake sink actually rendered, in order. */
let played: number[] = [];
/** Every command the HUD pushed at the bridge, in order. */
let sent: Array<{ kind: string }> = [];
/** The events the mocked `AudioCapture.start` was handed, so a test can speak. */
let captureEvents: {
  onFrame?(bytes: Uint8Array): void;
  onEnergy?(energy: number): void;
  onError?(err: unknown): void;
} | null = null;
/** Every PCM frame the HUD pushed up, in order. */
let pcmUp: number[] = [];
/** The options App handed to the bridge, so a test can push frames back in. */
let bridgeOptions: {
  onAudio?: (audio: Uint8Array) => void;
  onVoice?: (v: { phase: string }) => void;
} = {};

vi.mock('./settings/ipc-token.js', () => ({
  envToken: () => 'test-token',
  isTauriHost: () => false,
  resolveIpcToken: async () => 'test-token',
  resolveIpcTokenWithRetry: async () => 'test-token',
}));

vi.mock('./bridge/ws.js', () => ({
  UI_WS_URL: 'ws://127.0.0.1:4097/v1/ui',
  UI_SUBPROTOCOL: 'voice-ui.v1',
  VoxauraBridge: class VoxauraBridge {
    constructor(opts: Record<string, unknown>) {
      bridgeOptions = opts as typeof bridgeOptions;
    }
    get live(): boolean {
      return true;
    }
    connect(): void {
      /* nothing to do */
    }
    dispose(): void {
      /* nothing to do */
    }
    sendPcm(bytes: Uint8Array): boolean {
      pcmUp.push(bytes[0] ?? -1);
      return true;
    }
    async sendCommand(cmd: { kind: string }): Promise<boolean> {
      sent.push({ kind: cmd.kind });
      return true;
    }
    async sendCommandDetailed(cmd: { kind: string }): Promise<{ ok: boolean; detail?: string }> {
      sent.push({ kind: cmd.kind });
      return { ok: true };
    }
  },
}));

vi.mock('./audio/capture.js', () => ({
  AudioCapture: class AudioCapture {
    // `start` is promise-returning in the real class (`App.tsx` chains `.catch`).
    start(events: {
      onFrame?(bytes: Uint8Array): void;
      onEnergy?(energy: number): void;
      onError?(err: unknown): void;
    }): Promise<void> {
      captureEvents = events;
      return Promise.resolve();
    }
    stop(): void {
      captureEvents = null;
    }
  },
  // Re-exported so nothing that imports the real module shape breaks.
  encodeFrame: (samples: Int16Array): Uint8Array => new Uint8Array(samples.buffer),
}));

vi.mock('./audio/playback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./audio/playback.js')>();
  return {
    ...actual,
    // The REAL AudioPlayer (so the real gate runs) with a fake codec and sink.
    createDefaultPlayer: (events?: { onStart?(): void; onEnd?(): void; onLevel?(level: number): void }) => {
      let n = 0;
      return new actual.AudioPlayer({
        decode: async (bytes: Uint8Array) => `buf-${(n += 1)}-${bytes[0] ?? -1}` as unknown as AudioBuffer,
        sink: {
          play: (buffer: AudioBuffer) => {
            played.push(Number((buffer as unknown as string).split('-')[2]));
            // THE SIGNAL. See `awaitNextPlay` — this is the whole reason the
            // suite no longer sleeps.
            signalPlay?.();
          },
        },
        ...(events?.onStart !== undefined ? { onStart: events.onStart } : {}),
        ...(events?.onEnd !== undefined ? { onEnd: events.onEnd } : {}),
        // Forwarded so the real player's level seam stays reachable from here.
        // `App.orb.test.tsx` owns the wiring assertion; this file only needs the
        // option not to be dropped by the mock.
        ...(events?.onLevel !== undefined ? { onLevel: events.onLevel } : {}),
      });
    },
  };
});

/**
 * Wait for the fake sink to actually run, instead of sleeping for a while and
 * hoping it ran by then.
 *
 * THE FLAKE THIS REMOVES. `deliverAudio` used to `await setTimeout(r, 5)` after
 * every chunk. That is a race with the wall clock, and it is the reason this
 * file is the last place in the desktop suite where a millisecond sleep is load-
 * bearing: under load the real player's coalesce tick plus its `await decode`
 * can land after 5 ms, `played` is still empty, and a correct HUD fails a test
 * that says nothing about the HUD. The playback suite shed the same class when
 * it took the sink signal; this is that change here.
 *
 * The gate is the sink, not a duration — so it resolves the instant the work is
 * done and cannot lose. `PLAYBACK_HANG_MS` remains as a hang-guard for a real
 * bug (a chunk that never reaches the sink at all), and it FAILS rather than
 * waits quietly, so it can never turn into a slow pass.
 */
const PLAYBACK_HANG_MS = 1_000;
let signalPlay: (() => void) | null = null;

function awaitNextPlay(): Promise<'played' | 'hung'> {
  return new Promise<'played' | 'hung'>((resolve) => {
    signalPlay = () => {
      signalPlay = null;
      resolve('played');
    };
    setTimeout(() => {
      signalPlay = null;
      resolve('hung');
    }, PLAYBACK_HANG_MS);
  });
}

/**
 * Yield the event loop for a fixed number of macrotask turns, without assuming
 * any particular DURATION. Used only where the verdict is a negative — a chunk
 * that must not arrive — so there is no signal to wait on: `enqueue` returns
 * before the pipeline when the player is muted, and the assertion afterwards is
 * what decides the test.
 */
async function macrotasks(turns: number): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: React.ReactNode): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
}

/** Mount, let the token promise resolve so the bridge is really constructed. */
async function mountApp(): Promise<void> {
  await act(async () => {
    mount(<App />);
  });
  expect(bridgeOptions.onAudio).toBeTypeOf('function');
}

/**
 * Deliver one downlink chunk and wait for the sink to have run it.
 *
 * This is the happy path: the chunk MUST reach the sink, so there is a real
 * signal to wait on and the wait ends when the work ends.
 */
async function deliverAudio(firstByte: number): Promise<void> {
  const gate = awaitNextPlay();
  await act(async () => {
    bridgeOptions.onAudio?.(new Uint8Array([firstByte]));
  });
  const verdict = await act(async () => gate);
  expect(verdict, `a chunk that must play never reached the sink (first byte ${firstByte})`).toBe('played');
}

/**
 * Deliver a chunk that must NOT be played — the mute cases.
 *
 * No signal exists by construction, so this gives the pipeline a fixed number of
 * macrotask turns (the player's coalesce tick is one, then the decode) and lets
 * the caller's `expect(played).toEqual([])` be the verdict. That is a weaker
 * assertion than the happy path by exactly one thing: a chunk delayed by more
 * than a few turns would escape. It is not a duration, so it does not slow down
 * or flake under load the way a millisecond sleep did.
 */
async function deliverAudioExpectingDrop(firstByte: number): Promise<void> {
  await act(async () => {
    bridgeOptions.onAudio?.(new Uint8Array([firstByte]));
  });
  await act(async () => macrotasks(4));
}

function botToggle(): HTMLElement {
  const el = document.body.querySelector('[data-testid="bot-toggle"]');
  if (el === null) throw new Error('bot-toggle not rendered');
  return el as HTMLElement;
}

function statusPill(): string {
  return document.body.querySelector('[data-testid="bridge-status"]')?.textContent ?? '';
}

/** The phase the orb is currently wearing, as the shell derived it. */
function orbPhase(): string | null {
  return document.body.querySelector('[data-testid="orb"]')?.getAttribute('data-phase') ?? null;
}

beforeEach(() => {
  played = [];
  sent = [];
  pcmUp = [];
  captureEvents = null;
  bridgeOptions = {};
  signalPlay = null;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('App: assistant mute is a real gate, not an ok:true (W6)', () => {
  test('unmuted: downlink audio reaches the sink', async () => {
    await mountApp();
    await deliverAudio(1);
    expect(played).toEqual([1]);
  });

  test('muted: downlink audio is dropped, and the shell stops claiming speech', async () => {
    await mountApp();
    await deliverAudio(1);
    expect(played).toEqual([1]);

    // Positive control FIRST, on the unmuted shell: an audible turn really does
    // put the widget in `speaking`. Without it, the assertion at the end of this
    // test would also pass on a shell that never showed `speaking` at all.
    await act(async () => {
      bridgeOptions.onVoice?.({ phase: 'speaking' });
    });
    expect(orbPhase(), 'precondition: audible speech is shown as speaking').toBe('speaking');

    await act(async () => {
      botToggle().click();
    });
    expect(botToggle().getAttribute('aria-pressed')).toBe('true');

    // The daemon keeps synthesising; the player must refuse it.
    await act(async () => {
      bridgeOptions.onVoice?.({ phase: 'speaking' });
    });
    await deliverAudioExpectingDrop(2);
    expect(played).toEqual([1]);

    // And the shell must not report audible speech while it is silenced. The
    // old `speaking-indicator` paragraph is gone with the bento column; the
    // orb's phase is now the shell's primary state readout, so that is what this
    // asserts — and the status line beside it, which is a second reader.
    expect(orbPhase(), 'a silenced assistant is not speaking').not.toBe('speaking');
    expect(statusPill()).not.toContain('يتحدث الآن');
  });

  test('un-muting restores audio, and the mute state survives the player being created late', async () => {
    await mountApp();

    // Mute BEFORE any audio has ever arrived, so the player does not exist yet.
    await act(async () => {
      botToggle().click();
    });
    await deliverAudioExpectingDrop(3);
    expect(played).toEqual([]);

    await act(async () => {
      botToggle().click();
    });
    await deliverAudio(4);
    expect(played).toEqual([4]);
  });

  test('the mute never asks the daemon to confirm it', async () => {
    await mountApp();
    await act(async () => {
      botToggle().click();
    });
    // The daemon answers `mute` with `ok:true` while doing nothing and then pays
    // a model call to narrate it. A renderer-owned control must not ask.
    expect(sent.map((c) => c.kind)).not.toContain('mute');
  });
});

// M2 Pattern 2 — speech-only barge-in, renderer half.
//
// Barge-in used to send `{kind:'abort'}`, which the daemon turned into a FULL
// turn cancel: the plan the user was already paying for (p50 1,950 ms on the
// free tier) was discarded and never spoken. The renderer is where the two
// intents were conflated, so this is where the break-guard lives.
//
// Reverting App.tsx:257 to `abort` fails test 1. Deleting the whole barge block
// fails test 1 too (`sent` is empty). Breaking the button fails test 4.
describe('App: barge-in stops SPEECH, the button stops the TURN (M2-P2)', () => {
  /** A loud voice burst: ~-12 dBFS, comfortably over the -30 dB gate. */
  function loudFrame(): Uint8Array {
    const samples = new Int16Array(160);
    for (let i = 0; i < samples.length; i += 1) samples[i] = 8000;
    return new Uint8Array(samples.buffer);
  }
  /** Room tone: ~-60 dBFS, must be ducked, never a barge. */
  function quietFrame(): Uint8Array {
    const samples = new Int16Array(160);
    for (let i = 0; i < samples.length; i += 1) samples[i] = 32;
    return new Uint8Array(samples.buffer);
  }

  /** Mount, start the assistant's speech (so `speakingRef` is true), open the mic. */
  async function speakingWithMicOpen(): Promise<void> {
    await mountApp();
    await deliverAudio(1);
    expect(played, 'precondition: the assistant is audibly speaking').toEqual([1]);
    await act(async () => {
      (document.body.querySelector('[data-testid="mic-toggle"]') as HTMLElement).click();
    });
    expect(captureEvents, 'precondition: the mic is live').not.toBeNull();
    // Unmuting itself sends `deafen`; only what the FRAME causes is measured.
    sent = [];
  }

  test('a barge sends stopSpeech and NOT abort, and the frame still goes up', async () => {
    await speakingWithMicOpen();
    await act(async () => {
      captureEvents?.onFrame?.(loudFrame());
    });
    expect(sent.map((c) => c.kind)).toEqual(['stopSpeech']);
    expect(sent.map((c) => c.kind), 'abort would cancel the turn the user is paying for').not.toContain(
      'abort',
    );
    // The barge frame itself is the user's new words — it must still be sent.
    expect(pcmUp).toHaveLength(1);
  });

  test('the control: a loud frame while SILENT sends no command at all', async () => {
    // Without this, test 1 would also pass on a HUD that never barged.
    await mountApp();
    await act(async () => {
      (document.body.querySelector('[data-testid="mic-toggle"]') as HTMLElement).click();
    });
    expect(captureEvents).not.toBeNull();
    sent = [];
    await act(async () => {
      captureEvents?.onFrame?.(loudFrame());
    });
    expect(sent).toEqual([]);
    expect(pcmUp).toHaveLength(1);
  });

  test('room tone during speech is still ducked, not treated as a barge', async () => {
    await speakingWithMicOpen();
    await act(async () => {
      captureEvents?.onFrame?.(quietFrame());
    });
    expect(sent, 'echo suppression must not regress into a barge storm').toEqual([]);
    expect(pcmUp, 'a ducked frame never reaches STT').toEqual([]);
  });

  test('the shell has NO turn-cancel control, so `abort` can never be sent', async () => {
    // The old HUD had an `abort-button` in the bento's escape slot, and this
    // suite's companion `App.escape.test.tsx` spent 300 lines proving a dead
    // 4096 could not take it away. The 380x380 widget has three buttons and none
    // of them is that one: mic, assistant volume, keys. So the property is now
    // stronger and simpler — there is nothing to click.
    //
    // A "was not sent" assertion needs a matching "was sent" one or it is
    // vacuous, and the barge case above is exactly that control: the SAME frame
    // that used to reach the abort button reaches `stopSpeech` instead.
    await mountApp();
    // The assistant has to be AUDIBLY speaking before a loud frame is a barge:
    // the gate compares against `speakingRef`, which only `onStart` sets. Same
    // precondition `speakingWithMicOpen` establishes above.
    await deliverAudio(1);
    await act(async () => {
      (document.body.querySelector('[data-testid="mic-toggle"]') as HTMLElement).click();
    });
    sent = [];
    await act(async () => {
      captureEvents?.onFrame?.(loudFrame());
    });
    expect(
      sent.map((c) => c.kind),
      'the barge path still sends, and it is the speech stop, not a turn cancel',
    ).toEqual(['stopSpeech']);
    expect(document.body.querySelector('[data-testid="abort-button"]')).toBeNull();
    // And nothing in the shell can produce an `abort` on any path.
    for (const node of Array.from(document.body.querySelectorAll('button'))) node.click();
    expect(sent.map((c) => c.kind)).not.toContain('abort');
  });
});

// A1 — the shell actually applies the silence gate.
//
// `vad.test`/`uplink-gate.test` prove the POLICY. This file is the guard that
// the HUD reaches it, because a correct gate that `App.tsx` never calls is the
// same green lie as the W6 phantom-mute above, in a new place.
//
// Reverting `App.tsx` to send every frame fails "room tone in silence" below.
describe('App: nothing is transmitted in silence, and the mic is still open', () => {
  /** Room tone, ~-58 dBFS. */
  function roomTone(): Uint8Array {
    return new Uint8Array(new Int16Array(160).fill(40).buffer);
  }
  /** A voice burst, ~-18 dBFS. */
  function voice(): Uint8Array {
    return new Uint8Array(new Int16Array(160).fill(4000).buffer);
  }

  async function micOpenIdle(): Promise<void> {
    await mountApp();
    await act(async () => {
      (document.body.querySelector('[data-testid="mic-toggle"]') as HTMLElement).click();
    });
    expect(captureEvents, 'precondition: the mic is live').not.toBeNull();
    sent = [];
    pcmUp = [];
  }

  test('room tone in silence puts ZERO bytes on the wire', async () => {
    await micOpenIdle();
    await act(async () => {
      for (let i = 0; i < 300; i += 1) captureEvents?.onFrame?.(roomTone());
    });
    // 300 frames == 30 s of ambient audio. Before this gate every one of them
    // went up. Now none do.
    expect(pcmUp).toEqual([]);
  });

  test('the microphone is STILL OPEN — frames keep arriving, they are just not sent', async () => {
    await micOpenIdle();
    await act(async () => {
      for (let i = 0; i < 5; i += 1) captureEvents?.onFrame?.(roomTone());
    });
    expect(pcmUp).toEqual([]);
    // The gate drops frames; it never stops the capture. `captureEvents` is the
    // live handle the device is pumping into, and it is still there.
    expect(captureEvents).not.toBeNull();
    expect(sent, 'silence must not also start sending commands').toEqual([]);
  });

  test('speech still goes up, so the gate is not a mute', async () => {
    await micOpenIdle();
    await act(async () => {
      captureEvents?.onFrame?.(voice());
    });
    expect(pcmUp).toHaveLength(1);
  });

  test('speech, then a bounded tail, then silence again', async () => {
    await micOpenIdle();
    await act(async () => {
      captureEvents?.onFrame?.(voice());
      for (let i = 0; i < 200; i += 1) captureEvents?.onFrame?.(roomTone());
    });
    // The utterance plus enough post-utterance audio for the daemon to close
    // its 160,000-byte window — and then nothing, which is the whole point.
    expect(pcmUp.length).toBeGreaterThanOrEqual(50);
    expect(pcmUp.length).toBeLessThanOrEqual(57);
  });

  test('muting drops the tail debt, so unmuting does not flush 5.6 s of room tone', async () => {
    await micOpenIdle();
    await act(async () => {
      captureEvents?.onFrame?.(voice());
      captureEvents?.onFrame?.(roomTone());
      (document.body.querySelector('[data-testid="mic-toggle"]') as HTMLElement).click();
    });
    expect(captureEvents, 'muting released the device').toBeNull();
    pcmUp = [];
    await act(async () => {
      (document.body.querySelector('[data-testid="mic-toggle"]') as HTMLElement).click();
      captureEvents?.onFrame?.(roomTone());
    });
    expect(pcmUp, 'the tail was a debt to the window; a mute cancels the debt').toEqual([]);
  });
});
