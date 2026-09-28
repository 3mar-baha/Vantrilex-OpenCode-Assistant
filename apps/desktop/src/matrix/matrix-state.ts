// The daemon-state -> surface mapping. This is the ONLY member of the former
// 48×48 colour-field module that anything ever imported (`App.tsx:13`).
//
// W6 deleted the rest of it — `MATRIX_SIZE`, `createField`, `targetInto`,
// `targetFor`, `lerpToward`, `converged`, `borderMask`, `stateBase`,
// `stateAccent`, `LERP_ALPHA`, `Noise2D` and the hex tables behind them — plus
// the 13 tests that covered them. Two independent reasons, both measured:
//
//   1. Zero production importers. The old header claimed "the worker passes
//      simplex-noise, tests pass a stub", but there IS no matrix worker: no
//      worker file exists anywhere under `apps/desktop/src`, and the HUD
//      visualises through `SiriWaveCanvas` instead. Every caller of the field
//      code was `matrix-state.test.ts`.
//   2. The field it built was pure DSP that nothing rendered, and its
//      `simplex-noise` dependency had zero imports in the whole desktop tree.
//
// Deleting it also retires `simplex-noise` from `apps/desktop/package.json`:
// the only mention left in the tree was the stale comment this file carried.
export type MatrixState = 0 | 1 | 2 | 3 | 4; // IDLE | USER | THINKING | KAREEM | NOUR

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
