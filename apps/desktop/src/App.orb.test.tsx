import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';

// The orb, AS WIRED — the successor to `App.task-cards.test.tsx`.
//
// WHAT REPLACED WHAT. That file asserted the task-card strip: inventory states
// mapped to cards, a bounded scroll container, an overflow marker, a
// display-only receipt. The strip is no longer rendered by this shell (the
// whole bento column went), and it kept its own suites — `TaskCards.test.tsx`
// for the DOM contract and `matrix/task-state.test.ts` for the mapping — so the
// module coverage did not go with the composition assertions.
//
// WHAT IS COVERED HERE. `Orb.tsx` deliberately keeps its props OUT of the DOM:
// it copies them into refs and paints to a canvas, so nothing about the levels
// is observable from the mounted tree. That is correct for the orb (it owns the
// pixels and its own suite pins them) and it makes this file necessary: the one
// thing that can go wrong in the wiring is App handing the orb the wrong value,
// and a canvas cannot report that. So `Orb` is stubbed here with a component
// that publishes its props as data attributes, and every assertion below is
// about the WIRING — phase, persona, and the two levels in their own directions.
//
// This file is also the break-the-guard target for the whole change: deleting
// `outputLevel={...}` from App.tsx, or dropping `onLevel` from the player, fails
// the `outputLevel` cases below and nothing else in the suite notices.

/** The options App handed to the bridge, so a test can push frames back in. */
let bridgeOptions: {
  onHello?: (h: { persona?: 'kareem' | 'nour'; uplinkPaused?: boolean }) => void;
  onVoice?: (v: { phase: string; transcript?: string }) => void;
  onNotice?: (n: { code: string; detail: string; level: 'info' | 'warn' | 'error' }) => void;
  onAudio?: (audio: Uint8Array) => void;
  onFlow?: (f: { type: 'flow'; seq: number; state: 'pause' | 'resume' }) => void;
  onClose?: () => void;
};
/** The events App handed to `createDefaultPlayer`, so a test can drive levels. */
let playerEvents: { onLevel?(level: number): void } | null = null;
/** The events App handed to `AudioCapture.start`, so a test can drive energy. */
let captureEvents: { onEnergy?(energy: number): void } | null = null;
/** Every command the shell pushed at the bridge, in order. */
let sent: Array<{ kind: string }> = [];

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
    start(events: { onEnergy?(energy: number): void }): Promise<void> {
      captureEvents = events;
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
  createDefaultPlayer: (events?: { onLevel?(level: number): void }) => {
    playerEvents = events ?? null;
    return {
      setMuted: (): void => {},
      enqueue: (): void => {},
      stop: (): void => {},
      dispose: (): void => {},
    };
  },
}));

/**
 * The orb, as a props reader.
 *
 * Not a reimplementation and not a second opinion on the orb's rendering — the
 * real one is pinned by `orb/Orb.test.tsx`. This exists because a canvas cannot
 * report what it was handed, and the wiring is what this file owns.
 */
vi.mock('./orb/Orb.js', () => ({
  Orb: (props: {
    phase: string;
    persona: string;
    inputLevel: number;
    outputLevel: number;
    size?: number;
  }) => (
    <canvas
      data-testid="orb"
      data-phase={props.phase}
      data-persona={props.persona}
      data-input-level={String(props.inputLevel)}
      data-output-level={String(props.outputLevel)}
      data-size={String(props.size ?? '')}
    />
  ),
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
  sent = [];
}

function orb(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>('[data-testid="orb"]');
  if (found === null) throw new Error('orb not rendered');
  return found;
}

function attr(name: string): string | null {
  return orb().getAttribute(name);
}

function click(selector: string): Promise<void> {
  return act(async () => {
    document.body.querySelector<HTMLElement>(selector)?.click();
  });
}

/** Push one downlink chunk, which is what lazily creates the player. */
async function deliverAudio(): Promise<void> {
  await act(async () => {
    bridgeOptions.onAudio?.(new Uint8Array([1]));
  });
  expect(playerEvents, 'precondition: the player was created with events').not.toBeNull();
}

async function phase(value: string): Promise<void> {
  await act(async () => {
    bridgeOptions.onVoice?.({ phase: value });
  });
}

async function notice(code: string, detail: string): Promise<void> {
  await act(async () => {
    bridgeOptions.onNotice?.({ code, detail, level: 'warn' });
  });
}

async function flow(state: 'pause' | 'resume', seq = 1): Promise<void> {
  await act(async () => {
    bridgeOptions.onFlow?.({ type: 'flow', seq, state });
  });
}

/** The transport line, which is where W23 puts the uplink state. */
function statusLine(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>('[data-testid="bridge-status"]');
  if (found === null) throw new Error('bridge-status not rendered');
  return found;
}

// W23 — the backpressure subscription, AS WIRED.
//
// Before this, `onFlow` was among 7 of the 16 `BridgeOptions` callbacks that no
// production call site supplied (`App.tsx` is the HUD; `SettingsView` and
// `KeysView` are the two auxiliary windows). The bridge's latch worked, so
// nothing was broken in the bridge — but the shell dropped every uplink PCM
// chunk while the daemon was congested and rendered no indication of it, while
// the transport line kept claiming it was listening. That silence is the defect.
//
// The mocked bridge here records whatever options App hands it, so these cases
// assert the real subscription rather than a reimplementation of it: deleting
// `onFlow` from `App.tsx` makes `bridgeOptions.onFlow` undefined and the
// "the line stops claiming it is listening" case below cannot pass.

describe('W23 — a paused uplink is surfaced instead of silently dropping audio', () => {
  /**
   * A `hello` first, so the line is not stuck on `offline`.
   *
   * The shell starts in `connecting` and only promotes on an inbound frame, and
   * `offline` outranks everything — including the pause, deliberately. Without a
   * hello every case below would read `غير متصل` and would pass or fail for a
   * reason that has nothing to do with backpressure. Stated as a helper so the
   * precondition is in one place rather than repeated per case.
   */
  async function live(): Promise<void> {
    await act(async () => {
      bridgeOptions.onHello?.({ persona: 'kareem' });
    });
  }

  test('POSITIVE CONTROL: the callback App hands the bridge exists at all', async () => {
    await mountApp();
    expect(bridgeOptions.onFlow, 'App must subscribe to the flow frame').toBeTypeOf('function');
  });

  test('a pause replaces the "listening" claim, which would be false', async () => {
    await mountApp();
    await live();
    await phase('listening');
    expect(statusLine().textContent, 'precondition: it claims to be listening').toContain('الاستماع');
    await flow('pause');
    expect(statusLine().getAttribute('data-state')).toBe('uplink-paused');
    expect(statusLine().textContent, 'it must not still claim to be listening').not.toContain('الاستماع');
  });

  test('and the text says the SERVER suspended it, not the user', async () => {
    // The obvious user response to a "muted" line is to press the mic button,
    // which would silence a microphone the daemon is already refusing — so the
    // line has to name the cause, or it invites the one action that cannot help.
    await mountApp();
    await live();
    await flow('pause');
    expect(statusLine().textContent).toContain('الخادم');
    expect(statusLine().getAttribute('title')).toContain('الالتقاط');
  });

  test('a resume restores the ordinary line', async () => {
    await mountApp();
    await live();
    await flow('pause');
    expect(statusLine().getAttribute('data-state')).toBe('uplink-paused');
    await flow('resume', 2);
    expect(statusLine().getAttribute('data-state')).not.toBe('uplink-paused');
  });

  // `hello.uplinkPaused` is REQUIRED on the wire (`src/ipc/protocol.ts:443`), so
  // this is the ordinary path for a shell that connects while the daemon is
  // already congested — and the only one that works, because `flow` is not
  // retained for resume.
  test('the state is adopted from hello, which is how a late shell learns of it', async () => {
    await mountApp();
    await act(async () => {
      bridgeOptions.onHello?.({ persona: 'kareem', uplinkPaused: true });
    });
    expect(statusLine().getAttribute('data-state')).toBe('uplink-paused');
  });

  // The priority is the design: a pause must not overwrite a claim that is still
  // true, or it trades one lie for another. Speaking is exactly that case.
  test('speaking outranks the pause — that claim is still true', async () => {
    await mountApp();
    await live();
    await phase('speaking');
    await flow('pause');
    expect(statusLine().getAttribute('data-state')).toBe('speaking');
  });

  test('and offline outranks both — it is the more severe truth', async () => {
    await mountApp();
    await act(async () => {
      bridgeOptions.onClose?.();
    });
    await flow('pause');
    expect(statusLine().getAttribute('data-state')).toBe('offline');
  });
});

beforeEach(() => {
  bridgeOptions = {};
  playerEvents = null;
  captureEvents = null;
  sent = [];
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

describe('the orb is the shell, mounted once', () => {
  test('there is exactly one, and it is sized from the shell constants', async () => {
    await mountApp();
    expect(document.body.querySelectorAll('[data-testid="orb"]')).toHaveLength(1);
    // A non-empty `size` proves App passed the number explicitly rather than
    // leaning on the orb's own default, which is what keeps the height
    // arithmetic in App.tsx real.
    expect(attr('data-size')).not.toBe('');
  });

  test('it starts idle and on the default persona', async () => {
    await mountApp();
    expect(attr('data-phase')).toBe('idle');
    expect(attr('data-persona')).toBe('kareem');
  });
});

describe('the daemon phase drives the orb phase', () => {
  test.each(['idle', 'listening', 'thinking', 'speaking'] as const)('a %s voice frame lands as %s', async (value) => {
    await mountApp();
    await phase(value);
    expect(attr('data-phase')).toBe(value);
  });

  test('a muted assistant never wears the speaking phase', async () => {
    // W6 in the phase domain. The daemon keeps reporting `speaking` for as long
    // as it synthesises, so a muted shell that passed that straight through
    // would paint the persona's colours and pulse at output energy for speech
    // nobody can hear. `thinking` is the honest reading: the turn is real, it is
    // just not audible.
    await mountApp();
    await phase('speaking');
    expect(attr('data-phase'), 'precondition: audible, so speaking is honest').toBe('speaking');

    await click('[data-testid="bot-toggle"]');
    expect(attr('data-phase'), 'a silenced assistant is not speaking').toBe('thinking');

    await click('[data-testid="bot-toggle"]');
    expect(attr('data-phase'), 'and unmuting restores it').toBe('speaking');
  });
});

describe('persona is synced with the daemon, in both directions', () => {
  test('a hello adopts the daemon persona', async () => {
    // L22: a shell that connects after a change would otherwise sit on the
    // `kareem` default and paint the wrong voice's colour for whoever is
    // actually speaking.
    await mountApp();
    await act(async () => {
      bridgeOptions.onHello?.({ persona: 'nour' });
    });
    expect(attr('data-persona')).toBe('nour');
  });

  test('a persona-changed notice is followed, and never echoed back', async () => {
    await mountApp();
    await notice('persona-changed', 'nour');
    expect(attr('data-persona')).toBe('nour');
    // The handler sets local state and NOTHING else. Re-sending would bounce
    // the change between the two surfaces; the daemon's equality guard makes it
    // a no-op, but not starting it is the correct behaviour.
    expect(sent.map((c) => c.kind), 'a daemon-originated change must not be re-sent').toEqual([]);
  });

  test('the voice phase alone never changes the persona', async () => {
    await mountApp();
    await phase('speaking');
    expect(attr('data-persona')).toBe('kareem');
  });
});

describe('the microphone level reaches inputLevel, and only while audible', () => {
  test('the first reading is taken; later ones are sampled, not dropped', async () => {
    await mountApp();
    await click('[data-testid="mic-toggle"]');
    expect(captureEvents, 'precondition: the mic is live').not.toBeNull();
    expect(attr('data-input-level')).toBe('0');

    await act(async () => {
      captureEvents?.onEnergy?.(0.4);
    });
    expect(attr('data-input-level')).toBe('0.4');

    // Same clock reading again, so the 80 ms sampler is what rejects this one.
    await act(async () => {
      captureEvents?.onEnergy?.(0.9);
    });
    expect(attr('data-input-level'), 'the sampler throttles, it does not discard').toBe('0.4');
  });

  test('a muted microphone reports zero, whatever the last reading was', async () => {
    await mountApp();
    await click('[data-testid="mic-toggle"]');
    await act(async () => {
      captureEvents?.onEnergy?.(0.6);
    });
    expect(attr('data-input-level')).toBe('0.6');

    await click('[data-testid="mic-toggle"]');
    expect(attr('data-input-level'), 'a released mic has no level to report').toBe('0');
  });
});

describe('the playback level reaches outputLevel, and a zero is never sampled away', () => {
  test('the player is handed an `onLevel` and its readings reach the orb', async () => {
    await mountApp();
    await deliverAudio();
    expect(playerEvents?.onLevel, 'the player must be given a level consumer').toBeTypeOf('function');

    await act(async () => {
      playerEvents?.onLevel?.(0.7);
    });
    expect(attr('data-output-level')).toBe('0.7');
  });

  test('a muted assistant reports zero output, whatever the last reading was', async () => {
    await mountApp();
    await deliverAudio();
    await act(async () => {
      playerEvents?.onLevel?.(0.8);
    });
    expect(attr('data-output-level')).toBe('0.8');

    await click('[data-testid="bot-toggle"]');
    expect(attr('data-output-level'), 'a muted speaker is not making sound').toBe('0');
  });

  test('the terminal zero bypasses the sampler — the orb cannot stay lit', async () => {
    // THE reason the throttle exempts zero. `AudioPlayer.endLevel` publishes
    // exactly 0 when a run ends and on every stop() (which is also the path a
    // mute and a barge-in take). If the 80 ms sampler were allowed to drop it,
    // the orb would keep showing output energy for a reply that finished — or,
    // after a barge-in, for speech the user just talked over.
    await mountApp();
    await deliverAudio();

    await act(async () => {
      playerEvents?.onLevel?.(0.7);
    });
    expect(attr('data-output-level')).toBe('0.7');

    // A second non-zero reading inside the window IS sampled away. Asserted, so
    // the case below cannot pass on a throttle that was quietly removed.
    await act(async () => {
      playerEvents?.onLevel?.(0.9);
    });
    expect(attr('data-output-level'), 'precondition: non-zero levels are throttled').toBe('0.7');

    await act(async () => {
      playerEvents?.onLevel?.(0);
    });
    expect(attr('data-output-level'), 'the zero always lands').toBe('0');
  });

  test('a gap is a real zero, and the exemption is for silence only', async () => {
    // The shape of a Fish reply is speech → gap → speech, and the sampler snaps
    // its floor to exactly 0 so the gap is a VALUE the orb can act on rather
    // than a number too small to see. The exemption then stops there: admitting
    // every level inside the sample window would be no threshold at all.
    await mountApp();
    await deliverAudio();

    await act(async () => {
      playerEvents?.onLevel?.(0.5);
    });
    expect(attr('data-output-level')).toBe('0.5');

    await act(async () => {
      playerEvents?.onLevel?.(0);
    });
    expect(attr('data-output-level')).toBe('0');

    await act(async () => {
      playerEvents?.onLevel?.(0.6);
    });
    expect(attr('data-output-level')).toBe('0');
  });
});