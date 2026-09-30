// The orb's colour and pulse CONTRACT.
//
// Pure data and pure functions: no React, no canvas, no DOM, no `window`. That
// split is deliberate — `Orb.tsx` owns the pixels and this module owns the
// numbers, so the four states can be asserted as literals instead of being
// inferred from a recorded framebuffer, and so a future SVG/DOM orb (or a test)
// can read the same tables without importing a drawing component.
//
// Nothing here may grow a dependency on a component. `SiriWaveCanvas` already
// exports a `mixHex`, and the orb does NOT import it: importing a `.tsx` from a
// contract module drags React into every consumer's graph, and this file is
// meant to be readable by a shell, a test and a future renderer alike. The
// duplication is two lines of composition over a shared idea, not a second
// algorithm.

/** What the orb is doing. Drives both the palette and the pulse. */
export type OrbPhase = 'idle' | 'listening' | 'thinking' | 'speaking';

/** Which assistant persona is speaking, and therefore which colour the orb wears. */
export type OrbPersona = 'kareem' | 'nour';

/**
 * Four stops, not three. `core` is the centre of the body, `mid` the shoulder of
 * the gradient, `edge` the rim, and `glow` the halo that spills past it.
 *
 * `glow` has no value in the spec, so it is DERIVED from `edge` by `orbGlow`
 * rather than declared: one source of truth means the halo can never drift off
 * the rim it is supposed to be a halo of, and the same helper serves the orb's
 * per-frame interpolation (`Orb.tsx` calls `orbGlow` on the *live* edge colour,
 * so the halo cross-fades with the rim instead of snapping independently).
 */
export interface OrbPalette {
  core: string;
  mid: string;
  edge: string;
  glow: string;
}

/** An RGB triple, 0..255 per channel. */
export type OrbRgb = readonly [number, number, number];

/** Alpha of the `glow` stop. Low enough that the body still reads as the solid. */
const GLOW_ALPHA = 0.35;

/**
 * The phases that colour by PHASE rather than by persona. `speaking` is absent
 * on purpose: the assistant's own voice is the one thing that must be told
 * apart by persona, and a phase-keyed table cannot express that.
 */
const PHASE_COLORS: Record<Exclude<OrbPhase, 'speaking'>, readonly [string, string, string]> = {
  // Silence is charcoal, not black. A pure #000 core on a #000 field is a hole
  // in the window; these steps stay legible against the HUD's dark background.
  idle: ['#111115', '#1c1c20', '#27272a'],
  listening: ['#38bdf8', '#2f7fd8', '#2563eb'],
  // `thinking` has NO dedicated palette in the spec, so it borrows the
  // listening blue. The two are genuinely "the app is working on it" states
  // with no voice to attribute; the pulse (below) is what tells them apart,
  // not the colour. A fifth colour invented here would be a design decision
  // nobody asked for and the shell could not predict.
  thinking: ['#38bdf8', '#2f7fd8', '#2563eb'],
};

/** The assistant's own two voices. */
const PERSONA_COLORS: Record<OrbPersona, readonly [string, string, string]> = {
  kareem: ['#4ade80', '#34c265', '#16a34a'],
  nour: ['#f472b6', '#e04d97', '#db2777'],
};

/**
 * `#rrggbb` → RGB. An unparseable channel becomes 0 rather than NaN: a NaN
 * reaching `addColorStop` throws inside the 2D context and takes the whole
 * animation frame with it, and a black channel degrades to a dark pixel
 * instead. Cheaper failure, same visible symptom, no exception.
 */
export function hexToRgb(hex: string): OrbRgb {
  const channel = (i: number): number => {
    const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    return Number.isFinite(v) ? v : 0;
  };
  return [channel(0), channel(1), channel(2)];
}

/**
 * RGB → `#rrggbb`, LOWERCASE, rounded, clamped per channel.
 *
 * Lowercase because the tables above are lowercase: the orb's last frame of a
 * colour transition has to come out byte-identical to the declared palette, and
 * a case-flipping interpolator would leave a permanent off-by-case difference
 * between "converged" and "exact".
 */
export function rgbToHex(rgb: OrbRgb): string {
  const part = (v: number): string => {
    const n = Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0;
    return n.toString(16).padStart(2, '0');
  };
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

/** Linear RGB mix. `t` is clamped, so an over-driven lerp stops at the target. */
export function mixRgb(from: OrbRgb, to: OrbRgb, t: number): OrbRgb {
  const k = Math.max(0, Math.min(1, t));
  const ch = (a: number, b: number): number => a + (b - a) * k;
  return [ch(from[0], to[0]), ch(from[1], to[1]), ch(from[2], to[2])];
}

/** `#rrggbb` mix; `t` is clamped. The string form of {@link mixRgb}. */
export function mixHex(from: string, to: string, t: number): string {
  return rgbToHex(mixRgb(hexToRgb(from), hexToRgb(to), t));
}

/**
 * The halo stop for an edge colour. `alpha` defaults to the palette's glow
 * opacity; passing 0 gives the fully transparent end of the fade, which is why
 * the gradient terminates in `rgba(r,g,b,0)` and NOT `rgba(0,0,0,0)` — fading
 * through transparent black tints the halo grey where it meets the body.
 */
export function orbGlow(edge: string, alpha: number = GLOW_ALPHA): string {
  const [r, g, b] = hexToRgb(edge);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The palette for one (phase, persona) pair. Pure; safe to call per frame. */
export function orbPalette(phase: OrbPhase, persona: OrbPersona): OrbPalette {
  const stops = phase === 'speaking' ? PERSONA_COLORS[persona] : PHASE_COLORS[phase];
  return { core: stops[0], mid: stops[1], edge: stops[2], glow: orbGlow(stops[2]) };
}

/**
 * The breathing pulse the phase is allowed, as a fraction of the orb's radius.
 *
 * `idle` is 0.05 — a visible resting breath, exactly the spec's figure.
 * Every other phase is 1, meaning "this phase has voice authority": the motion
 * is then carried by the measured audio (listening/speaking) or, for `thinking`,
 * by the ponder cycle, both already normalised to 0..1. The 0.05 is therefore
 * the IDLE amplitude, not a per-phase table with four arbitrary numbers in it.
 */
export function orbBreathAmplitude(phase: OrbPhase): number {
  return phase === 'idle' ? 0.05 : 1;
}

/**
 * Clamp one audio level to 0..1.
 *
 * The NaN arm is the load-bearing one: `Math.min(1, NaN)` is NaN, so the naive
 * clamp hands NaN to a radius, a `Math.sin` and a gradient stop, and the 2D
 * context throws on the first frame — a black window, from a mic that reported
 * a level the UI could not use. `±Infinity` needs no arm because min/max already
 * resolve it to 1 and 0 respectively.
 */
export function clampLevel(level: number): number {
  if (Number.isNaN(level)) return 0;
  return Math.max(0, Math.min(1, level));
}
