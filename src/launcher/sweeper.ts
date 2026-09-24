// Orphan sweeper — compatibility re-export. The implementation lives in
// ./siblings.ts so sibling-serve protection shares one code path.
export type { SweepResult, SweepOptions } from './siblings.js';
export { sweepOrphans, startSweeper } from './siblings.js';
