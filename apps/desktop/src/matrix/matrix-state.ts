// Voxaura 48x48 matrix reducer — pure, dependency-free, worker-safe.
// All time-varying randomness enters through the injected `noise2D` so tests
// stay deterministic; the worker passes simplex-noise, tests pass a stub.

export const MATRIX_SIZE = 48;
/** Per-frame lerp factor: converges within 15 frames (250 ms @60fps). */
export const LERP_ALPHA = 0.3;
export type MatrixState = 0 | 1 | 2 | 3 | 4; // IDLE | USER | THINKING | KAREEM | NOUR
export type Noise2D = (x: number, y: number) => number;

const BASE_HEX: Record<MatrixState, string> = {
  0: '#1c1b18',
  1: '#0284c7',
  2: '#f59e0b',
  3: '#10b981',
  4: '#8b5cf6',
};

const ACCENT_HEX: Record<MatrixState, string> = {
  0: '#383530',
  1: '#38bdf8',
  2: '#fbbf24',
  3: '#34d399',
  4: '#a78bfa',
};

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function stateBase(state: MatrixState): string {
  return BASE_HEX[state];
}

export function stateAccent(state: MatrixState): string {
  return ACCENT_HEX[state];
}

/** Outer 2px perimeter — the THINKING ripple band. */
export function borderMask(x: number, y: number): boolean {
  return x < 2 || y < 2 || x >= MATRIX_SIZE - 2 || y >= MATRIX_SIZE - 2;
}

/** Reused RGB field (row-major, 3 bytes per pixel). Never allocated per frame. */
export function createField(): Float32Array {
  return new Float32Array(MATRIX_SIZE * MATRIX_SIZE * 3);
}

function writePixel(field: Float32Array, x: number, y: number, r: number, g: number, b: number): void {
  const o = (y * MATRIX_SIZE + x) * 3;
  field[o] = r;
  field[o + 1] = g;
  field[o + 2] = b;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Compute the target color field for a state. `t` is seconds, `energy` is
 * 0..1 vocal energy (USER) or intensity. `reducedMotion` freezes time.
 * Writes into `out` (which must hold MATRIX_SIZE²×3 floats) and returns it —
 * the worker reuses two buffers so no frame ever allocates.
 */
export function targetInto(
  out: Float32Array,
  state: MatrixState,
  t: number,
  energy: number,
  noise2D: Noise2D,
  reducedMotion: boolean,
): Float32Array {
  const time = reducedMotion ? 0 : t;
  const [br, bg, bb] = hexToRgb(BASE_HEX[state]);
  const [ar, ag, ab] = hexToRgb(ACCENT_HEX[state]);
  const cx = MATRIX_SIZE / 2;
  const cy = MATRIX_SIZE / 2;
  const maxDist = Math.hypot(cx, cy);

  for (let y = 0; y < MATRIX_SIZE; y += 1) {
    for (let x = 0; x < MATRIX_SIZE; x += 1) {
      let k: number; // 0 = base, 1 = accent
      switch (state) {
        case 0: {
          // Breathing graphite: low-res noise, slow drift.
          const n = noise2D(x / 8 + time * 0.15, y / 8 - time * 0.1) * 0.5 + 0.5;
          k = 0.25 + n * 0.5;
          break;
        }
        case 1: {
          // Radial sky-blue wave expanding with energy.
          const d = Math.hypot(x - cx, y - cy) / maxDist;
          const wave = 0.5 + 0.5 * Math.sin(d * 12 - time * 6);
          k = Math.min(1, 0.15 + energy * (0.35 + 0.5 * wave) + (1 - d) * 0.2 * energy);
          break;
        }
        case 2: {
          // Amber perimeter pulse; dim core.
          if (borderMask(x, y)) {
            k = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(time * 4));
          } else {
            k = 0.08;
          }
          break;
        }
        case 3: {
          // Structured horizontal emerald bands.
          const band = 0.5 + 0.5 * Math.sin((y / MATRIX_SIZE) * Math.PI * 8 - time * 5);
          k = 0.3 + 0.55 * band * (0.4 + 0.6 * energy);
          break;
        }
        case 4: {
          // Expanding royal-purple diamonds (Manhattan distance).
          const d = (Math.abs(x - cx) + Math.abs(y - cy)) / MATRIX_SIZE;
          const wave = 0.5 + 0.5 * Math.sin(d * 14 - time * 5);
          k = 0.3 + 0.55 * wave * (0.4 + 0.6 * energy);
          break;
        }
      }
      writePixel(out, x, y, mix(br, ar, k!), mix(bg, ag, k!), mix(bb, ab, k!));
    }
  }
  return out;
}

/** Allocating convenience wrapper for tests and one-shot renders. */
export function targetFor(
  state: MatrixState,
  t: number,
  energy: number,
  noise2D: Noise2D,
  reducedMotion: boolean,
): Float32Array {
  return targetInto(createField(), state, t, energy, noise2D, reducedMotion);
}

/** Ease the live field toward the target in place. Returns the same buffer. */
export function lerpToward(current: Float32Array, target: Float32Array, alpha: number): Float32Array {
  for (let i = 0; i < current.length; i += 1) {
    current[i] = current[i]! + (target[i]! - current[i]!) * alpha;
  }
  return current;
}

/** True when every channel is within `eps` — the lerp completion test. */
export function converged(current: Float32Array, target: Float32Array, eps: number): boolean {
  for (let i = 0; i < current.length; i += 1) {
    if (Math.abs(current[i]! - target[i]!) > eps) return false;
  }
  return true;
}

/**
 * Map a daemon lifecycle state to a matrix state for the Voxaura shell.
 * Returns null when the event carries no visual change. Persona colors apply
 * only at completion/idle (who spoke); errors and aborts snap to idle.
 */
export function matrixForDaemonState(
  daemonState: string,
  persona: 'kareem' | 'nour',
): MatrixState | null {
  switch (daemonState) {
    case 'awaiting-approval':
    case 'running':
      return 2;
    case 'complete':
    case 'idle':
      return persona === 'kareem' ? 3 : 4;
    case 'error':
    case 'aborted':
      return 0;
    default:
      return null;
  }
}
