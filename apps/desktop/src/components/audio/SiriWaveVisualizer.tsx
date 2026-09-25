import { useEffect, useRef } from 'react';

// Siri-style fluid audio visualizer (Canvas 2D, kopiro/siriwave algorithm
// family): layered sine harmonics with per-layer amplitude/phase drift.
// idle = slow cyan breathing; active = amplitude-modulated vocal wave.
// Reduced motion (or no 2D context, e.g. tests) renders one static frame.
export type SiriWaveMode = 'idle' | 'active';

export interface SiriWaveVisualizerProps {
  readonly mode: SiriWaveMode;
  readonly color?: string;
  readonly reducedMotion?: boolean;
}

const WIDTH = 320;
const HEIGHT = 120;
const LAYERS = 5;

export function SiriWaveVisualizer({ mode, color = '#38bdf8', reducedMotion = false }: SiriWaveVisualizerProps): JSX.Element {
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

    const draw = (t: number): void => {
      const live = modeRef.current;
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      for (let layer = 0; layer < LAYERS; layer += 1) {
        const depth = layer / (LAYERS - 1);
        const baseAmp = live === 'active' ? 26 - depth * 8 : 7 - depth * 2;
        // Harmonic tremolo: active mode breathes amplitude over time.
        const tremolo = live === 'active' ? 0.72 + 0.28 * Math.sin(t / 420 + layer * 1.3) : 0.9 + 0.1 * Math.sin(t / 1400);
        const amp = baseAmp * tremolo;
        const freq = 0.028 + depth * 0.012;
        const speed = (live === 'active' ? 0.0042 : 0.0011) * (1 + depth * 0.6);
        ctx.beginPath();
        for (let x = 0; x <= WIDTH; x += 2) {
          const harmonic =
            Math.sin(x * freq + t * speed + layer * 0.9) * 0.62 +
            Math.sin(x * freq * 2.7 + t * speed * 1.7 + layer * 2.1) * 0.26 +
            Math.sin(x * freq * 6.1 + t * speed * 2.6 + layer * 0.4) * 0.12;
          const y = HEIGHT / 2 + harmonic * amp;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.28 + (1 - depth) * 0.5;
        ctx.lineWidth = 2.2 - depth;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    if (reduce) {
      draw(0);
      return;
    }
    const raf = window.requestAnimationFrame ?? ((cb: FrameRequestCallback): number => window.setTimeout(() => cb(Date.now()), 16));
    const cancel = window.cancelAnimationFrame ?? ((id: number): void => window.clearTimeout(id));
    let id = 0;
    let alive = true;
    const tick = (t: number): void => {
      if (!alive) return;
      draw(t);
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
