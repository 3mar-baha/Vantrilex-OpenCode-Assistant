import { useEffect, useRef } from 'react';
import type { MatrixState } from './matrix-state.js';
import type { MatrixCommand } from './matrix.worker.js';

// PixelMatrix host — transfers an OffscreenCanvas to the worker when
// available, falls back to a static swatch when it is not. The host never
// computes pixels; all rendering lives in matrix.worker.ts.
export interface PixelMatrixProps {
  readonly state: MatrixState;
  readonly energy?: number;
  readonly reducedMotion?: boolean;
}

function post(worker: Worker | null, cmd: MatrixCommand, transfer?: Transferable[]): void {
  try {
    worker?.postMessage(cmd, transfer ?? []);
  } catch {
    // worker gone — the fallback swatch below already covers this frame
  }
}

export function PixelMatrix({ state, energy = 0, reducedMotion = false }: PixelMatrixProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let worker: Worker | null = null;
    try {
      if (typeof canvas.transferControlToOffscreen !== 'function') return;
      worker = new Worker(new URL('./matrix.worker.ts', import.meta.url), { type: 'module' });
      const offscreen = canvas.transferControlToOffscreen();
      workerRef.current = worker;
      post(worker, { kind: 'init' }, [offscreen as unknown as Transferable]);
    } catch {
      workerRef.current = null;
    }
    return () => {
      try {
        worker?.terminate();
      } catch {
        // best-effort
      }
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    post(workerRef.current, { kind: 'state', state });
  }, [state]);
  useEffect(() => {
    post(workerRef.current, { kind: 'energy', energy });
  }, [energy]);
  useEffect(() => {
    post(workerRef.current, { kind: 'motion', reducedMotion });
  }, [reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      width={48}
      height={48}
      role="img"
      aria-label={`Voxaura matrix, state ${state}`}
      data-testid="pixel-matrix"
      data-state={state}
      className="voxaura-matrix"
    />
  );
}
