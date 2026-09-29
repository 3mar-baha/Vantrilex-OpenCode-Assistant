import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { encodeFrame } from '../../audio/capture.js';
import { frameEnergyDb } from '../../audio/vad.js';
import {
  CalibrationWizard,
  LISTEN_MS,
  MEASURE_MS,
  TOTAL_MS,
  VERDICT_MS,
  type CalibrationClock,
  type CalibrationSource,
} from './CalibrationWizard.js';

// M4 C.6 — the calibration WIZARD, RED FIRST.
//
// The meter (`../audio/calibration-meter.js`) is the half that can be decided
// without hardware. This file is the other half, and the reason the split
// exists: the wizard owns the microphone, the clock and the Arabic, and every
// one of those is a seam here so the 10-second run can be decided in
// milliseconds under happy-dom.
//
// WHAT IS PINNED, in order of how badly it would hurt if it rotted:
//
//   1. THE ORDER of the three phases. A wizard that jumped straight to the
//      verdict would still render a floor, and the user would have had no way
//      to tell they were never asked to keep quiet.
//   2. THE VERDICT NAMES THE FLOOR. A verdict that says "your room is fine"
//      without the number is the defect: the number is the only part a user
//      can compare against a second run or a different mic.
//   3. THE DEFERRED-THRESHOLD CONTROL IS ABSENT — the negative that pins the
//      deferral. Persistence is SPECULATIVE and explicitly deferred: the
//      renderer threshold would only affect barge-in ducking, and nobody has
//      measured that, so writing one would claim an effect that does not exist.
//      Without this assertion a later edit can add a "remember my calibration"
//      control and the suite stays green. It also pins the storage fact: the
//      renderer holds NO durable state (`localStorage` has zero uses in this
//      tree and the webview has no fs capability), so such a control could not
//      work even if someone wanted it.
//   4. SILENCE. No canned reply, no `announce` write, no bridge: the wizard
//      sends nothing, so a user who never asked for a spoken sentence is not
//      given one.
//   5. THE BOUND. The window auto-sizes to its content, so the panel is
//      in-flow and capped rather than free to grow.
//   6. A DENIED MICROPHONE is explained in Arabic instead of failing silently.
//
// EVERY GUARD HERE HAS BEEN BROKEN BY HAND AND WATCHED FAIL; see the report.

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** A clock the test moves by hand. No real timer is ever involved. */
class FakeClock implements CalibrationClock {
  private t = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  /** Fire everything due at or before `target`, earliest first. */
  advanceTo(target: number): void {
    for (let guard = 0; guard < 1000; guard += 1) {
      const due = [...this.timers.entries()]
        .filter(([, v]) => v.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      act(() => {
        due[1].fn();
      });
    }
    this.t = target;
  }
}

interface FakeSourceEvents {
  onFrame(bytes: Uint8Array): void;
  onError?(err: Error): void;
}

/** A microphone that emits frames on demand instead of opening a device. */
class FakeSource implements CalibrationSource {
  started = false;
  stopped = false;
  private events: FakeSourceEvents | null = null;

  constructor(private readonly failure?: Error) {}

  async start(events: FakeSourceEvents): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.started = true;
    this.events = events;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Push `count` frames of a constant-amplitude tone near `db` dBFS. */
  emit(count: number, db: number): void {
    if (this.events === null) throw new Error('source not started');
    const frame = new Int16Array(1600).fill(Math.round(10 ** (db / 20) * 32768));
    for (let i = 0; i < count; i += 1) this.events.onFrame(encodeFrame(frame));
  }

  fail(err: Error): void {
    this.events?.onError?.(err);
  }
}

/**
 * Push frames and let React settle.
 *
 * Wrapped in `act` on purpose: a `setState` issued outside it is scheduled
 * rather than flushed, so the meter would still read its initial value and the
 * assertion would pass on a number nobody produced. That is not hypothetical —
 * an unwrapped `emit` made `data-db` read as `0` and the "quieter than loud"
 * guard compare `0 < 0`.
 */
function emitFrames(source: FakeSource, count: number, db: number): void {
  act(() => {
    source.emit(count, db);
  });
}

function mount(node: React.ReactNode): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(node);
  });
}

function panel(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('[data-testid="calibration-portal"]');
  if (el === null) throw new Error('calibration portal not rendered');
  return el;
}

function phase(): string | null {
  return document.body.querySelector('[data-testid="calibration-portal"]')?.getAttribute('data-phase') ?? null;
}

function text(testid: string): string {
  return document.body.querySelector(`[data-testid="${testid}"]`)?.textContent ?? '';
}

/**
 * Every durable-storage write the wizard could attempt, recorded.
 *
 * The real `localStorage` in this environment is not usable as an observation
 * point (Node's partial Web Storage shim shadows it and has no `clear`), so it
 * is REPLACED rather than read. That makes the guard stronger, not weaker: a
 * spy records an ATTEMPTED write, whereas reading a length only notices one
 * that already landed.
 */
let storageWrites: string[] = [];
let store: Map<string, string>;

function storageSpy(): void {
  vi.stubGlobal('localStorage', {
    get length(): number {
      return store.size;
    },
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      storageWrites.push(`set:${key}`);
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      storageWrites.push(`remove:${key}`);
      store.delete(key);
    },
    clear: (): void => {
      storageWrites.push('clear');
      store.clear();
    },
  });
  vi.stubGlobal('sessionStorage', {
    getItem: (): null => null,
    setItem: (): void => {
      storageWrites.push('sessionStorage:set');
    },
  });
}

beforeEach(() => {
  storageWrites = [];
  store = new Map<string, string>();
  storageSpy();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('C.6: the three phases run in order over ~10 s', () => {
  test('listen → measure → verdict, then the run is done', () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    mount(<CalibrationWizard onClose={() => {}} clock={clock} createSource={() => source} />);

    const seen: Array<string | null> = [phase()];
    expect(seen[0]).toBe('listen');
    expect(source.started, 'the wizard asks the microphone to open').toBe(true);

    clock.advanceTo(LISTEN_MS - 1);
    expect(phase(), 'still listening one millisecond before the boundary').toBe('listen');

    clock.advanceTo(LISTEN_MS);
    seen.push(phase());
    clock.advanceTo(LISTEN_MS + MEASURE_MS - 1);
    expect(phase(), 'measuring until the verdict boundary').toBe('measure');
    clock.advanceTo(LISTEN_MS + MEASURE_MS);
    seen.push(phase());
    clock.advanceTo(LISTEN_MS + MEASURE_MS + VERDICT_MS - 1);
    expect(phase()).toBe('verdict');
    clock.advanceTo(TOTAL_MS);
    seen.push(phase());

    expect(seen).toEqual(['listen', 'measure', 'verdict', 'done']);
    // The roadmap's geometry, pinned so the phases cannot quietly shorten.
    expect([LISTEN_MS, MEASURE_MS, VERDICT_MS, TOTAL_MS]).toEqual([3000, 5000, 2000, 10000]);
  });

  test('the live energy meter moves during LISTEN and the source is released on close', () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    // `onClose` unmounts, because that is what the shell does with it: the
    // device is released by the effect cleanup, so a close that does not
    // unmount is not a close. Asserting `stopped` without this would pin a
    // leak.
    const onClose = vi.fn(() => {
      root?.unmount();
    });
    mount(<CalibrationWizard onClose={onClose} clock={clock} createSource={() => source} />);

    emitFrames(source, 1, -12);
    const meter = document.body.querySelector<HTMLElement>('[data-testid="calibration-energy"]');
    expect(meter, 'a live meter is the point of the listen phase').not.toBeNull();
    const loud = Number(meter?.getAttribute('data-db') ?? 'NaN');
    expect(Number.isFinite(loud)).toBe(true);
    expect(loud).toBeGreaterThan(-30);

    emitFrames(source, 1, -70);
    const quiet = Number(document.body.querySelector('[data-testid="calibration-energy"]')?.getAttribute('data-db'));
    expect(quiet).toBeLessThan(loud);
    // The bar is a width, so the meter is readable, not just numeric.
    expect(meter?.getAttribute('style') ?? '').toContain('width');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(source.stopped, 'the device is released when the portal closes').toBe(true);
  });
});

describe('C.6: the verdict names the measured floor', () => {
  test('a loud room reads noisy and the dB figure is in the sentence', () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    mount(<CalibrationWizard onClose={() => {}} clock={clock} createSource={() => source} />);
    clock.advanceTo(LISTEN_MS);
    emitFrames(source, 30, -20);
    clock.advanceTo(LISTEN_MS + MEASURE_MS);

    const verdict = document.body.querySelector<HTMLElement>('[data-testid="calibration-verdict"]');
    expect(verdict).not.toBeNull();
    expect(panel().getAttribute('data-band')).toBe('noisy');
    const frame = new Int16Array(1600).fill(Math.round(10 ** (-20 / 20) * 32768));
    const measured = frameEnergyDb(frame);
    // The number is the whole verdict: exact in the attribute, rounded to one
    // decimal in the sentence a human reads.
    expect(verdict?.getAttribute('data-floor-db')).toBe(String(measured));
    expect(text('calibration-verdict')).toContain(measured.toFixed(1));
    expect(text('calibration-verdict')).toContain('ديسيبل');
  });

  test('a quiet room reads quiet, and the same sentence shape is used', () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    mount(<CalibrationWizard onClose={() => {}} clock={clock} createSource={() => source} />);
    clock.advanceTo(LISTEN_MS);
    emitFrames(source, 30, -62);
    clock.advanceTo(LISTEN_MS + MEASURE_MS);

    expect(panel().getAttribute('data-band')).toBe('quiet');
    const frame = new Int16Array(1600).fill(Math.round(10 ** (-62 / 20) * 32768));
    expect(text('calibration-verdict')).toContain(frameEnergyDb(frame).toFixed(1));
  });

  test('frames captured during LISTEN are not part of the floor', () => {
    // The listen phase exists to show the mic is live, and the user may well
    // be talking during it. Mixing those frames into the floor would measure
    // the user, not the room.
    const clock = new FakeClock();
    const source = new FakeSource();
    mount(<CalibrationWizard onClose={() => {}} clock={clock} createSource={() => source} />);
    emitFrames(source, 30, -5); // the user speaking, during LISTEN
    clock.advanceTo(LISTEN_MS);
    emitFrames(source, 30, -65); // the room, during MEASURE
    clock.advanceTo(LISTEN_MS + MEASURE_MS);

    expect(panel().getAttribute('data-band')).toBe('quiet');
  });

  test('with no microphone the verdict says so and claims no number', () => {
    // Not a fourth outcome: the band stays at the conservative arm, the copy
    // says the measurement did not happen, and NO floor is invented. A wizard
    // that printed "-70 dB" here would be stating a measurement it never took.
    const clock = new FakeClock();
    const source = new FakeSource();
    mount(<CalibrationWizard onClose={() => {}} clock={clock} createSource={() => source} />);
    clock.advanceTo(TOTAL_MS);

    const verdict = document.body.querySelector<HTMLElement>('[data-testid="calibration-verdict"]');
    expect(verdict?.getAttribute('data-measured')).toBe('false');
    expect(verdict?.getAttribute('data-floor-db')).toBe('');
    expect(text('calibration-verdict')).toMatch(/\p{sc=Arabic}/u);
    expect(text('calibration-verdict')).not.toMatch(/-?\d+\.\d/);
  });
});

describe('C.6: the deferred threshold is NOT offered', () => {
  test('there is no control, no storage write and no way to "apply" a value', () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    mount(<CalibrationWizard onClose={() => {}} clock={clock} createSource={() => source} />);
    clock.advanceTo(LISTEN_MS);
    emitFrames(source, 30, -45);
    clock.advanceTo(TOTAL_MS);

    // No input of any kind, and specifically not a threshold slider/number
    // box. Persistence is SPECULATIVE and deferred: the renderer threshold
    // would only affect barge-in ducking, and nobody has measured that.
    expect(panel().querySelectorAll('input')).toHaveLength(0);
    expect(panel().querySelectorAll('select')).toHaveLength(0);
    expect(panel().querySelectorAll('textarea')).toHaveLength(0);
    for (const marker of ['threshold', 'save', 'apply', 'persist', 'remember']) {
      expect(panel().innerHTML.toLowerCase(), `no ${marker} control may exist`).not.toContain(marker);
    }
    // The storage fact behind that choice: the renderer holds no durable
    // state, so a "remember my calibration" control could not work even if it
    // were wanted. The spy records an attempted write, not a landed one.
    expect(storageWrites).toEqual([]);
    expect(store.size).toBe(0);
  });

  test('the copy says the run measured and did not change anything', () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    mount(<CalibrationWizard onClose={() => {}} clock={clock} createSource={() => source} />);
    clock.advanceTo(TOTAL_MS);

    // Pinned verbatim: copy that implied the value was applied would be a lie
    // about a threshold nobody measured and nothing stored.
    expect(text('calibration-advice-only')).toBe('قياس فقط — لم تُحفظ أي عتبة ولم يتغيّر أي إعداد.');
    expect(text('calibration-advice-only')).toMatch(/\p{sc=Arabic}/u);
  });
});

describe('C.6: the wizard is silent and self-contained', () => {
  test('it opens no socket and renders no canned reply', () => {
    const opened: string[] = [];
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url: string) {
          opened.push(url);
        }
      },
    );
    const clock = new FakeClock();
    const source = new FakeSource();
    mount(<CalibrationWizard onClose={() => {}} clock={clock} createSource={() => source} />);
    clock.advanceTo(LISTEN_MS);
    emitFrames(source, 30, -50);
    clock.advanceTo(TOTAL_MS);

    expect(opened, 'a measurement must not open a socket').toEqual([]);
    expect(document.body.querySelector('[data-testid="announce"]')).toBeNull();
  });

  test('a denied microphone is explained in Arabic, not swallowed', async () => {
    const clock = new FakeClock();
    const denied = Object.assign(new Error('microphone denied or absent: refused'), { name: 'NotAllowedError' });
    const source = new FakeSource(denied);
    mount(<CalibrationWizard onClose={() => {}} clock={clock} createSource={() => source} />);
    // The rejection lands in a microtask, so the run is not started until the
    // component has actually seen it — otherwise this asserts on a race.
    await act(async () => {
      await Promise.resolve();
    });
    clock.advanceTo(TOTAL_MS);

    expect(text('calibration-mic-error')).toMatch(/\p{sc=Arabic}/u);
    expect(text('calibration-mic-error')).toContain('إذن');
    // The run still ends: a denial is a verdict about the room, not a hang.
    expect(phase()).toBe('done');
  });

  test('the panel is bounded, because the window auto-sizes to its content', () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    mount(<CalibrationWizard onClose={() => {}} clock={clock} createSource={() => source} />);

    // Resolved inline style, not only a Tailwind class: happy-dom resolves
    // inline styles, so this reads the value a layout engine will.
    const body = document.body.querySelector<HTMLElement>('[data-testid="calibration-body"]');
    const cap = Number(body?.style.maxHeight.replace('px', '') ?? 'NaN');
    expect(Number.isFinite(cap), 'the panel carries a real max-height').toBe(true);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(600); // the window's own height
    expect(body?.className ?? '').toContain('overflow-y-auto');
    const width = Number(body?.style.width.replace('px', '') ?? 'NaN');
    expect(width).toBeLessThanOrEqual(440); // the window's own width
  });
});
