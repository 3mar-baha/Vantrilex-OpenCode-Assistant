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
    sendPcm(): boolean {
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
