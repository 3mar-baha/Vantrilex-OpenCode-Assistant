import { describe, expect, test } from 'vitest';
import { NARRATOR_SYSTEM } from './orchestrator/narrator.js';
import { KAREEM, NOUR } from './knowledge/personas.js';
import type { NarratorChat } from './orchestrator/narrator.js';
import { readFileSync } from 'node:fs';

// WHY THIS FILE EXISTS SEPARATELY from narrator-persona.test.ts.
//
// The narrator tests prove the SEAM works. They do NOT prove the daemon USES it.
// When the seam was first written, breaking the daemon's call site - deleting the
// persona argument entirely - left all 9 narrator tests GREEN. A feature that
// compiles, is tested, and is never called looks exactly like a feature that
// ships. That is the "documented as shipped while unreachable" defect class this
// repository has now hit four times, so the integration itself is pinned here.

describe('daemon threads the active persona into the narrator', () => {
  test('the daemon source passes the persona to narrate()', () => {
    // Structural, because the runtime seam cannot be exercised without a live
    // serve plus a provider key. It is still a real guard: this exact line is
    // what the behavioural test below could not reach, and deleting it fails
    // here even though every narrator test stays green.
    const src = readFileSync('src/daemon.ts', 'utf8');
    expect(src).toMatch(/PERSONA_DIRECTIVES\[activePersona\]/);
    expect(src).toMatch(/id:\s*activePersona/);
  });

  test('the daemon imports directives from the persona module, not the barrel', () => {
    // The knowledge barrel re-exports the BM25 retriever and the 43-chunk
    // corpus. The daemon must not pull a search index into its import graph to
    // obtain one style string.
    const src = readFileSync('src/daemon.ts', 'utf8');
    const importLine = src.split('\n').find((l) => l.includes('PERSONA_DIRECTIVES')) ?? '';
    expect(importLine).toContain("knowledge/personas.js");
    expect(importLine).not.toContain("knowledge/index.js");
  });

  test('DaemonOptions exposes the narratorChat seam the behavioural test needs', () => {
    // Without this seam the persona integration is untestable at runtime, and an
    // untestable integration is an unverified one.
    const src = readFileSync('src/daemon.ts', 'utf8');
    expect(src).toMatch(/readonly narratorChat\?:\s*NarratorChat/);
    expect(src).toMatch(/options\.narratorChat\s*\?\?\s*narratorChat/);
  });

  test('an injected chat receives the persona directive in its system string', async () => {
    // The behavioural half, run against the narrator the daemon actually uses.
    const { narrate } = await import('./orchestrator/narrator.js');
    const seen: string[] = [];
    const chat: NarratorChat = (_m, system) => {
      seen.push(system);
      return Promise.resolve('{"reply_ar":"تمام"}');
    };
    await narrate({ action: 'a', outcome: 'ok' }, chat, 'm', 20, { id: 'kareem', directive: KAREEM.directive });
    await narrate({ action: 'a', outcome: 'ok' }, chat, 'm', 20, { id: 'nour', directive: NOUR.directive });
    expect(seen[0]).toContain(KAREEM.directive);
    expect(seen[1]).toContain(NOUR.directive);
    expect(seen[0]).not.toBe(seen[1]);
    // And the safety contract survives in both.
    for (const s of seen) expect(s).toContain(NARRATOR_SYSTEM.replace('{max}', '20'));
  });
});

describe('A5: the TTS credit clock is daemon state, not pipeline state', () => {
  // The same reasoning as the file above, applied to the credit monitor: the
  // behavioural test in daemon.test.ts observes the monitor the HANDLE exposes,
  // so a second monitor shadowing it inside `buildVoicePipeline` would leave
  // that test green while the pipeline records its faults into an object the
  // shell never reads. Structure is the only thing that can see it.
  test('the daemon constructs exactly one TtsCreditMonitor, and not in the rebuildable pipeline', () => {
    const src = readFileSync('src/daemon.ts', 'utf8');
    expect(src.match(/new TtsCreditMonitor\(/g) ?? []).toHaveLength(1);
    const body = src.slice(src.indexOf('const buildVoicePipeline'), src.indexOf('const rebuildVoice'));
    expect(body.length, 'the slice must be a real region, not an empty one').toBeGreaterThan(0);
    expect(body, 'a monitor built here is rebuilt on every key save').not.toMatch(/new TtsCreditMonitor/);
  });

  test('the clock seam the behavioural test drives is declared and consumed', () => {
    const src = readFileSync('src/daemon.ts', 'utf8');
    expect(src).toMatch(/readonly ttsCreditNow\?:\s*\(\)\s*=>\s*number/);
    expect(src).toMatch(/new TtsCreditMonitor\(options\.ttsCreditNow \?\? \(\(\) => Date\.now\(\)\)\)/);
  });
});
