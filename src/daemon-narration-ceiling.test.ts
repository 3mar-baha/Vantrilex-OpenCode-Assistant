import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P1 item 3: the narrator's timeout ceiling was 8,000 ms against a measured
// 5,010-5,015 ms on free-tier Inkling - roughly 1.6x headroom, on a provider
// that documents no SLA. Raised to 12,000 ms (~2.4x).
//
// This test reads the source rather than importing a constant, because the
// constant is function-scoped inside startDaemon. The point is not "a number is
// 12,000" but "the ceiling is documented where it is set, and the documentation
// survives edits" - a magic literal with no rationale is what produced the
// original 1.6x.
const SOURCE = readFileSync(join(process.cwd(), 'src', 'daemon.ts'), 'utf8');

describe('the narration ceiling has measured headroom (P1 item 3)', () => {
  test('it is a named constant, not an inline literal', () => {
    expect(SOURCE).toContain('const NARRATOR_TIMEOUT_MS =');
  });

  test('it is 12,000 ms', () => {
    expect(SOURCE).toMatch(/const NARRATOR_TIMEOUT_MS = 12_000;/);
  });

  test('the narrator actually uses it', () => {
    // A constant that is declared and never wired is the same failure as the
    // dead modules this project spent v0.7.0 removing.
    expect(SOURCE).toContain('timeoutMs: NARRATOR_TIMEOUT_MS,');
  });

  test('the rationale records the measurement it is based on', () => {
    // If this assertion ever fails, the fix is to re-measure, not to delete the
    // sentence. A ceiling with no recorded evidence is how 8,000 happened.
    const doc = SOURCE.slice(SOURCE.indexOf('const NARRATOR_TIMEOUT_MS') - 2000, SOURCE.indexOf('const NARRATOR_TIMEOUT_MS'));
    expect(doc).toContain('5,010');
    expect(doc).toMatch(/headroom/);
  });

  test('the optimizer ceiling is unchanged and separately justified', () => {
    // 8,000 is still correct for the optimizer: it is a bounded cosmetic pass
    // on an utterance that is already dispatchable, measured at 2,796-5,193 ms.
    // Conflating the two ceilings would be the easy mistake here.
    expect(SOURCE).toContain('const OPTIMIZER_TIMEOUT_MS = 8_000;');
  });
});
