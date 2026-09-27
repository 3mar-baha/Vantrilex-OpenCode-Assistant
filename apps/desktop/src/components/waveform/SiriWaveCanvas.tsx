import { useEffect, useRef } from 'react';

// SiriWaveCanvas — a single continuous thread ("خيط"), nothing else.
//
// D6/D7/D8. The previous version drew two systems: five sine curves *and* five
// chunky pill bars, which read as a dual wave. The bars are gone. The curves
// now take their amplitude from live mic RMS instead of hardcoded idle/active
// constants, and each curve is stroked along a two-stop gradient so the active
// speaker is readable at a glance. Reduced motion (or a missing 2D context)
// renders one static frame.
export type SiriWaveMode = 'idle' | 'active';

/** Who is speaking, and therefore which gradient the thread wears. */
export type WaveSpeaker = 'user' | 'kareem' | 'nour';

/**
 * The required two-stop palettes. `user` is the human at the microphone;
 * `kareem`/`nour` are the assistant personas.
 */
export const SPEAKER_PALETTE: Record<WaveSpeaker, readonly [string, string]> = {
  user: ['#2563EB', '#EAB308'],
  kareem: ['#16A34A', '#EAB308'],
  nour: ['#9333EA', '#EC4899'],
};

const DEFAULT_PALETTE = SPEAKER_PALETTE.user;

export function speakerPalette(speaker: string | undefined): readonly [string, string] {
  return speaker !== undefined && speaker in SPEAKER_PALETTE
    ? SPEAKER_PALETTE[speaker as WaveSpeaker]
    : DEFAULT_PALETTE;
}

/**
 * `#rrggbb` mix; t is clamped. Emits UPPERCASE so the ramp endpoints are
 * byte-identical to the declared palettes rather than a case-folded variant.
 */
export function mixHex(from: string, to: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const ch = (hex: string, i: number): number => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(ch(from, i) + (ch(to, i) - ch(from, i)) * k));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export interface SiriWaveCanvasProps {
  readonly mode: SiriWaveMode;
  /** Flat single colour. Ignored when `palette` is supplied. */
  readonly color?: string;
  /** Two-stop gradient, one colour per end of the curve stack. */
  readonly palette?: readonly [string, string];
  readonly reducedMotion?: boolean;
  /** Live input energy 0..1 (mic RMS). Drives the thread's amplitude. */
  readonly energy?: number;
}

const WIDTH = 320;
const HEIGHT = 90;
const CY = HEIGHT / 2;

// Upstream iOS-classic curve definition (Kopiro/siriwave README). The top
// curve is lineWidth 1.5 upstream; we had 2.5, which is why the thread read as
// a bar. Opacity carries depth, width does not.
const CURVES = [
  { attenuation: -2, lineWidth: 1, opacity: 0.1 },
  { attenuation: -6, lineWidth: 1, opacity: 0.2 },
  { attenuation: 4, lineWidth: 1, opacity: 0.4 },
  { attenuation: 2, lineWidth: 1, opacity: 0.6 },
  { attenuation: 1, lineWidth: 1.5, opacity: 1 },
] as const;

const LERP_SPEED = 0.06;

/** Amplitude at silence — a visible resting thread, never a flat line. */
const IDLE_AMPLITUDE = 0.2;
/** Amplitude at full-scale speech energy. */
const ACTIVE_AMPLITUDE = 1;
/**
 * Asymmetric smoothing: speech onset must be visible on the next frame, while
 * release has to fall off calmly. A single lerp constant forces a choice
 * between a laggy attack and a jittery idle — the reported "flicker".
 */
const ATTACK = 0.3;
const RELEASE = 0.06;

export function SiriWaveCanvas({
  mode,
  color,
  palette,
  reducedMotion = false,
  energy = 0,
}: SiriWaveCanvasProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const modeRef = useRef<SiriWaveMode>(mode);
  const energyRef = useRef<number>(energy);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    energyRef.current = Math.max(0, Math.min(1, energy));
  }, [energy]);

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.scale(dpr, dpr);
    const reduce =
      reducedMotion ||
      (typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    const stops: readonly [string, string] = palette ?? (color !== undefined ? [color, color] : DEFAULT_PALETTE);

    let speed = 0.15;
    let amplitude = IDLE_AMPLITUDE * 0.6;
    let phase = 0;

    const draw = (): void => {
      const live = modeRef.current;
      const e = energyRef.current;
      const targetSpeed = live === 'active' ? 0.9 : 0.15;
      // D7: amplitude is a function of live RMS, not a mode constant. In idle
      // the thread stays a resting filament and only breathes a little.
      const targetAmp =
        live === 'active'
          ? IDLE_AMPLITUDE + (ACTIVE_AMPLITUDE - IDLE_AMPLITUDE) * e
          : IDLE_AMPLITUDE * (0.55 + 0.45 * e);
      speed += (targetSpeed - speed) * LERP_SPEED;
      amplitude += (targetAmp - amplitude) * (targetAmp > amplitude ? ATTACK : RELEASE);
      phase += speed * 0.28;

      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      const cx = WIDTH / 2;
      for (let c = 0; c < CURVES.length; c += 1) {
        const curve = CURVES[c]!;
        ctx.beginPath();
        for (let x = 0; x <= WIDTH; x += 2) {
          // Center-peaked envelope (tall middle, flat edges) with per-curve
          // attenuation sign flipping the phase, as in the upstream model.
          const env = 1 / (1 + ((x - cx) / (WIDTH * 0.26)) ** 4);
          const y =
            CY +
            Math.sign(curve.attenuation) * env * amplitude * 34 * Math.sin(x * 0.021 + phase * (1 + c * 0.22) + c * 1.7);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        // D8: one stop at the outer curve, the other at the leading curve.
        ctx.strokeStyle =
          CURVES.length === 1 ? stops[0] : mixHex(stops[0], stops[1], c / (CURVES.length - 1));
        ctx.globalAlpha = curve.opacity;
        ctx.lineWidth = curve.lineWidth;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    if (reduce) {
      draw();
      return;
    }
    const raf = window.requestAnimationFrame ?? ((cb: FrameRequestCallback): number => window.setTimeout(() => cb(Date.now()), 16));
    const cancel = window.cancelAnimationFrame ?? ((id: number): void => window.clearTimeout(id));
    let id = 0;
    let alive = true;
    const tick = (): void => {
      if (!alive) return;
      draw();
      id = raf(tick);
    };
    id = raf(tick);
    return () => {
      alive = false;
      cancel(id);
    };
  }, [color, palette, reducedMotion]);

  return (
    <canvas
      ref={ref}
      data-testid="siri-wave"
      data-mode={mode}
      role="img"
      aria-label="الموجة الصوتية — خيط يتغيّر مع مستوى صوتك"
      width={WIDTH}
      height={HEIGHT}
    />
  );
}
