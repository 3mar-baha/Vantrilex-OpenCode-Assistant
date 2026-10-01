import { defineConfig } from 'vitest/config';

// THE LIVE TIER. Deliberately not reachable from any gate.
//
// Run it on purpose:
//   node node_modules/vitest/vitest.mjs run --config vitest.live.config.ts
//
// With `VOXAURA_LIVE_SERVE=1` in the environment as well, when a real serve is
// answering 4096 and a credential resolves. Without all three the file reports
// SKIPS — it never falls back to a stub, because "a suite that silently degrades
// to a stub" is the failure mode this repo keeps measuring.
//
// WHY A SECOND CONFIG AND NOT A SKIP. `describe.skipIf(!live)` inside the
// hermetic run was tried first and is wrong: a skip is still a row in the
// summary, so the reported total depends on whether 4096 happened to be
// listening and whether `serve.pass` happened to resolve. Both exit 0, which is
// the worst property a gate number can have. A file the hermetic `include` does
// not match has no row at all, so the total is a property of the tree.
//
// The suffix `*.live.test.ts` is the contract, and `serve-live-gating.test.ts`
// pins it from disk in both directions: nothing matching it may be collected by
// `vitest.config.ts`, and this config must collect all of it.
export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts'],
  },
});