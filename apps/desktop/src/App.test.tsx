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
  onEvent?: (e: { state: string }) => void;
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
    createDefaultPlayer: (events?: { onStart?(): void; onEnd?(): void }) => {
      let n = 0;
      return new actual.AudioPlayer({
        decode: async (bytes: Uint8Array) => `buf-${(n += 1)}-${bytes[0] ?? -1}` as unknown as AudioBuffer,
        sink: {
          play: (buffer: AudioBuffer) => {
            played.push(Number((buffer as unknown as string).split('-')[2]));
          },
        },
        ...(events?.onStart !== undefined ? { onStart: events.onStart } : {}),
        ...(events?.onEnd !== undefined ? { onEnd: events.onEnd } : {}),
      });
    },
  };
});

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

/** Deliver one downlink chunk and let the player drain. */
async function deliverAudio(firstByte: number): Promise<void> {
  await act(async () => {
    bridgeOptions.onAudio?.(new Uint8Array([firstByte]));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}

function botToggle(): HTMLElement {
  const el = document.body.querySelector('[data-testid="bot-toggle"]');
  if (el === null) throw new Error('bot-toggle not rendered');
  return el as HTMLElement;
}

function statusPill(): string {
  return document.body.querySelector('[data-testid="bridge-status"]')?.textContent ?? '';
}

beforeEach(() => {
  played = [];
  sent = [];
  pcmUp = [];
  captureEvents = null;
  bridgeOptions = {};
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

  test('muted: downlink audio is dropped, and the pill stops claiming speech', async () => {
    await mountApp();
    await deliverAudio(1);
    expect(played).toEqual([1]);

    await act(async () => {
      botToggle().click();
    });
    expect(botToggle().getAttribute('aria-pressed')).toBe('true');

    // The daemon keeps synthesising; the player must refuse it.
    bridgeOptions.onVoice?.({ phase: 'speaking' });
    await deliverAudio(2);
    expect(played).toEqual([1]);

    // And the shell must not report audible speech while it is silenced.
    expect(statusPill()).not.toContain('يتحدث الآن');
    expect(document.body.querySelector('[data-testid="speaking-indicator"]')).toBeNull();
  });

  test('un-muting restores audio, and the mute state survives the player being created late', async () => {
    await mountApp();

    // Mute BEFORE any audio has ever arrived, so the player does not exist yet.
    await act(async () => {
      botToggle().click();
    });
    await deliverAudio(3);
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

  test('the explicit abort button still sends abort, never stopSpeech', async () => {
    await mountApp();
    // The button's branch is `matrix !== 0` (`App.tsx:480`), so a real turn has
    // to be on screen first — `matrixForDaemonState('running')` is 2.
    await act(async () => {
      bridgeOptions.onEvent?.({ state: 'running' });
    });
    await act(async () => {
      (document.body.querySelector('[data-testid="abort-button"]') as HTMLElement).click();
    });
    expect(sent.map((c) => c.kind)).toEqual(['abort']);
  });
});
