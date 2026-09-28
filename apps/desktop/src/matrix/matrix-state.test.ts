import { describe, expect, test } from 'vitest';
import { matrixForDaemonState } from './matrix-state.js';

// W6 — the 13 tests that covered the deleted 48×48 colour field went with it.
// The mapper below is the only surviving member and the only one `App.tsx:13`
// ever imported, so it is the only one with a reason to be tested.
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
