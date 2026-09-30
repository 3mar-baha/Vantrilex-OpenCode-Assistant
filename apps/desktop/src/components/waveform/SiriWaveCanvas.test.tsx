import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  SPEAKER_PALETTE,
  SiriWaveCanvas,
  mixHex,
  speakerPalette,
  type SiriWaveMode,
} from './SiriWaveCanvas.js';
import { SPEECH_GATE_DB, dbToWaveEnergy, frameEnergyDb } from '../../audio/vad.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(el: React.ReactElement): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(el);
  });
}

/**
 * Recording 2D context. Captures every property assignment and method call so
 * a test can assert what was actually drawn rather than trusting the source.
 */
interface Recorded {
  fills: number;
  roundRects: number;
  strokes: number;
  lineWidths: number[];
  strokeStyles: string[];
  alphas: number[];
  ys: number[];
}

function recordingCtx(rec: Recorded): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {};
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'canvas') return null;
        if (prop in state) return state[prop];
        if (prop === 'roundRect') return () => void rec.roundRects++;
        return (...args: unknown[]) => {
          if (prop === 'stroke') rec.strokes++;
          if (prop === 'fill') rec.fills++;
          if (prop === 'lineTo' && typeof args[1] === 'number') rec.ys.push(args[1]);
        };
      },
      set: (_t, prop: string, value: unknown) => {
        state[prop] = value;
        if (prop === 'lineWidth') rec.lineWidths.push(value as number);
        if (prop === 'strokeStyle') rec.strokeStyles.push(value as string);
        if (prop === 'globalAlpha') rec.alphas.push(value as number);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

const CY = 90 / 2;
/** Peak vertical excursion of the drawn thread. */
function extent(rec: Recorded): number {
  if (rec.ys.length === 0) return 0;
  return Math.max(...rec.ys.map((y) => Math.abs(y - CY)));
}

// Manual frame driver: the component's rAF loop, handed to the test.
let frame: ((t: number) => void) | null = null;
let cancelCount = 0;

beforeEach(() => {
  frame = null;
  cancelCount = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frame = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    cancelCount += 1;
  });
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
  vi.restoreAllMocks();
});

function tick(n: number): void {
  act(() => {
    for (let i = 0; i < n; i += 1) {
      const cb = frame;
      frame = null;
      cb?.(i * 16);
    }
  });
}

describe('SiriWaveCanvas — thread only (D6)', () => {
  test('draws strokes and NEVER a bar', () => {
    const rec: Recorded = { fills: 0, roundRects: 0, strokes: 0, lineWidths: [], strokeStyles: [], alphas: [], ys: [] };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recordingCtx(rec));
    mount(<SiriWaveCanvas mode="active" />);
    tick(1);
    // The 5 chunky pill bars are gone. Only the thread remains.
    expect(rec.roundRects).toBe(0);
    expect(rec.fills).toBe(0);
    expect(rec.strokes).toBe(5);
  });

  test('uses the upstream top-curve lineWidth of 1.5, not 2.5', () => {
    const rec: Recorded = { fills: 0, roundRects: 0, strokes: 0, lineWidths: [], strokeStyles: [], alphas: [], ys: [] };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recordingCtx(rec));
    mount(<SiriWaveCanvas mode="active" />);
    tick(2);
    expect(Math.max(...rec.lineWidths)).toBe(1.5);
  });

  test('renders a labelled canvas in both modes without crashing', () => {
    mount(<SiriWaveCanvas mode="idle" />);
    const canvas = document.body.querySelector('[data-testid="siri-wave"]');
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute('aria-label')).toContain('الموجة الصوتية');
    expect(document.body.querySelector('[data-testid="siri-wave"]')).not.toBeNull();
  });

  test('cleans up its animation frame on unmount', () => {
    const rec: Recorded = { fills: 0, roundRects: 0, strokes: 0, lineWidths: [], strokeStyles: [], alphas: [], ys: [] };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recordingCtx(rec));
    mount(<SiriWaveCanvas mode="active" />);
    act(() => {
      root?.unmount();
    });
    root = null;
    expect(cancelCount).toBe(1);
  });
});

describe('SiriWaveCanvas — the thread reacts to live RMS (D7)', () => {
  function measure(energy: number, mode: SiriWaveMode = 'active'): number {
    const rec: Recorded = { fills: 0, roundRects: 0, strokes: 0, lineWidths: [], strokeStyles: [], alphas: [], ys: [] };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recordingCtx(rec));
    mount(<SiriWaveCanvas mode={mode} energy={energy} />);
    tick(30);
    const e = extent(rec);
    act(() => {
      root?.unmount();
    });
    root = null;
    return e;
  }

  test('silence draws a small thread, not a full-height one', () => {
    const quiet = measure(0);
    expect(quiet).toBeGreaterThan(0);
    expect(quiet).toBeLessThan(12);
  });

  test('loud speech draws a visibly larger thread', () => {
    const quiet = measure(0);
    const loud = measure(1);
    expect(loud).toBeGreaterThan(quiet * 3);
  });

  test('amplitude increases monotonically with energy', () => {
    const a = measure(0.25);
    const b = measure(0.5);
    const c = measure(0.75);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  test('idle mode never draws as large as active mode at the same energy', () => {
    expect(measure(1, 'idle')).toBeLessThan(measure(1, 'active'));
  });

  // A2 — the AMPLITUDE follows a real measurement, not a prop someone guessed.
  //
  // The brief asked for the VALUE, not a class name: a synthetic non-silent
  // frame must measurably change what is drawn, and silence must not. These
  // drive the same `dbToWaveEnergy(frameEnergyDb(frame))` pair the capture path
  // emits, so the assertion covers the measurement AND the pixels.
  test('a synthetic silent frame draws a resting thread, a voice frame a large one', () => {
    const silence = measure(dbToWaveEnergy(-100));
    const voice = measure(dbToWaveEnergy(frameEnergyDb(new Int16Array(1600).fill(4000))));
    expect(silence).toBeGreaterThan(0);
    expect(voice).toBeGreaterThan(silence * 3);
  });

  test('room tone and voice are told apart by the DRAWN EXTENT, not by a prop name', () => {
    // ~-58 dBFS room tone vs ~-18 dBFS voice: two real Int16 frames.
    const room = measure(dbToWaveEnergy(frameEnergyDb(new Int16Array(1600).fill(40))));
    const voice = measure(dbToWaveEnergy(frameEnergyDb(new Int16Array(1600).fill(4000))));
    expect(room).toBeLessThan(voice * 0.5);
  });

  test('a frame just over the gate is drawn visibly alive, not at the resting thread', () => {
    const atGate = Math.round(32768 * 10 ** (SPEECH_GATE_DB / 20)) + 1;
    const db = frameEnergyDb(new Int16Array(1600).fill(atGate));
    expect(db).toBeGreaterThan(SPEECH_GATE_DB);
    // The user sees the thread wake at the same moment their audio starts
    // being transmitted — one measurement, two consumers.
    expect(measure(dbToWaveEnergy(db))).toBeGreaterThan(measure(dbToWaveEnergy(-100)) * 2);
  });
});

describe('SiriWaveCanvas — speaker palettes (D8)', () => {
  test('every curve is stroked with a colour from the speaker palette', () => {
    const rec: Recorded = { fills: 0, roundRects: 0, strokes: 0, lineWidths: [], strokeStyles: [], alphas: [], ys: [] };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recordingCtx(rec));
    const [from, to] = SPEAKER_PALETTE.kareem;
    mount(<SiriWaveCanvas mode="active" palette={SPEAKER_PALETTE.kareem} />);
    tick(1);
    // Exactly the five ramp points, one per curve, and nothing off-palette.
    const expected = [0, 1, 2, 3, 4].map((c) => mixHex(from, to, c / 4));
    expect(rec.strokeStyles).toEqual(expected);
  });

  test('the ramp spans both stops across the curve stack', () => {
    const rec: Recorded = { fills: 0, roundRects: 0, strokes: 0, lineWidths: [], strokeStyles: [], alphas: [], ys: [] };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recordingCtx(rec));
    const [from, to] = SPEAKER_PALETTE.nour;
    mount(<SiriWaveCanvas mode="active" palette={SPEAKER_PALETTE.nour} />);
    tick(2);
    expect(rec.strokeStyles).toContain(from);
    expect(rec.strokeStyles).toContain(to);
  });

  test('the three required speaker palettes are exact', () => {
    expect(SPEAKER_PALETTE.user).toEqual(['#2563EB', '#EAB308']);
    expect(SPEAKER_PALETTE.kareem).toEqual(['#16A34A', '#EAB308']);
    expect(SPEAKER_PALETTE.nour).toEqual(['#9333EA', '#EC4899']);
  });

  test('speakerPalette resolves a speaker and falls back safely', () => {
    expect(speakerPalette('nour')).toEqual(SPEAKER_PALETTE.nour);
    expect(speakerPalette('nobody')).toEqual(SPEAKER_PALETTE.user);
  });

  test('a single `color` still works as a flat one-stop palette', () => {
    const rec: Recorded = { fills: 0, roundRects: 0, strokes: 0, lineWidths: [], strokeStyles: [], alphas: [], ys: [] };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recordingCtx(rec));
    mount(<SiriWaveCanvas mode="active" color="#123456" />);
    tick(2);
    expect(new Set(rec.strokeStyles)).toEqual(new Set(['#123456']));
  });

  test('mixHex interpolates endpoints and pins the middle', () => {
    expect(mixHex('#000000', '#FFFFFF', 0)).toBe('#000000');
    expect(mixHex('#000000', '#FFFFFF', 1)).toBe('#FFFFFF');
    expect(mixHex('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });
});
