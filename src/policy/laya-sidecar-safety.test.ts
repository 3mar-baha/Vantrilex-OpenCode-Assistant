import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

// Laya System-1 vs the shipped sidecar.
//
// `src/runtime/laya/laya-engine.ts` statically imports `onnxruntime-node`, a
// NATIVE module. The Windows sidecar does not bundle native binaries, so any
// STATIC path from `src/daemon.ts` to that file makes the whole daemon module
// graph fail to load with ERR_MODULE_NOT_FOUND — 4097 never binds and the app
// does nothing. That is the v0.6.0 failure, and it shipped with every gate
// green, because E2E drives a stub daemon (src/policy/sidecar-safety.test.ts:5-14).
//
// Two invariants are pinned here, and the second is what makes the first
// survivable:
//
//   A. `laya-engine.ts` must NEVER be statically reachable from `src/daemon.ts`.
//      This is the load-bearing one and it is enforced unconditionally, in
//      every wiring state: un-wired, dynamically wired, anything.
//   B. `loader.ts` — the sanctioned entry — must reach the engine through
//      `import()` only. That makes a static import of `loader.js` *survivable*,
//      so a second careless edit cannot re-arm A.
//
// Do not weaken A into "the daemon happens not to import it today". A graph
// invariant is the only thing that survives the next person's refactor.

const NATIVE = new Set(['onnxruntime-node', 'better-sqlite3', 'node-gyp-build']);
const STATIC_IMPORT = /^\s*(?:import|export)\s[^'"]*from\s+['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const BARE_IMPORT = /^\s*import\s+['"]([^'"]+)['"]/gm;

/**
 * Strip comments before edges are parsed.
 *
 * This is not cosmetic. A naive regex walker reads a header comment containing
 * `import('./laya-engine.js')` as a real dynamic edge — which is how this
 * walker first reported `laya-engine.ts` as statically reachable through
 * itself, and then spun forever. Comments must not fabricate an edge, and they
 * must not be able to hide one either, so they are removed before matching.
 *
 * Only FULL-LINE comments are stripped, plus block comments. A trailing `//`
 * after code is left alone so a URL inside a string literal (the model URL in
 * `vad.ts`) is never mangled — trailing comments cannot introduce an import
 * edge anyway, because an edge specifier always sits on its own import
 * statement.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

export interface Walk {
  /** Reached at least once, by any edge. */
  readonly any: Set<string>;
  /** Reached through at least one static `import ... from` edge. */
  readonly statics: Set<string>;
  /** Native packages reached statically from the entry. */
  readonly offenders: string[];
  /** Every edge seen, for failure messages. */
  readonly edges: string[];
}

function readIfPresent(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function fileExists(f: string): boolean {
  try {
    readFileSync(f);
    return true;
  } catch {
    return false;
  }
}

function walkFrom(entry: string): Walk {
  const any = new Set<string>();
  const statics = new Set<string>();
  const offenders: string[] = [];
  const edges: string[] = [];
  // Keyed by `file|static` so a static cycle terminates. The naive `!seen ||
  // isStatic` re-push re-queues a statically-reachable module once per inbound
  // edge, forever, if two modules import each other.
  const done = new Set<string>();
  const queue: Array<[string, boolean]> = [[resolve(entry), true]];

  const enqueue = (from: string, spec: string, isStatic: boolean): void => {
    if (!spec.startsWith('.')) return;
    const base = resolve(dirname(from), spec.replace(/\.js$/, ''));
    for (const cand of [`${base}.ts`, join(base, 'index.ts')]) {
      if (!fileExists(cand)) continue;
      any.add(cand);
      if (isStatic) statics.add(cand);
      edges.push(`${from} -${isStatic ? '->' : '~~>'}${spec}`);
      queue.push([cand, isStatic]);
    }
  };

  while (queue.length > 0) {
    const item = queue.pop() as [string, boolean];
    const file = item[0];
    const key = `${file}|${item[1] ? 's' : 'd'}`;
    if (done.has(key)) continue;
    done.add(key);
    if (!fileExists(file)) continue;
    const src = stripComments(readIfPresent(file));
    // A module is "statically reachable" if ANY edge into it is static, so scan
    // it in both classes when it has been reached both ways.
    const isStaticNode = statics.has(file) || item[1];
    for (const m of [...src.matchAll(STATIC_IMPORT), ...src.matchAll(BARE_IMPORT)]) {
      const spec = m[1] as string;
      if (NATIVE.has(spec)) {
        if (isStaticNode) offenders.push(`${file} -> ${spec} (static)`);
        continue;
      }
      enqueue(file, spec, true);
    }
    for (const m of src.matchAll(DYNAMIC_IMPORT)) {
      const spec = m[1] as string;
      if (NATIVE.has(spec)) continue;
      // A dynamic edge is LAZY whatever the parent looked like.
      enqueue(file, spec, false);
    }
  }
  return { any, statics, offenders, edges };
}

const DAEMON = resolve('src/daemon.ts');
const LAYA_ENGINE = resolve('src/runtime/laya/laya-engine.ts');
const LAYA_LOADER = resolve('src/runtime/laya/loader.ts');

describe('Laya is quarantined behind import() (v0.6.0 regression class)', () => {
  test('the scanner detects a static edge to a native package — it is not vacuous', () => {
    // A guard that cannot fail is decoration. This builds the exact failure
    // shape the real guard exists for, in a scratch tree, and requires the
    // scanner to catch it. If this test ever passes on an empty walk, the
    // scanner is broken and the tests below are worthless.
    const dir = mkdtempSync(join(tmpdir(), 'voxaura-laya-guard-'));
    try {
      writeFileSync(
        join(dir, 'entry.ts'),
        "import './middle.js';\nconst lazy = () => import('./lazy.js');\nvoid lazy;\n",
        'utf8',
      );
      // Static edge to a native package: this is v0.6.0, verbatim.
      writeFileSync(join(dir, 'middle.ts'), "import * as ort from 'onnxruntime-node';\nexport const x = ort;\n", 'utf8');
      // Reached ONLY dynamically: safe, and must NOT be reported.
      writeFileSync(join(dir, 'lazy.ts'), "import * as ort from 'onnxruntime-node';\nexport const y = ort;\n", 'utf8');

      const result = walkFrom(join(dir, 'entry.ts'));
      expect(result.offenders).toHaveLength(1);
      expect(result.offenders[0]).toContain('onnxruntime-node');
      expect(result.any.has(join(dir, 'lazy.ts'))).toBe(true);
      // The dynamic-only module is reachable but not statically so.
      expect(result.statics.has(join(dir, 'lazy.ts'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the scanner ignores a subtree that is never reached at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voxaura-laya-guard2-'));
    try {
      writeFileSync(join(dir, 'entry.ts'), "export const a = 1;\n", 'utf8');
      writeFileSync(join(dir, 'orphan.ts'), "import * as ort from 'onnxruntime-node';\nexport const z = ort;\n", 'utf8');
      const result = walkFrom(join(dir, 'entry.ts'));
      expect(result.offenders).toEqual([]);
      expect(result.any.has(join(dir, 'orphan.ts'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a comment that looks like an import is NOT an edge', () => {
    // This is not hypothetical: the first version of this scanner read the
    // header comment in loader.ts — "loaded through `import('./runtime/vad.js')`"
    // — as a real dynamic edge, and a similar comment in laya-engine.ts became a
    // self-edge that spun the walk forever. A comment must not fabricate a
    // reachability claim in either direction.
    const dir = mkdtempSync(join(tmpdir(), 'voxaura-laya-guard3-'));
    try {
      writeFileSync(
        join(dir, 'entry.ts'),
        [
          '// import { engine } from "./engine.js";',
          '// import("./engine.js")',
          '/* import * as ort from "onnxruntime-node"; */',
          'export const real = 1;',
          '',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(join(dir, 'engine.ts'), "import * as ort from 'onnxruntime-node';\nexport const e = ort;\n", 'utf8');
      const result = walkFrom(join(dir, 'entry.ts'));
      expect(result.any.has(join(dir, 'engine.ts'))).toBe(false);
      expect(result.offenders).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a static import cycle terminates instead of spinning forever', () => {
    // The naive `!seen || isStatic` re-push queues a statically-reachable module
    // once per inbound edge, so two mutually-importing modules loop forever. A
    // guard that hangs the suite is worse than no guard.
    const dir = mkdtempSync(join(tmpdir(), 'voxaura-laya-guard4-'));
    try {
      writeFileSync(join(dir, 'entry.ts'), "import { b } from './b.js';\nexport const a = b;\n", 'utf8');
      writeFileSync(join(dir, 'b.ts'), "import { a } from './a.js';\nexport const b = a;\n", 'utf8');
      const result = walkFrom(join(dir, 'entry.ts'));
      expect(result.any.has(join(dir, 'b.ts'))).toBe(true);
      expect(result.edges.length).toBeLessThan(50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('laya-engine.ts is NEVER statically reachable from src/daemon.ts', () => {
    const result = walkFrom(DAEMON);
    expect(
      result.statics.has(LAYA_ENGINE),
      'src/daemon.ts reaches src/runtime/laya/laya-engine.ts through a static import. ' +
        'That file imports onnxruntime-node, which the sidecar does not bundle: the daemon ' +
        'will die with ERR_MODULE_NOT_FOUND and never bind 4097. Import it with `import()`.',
    ).toBe(false);
    // And the broader invariant, stated once, over every native package.
    expect(
      result.offenders,
      `native packages STATICALLY reachable from daemon.ts:\n${result.offenders.join('\n')}`,
    ).toEqual([]);
  });

  test('the premise holds: laya-engine.ts really does statically import onnxruntime-node', () => {
    // If someone "fixes" the file by dropping ORT, invariant A becomes vacuous
    // and nobody would notice. This test is the tripwire for that.
    expect(readFileSync(LAYA_ENGINE, 'utf8')).toMatch(/^\s*import\s+\*\s+as\s+ort\s+from\s+'onnxruntime-node'/m);
  });

  test('the sanctioned entry holds NO specifier-bearing edge to the engine', () => {
    // B: loader.js is the file the daemon is told to name. It must be safe even
    // if someone imports it STATICALLY, which means it must not reach the engine
    // by any static edge — not even an `import type`, which TypeScript erases and
    // which is therefore safe but unreadable-as-safe. The `LayaDecision` type was
    // moved to ./types.js so this file has nothing to exempt.
    const src = readFileSync(LAYA_LOADER, 'utf8');
    expect(src).toMatch(/import\(\s*'\.\/laya-engine\.js'\s*\)/);
    const staticEdges = src
      .split('\n')
      .map((line, i) => [`${LAYA_LOADER}:${i + 1}`, line] as const)
      .filter(([, line]) => /\bfrom\s+'[^']*laya-engine/.test(line) || /^\s*import\s+['"][^'"]*laya-engine/.test(line));
    expect(
      staticEdges.map(([where, line]) => `${where}  ${line.trim()}`),
      'src/runtime/laya/loader.ts must hold no static edge to the engine. An `import type` is ' +
        'erased by tsc and is therefore safe, but a reader should not need to know that to ' +
        'trust this file. Put the type in ./types.js.',
    ).toEqual([]);
    // And no static edge to any native package at all.
    for (const m of src.matchAll(STATIC_IMPORT)) {
      expect(NATIVE.has(String(m[1]))).toBe(false);
    }
    for (const m of src.matchAll(BARE_IMPORT)) {
      expect(NATIVE.has(String(m[1]))).toBe(false);
    }
  });

  test('no module under src/runtime/laya/ except the engine imports a native package', () => {
    // One choke point for the whole subsystem. A second native import added
    // later (a tokenizer in Rust, a sqlite cache) would land somewhere here and
    // would have to be re-classified deliberately, not by accident.
    const files = ['index.ts', 'loader.ts', 'tokenizer.ts', 'telemetry.ts', 'constants.ts', 'types.ts'];
    for (const f of files) {
      const src = readFileSync(resolve('src/runtime/laya', f), 'utf8');
      for (const m of [...src.matchAll(STATIC_IMPORT), ...src.matchAll(BARE_IMPORT)]) {
        expect(NATIVE.has(String(m[1])), `${f} statically imports native package ${String(m[1])}`).toBe(false);
      }
    }
  });

  test('daemon.ts holds no static import of anything under runtime/laya/', () => {
    // A narrower, greppable version of invariant A, mirroring
    // src/policy/sidecar-safety.test.ts:27-34. The graph walk above is the real
    // check; this one names the mistake in the failure output.
    const src = readFileSync('src/daemon.ts', 'utf8');
    expect(src).not.toMatch(/^\s*import\s[^\n]*from\s+['"][^'"]*runtime\/laya[^'"]*['"]/m);
    expect(src).not.toMatch(/^\s*import\s+['"][^'"]*runtime\/laya[^'"]*['"]/m);
  });

  test('the LAYA telemetry producer exists and the union member is not orphaned', () => {
    // writer.ts:36 has accepted 'LAYA' since it was written with no producer.
    // This asserts a producer now exists. It does NOT assert the daemon calls
    // it — that is the call site the orchestrator is asked to add, and it is
    // the reason the seam takes an injected sink.
    const src = readFileSync('src/runtime/laya/telemetry.ts', 'utf8');
    expect(src).toMatch(/subsystem:\s*'LAYA'/);
    expect(readFileSync('src/telemetry/writer.ts', 'utf8')).toMatch(/'LAYA'/);
  });
});
