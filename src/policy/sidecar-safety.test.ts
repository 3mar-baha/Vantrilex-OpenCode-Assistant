import { describe, expect, test } from 'vitest';
import { isLoudWindow, windowRmsDb, WINDOW_BYTES } from '../voice/ingest.js';
import { AudioPipeline } from '../orchestrator/audio-pipeline.js';

// v0.6.0 shipped a daemon that could not boot in an installed build.
//
// `runtime/vad.ts` imports `onnxruntime-node`, a NATIVE module the sidecar does
// not bundle. `daemon.ts` imported it statically, so the whole daemon module
// graph failed to load with ERR_MODULE_NOT_FOUND and 4097 never opened — even
// though every unit, Rust and E2E test passed, because E2E drives a stub daemon.
//
// These tests pin the two properties that make that class of bug survivable:
//   1. no static import of the VAD module survives in the daemon's import graph;
//   2. the speech gate still works, and degrades to the RMS gate, without it.

function speechWindow(): Uint8Array {
  const samples = new Int16Array(WINDOW_BYTES / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(32768 * 0.25 * Math.sin((2 * Math.PI * 440 * i) / 16_000));
  }
  return new Uint8Array(samples.buffer);
}

const silent = (): Uint8Array => new Uint8Array(WINDOW_BYTES);

describe('sidecar-safe VAD wiring (v0.6.0 regression)', () => {
  test('daemon.ts imports the VAD module dynamically, never statically', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/daemon.ts', 'utf8');
    // A static `from './runtime/vad.js'` makes a missing native package fatal.
    expect(src).not.toMatch(/^\s*import\s[^\n]*from\s+['"][^'"]*runtime\/vad(\.js)?['"]/m);
    // The dynamic form must be present, or the gate has no detector at all.
    expect(src).toMatch(/import\(\s*['"][^'"]*runtime\/vad(\.js)?['"]\s*\)/);
  });

  test('nothing on the daemon import graph statically imports a native package', async () => {
    // The real invariant is reachability, not "the string appears once": a
    // native module anywhere in the daemon's static import graph makes an
    // installed build fail to boot, because the sidecar omits native binaries.
    // `laya-engine.ts` also imports onnxruntime-node but is never reached from
    // the daemon, so it is correctly not flagged here.
    const { readFileSync, existsSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');

    const NATIVE = new Set(['onnxruntime-node', 'better-sqlite3', 'node-gyp-build']);
    const STATIC_IMPORT = /^\s*(?:import|export)\s[^'"]*from\s+['"]([^'"]+)['"]/gm;
    const DYNAMIC_IMPORT = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

    // A module reached only through `import()` is safe: the failure is lazy and
    // catchable, which is the entire point of the v0.6.1 fix. A module reached
    // through a static `import ... from` is fatal — it must resolve at load time.
    const anyReach = new Set<string>();
    const offenders: string[] = [];

    const resolveSpec = (from: string, spec: string): string[] => {
      if (!spec.startsWith('.')) return [];
      const base = resolve(dirname(from), spec.replace(/\.js$/, ''));
      return [`${base}.ts`, join(base, 'index.ts')].filter((c) => existsSync(c));
    };

    // TWO INDEPENDENT BFS PASSES.
    //
    // The invariant this test needs is "is this file reachable from daemon.ts
    // following ONLY static edges". That is independent of full reachability,
    // so the two do not need to be computed together — and computing them
    // together is exactly what made the previous version diverge.
    //
    // The old walker de-duplicated with `queue.some(([f]) => f === cand)`: an
    // O(n) scan of the CURRENT queue, which cannot see a node that has already
    // been popped. Any import cycle therefore re-enqueued its members forever.
    // Measured on this graph before the fix: 16 ms / 45 pops with the VAD edge
    // alone, then no termination in 300 s at a 3M-pop cap once a cycle-bearing
    // edge (the Laya loader) was added, OOM-killing a vitest worker at 4 GB.
    // A per-pass `seen` set bounds each walk to one visit per file, which is
    // all reachability requires.
    const walk = (followDynamic: boolean): Set<string> => {
      const root = resolve('src/daemon.ts');
      const seen = new Set<string>([root]);
      const stack: string[] = [root];
      while (stack.length > 0) {
        const file = stack.pop() as string;
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(STATIC_IMPORT)) {
          for (const cand of resolveSpec(file, m[1] as string)) {
            if (!seen.has(cand)) { seen.add(cand); stack.push(cand); }
          }
        }
        if (followDynamic) {
          for (const m of src.matchAll(DYNAMIC_IMPORT)) {
            for (const cand of resolveSpec(file, m[1] as string)) {
              if (!seen.has(cand)) { seen.add(cand); stack.push(cand); }
            }
          }
        }
      }
      return seen;
    };

    // Pass 1 — static edges only. Every module in this set must resolve at
    // daemon load time, so none of them may pull a native package.
    const staticReach = walk(false);
    for (const file of staticReach) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(STATIC_IMPORT)) {
        const spec = m[1] as string;
        if (NATIVE.has(spec)) offenders.push(`${file} -> ${spec} (statically reachable)`);
      }
    }
    // Pass 2 — every edge, so the sanity assertions below can prove the walk
    // really did traverse the graph rather than returning an empty set.
    for (const f of walk(true)) anyReach.add(f);

    expect(
      offenders,
      `native packages STATICALLY reachable from daemon.ts (absent from the sidecar):\n${offenders.join('\n')}`,
    ).toEqual([]);
    // Sanity: the walk really traversed the graph, and vad.ts is on it — but
    // only through the dynamic edge.
    expect(anyReach.size).toBeGreaterThan(15);
    expect(anyReach.has(resolve('src/runtime/vad.ts'))).toBe(true);
    expect(staticReach.has(resolve('src/runtime/vad.ts'))).toBe(false);
  });
});

describe('the speech gate works without the native model (fallback path)', () => {
  test('the RMS gate still separates speech from silence with no detector', () => {
    expect(isLoudWindow(silent())).toBe(false);
    expect(isLoudWindow(speechWindow())).toBe(true);
  });

  test('a window pipeline gated only by energy still reaches the brain', async () => {
    // Exactly what runs in the packaged build: no `speechGate` dep supplied, so
    // AudioPipeline uses the energy gate in ingest.ts.
    const calls: string[] = [];
    const pipeline = new AudioPipeline({
      transcribe: async () => 'مرحبا',
      think: async () => {
        calls.push('think');
        return { reply: 'حاضر' };
      },
      activeSessionId: () => undefined,
    });
    await pipeline.pushChunk(speechWindow());
    expect(calls).toEqual(['think']);
    expect(pipeline.gatedWindows).toBe(0);
  });

  test('silence is still gated out with no detector present', async () => {
    let thinks = 0;
    const pipeline = new AudioPipeline({
      transcribe: async () => 'should not run',
      think: async () => {
        thinks += 1;
        return { reply: 'x' };
      },
      activeSessionId: () => undefined,
    });
    await pipeline.pushChunk(silent());
    expect(thinks).toBe(0);
    expect(pipeline.gatedWindows).toBe(1);
  });

  test('the fallback is not "transcribe everything": silence stays silent', async () => {
    // The whole point of D1. A degraded gate must still reject room tone.
    expect(windowRmsDb(silent())).toBe(-100);
  });
});
