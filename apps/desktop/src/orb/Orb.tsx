import { useEffect, useRef } from 'react';
import {
  clampLevel,
  hexToRgb,
  mixRgb,
  orbBreathAmplitude,
  orbGlow,
  orbHaloRadius,
  orbPalette,
  rgbToHex,
  type OrbPalette,
  type OrbPersona,
  type OrbPhase,
  type OrbRgb,
} from './palette.js';

// The orb — the shell's one piece of continuous, non-textual state.
//
// Canvas 2D and nothing else. There is no WebGL, no `three` and no
// `@react-three/fiber` in this project and adding one is not on the table, so
// the whole visual is three radial gradients and three arcs per frame.
//
// Structure deliberately mirrors `components/waveform/SiriWaveCanvas.tsx`: props
// are copied into refs, ONE effect owns the context/DPR/animation loop, and the
// teardown cancels the frame. The differences are the two that the orb needs
// and the wave does not — the effect depends on `size` only (never on the
// palette), and the live colour is held in a ref so a phase change
// cross-fades instead of repainting.

/** The contract. Frozen — a shell module imports exactly these names. */
export interface OrbProps {
  phase: OrbPhase;
  persona: OrbPersona;
  /** 0..1 from mic capture energy. Drives the orb in `listening` only. */
  inputLevel: number;
  /** 0..1 from TTS playback energy. Drives the orb in `speaking` only. */
  outputLevel: number;
  size?: number;
}

/** The spec's figure, and the default when `size` is absent. */
const DEFAULT_SIZE = 260;

/** Body radius as a fraction of `size` at unity scale. */
const BASE_RADIUS = 0.3;
const TAU = Math.PI * 2;

/**
 * The animation constants are expressed per 60 Hz frame and rescaled by the
 * real frame delta below. A raw per-frame lerp settles twice as fast on a
 * 144 Hz panel, which reads as a different design rather than a faster one.
 */
const NOMINAL_DT = 1000 / 60;
/**
 * A long frame (tab restored from the background, a GC pause) is truncated
 * rather than integrated: 4 s of real time in one step would teleport the
 * colour transition to its target and hide the very thing it exists to show.
 */
const MAX_DT = 64;

/** Per-frame share of the remaining colour distance. ~200 ms to settle. */
const COLOR_LERP = 0.08;

/** Asymmetric level smoothing: speech onset on the next frame, calm release. */
const LEVEL_ATTACK = 0.3;
const LEVEL_RELEASE = 0.06;

/** Fractional radius swing at a full-scale (1.0) level. */
const LEVEL_GAIN = 0.3;

/** Idle phase amplitude, straight from the contract, so it cannot drift. */
const REST_SHIMMER = 0.05;
/** `thinking` has no audio to carry it, so its pulse is the loudest internal one. */
const POND_PULSE = 0.12;

/**
 * Internal (non-audio) pulse per phase, in fractional radius.
 *
 * `orbBreathAmplitude` is the AUTHORITY, not the amplitude: `idle` is 0.05
 * (taken directly — that IS the spec's breathing amplitude), and a phase with
 * voice authority multiplies 1 by its own documented constant. Reading the
 * weight as a literal 1.0 radius swing would make the orb vanish and double
 * on every frame, which is why the number means "full authority" here.
 */
const PHASE_PULSE: Record<OrbPhase, number> = {
  idle: orbBreathAmplitude('idle'),
  listening: orbBreathAmplitude('listening') * REST_SHIMMER,
  thinking: orbBreathAmplitude('thinking') * POND_PULSE,
  speaking: orbBreathAmplitude('speaking') * REST_SHIMMER,
};

/** Internal pulse rate per phase, radians/second. Idle is the slowest thing here. */
const PHASE_RATE: Record<OrbPhase, number> = {
  idle: 1.1,
  listening: 2.6,
  thinking: 1.9,
  speaking: 2.6,
};

/** Halo opacity at silence, and how much of it a full-scale level adds. */
const GLOW_MIN = 0.18;
const GLOW_GAIN = 0.45;

/** Live colour state, in RGB. Strings are rebuilt per frame at draw time. */
interface LiveColours {
  core: OrbRgb;
  mid: OrbRgb;
  edge: OrbRgb;
}

function snapshot(p: OrbPalette): LiveColours {
  return { core: hexToRgb(p.core), mid: hexToRgb(p.mid), edge: hexToRgb(p.edge) };
}

/**
 * Non-textual does not mean unspeakable: the orb is the shell's primary state
 * readout, so it carries the phase in the shell's dialect rather than a colour
 * name, and `role="img"` makes the canvas one announcement instead of an
 * unlabelled graphic.
 */
const PHASE_LABEL: Record<Exclude<OrbPhase, 'speaking'>, string> = {
  idle: 'الكرة ساكنة — بانتظار الكلام',
  listening: 'الكرة تستمع إلى صوتك',
  thinking: 'الكرة تفكر في طلبك',
};

const SPEAKING_LABEL: Record<OrbPersona, string> = {
  kareem: 'الكرة تتحدث بصوت كريم',
  nour: 'الكرة تتحدث بصوت نور',
};

export function Orb({ phase, persona, inputLevel, outputLevel, size = DEFAULT_SIZE }: OrbProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const phaseRef = useRef<OrbPhase>(phase);
  const personaRef = useRef<OrbPersona>(persona);
  const inputRef = useRef<number>(clampLevel(inputLevel));
  const outputRef = useRef<number>(clampLevel(outputLevel));
  // Survives effect restarts (a `size` change) so a resize resumes the colour
  // transition in flight instead of snapping to the target — a window resize
  // must not look like a phase change.
  const liveRef = useRef<LiveColours | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    personaRef.current = persona;
  }, [persona]);
  useEffect(() => {
    inputRef.current = clampLevel(inputLevel);
  }, [inputLevel]);
  useEffect(() => {
    outputRef.current = clampLevel(outputLevel);
  }, [outputLevel]);

  // A non-finite or non-positive size would size the backing store to 0 and
  // draw nothing at all; falling back is the same call the omitted prop makes.
  const px = Number.isFinite(size) && size > 0 ? size : DEFAULT_SIZE;

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    canvas.width = px * dpr;
    canvas.height = px * dpr;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.scale(dpr, dpr);
    const reduce =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Seeded at the phase the orb MOUNTED in, so the very first frame is the
    // declared palette rather than a colour halfway to it.
    if (liveRef.current === null) liveRef.current = snapshot(orbPalette(phaseRef.current, personaRef.current));
    const live = liveRef.current;

    let target = snapshot(orbPalette(phaseRef.current, personaRef.current));
    let targetPhase = phaseRef.current;
    let targetPersona = personaRef.current;
    let t = 0;
    let last: number | null = null;
    let level = 0;

    const draw = (now: number): void => {
      const dt = last === null ? NOMINAL_DT : Math.max(0, Math.min(MAX_DT, now - last));
      last = now;
      t += dt / 1000;

      const p = phaseRef.current;
      if (p !== targetPhase || personaRef.current !== targetPersona) {
        targetPhase = p;
        targetPersona = personaRef.current;
        target = snapshot(orbPalette(p, targetPersona));
      }

      // Only the phase that OWNS the audio reads it: the mic in `listening`, the
      // playback level in `speaking`, and neither in `idle`/`thinking`, where
      // there is no voice. A level that leaked across would make the orb answer
      // to audio the user cannot hear.
      const raw = p === 'listening' ? inputRef.current : p === 'speaking' ? outputRef.current : 0;
      const kLevel = 1 - Math.pow(1 - (raw > level ? LEVEL_ATTACK : LEVEL_RELEASE), dt / NOMINAL_DT);
      level += (raw - level) * kLevel;

      // THE SMOOTH TRANSITION. Every channel walks toward the target palette;
      // a `fillStyle` assignment of the new palette would snap, and a snap is
      // the difference between "the assistant took the turn" and "the window
      // glitched".
      const kColor = 1 - Math.pow(1 - COLOR_LERP, dt / NOMINAL_DT);
      live.core = mixRgb(live.core, target.core, kColor);
      live.mid = mixRgb(live.mid, target.mid, kColor);
      live.edge = mixRgb(live.edge, target.edge, kColor);

      // `prefers-reduced-motion` zeroes the AUTONOMOUS term only — the `sin`
      // breath and the `thinking` ponder cycle, which move with no input and are
      // therefore the decoration the preference is about. The measured-audio term
      // stays: a radius that answers the user's own voice is a readout, not an
      // animation, and dropping it would take the orb's only job away from a user
      // who asked for less motion rather than less feedback. The loop itself is
      // NOT stopped — see the `reduce` comment at the bottom.
      const pulse = reduce ? 0 : PHASE_PULSE[p] * Math.sin(t * PHASE_RATE[p]);
      const scale = 1 + pulse + orbBreathAmplitude(p) * level * LEVEL_GAIN;
      const r = BASE_RADIUS * px * scale;
      const cx = px / 2;
      const cy = px / 2;
      const core = rgbToHex(live.core);
      const mid = rgbToHex(live.mid);
      const edge = rgbToHex(live.edge);

      ctx.clearRect(0, 0, px, px);

      // Halo. Rebuilt every frame because its stop moves with the interpolated
      // edge: a cached gradient cannot have moving stops, so "cache it" would
      // mean quantising the colour instead of interpolating it.
      //
      // `orbHaloRadius` clamps to the canvas, and the comment there carries the
      // arithmetic: at the shipped 232 px the unclamped halo wants 128.76 px of a
      // 116 px radius at REST, and up to 173.83 px under a full-scale level, so the
      // glow was being cut at the canvas edge in every phase at every size. A
      // bigger canvas cannot fix it — the overflow ratio is independent of `size`.
      const haloR = orbHaloRadius(px, r);
      const halo = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, haloR);
      halo.addColorStop(0, orbGlow(edge));
      halo.addColorStop(1, orbGlow(edge, 0));
      ctx.globalAlpha = Math.max(0, Math.min(1, GLOW_MIN + GLOW_GAIN * level));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, haloR, 0, TAU);
      ctx.fill();

      // Body: the declared core → mid → edge, as a radial gradient.
      const body = ctx.createRadialGradient(cx, cy, r * 0.08, cx, cy, r);
      body.addColorStop(0, core);
      body.addColorStop(0.55, mid);
      body.addColorStop(1, edge);
      ctx.globalAlpha = 1;
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fill();

      // Rim. Without it the body dissolves into its own halo on a dark field and
      // the orb has no edge to read its size from.
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    // THE LOOP RUNS UNDER REDUCED MOTION. It used not to: the old code drew one
    // frame and returned, which is not "reduced motion" but a permanent freeze —
    // and the orb's whole job is continuity of state. A user with animation
    // effects off in the OS was left with a static disc that never breathed, never
    // cross-faded to the phase that had just changed, and never moved for their own
    // voice. The preference is honoured by zeroing one term inside `draw` (see
    // `pulse` above), which is the difference between honouring a preference and
    // removing a feature. `Orb.test.tsx` asserts the loop still runs, that the
    // autonomous term is the ONLY thing that stops, and that audio still drives the
    // radius — the positive control is in the same file, because a "no motion" test
    // with no "motion without the flag" control next to it is the vacuous shape.
    // The fallback clock is `performance.now()` and not `Date.now()` so the
    // timestamp is on the same scale as the rAF timestamp it replaces — mixing
    // the two hands `draw` an epoch-scale first frame.
    const raf = window.requestAnimationFrame ?? ((cb: FrameRequestCallback): number => window.setTimeout(() => cb(performance.now()), 16));
    const cancel = window.cancelAnimationFrame ?? ((id: number): void => window.clearTimeout(id));
    let id = 0;
    let alive = true;
    const tick = (now: number): void => {
      if (!alive) return;
      draw(now);
      id = raf(tick);
    };
    id = raf(tick);
    return () => {
      alive = false;
      cancel(id);
    };
  }, [px]);

  return (
    <canvas
      ref={ref}
      data-testid="orb"
      data-phase={phase}
      data-persona={persona}
      role="img"
      aria-label={phase === 'speaking' ? SPEAKING_LABEL[persona] : PHASE_LABEL[phase]}
      // CSS box in px, backing store in device pixels (set in the effect). The
      // window auto-sizes to content, so the box is what the OS measures.
      style={{ width: px, height: px }}
      width={px}
      height={px}
    />
  );
}
