import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import {
  MAX_TASK_CARDS,
  TASK_CHIP_CLASS,
  TASK_TONE,
  TASK_STRIP_MAX_HEIGHT_PX,
  type TaskCard,
} from './matrix/task-state.js';

// M4 C.5 Phase 1 — the task-card strip AS WIRED. RED FIRST.
//
// WHY THIS FILE EXISTS AT ALL, and it is the note the previous item left behind:
// `App.test.tsx` mocks the bridge and asserts nothing about new surfaces, so a
// wiring bug there is GREEN under happy-dom. The pure mapping table is only
// half of C.5; the other half is that the strip is actually mounted, actually
// bounded, and actually silent. None of those three is observable without
// mounting `App` and holding the bridge spy, which is why this is a separate
// file rather than three more cases appended to `App.test.tsx`.
//
// WHAT IS NOT COVERED HERE, stated plainly rather than implied: this file proves
// the strip renders, maps, bounds and sends nothing. It does NOT prove the
// daemon ever produced the inventory frame that feeds it — the stub in E2E
// fabricates one. `inventory` really is produced (`daemon.ts` `publishSessions`
// + `SessionInventory`'s 15 s poll, both live serve calls), so this is the right
// frame to build on, but "the shell renders it" and "the daemon sends it" are
// two claims and only the first is tested here.
//
// The `event` frame is deliberately NOT used, and there is no test that pretends
// it is: `broadcast()` has zero production producers, so an `event`-driven card
// would be a green E2E over a call the daemon never makes. That is Phase 2 and it
// stays unshipped.

/** Every command the HUD pushed at the bridge, in order. */
let sent: Array<{ kind: string }> = [];
/** The options App handed to the bridge, so a test can push frames back in. */
let bridgeOptions: {
  onInventory?: (sessions: Array<{ sessionId: string; state: string }>) => void;
  onVoice?: (v: { phase: string; transcript?: string }) => void;
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
  expect(bridgeOptions.onInventory, 'the inventory handler must be wired at all').toBeTypeOf('function');
  // Baseline: the context gauge asks for telemetry on an interval, and the
  // persona defaults do not send. Nothing above this line may be attributed to
  // the card strip, so it is cleared rather than assumed empty.
  sent = [];
}

/** Deliver one inventory snapshot and let the reducer + strip settle. */
async function deliverInventory(sessions: Array<{ sessionId: string; state: string }>): Promise<void> {
  await act(async () => {
    bridgeOptions.onInventory?.(sessions);
  });
  sent = [];
}

function strip(): HTMLElement | null {
  return document.body.querySelector('[data-testid="task-strip"]');
}

/** Every rendered row. Selected by DATA attribute, not testid, so the same
 *  element can also be addressed by its key without a second marker attribute. */
function cardEls(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[data-task-card]'));
}

function cardByKey(key: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-task-key="${key}"]`);
}

/**
 * Make a session the shell's active one, through the REAL session chip.
 *
 * This is not incidental: the strip only shows a `done`/`unknown` card for the
 * ACTIVE session (a non-active finished row is history, and history lives in
 * the chip's dropdown). So the only honest way to see those two arms rendered is
 * to actually select the session first. It sends `switchSession` — that is the
 * chip's command, and `sent` is cleared afterwards so it is never attributed to
 * the card strip.
 */
async function selectSession(sessionId: string): Promise<void> {
  await act(async () => {
    document.body.querySelector<HTMLElement>('[data-testid="session-chip-trigger"]')?.click();
  });
  await act(async () => {
    document.body.querySelector<HTMLElement>(`[data-testid="session-${sessionId}"]`)?.click();
  });
  sent = [];
}

/** The auto-sized root: the element `useAutoSize` measures with scrollHeight. */
function measuredRoot(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('[data-testid="voxaura-shell"]');
  if (el === null) throw new Error('shell not rendered');
  return el;
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

describe('C.5: each inventory state lands as the right card', () => {
  const CASES: ReadonlyArray<readonly [string, TaskCard['state']]> = [
    ['running', 'running'],
    ['succeeded', 'done'],
    ['error', 'failed'],
    ['idle', 'unknown'],
    ['some-future-token', 'unknown'],
  ];

  test.each(CASES)('state %s renders a %s card with its own chip', async (raw, expected) => {
    await mountApp();
    // A running frame is how the shell learns the session exists at all, and
    // selecting it is what makes the `done`/`unknown` arms visible at all.
    await deliverInventory([{ sessionId: 'ses_probe', state: 'running' }]);
    await selectSession('ses_probe');
    // The row itself is what changes underneath the card.
    await deliverInventory([{ sessionId: 'ses_probe', state: raw }]);

    const card = cardByKey('ses_probe');
    expect(card, 'a card exists for the live session').not.toBeNull();
    expect(card?.getAttribute('data-state')).toBe(expected);
    expect(card?.getAttribute('data-tone')).toBe(TASK_TONE[expected]);
    const chip = card?.querySelector<HTMLElement>('[data-testid="task-chip"]');
    expect(chip?.getAttribute('class')).toBe(TASK_CHIP_CLASS[expected]);
  });

  test('a NON-active finished row is omitted, and running/failed rows are not', async () => {
    await mountApp();
    // No active session, so only the `running` and `failed` arms can render.
    await deliverInventory([
      { sessionId: 'ses_run', state: 'running' },
      { sessionId: 'ses_fail', state: 'error' },
      { sessionId: 'ses_old', state: 'succeeded' },
    ]);
    expect(cardEls().map((c) => c.getAttribute('data-task-key'))).toEqual(['ses_run', 'ses_fail']);
  });
});

describe('C.5: unknown is neutral, asserted on the rendered class', () => {
  test('an unreadable state gets no semantic colour on the chip', async () => {
    await mountApp();
    await deliverInventory([{ sessionId: 'ses_probe', state: 'running' }]);
    await selectSession('ses_probe');
    await deliverInventory([{ sessionId: 'ses_probe', state: 'idle' }]);

    const chip = cardByKey('ses_probe')?.querySelector<HTMLElement>('[data-testid="task-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('data-tone')).toBe('neutral');
    // Asserted on the ACTUAL rendered class string, not on a name, and checked
    // against the exact token the module ships so a hand-edited chip fails.
    expect(chip?.getAttribute('class')).toBe(TASK_CHIP_CLASS.unknown);
    for (const colour of ['#34d399', '#f87171', '#fbbf24', '#38bdf8', '#2563eb']) {
      expect(chip?.getAttribute('class') ?? '').not.toContain(colour);
    }
  });
});

describe('C.5: the synthesised queued card is display-only', () => {
  test('it appears at utterance time and emits ZERO commands', async () => {
    await mountApp();
    expect(cardEls()).toHaveLength(0);

    await act(async () => {
      // `daemon.ts` `setVoicePhase('thinking', transcript)` — the daemon itself
      // reporting that the turn started, carrying the user's own words.
      bridgeOptions.onVoice?.({ phase: 'thinking', transcript: 'افتح المنفذ ٤٠٩٦' });
    });

    const card = cardByKey('local');
    expect(card, 'the receipt is on screen immediately').not.toBeNull();
    expect(card?.getAttribute('data-state')).toBe('queued');
    // THE guard of the item: a card must never manufacture a server round-trip.
    expect(sent, 'a display-only receipt must not send anything').toEqual([]);
    // And it must not be a canned reply either.
    expect(document.body.querySelector('[data-testid="announce"]')?.textContent).toBe('');
  });

  test('it is not a control: no button, no click handler, nothing to press', async () => {
    await mountApp();
    await act(async () => {
      bridgeOptions.onVoice?.({ phase: 'thinking', transcript: 'شغّل الاختبارات' });
    });
    const card = cardByKey('local');
    expect(card?.querySelector('button')).toBeNull();
    // A title is still required, in Arabic, for the row to be readable on hover.
    expect(card?.getAttribute('title') ?? '').toMatch(/\p{sc=Arabic}/u);
  });

  test('the next NON-EMPTY snapshot retires it, and an empty one does not', async () => {
    await mountApp();
    await act(async () => {
      bridgeOptions.onVoice?.({ phase: 'thinking', transcript: 'افتح المنفذ ٤٠٩٦' });
    });
    expect(cardByKey('local')).not.toBeNull();

    // `protocol.ts` documents `sessions: []` as the ERROR/UNREADY shape, so an
    // empty snapshot carries no evidence and must not erase a live receipt.
    await deliverInventory([]);
    expect(cardByKey('local'), 'an empty snapshot is not evidence').not.toBeNull();

    await deliverInventory([{ sessionId: 'ses_a', state: 'succeeded' }]);
    expect(cardByKey('local'), 'a real snapshot supersedes it').toBeNull();
    expect(sent).toEqual([]);
  });
});

describe('C.5: the strip is bounded — the auto-size guard', () => {
  // THE REASON this file bothers: the window AUTO-SIZES to its content
  // (`useAutoSize` measures the root's `scrollHeight`), so an in-flow element
  // that grows with the session list resizes the OS window on every 15 s tick.
  // A 200-row inventory in an unbounded strip would grow the window to 200 rows
  // tall, forever, with no user action.
  //
  // A REAL overflow set-up, not a class name in the DOM: 12 running sessions,
  // which is more than the 88px box can show, so the strip must be a scroll
  // container and the rows must live INSIDE it — not beside it, and not in a
  // sibling that the measured root adds up.
  test('with more cards than fit, the rows are nested inside a bounded scroll container', async () => {
    await mountApp();
    const many = Array.from({ length: MAX_TASK_CARDS }, (_, i) => ({ sessionId: `ses_${i}`, state: 'running' }));
    await deliverInventory(many);

    const el = strip();
    expect(el, 'the strip is mounted').not.toBeNull();
    const cards = cardEls();
    expect(cards.length, 'precondition: the overflow set-up is real').toBeGreaterThan(3);
    expect(cards).toHaveLength(MAX_TASK_CARDS);

    // 1. The bound is a real applied style, not only a Tailwind class: happy-dom
    //    resolves inline styles, so this reads the value a layout engine will.
    expect(window.getComputedStyle(el as HTMLElement).maxHeight).toBe(`${TASK_STRIP_MAX_HEIGHT_PX}px`);
    // 2. …and the house-style class ships too, because that is what Tailwind
    //    compiles for the real renderer.
    expect(el?.className).toContain('overflow-y-auto');
    expect(el?.className).toContain(`max-h-[${TASK_STRIP_MAX_HEIGHT_PX}px]`);

    // 3. The structural proof, which is the part a class name cannot fake: every
    //    row is a DESCENDANT of the scroll container, so the measured root sees
    //    one bounded box instead of N stacked rows. A strip that rendered the
    //    rows as siblings would pass checks 1 and 2 and fail this one.
    for (const card of cards) {
      expect(el?.contains(card), 'every card is inside the bounded scroll container').toBe(true);
      let node: HTMLElement | null = card.parentElement;
      let crossed = false;
      while (node !== null) {
        if (node === el) {
          crossed = true;
          break;
        }
        if (node === measuredRoot()) break;
        node = node.parentElement;
      }
      expect(crossed, 'the card reaches the strip without leaving the measured root').toBe(true);
    }
  });

  test('with no cards the strip renders NOTHING, so the common case costs no height', async () => {
    await mountApp();
    expect(cardEls()).toHaveLength(0);
    // Not "an empty 88px box": an empty in-flow box still adds 88px to every
    // window for every user who has no live work, which is most of them.
    expect(strip(), 'no strip, no height').toBeNull();
  });

  test('the overflow marker is visible instead of a silent trim', async () => {
    await mountApp();
    const many = Array.from({ length: MAX_TASK_CARDS + 3 }, (_, i) => ({ sessionId: `ses_${i}`, state: 'running' }));
    await deliverInventory(many);

    const marker = cardByKey('overflow');
    expect(marker, 'a trim that is not shown is the `totalSessions` defect').not.toBeNull();
    expect(marker?.getAttribute('data-state')).toBe('unknown');
    expect(marker?.textContent ?? '').toContain('3');
    expect(cardEls()).toHaveLength(MAX_TASK_CARDS + 1);
  });
});
