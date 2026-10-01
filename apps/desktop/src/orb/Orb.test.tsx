import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Orb, type OrbProps } from './Orb.js';
import { HALO_SPAN, orbHaloRadius, orbPalette, type OrbPersona, type OrbPhase } from './palette.js';

// The orb, measured rather than trusted.
//
// happy-dom has no 2D context, so `getContext('2d')` is stubbed with a
// RECORDING proxy: every property assignment and every method call is captured,
// and the assertions below read what the component actually drew. A test that
// only asserted "it rendered" would pass for a component that paints nothing —
// the failure mode this whole file exists to rule out.
//
// HARNESS NOTE, because it has already produced vacuous passes in this repo: the
// frame driver hands the component a MONOTONIC clock. The component integrates
// that clock, so a driver that restarted at 0 every tick would freeze the breath
// at sin(0) and every geometry assertion would still be green while measuring a
// single instant.

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** A recording 2D context: fills, strokes, arcs, gradients, styles, alphas. */
interface Recorded {
  fills: number;
  strokes: number;
  arcs: number[];
  lineWidths: number[];
  strokeStyles: string[];
  alphas: number[];
  gradients: { r0: number; r1: number; stops: { offset: number; color: string }[] }[];
}

interface FakeGradient {
  r0: number;
  r1: number;
  stops: { offset: number; color: string }[];
}

function recordingCtx(rec: Recorded): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {};
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'canvas') return null;
        if (prop in state) return state[prop];
        if (prop === 'createRadialGradient') {
          return (...args: unknown[]): CanvasGradient => {
            const g: FakeGradient = {
              // createRadialGradient(x0, y0, r0, x1, y1, r1) — the radii, not
              // the centres, are what the orb's size assertions read.
              r0: args[2] as number,
              r1: args[5] as number,
              stops: [],
            };
            rec.gradients.push(g);
            return {
              addColorStop: (offset: number, color: string): void => {
                g.stops.push({ offset, color });
              },
            } as unknown as CanvasGradient;
          };
        }
        return (...args: unknown[]) => {
          if (prop === 'arc' && typeof args[2] === 'number') rec.arcs.push(args[2]);
          if (prop === 'fill') rec.fills += 1;
          if (prop === 'stroke') rec.strokes += 1;
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

function freshRec(): Recorded {
  return { fills: 0, strokes: 0, arcs: [], lineWidths: [], strokeStyles: [], alphas: [], gradients: [] };
}

/** Install the stub and return the recorder it writes into. */
function stubContext(rec: Recorded): Recorded {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recordingCtx(rec));
  return rec;
}

/** The body's radius in the LAST drawn frame: the rim shares it, and is last. */
function bodyRadius(rec: Recorded): number {
  return rec.arcs[rec.arcs.length - 1] as number;
}

/** Colour stops of the body gradient (halo is created first, body second). */
function bodyStops(rec: Recorded): string[] {
  const g = rec.gradients[rec.gradients.length - 1] as FakeGradient;
  return g.stops.map((s) => s.color);
}

function haloStops(rec: Recorded): string[] {
  const g = rec.gradients[rec.gradients.length - 2] as FakeGradient;
  return g.stops.map((s) => s.color);
}

// Manual frame driver: the component's rAF loop, handed to the test.
let frame: ((t: number) => void) | null = null;
let cancelCount = 0;
let clock = 0;
let reduceMotion = false;

beforeEach(() => {
  frame = null;
  cancelCount = 0;
  clock = 0;
  reduceMotion = false;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frame = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    cancelCount += 1;
  });
  // Pinned rather than inherited: whether happy-dom honours
  // `prefers-reduced-motion` is not a property these tests should depend on.
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) => ({ matches: reduceMotion, media: query }) as unknown as MediaQueryList,
  );
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

function mount(el: React.ReactElement): void {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(el);
  });
}

function rerender(el: React.ReactElement): void {
  act(() => {
    root!.render(el);
  });
}

function tick(n: number): void {
  act(() => {
    for (let i = 0; i < n; i += 1) {
      const cb = frame;
      frame = null;
      clock += 16;
      cb?.(clock);
    }
  });
}

function orbEl(): HTMLCanvasElement {
  const el = document.body.querySelector('[data-testid="orb"]');
  if (el === null) throw new Error('no [data-testid="orb"] in the document');
  return el as HTMLCanvasElement;
}

function props(over: Partial<OrbProps> = {}): OrbProps {
  return { phase: 'idle', persona: 'kareem', inputLevel: 0, outputLevel: 0, ...over };
}

/** The body's radius, once per frame, for `frames` frames. */
function radiusSeries(p: OrbProps, frames: number): number[] {
  const rec = stubContext(freshRec());
  mount(<Orb {...p} />);
  const out: number[] = [];
  for (let i = 0; i < frames; i += 1) {
    rec.arcs.length = 0;
    tick(1);
    out.push(bodyRadius(rec));
  }
  return out;
}

function maxRadius(p: OrbProps, frames = 30): number {
  return Math.max(...radiusSeries(p, frames));
}

describe('Orb — geometry and the requested size', () => {
  test('renders at the requested size, in the CSS box and the backing store', () => {
    mount(<Orb {...props({ size: 320 })} />);
    const canvas = orbEl();
    expect(canvas.style.width).toBe('320px');
    expect(canvas.style.height).toBe('320px');
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    expect(Number(canvas.getAttribute('width'))).toBe(320 * dpr);
    expect(Number(canvas.getAttribute('height'))).toBe(320 * dpr);
  });

  test('defaults to 260 when no size is given', () => {
    mount(<Orb {...props()} />);
    expect(orbEl().style.width).toBe('260px');
    expect(orbEl().style.height).toBe('260px');
  });

  test('the drawn orb scales with the size, not just the element', () => {
    // 30% of the box, at unity scale — measured, so a `size` prop that only
    // resizes the <canvas> attribute would fail here.
    const small = maxRadius(props({ size: 260 }));
    const large = maxRadius(props({ size: 520 }));
    expect(large / small).toBeGreaterThan(1.95);
    expect(large / small).toBeLessThan(2.05);
  });

  test('draws a filled body and a rim every frame', () => {
    const rec = stubContext(freshRec());
    mount(<Orb {...props()} />);
    tick(3);
    // halo fill + body fill + rim stroke, per frame.
    expect(rec.fills).toBe(6);
    expect(rec.strokes).toBe(3);
    expect(rec.gradients).toHaveLength(6);
    expect(rec.lineWidths.every((w) => w === 1.5)).toBe(true);
  });
});

describe('Orb — the four states wear the declared palettes', () => {
  function drawnStops(phase: OrbPhase, persona: OrbPersona = 'kareem'): string[] {
    const rec = stubContext(freshRec());
    mount(<Orb {...props({ phase, persona })} />);
    tick(1);
    return bodyStops(rec);
  }

  test('idle is charcoal', () => {
    expect(drawnStops('idle')).toEqual(['#111115', '#1c1c20', '#27272a']);
  });

  test('listening is the vibrant blue', () => {
    expect(drawnStops('listening')).toEqual(['#38bdf8', '#2f7fd8', '#2563eb']);
  });

  test('thinking borrows the listening blue, exactly', () => {
    expect(drawnStops('thinking')).toEqual(drawnStops('listening'));
  });

  test('speaking is mint green for Kareem', () => {
    expect(drawnStops('speaking', 'kareem')).toEqual(['#4ade80', '#34c265', '#16a34a']);
  });

  test('speaking is pink/rose for Nour', () => {
    expect(drawnStops('speaking', 'nour')).toEqual(['#f472b6', '#e04d97', '#db2777']);
  });

  test('the halo is drawn from the same rim colour, in the same frame', () => {
    const rec = stubContext(freshRec());
    mount(<Orb {...props({ phase: 'speaking', persona: 'nour' })} />);
    tick(1);
    expect(haloStops(rec)[0]).toBe(orbPalette('speaking', 'nour').glow);
    expect(haloStops(rec)[0]).toBe('rgba(219, 39, 119, 0.35)');
  });
});

describe('Orb — the colour transition is interpolated, never snapped', () => {
  test('a phase change walks the RGB channels toward the new palette', () => {
    const rec = stubContext(freshRec());
    mount(<Orb {...props({ phase: 'idle' })} />);
    tick(1);
    expect(bodyStops(rec)[0]).toBe('#111115');

    rerender(<Orb {...props({ phase: 'speaking', persona: 'kareem' })} />);
    tick(1);
    const mid = bodyStops(rec)[0] as string;
    // #111115 = 17, #4ade80 = 74. Strictly between means the fill moved.
    const channel = Number.parseInt(mid.slice(1, 3), 16);
    expect(channel).toBeGreaterThan(17);
    expect(channel).toBeLessThan(74);
    expect(mid).not.toBe('#4ade80');
  });

  test('and it converges on the target palette rather than stalling short', () => {
    const rec = stubContext(freshRec());
    mount(<Orb {...props({ phase: 'idle' })} />);
    tick(1);
    rerender(<Orb {...props({ phase: 'speaking', persona: 'kareem' })} />);
    tick(120);
    expect(bodyStops(rec)).toEqual(['#4ade80', '#34c265', '#16a34a']);
  });

  test('every channel moves, not just the core', () => {
    const rec = stubContext(freshRec());
    mount(<Orb {...props({ phase: 'idle' })} />);
    tick(1);
    rerender(<Orb {...props({ phase: 'speaking', persona: 'nour' })} />);
    tick(1);
    const [core, mid, edge] = bodyStops(rec) as [string, string, string];
    // idle #111115/#1c1c20/#27272a → nour #f472b6/#e04d97/#db2777
    expect(Number.parseInt(edge.slice(1, 3), 16)).toBeGreaterThan(Number.parseInt('#27272a'.slice(1, 3), 16));
    expect(Number.parseInt(mid.slice(3, 5), 16)).toBeGreaterThan(Number.parseInt('#1c1c20'.slice(3, 5), 16));
    expect(Number.parseInt(core.slice(5, 7), 16)).toBeGreaterThan(Number.parseInt('#111115'.slice(5, 7), 16));
  });
});

describe('Orb — audio reactivity', () => {
  test('inputLevel visibly drives the orb while listening', () => {
    const quiet = maxRadius(props({ phase: 'listening', inputLevel: 0 }));
    const loud = maxRadius(props({ phase: 'listening', inputLevel: 1 }));
    expect(loud).toBeGreaterThan(quiet * 1.2);
  });

  test('outputLevel visibly drives the orb while speaking', () => {
    const quiet = maxRadius(props({ phase: 'speaking', outputLevel: 0 }));
    const loud = maxRadius(props({ phase: 'speaking', outputLevel: 1 }));
    expect(loud).toBeGreaterThan(quiet * 1.2);
  });

  test('amplitude rises monotonically with the level', () => {
    const a = maxRadius(props({ phase: 'listening', inputLevel: 0.25 }));
    const b = maxRadius(props({ phase: 'listening', inputLevel: 0.5 }));
    const c = maxRadius(props({ phase: 'listening', inputLevel: 0.75 }));
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  test('the channels do not cross-talk: playback energy is ignored while listening', () => {
    // There is no voice playing in `listening`; a radius that answered to
    // `outputLevel` would be the orb reacting to audio the user cannot hear.
    expect(radiusSeries(props({ phase: 'listening', inputLevel: 0, outputLevel: 1 }), 20)).toEqual(
      radiusSeries(props({ phase: 'listening', inputLevel: 0, outputLevel: 0 }), 20),
    );
  });

  test('and mic energy is ignored while speaking', () => {
    expect(radiusSeries(props({ phase: 'speaking', inputLevel: 1, outputLevel: 0 }), 20)).toEqual(
      radiusSeries(props({ phase: 'speaking', inputLevel: 0, outputLevel: 0 }), 20),
    );
  });

  test('idle ignores both channels and breathes instead', () => {
    expect(radiusSeries(props({ phase: 'idle', inputLevel: 1, outputLevel: 1 }), 20)).toEqual(
      radiusSeries(props({ phase: 'idle', inputLevel: 0, outputLevel: 0 }), 20),
    );
  });

  test('the idle breath is a real motion at about 5% of the radius', () => {
    // 400 frames @16 ms = 6.4 s, more than one 5.7 s period at 1.1 rad/s, so
    // both extremes are sampled. 1.05/0.95 = 1.105 exactly.
    const series = radiusSeries(props({ phase: 'idle' }), 400);
    const max = Math.max(...series);
    const min = Math.min(...series);
    expect(max / min).toBeGreaterThan(1.09);
    expect(max / min).toBeLessThan(1.11);
  });

  test('a live level moves the orb far more than the idle breath does', () => {
    const idle = maxRadius(props({ phase: 'idle' }), 200);
    const live = maxRadius(props({ phase: 'listening', inputLevel: 1 }), 60);
    expect(live / idle).toBeGreaterThan(1.2);
  });
});

describe('Orb — the level boundary cannot break the render', () => {
  const listening = (inputLevel: number): number[] => radiusSeries(props({ phase: 'listening', inputLevel }), 20);
  // A FUNCTION, not a value: a describe body runs at COLLECTION time, before
  // any beforeEach has installed the rAF stub, so measuring here would compare
  // two arrays of `undefined` and pass for the wrong reason.
  const silence = (): number[] => listening(0);

  test('NaN is silence, not a black window', () => {
    const measured = listening(Number.NaN);
    expect(measured.every((r) => Number.isFinite(r))).toBe(true);
    expect(measured).toEqual(silence());
  });

  test('a level above 1 clamps to 1', () => {
    expect(listening(7)).toEqual(listening(1));
  });

  test('a negative level clamps to 0', () => {
    expect(listening(-3)).toEqual(silence());
  });

  test('Infinity clamps to a full-scale orb, and still draws a valid colour', () => {
    const rec = stubContext(freshRec());
    mount(<Orb {...props({ phase: 'listening', inputLevel: Number.POSITIVE_INFINITY })} />);
    tick(30);
    expect(bodyRadius(rec)).toBeGreaterThan(0);
    expect(bodyStops(rec).every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
  });
});

describe('Orb — the halo fits inside the canvas it is drawn into', () => {
  // W22. Every frame records the halo's gradient outer radius (`gradients[…-2].r1`),
  // which is the radius the FILL path is built from, so this measures the geometry
  // that actually clips rather than a restatement of the formula.
  function haloSeries(p: OrbProps, frames: number): number[] {
    const rec = stubContext(freshRec());
    mount(<Orb {...p} />);
    const out: number[] = [];
    for (let i = 0; i < frames; i += 1) {
      tick(1);
      const halo = rec.gradients[rec.gradients.length - 2] as FakeGradient;
      out.push(halo.r1);
    }
    return out;
  }

  /**
   * The widest halo across all four phases at a full-scale audio level, against
   * the usable radius. This is the W22 regression test proper: the clamp is
   * invisible at rest and obvious under load, so a sweep that only sampled
   * `idle` at level 0 would have stayed green on the defect.
   */
  test('the halo never exceeds the usable radius, in any phase, at any level', () => {
    for (const phase of ['idle', 'listening', 'thinking', 'speaking'] as const) {
      const size = 232;
      const widest = Math.max(
        ...haloSeries(props({ phase, inputLevel: 1, outputLevel: 1, size }), 400),
      );
      expect(widest, `halo at ${phase} must fit inside px/2`).toBeLessThanOrEqual(size / 2);
    }
  });

  test('and it holds at the default size too — the defect was never 232-specific', () => {
    const widest = Math.max(...haloSeries(props({ inputLevel: 1, outputLevel: 1 }), 400));
    expect(widest, 'default 260 px canvas').toBeLessThanOrEqual(130);
  });

  // THE POSITIVE CONTROL, and the reason this test is not a tautology.
  // `orbHaloRadius` clamps with a `min`, so asserting `haloR <= size/2` is
  // satisfied by construction and would pass even if `orbHaloRadius` were deleted
  // and the drawing stopped happening. What has to be shown is that the UNCLAMPED
  // halo really does exceed the canvas — otherwise there was never a defect and
  // this "fix" is a change with no cause. The measured overshoot at rest is
  // 128.76 px against a 116 px radius, i.e. 1.11x, and 173.83 px at full scale.
  test('POSITIVE CONTROL: the unclamped halo really would exceed the canvas', () => {
    const size = 232;
    const bodyAtRest = 0.3 * size;
    const unclampedAtRest = bodyAtRest * HALO_SPAN;
    const bodyLoud = 0.3 * size * 1.35;
    const unclampedLoud = bodyLoud * HALO_SPAN;
    expect(unclampedAtRest).toBeGreaterThan(size / 2);
    expect(unclampedLoud).toBeGreaterThan(size / 2);
    // The overshoot is what the clamp removes, and the clamp binds at BOTH ends
    // of the level range — which is the part a level-0 sample would miss.
    expect(orbHaloRadius(size, bodyAtRest)).toBe(size / 2);
    expect(orbHaloRadius(size, bodyLoud)).toBe(size / 2);
  });

  // The clamp must not flatten the halo to a constant everywhere: `thinking` dips
  // to scale 0.88, where 1.85 × 0.3 × 232 × 0.88 = 113.31 < 116, so the design
  // FITS there and the orb must still breathe. A fix that hard-coded the radius
  // would satisfy every assertion above and kill the only phase that breathes.
  test('the halo still breathes in `thinking`, where the design fits unclamped', () => {
    const size = 232;
    const series = haloSeries(props({ phase: 'thinking', size }), 400);
    expect(new Set(series).size, 'thinking must not be pinned to one radius').toBeGreaterThan(1);
    // 0.3 × 232 × 0.88 × 1.85 = 113.31 < 116, so the clamp does not bind at the
    // bottom of the ponder cycle and the glow really does breathe there.
    expect(Math.min(...series), 'and its minimum is inside the canvas').toBeLessThan(size / 2);
    expect(Math.min(...series)).toBeCloseTo(113.31, 1);
  });
});

describe('Orb — lifecycle, accessibility and reduced motion', () => {
  test('is a labelled, non-textual image that publishes its state', () => {
    mount(<Orb {...props({ phase: 'idle' })} />);
    const canvas = orbEl();
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas.getAttribute('role')).toBe('img');
    expect(canvas.getAttribute('aria-label')).toContain('ساكنة');
    expect(canvas.getAttribute('data-phase')).toBe('idle');
    expect(canvas.getAttribute('data-persona')).toBe('kareem');
  });

  test('the label names the persona while the assistant speaks', () => {
    mount(<Orb {...props({ phase: 'speaking', persona: 'nour' })} />);
    expect(orbEl().getAttribute('aria-label')).toContain('نور');
  });

  test('cancels its animation frame on unmount', () => {
    stubContext(freshRec());
    mount(<Orb {...props()} />);
    tick(2);
    act(() => {
      root?.unmount();
    });
    root = null;
    expect(cancelCount).toBe(1);
  });

  test('a missing 2D context is survivable — no throw, no element', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(() => mount(<Orb {...props()} />)).not.toThrow();
    expect(orbEl()).toBeInstanceOf(HTMLCanvasElement);
  });

  // W21. THIS TEST PREVIOUSLY PINNED THE DEFECT AS INTENDED, and the inversion
  // below is deliberate. The old case asserted `expect(frame).toBeNull()` and
  // `cancelCount === 0` — i.e. that `prefers-reduced-motion` started NO loop and
  // drew exactly one frame. That is the freeze: the orb is the shell's only
  // continuous state readout, and one static frame means a user with OS animation
  // effects off got a disc that never breathed, never cross-faded to a phase that
  // had just changed, and never moved for their own voice. Reduced motion is a
  // request for less movement, not for a component that stops updating.
  //
  // The fix keeps the loop and zeroes only the autonomous `sin` term, so the three
  // properties asserted here are the specification of that choice: the loop
  // RUNS, the autonomous pulse is the ONLY thing that stops, and the measured
  // audio still drives the radius. `radiusSeries` sweeps 400 frames (6.4 s), which
  // is more than one full idle breath period at 1.1 rad/s, so a constant series is
  // a real measurement of stillness rather than a phase that happens to be sampled
  // at its turning point.
  test('reduced motion keeps the loop and stops only the autonomous pulse', () => {
    reduceMotion = true;
    const rec = stubContext(freshRec());
    mount(<Orb {...props({ phase: 'idle' })} />);
    // The loop is alive: rAF was asked for a frame.
    expect(frame, 'the animation loop must still run under reduced motion').not.toBeNull();
    tick(1);
    // …and it keeps drawing every frame it is given.
    expect(rec.gradients.length, 'two gradients per frame: halo, then body').toBe(2);
    expect(rec.fills, 'two fills per frame: halo, then body').toBe(2);
    // 6.4 s of frames at scale exactly 1.0 — the `sin` term is gone, so the idle
    // breath the "the idle breath is a real motion" case measures is not here.
    const series = radiusSeries(props({ phase: 'idle' }), 400);
    expect(new Set(series).size, 'the autonomous breath must be exactly zero, not merely small').toBe(1);
    expect(series[0]).toBeCloseTo(0.3 * 260, 6);
  });

  // THE POSITIVE CONTROL for the case above, in the same file on purpose. A test
  // that asserts "the radius did not move" passes just as happily against a
  // component that draws one frame and stops for ANY reason — a dead rAF stub, a
  // broken effect, a phase that never advances. The control says: the SAME sweep,
  // the SAME clock, with the preference off, does move. Without it the case above
  // is the vacuous shape this repo has been bitten by repeatedly.
  test('POSITIVE CONTROL: the identical sweep DOES breathe without the preference', () => {
    reduceMotion = false;
    const series = radiusSeries(props({ phase: 'idle' }), 400);
    const max = Math.max(...series);
    const min = Math.min(...series);
    expect(max / min, 'without the preference the idle breath is real').toBeGreaterThan(1.09);
  });

  // Reduced motion must not cost FUNCTIONALITY, and the audio response is the
  // functionality: the radius answers the user's own voice. A full-scale level
  // must still move the orb by the same ~30% it does otherwise, and the orb must
  // still be recognisably at unity scale while doing it.
  test('and audio still drives the radius under reduced motion', () => {
    reduceMotion = true;
    const quiet = maxRadius(props({ phase: 'listening', inputLevel: 0 }));
    const loud = maxRadius(props({ phase: 'listening', inputLevel: 1 }));
    expect(loud, 'the measured-audio term is a readout, not an animation').toBeGreaterThan(quiet * 1.2);
  });

  // The loop must also still be CANCELLED. Dropping the rAF would leak a frame
  // callback per mounted orb, and the unmount path is the only place that shows it.
  test('and the loop is still cancelled on unmount', () => {
    reduceMotion = true;
    stubContext(freshRec());
    mount(<Orb {...props()} />);
    tick(2);
    act(() => {
      root?.unmount();
    });
    root = null;
    expect(cancelCount).toBe(1);
  });

  test('a non-positive size falls back to the default instead of drawing nothing', () => {
    const rec = stubContext(freshRec());
    mount(<Orb {...props({ size: 0 })} />);
    tick(1);
    expect(orbEl().style.width).toBe('260px');
    expect(bodyRadius(rec)).toBeGreaterThan(0);
  });
});
