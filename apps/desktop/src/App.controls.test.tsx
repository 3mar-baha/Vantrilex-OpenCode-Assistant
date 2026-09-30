import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';

// The three pill controls, AS MOUNTED — the successor to `App.escape.test.tsx`.
//
// WHAT REPLACED WHAT, and why the file did not simply disappear. That file
// pinned the fix for the outage trap: `BentoGrid` put one `inert` attribute on
// the whole action slot, `inert` is inherited, and the net effect was that a
// dead 4096 removed the button that stops the assistant. Its assertions were
// about a SIBLING escape slot that does not exist any more, because there is no
// blocked slot to escape from.
//
// The invariant it defended is stronger here, and it is kept: NOTHING in this
// shell is ever inside an `inert` subtree, so a serve-health notice — which the
// shell now renders as ordinary message text rather than as a block — cannot
// take a control away. That is a real property of the composed tree, and the
// structural assertion below is what makes it one.
//
// The other half of that file survives as behaviour: the two mute controls are
// the shell's only wire, so their wiring IS the security-relevant surface, and
// it is asserted here — including the W6 rule that the assistant mute must never
// ask the daemon to confirm it.

/** Every command the shell pushed at the bridge, in order. */
let sent: Array<{ kind: string }> = [];
/** Every `setMuted` the fake player was told, in order. */
let muteCalls: boolean[] = [];
/** The options App handed to the bridge, so a test can push frames back in. */
let bridgeOptions: {
  onAudio?: (audio: Uint8Array) => void;
  onNotice?: (n: { code: string; detail: string; level: 'info' | 'warn' | 'error' }) => void;
};
/** The window launchers App called, in order, as `label` pairs. */
let opened: string[] = [];

vi.mock('./settings/ipc-token.js', () => ({
  envToken: () => 'test-token',
  isTauriHost: () => false,
  resolveIpcToken: async () => 'test-token',
  resolveIpcTokenWithRetry: async () => 'test-token',
}));

vi.mock('./settings/open-settings.js', () => ({
  SETTINGS_LABEL: 'settings',
  KEYS_LABEL: 'api-keys',
  isTauriHost: () => false,
  openSettingsWindow: async (persona?: string): Promise<string> => {
    opened.push(`settings:${persona ?? ''}`);
    return 'settings';
  },
  openKeysWindow: async (): Promise<string> => {
    opened.push('keys');
    return 'api-keys';
  },
  isSettingsView: () => false,
  isKeysView: () => false,
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

vi.mock('./audio/capture.js', () => ({
  AudioCapture: class AudioCapture {
    start(): Promise<void> {
      return Promise.resolve();
    }
    stop(): void {
      /* nothing to do */
    }
  },
  encodeFrame: (samples: Int16Array): Uint8Array => new Uint8Array(samples.buffer),
}));

vi.mock('./audio/playback.js', () => ({
  AudioPlayer: class AudioPlayer {},
  createDefaultPlayer: () => ({
    setMuted: (value: boolean) => {
      muteCalls.push(value);
    },
    enqueue: (): void => {},
    stop: (): void => {},
    dispose: (): void => {},
  }),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mountApp(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<App />);
  });
  expect(bridgeOptions.onAudio, 'the downlink must be wired at all').toBeTypeOf('function');
  sent = [];
}

function el(selector: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(selector);
}

function all(selector: string): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(selector));
}

/** True when `node` sits inside a subtree carrying `inert` — i.e. unclickable. */
function insideInert(node: HTMLElement | null): boolean {
  let cursor: HTMLElement | null = node;
  while (cursor !== null) {
    if (cursor.hasAttribute('inert')) return true;
    cursor = cursor.parentElement;
  }
  return false;
}

async function click(selector: string): Promise<void> {
  await act(async () => {
    el(selector)?.click();
  });
}

beforeEach(() => {
  sent = [];
  opened = [];
  muteCalls = [];
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

describe('no control in this shell can be taken away', () => {
  test('nothing in the composed tree carries `inert`', async () => {
    // The successor to the escape slot. The old shell's defect was that one
    // inherited `inert` could remove the stop control; the compact shell has no
    // blocked subtree at all, and this is the assertion that keeps it that way.
    // It would fail the moment a future change reintroduced a blocked region.
    await mountApp();
    expect(all('[inert]'), 'no inert subtree may exist in this shell').toHaveLength(0);
    for (const id of ['mic-toggle', 'bot-toggle', 'open-keys']) {
      expect(insideInert(el(`[data-testid="${id}"]`)), `${id} must be reachable`).toBe(false);
    }
  });

  test('a serve-health notice shows words and takes nothing away', async () => {
    await mountApp();
    await act(async () => {
      bridgeOptions.onNotice?.({
        code: 'serve-degraded',
        detail: 'انقطع الاتصال بالخادم على المنفذ ٤٠٩٦',
        level: 'warn',
      });
    });
    expect(el('[data-testid="notice-banner"]')?.textContent).toContain('٤٠٩٦');
    expect(all('[inert]')).toHaveLength(0);
    // And the controls still do their job afterwards — the behaviour half of
    // the same property, so this cannot pass on a shell that merely removed the
    // attribute from the DOM without wiring it up.
    await click('[data-testid="mic-toggle"]');
    expect(sent.map((c) => c.kind)).toContain('deafen');
  });
});

describe('the microphone control', () => {
  test('it opens the device, tells the daemon, and reports its own state', async () => {
    await mountApp();
    expect(el('[data-testid="mic-toggle"]')?.getAttribute('aria-pressed'), 'muted at rest').toBe('true');
    await click('[data-testid="mic-toggle"]');
    expect(el('[data-testid="mic-toggle"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(sent.map((c) => c.kind)).toEqual(['deafen']);
  });

  test('it toggles back, and only `deafen` ever goes on the wire', async () => {
    await mountApp();
    await click('[data-testid="mic-toggle"]');
    await click('[data-testid="mic-toggle"]');
    expect(el('[data-testid="mic-toggle"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(new Set(sent.map((c) => c.kind))).toEqual(new Set(['deafen']));
  });
});

describe('the assistant-audio control is renderer-local (W6)', () => {
  test('it gates the player, not the daemon', async () => {
    await mountApp();
    // The player does not exist until the first downlink chunk, so unmute first
    // and prove the gate is reached through the lazy path.
    await act(async () => {
      bridgeOptions.onAudio?.(new Uint8Array([1]));
    });
    expect(muteCalls, 'precondition: the player was created and told its state').toContain(false);

    await click('[data-testid="bot-toggle"]');
    expect(el('[data-testid="bot-toggle"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(muteCalls.at(-1), 'the player is the gate').toBe(true);
    // The daemon answers `mute` with `ok:true` while doing nothing at all and
    // then pays an Inkling call to narrate silencing a microphone it never
    // silenced, so a renderer-owned control must never ask.
    expect(sent.map((c) => c.kind), 'the daemon must not be asked to confirm it').toEqual([]);
  });

  test('a mute pressed before the player exists is remembered', async () => {
    // The ref-not-a-state property: muting with no player yet would otherwise be
    // lost, and the very next chunk would play through an "unmuted" player.
    await mountApp();
    await click('[data-testid="bot-toggle"]');
    expect(el('[data-testid="bot-toggle"]')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      bridgeOptions.onAudio?.(new Uint8Array([1]));
    });
    expect(muteCalls.at(-1), 'the persisted mute was applied on creation').toBe(true);
  });
});

describe('the third button opens the existing keys window', () => {
  test('it calls `openKeysWindow`, and does not build a modal of its own', async () => {
    await mountApp();
    await click('[data-testid="open-keys"]');
    expect(opened).toEqual(['keys']);
    // Proof that no new dialog was invented: the shell renders no dialog.
    expect(all('[role="dialog"]')).toHaveLength(0);
  });

  test('`Ctrl+,` still reaches the settings window — the persona route', async () => {
    // The pill has three buttons by specification and persona is not one of
    // them, so this shortcut is the ONLY way to switch persona from the widget.
    // That makes it load-bearing rather than a convenience, which is why it is
    // asserted here instead of left as an undocumented convenience.
    await mountApp();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
    });
    expect(opened).toEqual(['settings:kareem']);
  });
});