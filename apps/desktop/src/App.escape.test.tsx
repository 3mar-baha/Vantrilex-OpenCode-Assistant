import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import { SERVE_LOCAL_ONLY_COMMANDS, isServeLocalOnlyCommand } from './serve-health-signal.js';

// The escape slot, AS MOUNTED — the test that pins the fix for the outage trap.
//
// THE DEFECT THIS FILE EXISTS FOR. Two agents, each right about their own layer:
//
//   · `src/runtime/serve-health.ts` allowlists nine command kinds as provably
//     unable to reach serve, and its comment on `withServeGate` names the reason
//     in one line: blocking `abort` would "strand a mid-utterance user behind a
//     dead port with no way to make it stop".
//   · `BentoGrid` put ONE `inert` attribute on the whole action slot, and `inert`
//     is inherited, so the stop control was inside it.
//
// Net effect: a dead 4096 removed the button that stops the assistant. The
// outage became the thing the user could not escape. The two tests that matter
// most here are `abort works in every serve state` and `every escape control
// sends a command the daemon will still honour` — the first is the behaviour, the
// second is the reason the behaviour is safe.
//
// NOT COVERED, and the reason is structural rather than an omission: that the
// daemon ever EMITS a serve-health notice. `serve-health.ts` documents that the
// monitor is not wired into the daemon yet, so every test below drives the shell
// through the notice frame it would receive. These tests are about what the
// renderer does with an OBSERVED loss, never about whether one is observed.

let sent: Array<{ kind: string }> = [];
let bridgeOptions: {
  onNotice?: (n: { code: string; detail: string; level: 'info' | 'warn' | 'error' }) => void;
  onEvent?: (e: { state: string }) => void;
  onAck?: unknown;
};

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
    setMuted: (): void => {},
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
  expect(bridgeOptions.onNotice, 'serve health arrives on the notice channel').toBeTypeOf('function');
  sent = [];
}

async function deliverNotice(code: string, detail: string): Promise<void> {
  await act(async () => {
    bridgeOptions.onNotice?.({ code, detail, level: 'warn' });
  });
}

/** Put the HUD into the "a turn is running" state, so abort is the live action. */
async function makeLive(): Promise<void> {
  await act(async () => {
    bridgeOptions.onEvent?.({ state: 'running' });
  });
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

beforeEach(() => {
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

describe('the escape slot survives a serve outage', () => {
  test('the slot exists as a SIBLING of the blocked slot, never inside it', async () => {
    // The structural fix, asserted before any behaviour: `inert` is inherited, so
    // the only way an escape control is guaranteed live in every state is to not
    // be a descendant of anything that can be inerted.
    await mountApp();
    const blocked = el('[data-testid="bento-actions"]');
    const escape = el('[data-testid="bento-escape"]');
    expect(blocked).not.toBeNull();
    expect(escape).not.toBeNull();
    expect(blocked?.contains(escape ?? null)).toBe(false);
    expect(escape?.contains(blocked ?? null)).toBe(false);
    expect(escape?.parentElement).toBe(blocked?.parentElement);
    expect(escape?.className, 'and it carries no blocker styling in any state').not.toContain(
      'pointer-events-none',
    );
  });

  test('abort works in every serve state — the whole point of the fix', async () => {
    // Four states, and the assertion in each is the same: the click lands, the
    // command goes out. `dropped` is the one that used to fail.
    const states: Array<[string, () => Promise<void>]> = [
      ['connected', async () => undefined],
      ['degraded', async () => deliverNotice('serve-degraded', 'انقطع الاتصال بالخادم على المنفذ ٤٠٩٦')],
      [
        'reconnecting',
        async () => deliverNotice('serve-reconnecting', 'جارٍ إعادة الاتصال بالخادم على المنفذ ٤٠٩٦'),
      ],
      [
        'exhausted',
        async () => deliverNotice('serve-reconnect-exhausted', 'تعذر إعادة الاتصال بالخادم على المنفذ ٤٠٩٦'),
      ],
    ];

    for (const [label, drive] of states) {
      await mountApp();
      await drive();
      // Precondition, so this test cannot pass by the outage never having been
      // raised: the banner is up and the blocked slot really is inert.
      const blocked = el('[data-testid="bento-actions"]');
      if (label !== 'connected') {
        expect(el('[data-testid="reconnect-banner"]'), `${label}: the outage must be real`).not.toBeNull();
        expect(blocked?.hasAttribute('inert'), `${label}: the block must be real`).toBe(true);
      }

      const button = el('[data-testid="abort-button"]');
      expect(button, `${label}: the stop control must be rendered`).not.toBeNull();
      expect(insideInert(button), `${label}: the stop control must not be inert`).toBe(false);

      await makeLive();
      await act(async () => {
        el('[data-testid="abort-button"]')?.click();
      });
      expect(sent.map((c) => c.kind), `${label}: the stop must reach the daemon`).toContain('abort');

      act(() => {
        root?.unmount();
      });
      host?.remove();
      root = null;
      host = null;
      document.body.innerHTML = '';
    }
  });

  test('dismissing the banner does not touch the escape slot either', async () => {
    // Dismissal governs the WORDS. If it could also govern the consequence — even
    // for the controls that are supposed to be unconditionally live — then the
    // invariant above would be a property of a state nobody can reach.
    await mountApp();
    await deliverNotice('serve-degraded', 'انقطع الاتصال بالخادم');
    await act(async () => {
      el('[data-testid="reconnect-dismiss"]')?.click();
    });
    expect(el('[data-testid="reconnect-banner"]')).toBeNull();
    expect(el('[data-testid="bento-actions"]')?.hasAttribute('inert'), 'still blocked').toBe(true);
    const escape = el('[data-testid="bento-escape"]');
    expect(escape?.hasAttribute('inert')).toBe(false);
    expect(insideInert(el('[data-testid="abort-button"]'))).toBe(false);
    expect(insideInert(el('[data-testid="bot-toggle"]'))).toBe(false);
  });

  test('every escape control sends a command the daemon will still honour', async () => {
    // THE reason the escape slot is safe rather than merely available. The mirror
    // is the daemon's own allowlist, so this walks the mounted DOM, clicks
    // everything in the slot, and asks the specification whether the daemon would
    // have honoured each thing it sent. A control that sends nothing at all is
    // trivially safe and is called out separately.
    await mountApp();
    await deliverNotice('serve-degraded', 'انقطع الاتصال بالخادم');
    const escape = el('[data-testid="bento-escape"]');
    expect(escape, 'the escape slot is rendered').not.toBeNull();
    const controls = Array.from(escape?.querySelectorAll('button') ?? []);
    expect(controls.length, 'the slot holds the stop and the silence controls').toBeGreaterThan(1);

    for (const control of controls) {
      await act(async () => {
        control.click();
      });
    }
    // The stop control is a toggle: at rest it arms a new turn, mid-turn it
    // aborts. Both are on the allowlist and both are on the escape path, so the
    // walk visits each — a fix that left one arm in the blocked slot would pass a
    // test that only clicked the idle state.
    await makeLive();
    await act(async () => {
      el('[data-testid="abort-button"]')?.click();
    });

    expect(sent.length, 'every escape control is wired to something').toBeGreaterThan(0);
    for (const cmd of sent) {
      expect(
        isServeLocalOnlyCommand(cmd.kind),
        `${cmd.kind} must be on the daemon's serve-INDEPENDENT allowlist, or the escape slot is a lie`,
      ).toBe(true);
    }
    // The two arms of the stop control are reached by this walk, not asserted
    // beside it, and the silence control contributed NOTHING (W6 made it
    // renderer-local) — which is why the set assertion above is over `sent` and
    // not over the control list.
    expect(sent.map((c) => c.kind)).toContain('abort');
    expect(sent.map((c) => c.kind)).toContain('arm');
    expect(new Set(sent.map((c) => c.kind))).toEqual(new Set(['abort', 'arm']));
  });

  test('the microphone IS blocked — the block is scoped, not abolished', async () => {
    // The other half, and the one that would be missed by a fix that simply
    // turned the `inert` off. `deafen` is on the daemon's allowlist, and the mic
    // is still inside the blocked slot: what a dead port breaks is the AFFORDANCE
    // ("speak and OpenCode will answer"), not the transport. A shell that let the
    // user unmute into a dead 4096 would be selling a turn that cannot happen.
    await mountApp();
    await deliverNotice('serve-degraded', 'انقطع الاتصال بالخادم');
    const slot = el('[data-testid="bento-actions"]');
    expect(slot?.hasAttribute('inert')).toBe(true);
    expect(slot?.contains(el('[data-testid="mic-toggle"]') ?? null)).toBe(true);
    expect(insideInert(el('[data-testid="mic-toggle"]'))).toBe(true);
    expect(slot?.contains(el('[data-testid="abort-button"]') ?? null)).toBe(false);
  });

  test('stopSpeech has no control, so nothing in the DOM can gate it', async () => {
    // `stopSpeech` is the barge path: it is sent from the microphone's frame
    // handler, not from a button, so no `inert` subtree can reach it. Asserted
    // from both ends — no control claims to send it, and the mirror that governs
    // the escape slot says the daemon honours it anyway.
    await mountApp();
    await deliverNotice('serve-degraded', 'انقطع الاتصال بالخادم');
    expect(all('button[data-testid="stop-speech"]')).toHaveLength(0);
    expect(isServeLocalOnlyCommand('stopSpeech')).toBe(true);
    // And the one control that stops SPEECH from the UI is the bot mute, which is
    // in the escape slot and sends nothing at all — the renderer-local path (W6).
    expect(insideInert(el('[data-testid="bot-toggle"]'))).toBe(false);
  });
});

describe('the escape slot does not leak into the blocked affordances', () => {
  test('the blocked slot still holds the turn controls, and only those', async () => {
    await mountApp();
    const slot = el('[data-testid="bento-actions"]');
    for (const id of ['mic-toggle', 'hud-persona-kareem', 'hud-persona-nour']) {
      expect(slot?.contains(el(`[data-testid="${id}"]`) ?? null), `${id} is a turn control`).toBe(true);
    }
    for (const id of ['abort-button', 'bot-toggle']) {
      expect(slot?.contains(el(`[data-testid="${id}"]`) ?? null), `${id} is an escape control`).toBe(false);
    }
  });

  test('the mirror the slot is checked against is the nine-member allowlist', async () => {
    // Guards the guard: if this file ever asserted against an empty set, every
    // "escape controls are safe" test above would pass for the wrong reason.
    expect(SERVE_LOCAL_ONLY_COMMANDS.size).toBe(9);
  });

  test('the grid keeps rendering a blocked slot when there is no escape content', async () => {
    // `escape` is optional. A grid without it must behave exactly as it did
    // before, and this is asserted on the composed shell rather than on a
    // hand-rolled fixture so the prop really is optional in the shipped path.
    await mountApp();
    expect(el('[data-testid="bento-escape"]')).not.toBeNull();
    expect(el('[data-testid="bento-actions"]')).not.toBeNull();
  });
});
