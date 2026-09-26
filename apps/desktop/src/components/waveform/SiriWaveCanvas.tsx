import { useEffect, useRef } from 'react';

// SiriWaveCanvas — sine-flow backdrop plus the 5-bar emblem voiceprint.
// The curves breathe (lerped speed/amplitude per mode: idle breathes, active
// speaks); the solid blueprint bars echo assets/icon.svg and scale with the
// same lerped amplitude, so the mark itself reacts to live audio. Reduced
// motion (or missing 2D context) renders one static frame.
export type SiriWaveMode = 'idle' | 'active';

export interface SiriWaveCanvasProps {
  readonly mode: SiriWaveMode;
  readonly color?: string;
  readonly reducedMotion?: boolean;
  /** Live input energy 0..1 (mic RMS). Bars breathe with real speech. */
  readonly energy?: number;
}

const WIDTH = 320;
const HEIGHT = 90;

// Upstream iOS-classic curve definition (kopiro/siriwave README).
const CURVES = [
  { attenuation: -2, lineWidth: 1, opacity: 0.1 },
  { attenuation: -6, lineWidth: 1, opacity: 0.2 },
  { attenuation: 4, lineWidth: 1, opacity: 0.4 },
  { attenuation: 2, lineWidth: 1, opacity: 0.6 },
  { attenuation: 1, lineWidth: 2.5, opacity: 1 },
] as const;

const LERP_SPEED = 0.06;

// Emblem voiceprint: short, medium, tall center, medium, short — relative
// heights from WaveformEmblem (assets/icon.svg), drawn solid in emblem blue.
const EMBLEM_BLUE = '#2563eb';
const BAR_FRACS = [0.43, 0.64, 1, 0.57, 0.36] as const;
const BAR_W = 22;
const BAR_GAP = 12;
const BAR_MAX_H = 64;

export function SiriWaveCanvas({ mode, color = EMBLEM_BLUE, reducedMotion = false, energy = 0 }: SiriWaveCanvasProps): JSX.Element {
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
      reducedMotion || (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false);

    let speed = 0.15;
    let amplitude = 0.35;
    let phase = 0;

    const draw = (): void => {
      const live = modeRef.current;
      const targetSpeed = live === 'active' ? 0.9 : 0.15;
      const targetAmp = live === 'active' ? 1 : 0.32;
      speed += (targetSpeed - speed) * LERP_SPEED;
      amplitude += (targetAmp - amplitude) * LERP_SPEED;
      phase += speed * 0.28;

      ctx.clearRect(0, 0, WIDTH, HEIGHT);
            const cx = WIDTH / 2;
      const cy = HEIGHT / 2;
      for (let c = 0; c < CURVES.length; c += 1) {
        const curve = CURVES[c]!;
        ctx.beginPath();
        for (let x = 0; x <= WIDTH; x += 2) {
          // Center-peaked envelope (tall middle, flat edges) with per-curve
          // attenuation sign flipping the phase, as in the upstream model.
          const env = 1 / (1 + ((x - cx) / (WIDTH * 0.26)) ** 4);
          const y =
            cy +
            Math.sign(curve.attenuation) *
              env *
              amplitude *
              34 *
              Math.sin(x * 0.021 + phase * (1 + c * 0.22) + c * 1.7);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color;
        ctx.globalAlpha = curve.opacity * 0.45;
        ctx.lineWidth = curve.lineWidth;
        ctx.stroke();
      }
      // Emblem bars over the flow: heights follow live input energy so the
      // user can see the mic is picking up sound.
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = EMBLEM_BLUE;
      const drive = Math.max(amplitude, energyRef.current);
      const span = BAR_FRACS.length * BAR_W + (BAR_FRACS.length - 1) * BAR_GAP;
      let bx = cx - span / 2;
      for (const frac of BAR_FRACS) {
        const h = Math.max(6, frac * BAR_MAX_H * (0.35 + 0.65 * drive));
        const by = cy - h / 2;
        if (typeof ctx.roundRect === 'function') {
          ctx.beginPath();
          ctx.roundRect(bx, by, BAR_W, h, BAR_W / 2);
          ctx.fill();
        } else {
          ctx.fillRect(bx, by, BAR_W, h);
        }
        bx += BAR_W + BAR_GAP;
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
  }, [color, reducedMotion]);

  return (
    <canvas
      ref={ref}
      data-testid="siri-wave"
      data-mode={mode}
      role="img"
      aria-label="الموجة الصوتية — تصور حالة الصوت"
      width={WIDTH}
      height={HEIGHT}
    />
  );
}
