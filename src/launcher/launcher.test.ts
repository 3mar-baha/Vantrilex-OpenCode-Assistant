import { describe, expect, test } from 'vitest';
import { resolvePort } from './launcher.js';

describe('port adopt-or-escalate (E-1)', () => {
  test('adopts healthy owner with matching password', () => {
    expect(resolvePort({ healthy: true, passwordMatches: true }, 4096, [])).toEqual({ port: 4096, adopted: true });
  });

  test('escalates on password mismatch or unhealthy listener', () => {
    expect(resolvePort({ healthy: true, passwordMatches: false }, 4096, []).port).toBe(4097);
    expect(resolvePort({ healthy: false, passwordMatches: false }, 4096, [4097]).port).toBe(4098);
  });
});
