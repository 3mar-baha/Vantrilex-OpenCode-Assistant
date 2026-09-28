import { defineConfig } from 'vitest/config';

// Coverage is deliberately NOT configured here. This file previously declared
// `coverage.thresholds: { lines: 80 }` while nothing ever set `coverage.enabled`,
// so the threshold had never once been evaluated. It read like a floor and
// guaranteed nothing — the worse of the two failure modes, because a reviewer
// who sees "lines: 80" stops looking.
//
// Why it is not simply switched on:
//  - `coverage.enabled` defaults to `false` (Vitest 4 docs), so `thresholds`
//    is inert without it, and `npm run test:vantrilex` has no `--coverage`
//    stage at all — enabling it here would change no gate's exit code.
//  - `@vitest/coverage-v8` is not present in `node_modules`, so turning it on
//    requires an install that the release flow deliberately avoids.
//  - The real line-coverage number has never been measured. Any threshold
//    written before that measurement would be a guess wearing a number's
//    clothes, and would land the repo permanently red on unknown ground.
//
// To reinstate a real floor, measure first, then commit both the number and
// the command that produces it:
//   1. npm i -D @vitest/coverage-v8
//   2. npx vitest run --coverage.enabled --coverage.provider=v8
//   3. only then set `coverage: { enabled: true, thresholds: { lines: <measured> } }`
//      and add a `--coverage` stage to `test:vantrilex` in package.json.
// Do not re-add a threshold before step 2 has been run and its output recorded
// in docs/10-CHECKPOINT.md.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'bench/**/*.bench.ts'],
  },
});
