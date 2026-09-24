import { describe, expect, test } from 'vitest';
import {
  borderMask,
  converged,
  createField,
  LERP_ALPHA,
  lerpToward,
  matrixForDaemonState,
  MATRIX_SIZE,
  stateBase,
  targetFor,
  type MatrixState,
} from './matrix-state.js';

// G3 TDD — pure matrix reducer. Deterministic stub noise keeps every test
// hermetic (no canvas, no worker, no simplex dependency).
const stubNoise = (x: number, y: number): number => Math.sin(x * 12.9898 + y * 78.233) * 0.5;

describe('matrix geometry', () => {
  test('48x48 field layout', () => {
    expect(MATRIX_SIZE).toBe(48);
    expect(createField().length).toBe(48 * 48 * 3);
  });

  test('border mask covers exactly the outer 2px', () => {
    expect(borderMask(0, 0)).toBe(true);
    expect(borderMask(1, 1)).toBe(true);
    expect(borderMask(2, 2)).toBe(false);
    expect(borderMask(24, 24)).toBe(false);
    expect(borderMask(47, 47)).toBe(true);
    expect(borderMask(46, 46)).toBe(true);
    expect(borderMask(45, 45)).toBe(false);
  });
});

describe('state palettes (design tokens)', () => {
  test.each([
    [0, '#1c1b18'],
    [1, '#0284c7'],
    [2, '#f59e0b'],
    [3, '#10b981'],
    [4, '#8b5cf6'],
  ] as Array<[MatrixState, string]>)('state %i base is %s', (state, hex) => {
    expect(stateBase(state)).toBe(hex);
  });
});

describe('targetFor (pattern field)', () => {
  test('idle varies with noise but stays in graphite ramp', () => {
    const a = targetFor(0, 0.0, 0, stubNoise, false);
    const b = targetFor(0, 10.0, 0, stubNoise, false);
    expect(a).not.toEqual(b); // breathing over time
    for (let i = 0; i < a.length; i += 3) {
      expect(a[i]!).toBeGreaterThanOrEqual(0x1c - 6);
      expect(a[i]!).toBeLessThanOrEqual(0x38 + 6);
    }
  });

  test('user state brightens with energy', () => {
    const dim = targetFor(1, 0, 0.1, stubNoise, false);
    const loud = targetFor(1, 0, 0.9, stubNoise, false);
    const avg = (f: Float32Array): number => {
      let s = 0;
      for (let i = 0; i < f.length; i += 3) s += f[i]! + f[i + 1]! + f[i + 2]!;
      return s / (f.length / 3);
    };
    expect(avg(loud)).toBeGreaterThan(avg(dim));
  });

  test('thinking state lights the border, dims the core', () => {
    const f = targetFor(2, 0, 0, stubNoise, false);
    const at = (x: number, y: number): number => {
      const o = (y * 48 + x) * 3;
      return f[o]! + f[o + 1]! + f[o + 2]!;
    };
    expect(at(0, 0)).toBeGreaterThan(at(24, 24));
  });

  test('reduced-motion freezes time', () => {
    const a = targetFor(3, 0.0, 0.5, stubNoise, true);
    const b = targetFor(3, 99.0, 0.5, stubNoise, true);
    expect(a).toEqual(b);
  });
});

describe('matrixForDaemonState (4B surface)', () => {
  test('approval/running attend, completion colors by persona, errors idle', () => {
    expect(matrixForDaemonState('awaiting-approval', 'kareem')).toBe(2);
    expect(matrixForDaemonState('running', 'nour')).toBe(2);
    expect(matrixForDaemonState('complete', 'kareem')).toBe(3);
    expect(matrixForDaemonState('idle', 'nour')).toBe(4);
    expect(matrixForDaemonState('error', 'kareem')).toBe(0);
    expect(matrixForDaemonState('aborted', 'nour')).toBe(0);
    expect(matrixForDaemonState('something-else', 'kareem')).toBeNull();
  });
});

describe('lerp convergence', () => {
  test('lerpToward converges within the 250ms budget (15 frames)', () => {
    const current = createField();
    const target = targetFor(3, 0, 0.8, stubNoise, false);
    for (let i = 0; i < 15; i += 1) lerpToward(current, target, LERP_ALPHA);
    expect(converged(current, target, 2)).toBe(true);
  });

  test('retargeting mid-lerp never allocates', () => {
    const current = createField();
    const before = current.byteLength;
    lerpToward(current, targetFor(1, 0, 1, stubNoise, false), 0.25);
    lerpToward(current, targetFor(4, 0, 1, stubNoise, false), 0.25);
    expect(current.byteLength).toBe(before);
  });
});
