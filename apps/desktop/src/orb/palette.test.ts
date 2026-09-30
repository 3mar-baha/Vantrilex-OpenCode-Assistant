import { describe, expect, test } from 'vitest';
import {
  clampLevel,
  hexToRgb,
  mixHex,
  mixRgb,
  orbBreathAmplitude,
  orbGlow,
  orbPalette,
  rgbToHex,
  type OrbPersona,
  type OrbPhase,
} from './palette.js';

// The orb's frozen contract, asserted as LITERALS.
//
// Every hex below is transcribed from the interface spec, not from the tables in
// `palette.ts`. Copying `PHASE_COLORS.idle[0]` into the expectation would make
// this file a restatement of the implementation and prove nothing; the point of
// the split is that a hand-edited colour is a failure here.

const IDLE = { core: '#111115', mid: '#1c1c20', edge: '#27272a' };
const LISTEN = { core: '#38bdf8', mid: '#2f7fd8', edge: '#2563eb' };
const KAREEM = { core: '#4ade80', mid: '#34c265', edge: '#16a34a' };
const NOUR = { core: '#f472b6', mid: '#e04d97', edge: '#db2777' };

const PERSONAS: readonly OrbPersona[] = ['kareem', 'nour'];
const PHASES: readonly OrbPhase[] = ['idle', 'listening', 'thinking', 'speaking'];

describe('orbPalette — one assertion per phase', () => {
  test('idle is charcoal, and says so for both personas', () => {
    for (const persona of PERSONAS) {
      const p = orbPalette('idle', persona);
      expect(p.core).toBe(IDLE.core);
      expect(p.mid).toBe(IDLE.mid);
      expect(p.edge).toBe(IDLE.edge);
    }
  });

  test('listening (the user at the mic) is the vibrant blue', () => {
    const p = orbPalette('listening', 'kareem');
    expect(p.core).toBe(LISTEN.core);
    expect(p.mid).toBe(LISTEN.mid);
    expect(p.edge).toBe(LISTEN.edge);
  });

  test("thinking has no palette of its own and borrows the listening blue", () => {
    // The spec says so explicitly, so this is a spec pin rather than a design
    // choice: a fourth colour invented for `thinking` would be something the
    // shell could not have predicted.
    expect(orbPalette('thinking', 'kareem')).toEqual(orbPalette('listening', 'kareem'));
    expect(orbPalette('thinking', 'nour')).toEqual(orbPalette('listening', 'nour'));
  });

  test('speaking wears mint green for Kareem', () => {
    const p = orbPalette('speaking', 'kareem');
    expect(p.core).toBe(KAREEM.core);
    expect(p.mid).toBe(KAREEM.mid);
    expect(p.edge).toBe(KAREEM.edge);
  });

  test('speaking wears pink/rose for Nour', () => {
    const p = orbPalette('speaking', 'nour');
    expect(p.core).toBe(NOUR.core);
    expect(p.mid).toBe(NOUR.mid);
    expect(p.edge).toBe(NOUR.edge);
  });

  test('the persona only colours `speaking`; the other three ignore it', () => {
    for (const phase of ['idle', 'listening', 'thinking'] as const) {
      expect(orbPalette(phase, 'kareem')).toEqual(orbPalette(phase, 'nour'));
    }
  });

  test('every phase/persona pair resolves — no undefined channel', () => {
    for (const phase of PHASES) {
      for (const persona of PERSONAS) {
        const p = orbPalette(phase, persona);
        for (const channel of [p.core, p.mid, p.edge, p.glow]) {
          expect(typeof channel).toBe('string');
          expect(channel.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('orbPalette.glow — derived from the rim, never declared beside it', () => {
  test('is the edge colour at the glow alpha', () => {
    expect(orbPalette('listening', 'kareem').glow).toBe('rgba(37, 99, 235, 0.35)');
    expect(orbPalette('speaking', 'kareem').glow).toBe('rgba(22, 163, 74, 0.35)');
    expect(orbPalette('speaking', 'nour').glow).toBe('rgba(219, 39, 119, 0.35)');
    expect(orbPalette('idle', 'nour').glow).toBe('rgba(39, 39, 42, 0.35)');
  });

  test('tracks the edge of whatever palette it is asked about', () => {
    for (const phase of PHASES) {
      for (const persona of PERSONAS) {
        const p = orbPalette(phase, persona);
        expect(p.glow).toBe(orbGlow(p.edge));
      }
    }
  });

  test('alpha 0 fades in the rim hue, not through transparent black', () => {
    // rgba(0,0,0,0) at the far stop tints the halo grey where it meets the body.
    expect(orbGlow('#2563eb', 0)).toBe('rgba(37, 99, 235, 0)');
  });
});

describe('orbBreathAmplitude — the pinned idle figure', () => {
  test("idle is exactly 0.05, the spec's breathing amplitude", () => {
    expect(orbBreathAmplitude('idle')).toBe(0.05);
  });

  test('every phase that owns a voice has full authority', () => {
    expect(orbBreathAmplitude('listening')).toBe(1);
    expect(orbBreathAmplitude('thinking')).toBe(1);
    expect(orbBreathAmplitude('speaking')).toBe(1);
  });
});

describe('colour maths', () => {
  test('hex round-trips through RGB, lowercase', () => {
    for (const hex of [IDLE.core, LISTEN.mid, KAREEM.edge, NOUR.core]) {
      expect(rgbToHex(hexToRgb(hex))).toBe(hex);
    }
  });

  test('mixHex pins both endpoints and the midpoint', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  test('mixHex clamps t instead of extrapolating past the palette', () => {
    expect(mixHex('#000000', '#ffffff', 2)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', -1)).toBe('#000000');
  });

  test('mixRgb is the channel-wise linear mix', () => {
    expect(mixRgb([0, 10, 20], [100, 110, 120], 0.5)).toEqual([50, 60, 70]);
  });

  test('an unparseable hex degrades to black channels, never NaN', () => {
    // A NaN reaching addColorStop throws inside the 2D context and takes the
    // whole animation frame with it.
    expect(hexToRgb('#zzzzzz')).toEqual([0, 0, 0]);
    expect(hexToRgb('')).toEqual([0, 0, 0]);
  });

  test('rgbToHex clamps out-of-range and non-finite channels', () => {
    expect(rgbToHex([300, -20, 12.6])).toBe('#ff000d');
    // A non-finite channel is 0, not a clamped Infinity: the point is that the
    // string is always a valid colour, and black is the safe direction.
    expect(rgbToHex([Number.NaN, Number.POSITIVE_INFINITY, 0])).toBe('#000000');
  });
});

describe('clampLevel — the audio boundary', () => {
  test('passes an in-range level through untouched', () => {
    expect(clampLevel(0)).toBe(0);
    expect(clampLevel(0.42)).toBe(0.42);
    expect(clampLevel(1)).toBe(1);
  });

  test('clamps above 1 and below 0', () => {
    expect(clampLevel(7)).toBe(1);
    expect(clampLevel(-3)).toBe(0);
  });

  test('NaN is silence, not a black window', () => {
    // Math.min(1, NaN) is NaN, so the naive clamp hands NaN to a radius, a
    // Math.sin and a gradient stop.
    expect(clampLevel(Number.NaN)).toBe(0);
  });

  test('infinities resolve through min/max', () => {
    expect(clampLevel(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampLevel(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
