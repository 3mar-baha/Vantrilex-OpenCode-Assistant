import { useEffect, useRef } from 'react';

// SiriWaveCanvas — kopiro/siriwave iOS-classic replication: 5 sine curves with
// the upstream attenuation/lineWidth/opacity table, `lighter` compositing for
// the cyan/blue glow, and lerped speed/amplitude (lerpSpeed) easing toward
// per-mode targets. idle breathes; active speaks. Reduced motion (or missing
// 2D context) renders one static frame.
export type SiriWaveMode = 'idle' | 'active';

export interface SiriWaveCanvasProps {
  readonly mode: SiriWaveMode;
  readonly color?: string;
  readonly reducedMotion?: boolean;
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

export function SiriWaveCanvas({ mode, color = '#38bdf8', reducedMotion = false }: SiriWaveCanvasProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const modeRef = useRef<SiriWaveMode>(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

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
      ctx.globalCompositeOperation = 'lighter';
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
        ctx.strokeStyle = c === CURVES.length - 1 ? '#2563eb' : color;
        ctx.globalAlpha = curve.opacity;
        ctx.lineWidth = curve.lineWidth;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
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
