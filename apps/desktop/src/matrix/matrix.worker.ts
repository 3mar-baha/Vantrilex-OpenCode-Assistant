import { createNoise2D } from 'simplex-noise';
import {
  createField,
  LERP_ALPHA,
  lerpToward,
  MATRIX_SIZE,
  targetFor,
  type MatrixState,
} from './matrix-state.js';

// Voxaura matrix worker — owns the OffscreenCanvas render loop. Buffers are
// allocated once and reused; state messages retarget the lerp mid-flight.
export interface MatrixCommand {
  readonly kind: 'init' | 'state' | 'energy' | 'motion';
  readonly state?: MatrixState;
  readonly energy?: number;
  readonly reducedMotion?: boolean;
}

const noise2D = createNoise2D();
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let image: ImageData | null = null;
const live = createField();
let state: MatrixState = 0;
let energy = 0;
let reducedMotion = false;
let running = false;
let lastT = 0;

function frame(t: number): void {
  if (!running || ctx === null || image === null) return;
  const target = targetFor(state, t / 1000, energy, noise2D, reducedMotion);
  lerpToward(live, target, LERP_ALPHA);
  const px = image.data;
  for (let i = 0, j = 0; i < live.length; i += 3, j += 4) {
    px[j] = live[i]!;
    px[j + 1] = live[i + 1]!;
    px[j + 2] = live[i + 2]!;
    px[j + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  lastT = t;
  requestAnimationFrame(frame);
}

self.onmessage = (ev: MessageEvent<MatrixCommand>) => {
  const cmd = ev.data;
  if (cmd.kind === 'init') {
    const transferred = (ev as MessageEvent & { canvas?: OffscreenCanvas }).canvas;
    if (transferred instanceof OffscreenCanvas) {
      canvas = transferred;
      canvas.width = MATRIX_SIZE;
      canvas.height = MATRIX_SIZE;
      ctx = canvas.getContext('2d');
      if (ctx !== null) {
        image = ctx.createImageData(MATRIX_SIZE, MATRIX_SIZE);
        running = true;
        requestAnimationFrame(frame);
      }
    }
    return;
  }
  if (cmd.kind === 'state' && cmd.state !== undefined) {
    state = cmd.state;
    void lastT;
    return;
  }
  if (cmd.kind === 'energy' && cmd.energy !== undefined) {
    energy = Math.min(1, Math.max(0, cmd.energy));
    return;
  }
  if (cmd.kind === 'motion' && cmd.reducedMotion !== undefined) {
    reducedMotion = cmd.reducedMotion;
  }
};
