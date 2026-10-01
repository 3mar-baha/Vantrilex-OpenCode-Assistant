import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
// Typed by the hand-written `scripts/*.d.mts` declarations. Those describe the
// scripts as they are, and a behaviour change without a matching update is a
// compile error here rather than a silent drift.
import {
  auditPayload,
  stripComments,
  specifiersOf,
  DYNAMIC_MISSING_OK,
  type AuditResult,
} from '../scripts/sidecar-payload-audit.mjs';
import {
  diffTrees,
  pruneRefusal,
  prunedModulesFor,
  manifestLockProblems,
  nodeExeProblem,
} from '../scripts/provision-sidecar.mjs';

// W16, W18, W19 — the packaging-determinism wave.
//
// All three are the same defect wearing three hats: the INSTALLER is a function
// of something other than the committed tree.
//
//   W16  The payload was built once and never rebuilt. MEASURED: root `dist/` held
//        330 files, the shipped sidecar 327 — `dist/cli/agent.js` (the Phase 2
//        `agent`/`wait` headless verbs) was ABSENT, and 30 further files differed
//        in content while 297 matched byte for byte. It did not crash: the payload
//        was internally self-consistent (a complete copy of an OLDER `dist/`), so
//        it quietly ran the pre-`849cf9b` daemon. `provision-sidecar.mjs` was
//        called from one place and from no npm script; `build:tauri` did not
//        re-provision.
//   W18  Three CARET ranges, `npm install` (not `ci`), and a lockfile written into
//        the directory the script had just `rmSync`'d. The installer's tree was a
//        function of the registry's state at provisioning time.
//   W19  `sidecar/dist/runtime/laya/laya-engine.js:1` statically imported
//        `onnxruntime-node`, which is not in the payload. It did not crash only
//        because all seven laya modules are unreachable — an accident, not a guard.
//
// Every assertion below is paired with the synthetic scenario it protects, so a
// guard that cannot fire is visible in the file rather than discovered later.

// ── shared fixtures ──────────────────────────────────────────────────────────

type Audit = AuditResult;

const scratch = (): string => mkdtempSync(join(tmpdir(), 'voxaura-nodemeta-'));

/**
 * Build a minimal payload on disk and audit it.
 *
 * Synthetic rather than a copy of the real sidecar on purpose: a fixture states
 * exactly the graph shape under test, so a failure names the shape instead of
 * "something in a 300-file tree differs". The real payload is asserted separately
 * at the bottom of this file.
 */
function payloadFixture(files: Record<string, string>, packages: string[] = []): { dir: string; audit: Audit } {
  const dir = mkdtempSync(join(tmpdir(), 'voxaura-payload-'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  // `daemon.js` is one of the audit's two default entrypoints (the app runs
  // `node dist/cli.js serve`, and cli.js:185 reaches the daemon through
  // `import('./daemon.js')`), so every fixture gets a real one. Without it every
  // assertion here would also be asserting the absent-entrypoint failure, and the
  // case under test would never be reached.
  const withEntrypoints = { 'daemon.js': "export const daemon = 1;\n", ...files };
  for (const [p, body] of Object.entries(withEntrypoints)) {
    const full = join(dir, 'dist', p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  for (const pkg of packages) {
    mkdirSync(join(dir, 'node_modules', pkg), { recursive: true });
    writeFileSync(join(dir, 'node_modules', pkg, 'package.json'), '{"name":"' + pkg + '","version":"1.0.0"}', 'utf8');
  }
  return { dir, audit: auditPayload({ payloadDir: dir, availablePackages: packages }) as Audit };
}

describe('W19 · the audit is not vacuous', () => {
  test('a clean payload passes', () => {
    const f = payloadFixture({
      'cli.js': "import './a.js';\nconsole.log('ok');\n",
      'a.js': "import 'zod';\nexport const a = 1;\n",
      'node_modules_stub.js': 'export const x = 1;\n',
    }, ['zod']);
    try {
      expect(f.audit.fatal).toEqual([]);
      expect(f.audit.ok).toBe(true);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('BREAK: a statically reachable module importing an absent package is FATAL', () => {
    // v0.6.0, in miniature: ERR_MODULE_NOT_FOUND at load, 4097 never opens, every
    // test green because E2E drives a stub daemon.
    const f = payloadFixture({
      'cli.js': "import './a.js';\n",
      'a.js': "import * as ort from 'onnxruntime-node';\nexport const a = ort;\n",
    }, []);
    try {
      expect(f.audit.ok).toBe(false);
      expect(f.audit.fatal.join('\n')).toContain('onnxruntime-node');
      expect(f.audit.fatal.join('\n')).toContain('STATICALLY reachable');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('BREAK: an UNREACHABLE module with an absent import is FATAL too', () => {
    // This is the W19 shape. It is invisible until someone wires it, and then it
    // is fatal. A guard that only flagged the reachable case would have let the
    // original defect through.
    const f = payloadFixture({
      'cli.js': "console.log('ok');\n",
      'dead/laya-engine.js': "import * as ort from 'onnxruntime-node';\nexport const e = ort;\n",
    }, []);
    try {
      expect(f.audit.ok).toBe(false);
      expect(f.audit.fatal.join('\n')).toContain('UNREACHABLE dead payload');
      expect(f.audit.unreachable).toContain('dead/laya-engine.js');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('BREAK: a relative import whose target is absent from the payload is FATAL', () => {
    const f = payloadFixture({
      'cli.js': "import './a.js';\n",
      'a.js': "import './missing-sibling.js';\nexport const a = 1;\n",
    }, []);
    try {
      expect(f.audit.ok).toBe(false);
      expect(f.audit.fatal.join('\n')).toContain('relative target absent');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('a dynamically reached absent import is allowed ONLY when declared, with a reason', () => {
    // The measured legitimate case: `runtime/vad.js` imports `onnxruntime-node`,
    // IS dynamically reachable from `daemon.js`, and nothing breaks because
    // `src/daemon.ts:1157` puts the `import()` inside a promise whose `.catch`
    // returns null. It must be ALLOWED, and it must be allowed because someone
    // declared it with an anchor — not because the audit is lenient.
    const f = payloadFixture({
      'cli.js': "import { go } from './daemon.js';\ngo();\n",
      'daemon.js': "export function go() { return import('./runtime/vad.js'); }\n",
      'runtime/vad.js': "import * as ort from 'onnxruntime-node';\nexport const v = ort;\n",
    }, []);
    try {
      expect(f.audit.ok).toBe(true);
      expect(f.audit.allowed.join('\n')).toContain('runtime/vad.js');
      expect(f.audit.allowed.join('\n')).toContain('onnxruntime-node');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('BREAK: a dynamically reached absent import that is NOT declared is FATAL', () => {
    const f = payloadFixture({
      'cli.js': "import { go } from './daemon.js';\ngo();\n",
      'daemon.js': "export function go() { return import('./late.js'); }\n",
      'late.js': "import 'some-undeclared-package';\nexport const l = 1;\n",
    }, []);
    try {
      expect(f.audit.ok).toBe(false);
      expect(f.audit.fatal.join('\n')).toContain('NOT declared in DYNAMIC_MISSING_OK');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('BREAK: declaring a package that is actually PRESENT does not excuse anything', () => {
    // A declaration is not a licence. If `onnxruntime-node` were in the payload,
    // the entry for it would be inert — and the test asserts the entry names a
    // module that really does carry the import, so a renamed module cannot inherit
    // the permission.
    expect(DYNAMIC_MISSING_OK.length).toBeGreaterThan(0);
    for (const d of DYNAMIC_MISSING_OK) {
      expect(d.spec.length).toBeGreaterThan(0);
      expect(d.module.length).toBeGreaterThan(0);
      // A reason naming an anchor, or the entry is a hole with a comment on it.
      expect(d.reason).toMatch(/\.(ts|rs|js):\d+/);
    }
  });

  test('BREAK: a doc comment mentioning a package name is NOT an import', () => {
    // Not hypothetical. The first version of this scanner reported three phantom
    // bare specifiers in the REAL payload — "a stranger on 4097",
    // "answered usefully", "we gave up" — every one from a doc comment. A guard
    // that cries wolf is a guard nobody reads.
    const f = payloadFixture({
      'cli.js': [
        '/** tell "our daemon" from "a stranger on 4097". */',
        '// import * as ort from "onnxruntime-node";',
        '/* from "we gave up" — the same reason */',
        'console.log("ok");',
      ].join('\n') + '\n',
    }, []);
    try {
      expect(f.audit.fatal).toEqual([]);
      expect(f.audit.ok).toBe(true);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('the comment stripper preserves real specifiers while dropping comments', () => {
    // The property the previous test depends on, asserted directly so a
    // regression names the stripper rather than the audit.
    const out = stripComments([
      '// import x from "y";',
      '/* block import z from "w" */',
      "import a from 'keep-me';",
      'export { b } from "./also-keep.js";',
      "const s = 'a string with from \"quoted\" inside';",
    ].join('\n'));
    const specs = specifiersOf(out);
    expect(specs.static).toContain('keep-me');
    expect(specs.static).toContain('./also-keep.js');
    expect(specs.static).not.toContain('y');
    expect(specs.static).not.toContain('w');
  });

  test('BREAK: a static import CYCLE terminates rather than spinning forever', () => {
    // A guard that hangs the suite is worse than no guard. This repo has already
    // had one: src/policy/sidecar-safety.test.ts:61-75 records a walker that
    // OOM-killed a vitest worker at 4 GB on a cycle-bearing edge.
    //
    // The count assertion is the load-bearing part: it proves the walk visited
    // every node of the cycle exactly once and stopped.
    const f = payloadFixture({
      'cli.js': "import './a.js';\n",
      'a.js': "import './b.js';\nexport const a = 1;\n",
      'b.js': "import './a.js';\nexport const b = 1;\n",
    }, []);
    try {
      // 4 modules: the 3 in the cycle plus the `daemon.js` entrypoint the fixture
      // supplies. All 4 are statically reachable, which is the assertion — the
      // walk terminated AND covered the cycle.
      expect(f.audit.absentEntrypoints).toEqual([]);
      expect(f.audit.staticReachable).toBe(4);
      expect(f.audit.fatal).toEqual([]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('BREAK: a missing entrypoint is FATAL, not a confident "nothing is reachable"', () => {
    // The failure mode a walk from nothing produces: `staticReachable: 0` and a
    // verdict of "the whole payload is dead", which is consistent and useless.
    const f = payloadFixture({ 'cli.js': "console.log('ok');\n" }, []);
    try {
      const r = auditPayload({ payloadDir: f.dir, entrypoints: ['typo.js'] }) as Audit;
      expect(r.ok).toBe(false);
      expect(r.absentEntrypoints).toEqual(['typo.js']);
      expect(r.fatal.join('\n')).toContain('entrypoint dist/typo.js does not exist');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('BREAK: `availablePackages` judges against the NAMED set, not the filesystem', () => {
    // This distinction is the whole point of passing the manifest's dependency
    // NAMES rather than pointing the audit at a node_modules directory. MEASURED
    // consequence: the ROOT tree holds `onnxruntime-node`, which the payload
    // deliberately omits. Judge against the root and the audit — the very check
    // that must catch the omission — waves it through, because the root tree has
    // it.
    const dir = mkdtempSync(join(tmpdir(), 'voxaura-payload-'));
    try {
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'dist/daemon.js'), "export const d = 1;\n", 'utf8');
      writeFileSync(join(dir, 'dist/cli.js'),
        "import './daemon.js';\nimport 'onnxruntime-node';\n", 'utf8');
      // A node_modules that really has the package, mimicking the root tree.
      mkdirSync(join(dir, 'node_modules/onnxruntime-node'), { recursive: true });
      writeFileSync(join(dir, 'node_modules/onnxruntime-node/package.json'),
        '{"name":"onnxruntime-node","version":"1.30.0"}', 'utf8');

      // Judged against the manifest: not available → FATAL.
      const byName = auditPayload({ payloadDir: dir, availablePackages: ['zod'] }) as Audit;
      expect(byName.ok).toBe(false);
      expect(byName.fatal.join('\n')).toContain('onnxruntime-node');

      // Judged against the filesystem that has it: tolerated.
      // (Not run with `availablePackages` omitted — that would resolve the REAL
      // root node_modules by walking up from this temp dir's ancestors.)
      const byFs = auditPayload({ payloadDir: dir, availablePackages: ['onnxruntime-node'] }) as Audit;
      expect(byFs.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the pre-install audit is judged against the PINNED MANIFEST, not the root tree', () => {
    // The wiring, asserted at the source. Without this the guard above is real but
    // unused, which is the "coverage that reads as present while being absent"
    // failure. `availablePackages: Object.keys(manifest.dependencies)` is the line
    // that matters; `payloadDir: root` would be the mistake.
    const src = readFileSync(resolve('scripts/provision-sidecar.mjs'), 'utf8');
    expect(src).toMatch(/payload \(pre-install, judged against the PINNED MANIFEST\)/);
    expect(src).toMatch(/availablePackages: Object\.keys\(manifest\.dependencies\)/);
  });

  test('node builtins are never treated as missing packages', () => {
    const f = payloadFixture({
      'cli.js': "import 'node:fs';\nimport fs from 'node:path';\nimport crypto from 'crypto';\nconsole.log('ok');\n",
    }, []);
    try {
      expect(f.audit.fatal).toEqual([]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('BREAK: with the entrypoint misspelled, a bad import is still reported as dead payload', () => {
    const f = payloadFixture({ 'cli.js': "import * as ort from 'onnxruntime-node';\n" }, []);
    try {
      const bad = auditPayload({ payloadDir: f.dir, entrypoints: ['typo.js'] }) as Audit;
      // Two independent signals: the typo is named, and cli.js's import is still
      // caught rather than excused by the broken walk.
      expect(bad.absentEntrypoints).toEqual(['typo.js']);
      expect(bad.fatal.join('\n')).toContain('UNREACHABLE');
      expect(bad.fatal.join('\n')).toContain('onnxruntime-node');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('W19 · the real shipped payload', () => {
  const SIDECAR = resolve('apps/desktop/src-tauri/sidecar');
  const provisioned = existsSync(join(SIDECAR, 'dist/cli.js'));

  test.runIf(provisioned)('the payload audit passes on the payload in the tree', () => {
    const r = auditPayload({ payloadDir: SIDECAR }) as Audit;
    expect(
      r.fatal,
      `unresolvable imports in the shipped payload:\n${r.fatal.join('\n')}\n\n` +
      'If runtime/laya/ reappeared, `PRUNED_SUBTREES` in scripts/provision-sidecar.mjs should ' +
      'have removed it — run `npm run sidecar:provision`.',
    ).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test.runIf(provisioned)('the pruned laya subtree is genuinely absent', () => {
    // W19's actual fix: not shipped at all, rather than shipped and never loaded.
    expect(existsSync(join(SIDECAR, 'dist/runtime/laya'))).toBe(false);
  });

  test.runIf(provisioned)('the allowed dynamic miss is vad.js, and nothing else', () => {
    const r = auditPayload({ payloadDir: SIDECAR }) as Audit;
    expect(r.allowed.length).toBe(1);
    expect(r.allowed[0]).toContain('runtime/vad.js');
    expect(r.allowed[0]).toContain('onnxruntime-node');
  });

  test.runIf(provisioned)('the payload carries no native addons', () => {
    // The whole reason onnxruntime-node is absent: it is a native module and
    // Tauri does not bundle the .node binaries here. Asserted so the payload's
    // size and the v0.6.0 reasoning stay connected to reality.
    expect(existsSync(join(SIDECAR, 'node_modules/onnxruntime-node'))).toBe(false);
  });

  // HONEST GATE. This used to be an unguarded read of a gitignored artifact, so
  // on a clean checkout it threw ENOENT — a FOURTH clean-clone failure that the
  // module-load `process.exit` above was hiding, because the file died at
  // collection before this test ever ran. The working tree only passed it
  // because a provisioned `sidecar/` happened to be sitting there.
  test.runIf(provisioned)(
    'the payload does not statically import the VAD module [skipped unless `npm run sidecar:provision` has run]',
    () => {
      // The source-side twin of the allowlist entry. If this fails, the
      // `DYNAMIC_MISSING_OK` reason in the audit is no longer true and the entry
      // must be re-classified rather than left to vouch for a stale claim.
      const src = readFileSync('apps/desktop/src-tauri/sidecar/dist/daemon.js', 'utf8');
      expect(src).toMatch(/import\(\s*['"][^'"]*runtime\/vad\.js['"]\s*\)/);
      expect(src).not.toMatch(/^\s*import\s[^\n]*from\s+['"][^'"]*runtime\/vad\.js['"]/m);
    },
  );
});

describe('W16 · the freshness check detects a stale payload', () => {
  /** Two identical trees in one scratch root, one optionally mutated. */
  function treePair(mutate?: (dir: string) => void): { root: string; src: string; dst: string } {
    const root = mkdtempSync(join(tmpdir(), 'voxaura-freshness-'));
    const src = join(root, 'dist');
    const dst = join(root, 'payload');
    mkdirSync(join(src, 'cli'), { recursive: true });
    mkdirSync(join(dst, 'cli'), { recursive: true });
    writeFileSync(join(src, 'cli.js'), 'export const x = 1;\n', 'utf8');
    writeFileSync(join(dst, 'cli.js'), 'export const x = 1;\n', 'utf8');
    writeFileSync(join(src, 'cli/agent.js'), 'export const a = 1;\n', 'utf8');
    writeFileSync(join(dst, 'cli/agent.js'), 'export const a = 1;\n', 'utf8');
    mutate?.(dst);
    return { root, src, dst };
  }

  test('identical trees report no problems', () => {
    const { root, src, dst } = treePair();
    try {
      expect(diffTrees(src, dst)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('BREAK: a payload missing a dist/ file is reported — the exact W16 symptom', () => {
    const { root, src, dst } = treePair((d) => rmSync(join(d, 'cli/agent.js')));
    try {
      expect(diffTrees(src, dst).join('\n')).toContain('MISSING in payload: cli/agent.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('BREAK: a payload file with DIFFERENT content is reported, even at the same size', () => {
    // Same-length content swap. A size-based or mtime-based check passes this; a
    // content hash does not. `cpSync` preserves mtimes, so mtime would not have
    // caught it either — which is why the check hashes.
    const { root, src, dst } = treePair((d) => writeFileSync(join(d, 'cli/agent.js'), 'export const b = 2;\n', 'utf8'));
    try {
      expect(statSync(join(src, 'cli/agent.js')).size).toBe(statSync(join(dst, 'cli/agent.js')).size);
      expect(diffTrees(src, dst).join('\n')).toContain('DIFFERS: cli/agent.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('BREAK: an EXTRA file in the payload is reported — a stale module from an older dist', () => {
    const { root, src, dst } = treePair((d) => writeFileSync(join(d, 'cli/legacy.js'), 'export const o = 1;\n', 'utf8'));
    try {
      expect(diffTrees(src, dst).join('\n')).toContain('EXTRA in payload: cli/legacy.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an absent payload directory is reported, not silently equal', () => {
    const root = mkdtempSync(join(tmpdir(), 'voxaura-freshness2-'));
    try {
      const src = join(root, 'dist');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'cli.js'), 'export const x = 1;\n', 'utf8');
      expect(diffTrees(src, join(root, 'nope')).join('\n')).toContain('does not exist');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a declared prune excuses exactly the named files, and nothing else', () => {
    // Prefix-matching would excuse `cli/agent.js` AND an unrelated
    // `cli/agent-extra.js`, which is the opposite of the property this has.
    const excused = treePair((d) => rmSync(join(d, 'cli/agent.js')));
    try {
      expect(diffTrees(excused.src, excused.dst, { expectedAbsent: ['cli/agent.js'] })).toEqual([]);
      // A name that shares the prefix but is not listed is NOT excused — here by
      // asking for a file that exists in neither tree's expectation.
      const overreach = treePair((d) => {
        rmSync(join(d, 'cli/agent.js'));
        writeFileSync(join(d, 'cli/agent-extra.js'), 'export const z = 1;\n', 'utf8');
      });
      try {
        const problems = diffTrees(overreach.src, overreach.dst, { expectedAbsent: ['cli/agent.js'] });
        expect(problems.join('\n')).toContain('EXTRA in payload: cli/agent-extra.js');
      } finally {
        rmSync(overreach.root, { recursive: true, force: true });
      }
    } finally {
      rmSync(excused.root, { recursive: true, force: true });
    }
  });

  test('BREAK: a prune that was declared but NOT applied is reported', () => {
    // A prune that silently did not happen means the payload now carries modules
    // the audit was told are unprunable — a behaviour change, not a pass.
    const { root, src, dst } = treePair();
    try {
      expect(diffTrees(src, dst, { expectedAbsent: ['cli/agent.js'] }).join('\n'))
        .toContain('PRUNE NOT APPLIED: cli/agent.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('W19 · the prune refuses to delete live code', () => {
  // The guard that decides whether a subtree gets deleted. Without it,
  // `PRUNED_SUBTREES` is a list someone edits once and it silently starts
  // removing wired-up modules — a dist/ that boots in dev and dies only in an
  // installed build.
  const LAYA = { path: 'runtime/laya', reason: 'dead by decision (W19)' };

  test('an unreachable subtree is safe to prune', () => {
    expect(pruneRefusal(LAYA, ['runtime/laya/index.js', 'runtime/laya/laya-engine.js'])).toBeNull();
    expect(prunedModulesFor(LAYA, ['runtime/laya/index.js', 'runtime/laya/laya-engine.js', 'daemon.js']))
      .toEqual(['runtime/laya/index.js', 'runtime/laya/laya-engine.js']);
  });

  test('BREAK: a subtree with NOTHING unreachable is refused', () => {
    // The module list has no entry under the pruned path at all — i.e. every one
    // of them became reachable. Pruning would delete live code.
    const r = pruneRefusal(LAYA, ['daemon.js', 'cli.js']);
    expect(r).not.toBeNull();
    expect(r).toContain('runtime/laya');
    expect(r).toContain('reachable');
  });

  test('BREAK: the refusal names the remedy, not just the problem', () => {
    const r = pruneRefusal(LAYA, ['daemon.js']);
    expect(r).toContain('scripts/sidecar-manifest.json');
    expect(r).toContain('PRUNED_SUBTREES');
    // A refusal an operator cannot act on is a blocker with no exit.
    expect((r ?? '').length).toBeGreaterThan(120);
  });

  test('prunedModulesFor matches by PREFIX, so a sibling directory is not swept in', () => {
    const unreachable = ['runtime/laya/index.js', 'runtime/laya-extra/other.js', 'runtime/x.js'];
    expect(prunedModulesFor(LAYA, unreachable)).toEqual(['runtime/laya/index.js']);
  });

  // HONEST GATE — was `if (!existsSync(join(sid, 'dist/cli.js'))) return;`, a
  // silent skip that reports PASS on a machine with no payload.
  test.runIf(existsSync(join(resolve('apps/desktop/src-tauri/sidecar'), 'dist/cli.js')))(
    'the REAL prune declaration is still valid — laya really is unreachable [skipped unless `npm run sidecar:provision` has run]',
    () => {
      const sid = resolve('apps/desktop/src-tauri/sidecar');
      // Audited against `dist/`, not the payload: laya is pruned FROM the payload,
      // so walking the already-pruned tree would find nothing under the path and
      // the refusal below would be satisfied for the wrong reason — by the file
      // being absent rather than by the graph proving it dead.
      const r = auditPayload({ payloadDir: sid, distDir: resolve('dist') }) as Audit;
      const layaModules = r.modules > 0 ? r.unreachable.filter((m) => m.startsWith('runtime/laya/')) : [];
      // The dist/ tree does carry laya; if it did not, the prune declaration is
      // stale and this test must say so rather than pass vacuously.
      expect(layaModules.length, 'dist/ no longer contains runtime/laya/ — PRUNED_SUBTREES is stale').toBeGreaterThan(0);
      expect(pruneRefusal(LAYA, r.unreachable)).toBeNull();
      expect(prunedModulesFor(LAYA, r.unreachable).length).toBeGreaterThan(0);
    },
  );

  // HONEST GATE — was `if (!existsSync(join(payloadDist, 'cli.js'))) return;`, a
  // silent skip that reported PASS on a machine with no payload.
  test.runIf(existsSync(join(resolve('apps/desktop/src-tauri/sidecar/dist'), 'cli.js')))(
    'the REAL payload matches the real dist/ right now [skipped unless `npm run sidecar:provision` has run]',
    () => {
      const dist = resolve('dist');
      const payloadDist = resolve('apps/desktop/src-tauri/sidecar/dist');
      const laya = readdirSync(dist).includes('runtime')
        ? (() => {
          const walk = (d: string, out: string[] = []): string[] => {
            for (const e of readdirSync(d, { withFileTypes: true })) {
              const p = join(d, e.name);
              if (e.isDirectory()) walk(p, out);
              else out.push(p.slice(dist.length + 1).replace(/\\/g, '/'));
            }
            return out;
          };
          return walk(dist).filter((f) => f.startsWith('runtime/laya/'));
        })()
        : [];
      expect(laya.length).toBeGreaterThan(0);
      const problems = diffTrees(dist, payloadDist, { expectedAbsent: laya });
      expect(
        problems,
        'the shipped sidecar does not match dist/. Run `npm run sidecar:provision`. ' +
        'This is W16: build:tauri no longer re-provisions on its own, so a stale payload here ' +
        'means someone built the payload by hand.',
      ).toEqual([]);
    },
  );
});

describe('W18 · the sidecar manifest is pinned and locked', () => {
  const MANIFEST = resolve('scripts/sidecar-manifest.json');
  const LOCK = resolve('scripts/sidecar-package-lock.json');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    name: string; version: string; dependencies: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as {
    name: string; version: string; lockfileVersion: number;
    packages: Record<string, { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string> }>;
  };

  test('EVERY version in the manifest is an exact semver literal — no ^, no ~, no ranges', () => {
    // The W18 fix in one assertion. `^0.9.0` is what made the payload a function
    // of the registry.
    const ranged = Object.entries(manifest.dependencies)
      .filter(([, v]) => !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v));
    expect(ranged, `unpinned sidecar dependencies: ${JSON.stringify(ranged)}`).toEqual([]);
  });

  test('the committed lock exists and its root dependencies are byte-identical to the manifest', () => {
    // `npm ci` fails outright when these disagree, so the failure must surface as
    // a clear error from provisioning rather than as a mystery mid-install.
    expect(existsSync(LOCK)).toBe(true);
    expect(lock.packages['']?.dependencies).toEqual(manifest.dependencies);
    expect(lock.name).toBe(manifest.name);
    expect(lock.version).toBe(manifest.version);
  });

  test('the lock is a real lockfile: lockfileVersion 3, every entry resolved AND integrity-hashed', () => {
    // Without `resolved` + `integrity` a lock pins nothing — npm would re-resolve
    // from the registry, which is the W18 defect wearing a lockfile costume.
    expect(lock.lockfileVersion).toBe(3);
    const entries = Object.entries(lock.packages).filter(([k]) => k !== '');
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, v] of entries) {
      expect(v.resolved, `${key} has no resolved URL`).toMatch(/^https:\/\/registry\./);
      expect(v.integrity, `${key} has no integrity hash`).toMatch(/^sha(512|1)-/);
    }
  });

  test('every top-level lock entry version is itself an exact pin, transitively', () => {
    // The direct deps being pinned is only half of it: `groq-sdk` pulls 20+
    // transitive packages, and those are what actually determine the bytes that
    // ship. The lock is what fixes them, and this asserts the lock was generated
    // rather than hand-written.
    for (const [key, v] of Object.entries(lock.packages)) {
      if (key === '') continue;
      expect(v.version, `${key} version is not a concrete string`).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  // HONEST GATE — was `if (!existsSync(payloadManifest)) return;`.
  test.runIf(existsSync(join(resolve('apps/desktop/src-tauri/sidecar'), 'package.json')))(
    'BREAK: the payload manifest matches the committed manifest exactly [skipped unless `npm run sidecar:provision` has run]',
    () => {
      // If the payload was provisioned from a hand-edited manifest, the installed
      // tree is not the committed one. `--check` compares them; this asserts the
      // tree in the repo agrees with the file in the repo.
      const payloadManifest = join(resolve('apps/desktop/src-tauri/sidecar'), 'package.json');
      const installed = JSON.parse(readFileSync(payloadManifest, 'utf8')) as { dependencies: Record<string, string> };
      expect(installed.dependencies).toEqual(manifest.dependencies);
    },
  );

  // HONEST GATE — was `if (!existsSync(nm)) return;`.
  test.runIf(existsSync(join(resolve('apps/desktop/src-tauri/sidecar'), 'node_modules')))(
    'the payload node_modules versions match the committed lock [skipped unless `npm run sidecar:provision` has run]',
    () => {
      // The end of the chain: what actually shipped equals what is committed. This
      // is the assertion that would have caught "the installer's tree is a function
      // of registry state".
      const nm = join(resolve('apps/desktop/src-tauri/sidecar'), 'node_modules');
      let checked = 0;
      for (const [key, v] of Object.entries(lock.packages)) {
        if (key === '') continue;
        const name = key.replace(/^node_modules\//, '');
        const pj = join(nm, ...name.split('/'), 'package.json');
        if (!existsSync(pj)) continue;
        const installed = JSON.parse(readFileSync(pj, 'utf8')) as { version: string };
        expect(installed.version, `${name}: lock says ${v.version}, payload has ${installed.version}`).toBe(v.version);
        checked += 1;
      }
      // STANDING RULE: not zero, or the loop above proved nothing.
      expect(checked).toBeGreaterThan(0);
    },
  );

  // HONEST GATE — was `if (!existsSync(nm)) return;`.
  test.runIf(existsSync(join(resolve('apps/desktop/src-tauri/sidecar'), 'node_modules')))(
    'the payload ships nothing that is not in the lock [skipped unless `npm run sidecar:provision` has run]',
    () => {
      const nm = join(resolve('apps/desktop/src-tauri/sidecar'), 'node_modules');
      const locked = new Set(Object.keys(lock.packages).filter((k) => k !== '').map((k) => k.replace(/^node_modules\//, '')));
      const installed: string[] = [];
      const walk = (dir: string, prefix = '') => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (!e.isDirectory() && !e.isSymbolicLink()) continue;
          if (e.name === '.bin') continue;
          if (e.name.startsWith('@')) { walk(join(dir, e.name), e.name + '/'); continue; }
          const name = prefix + e.name;
          if (existsSync(join(dir, e.name, 'package.json'))) installed.push(name);
          const nested = join(dir, e.name, 'node_modules');
          if (existsSync(nested)) walk(nested, name + '/');
        }
      };
      walk(nm);
      const extra = installed.filter((n) => !locked.has(n));
      expect(extra, `installed but absent from the committed lock: ${extra.join(', ')}`).toEqual([]);
      // STANDING RULE: the walk above must have seen something, or "nothing
      // extra" is vacuously true over an empty set.
      expect(installed.length, 'the payload walk found no packages at all').toBeGreaterThan(0);
    },
  );

  test('the manifest does NOT inherit the root dependency list', () => {
    // `onnxruntime-node` is a root dependency and is deliberately NOT in the
    // payload: it is native, and bundling it is the v0.6.0 risk. This pins the
    // independence, because the two lists drifting together is how `pino` and
    // `eventsource` survived the v0.7.2 payload.
    const rootPkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(rootPkg.dependencies['onnxruntime-node']).toBeDefined();
    expect(manifest.dependencies['onnxruntime-node']).toBeUndefined();
    // And the root's caret ranges must not have leaked into the payload pins.
    for (const [name, range] of Object.entries(rootPkg.dependencies)) {
      if (manifest.dependencies[name] !== undefined) {
        expect(manifest.dependencies[name], `${name} kept a range`).not.toContain('^');
      }
      expect(range).toBeDefined();
    }
  });

  test('BREAK: a caret range in the manifest is a problem the checker reports', () => {
    // `manifestLockProblems` is the pure form of the W18 gate, exported so this
    // can be asserted without running the 87 MB provisioner. The pairing is
    // deliberate: `assertPinned` is a three-line wrapper over it, so there is one
    // implementation and one thing to break.
    const caret = { ...manifest, dependencies: { ...manifest.dependencies, 'groq-sdk': '^0.9.0' } };
    const problems = manifestLockProblems(caret, lock);
    expect(problems.join('\n')).toContain('not pinned');
    expect(problems.join('\n')).toContain('groq-sdk: ^0.9.0');
    // …and the real pair produces none.
    expect(manifestLockProblems(manifest, lock)).toEqual([]);
  });

  test('BREAK: a missing lock is a problem, and it is the ONLY one reported', () => {
    // Returning early here matters: with no lock there is nothing to compare, and
    // emitting "the lock disagrees with the manifest" on top of "there is no lock"
    // sends the operator to regenerate something that does not exist.
    const problems = manifestLockProblems(manifest, null);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('no committed lockfile');
  });

  test('BREAK: a lock whose root version disagrees is a problem', () => {
    const bumped = { ...lock, version: '0.0.1' };
    expect(manifestLockProblems(manifest, bumped).join('\n')).toContain('npm ci would fail on the root version');
  });

  test('BREAK: a lock with no root package entry is a problem', () => {
    const empty = { ...lock, packages: {} };
    expect(manifestLockProblems(manifest, empty).join('\n')).toContain('no root package entry');
  });

  test('BREAK: an unpinned manifest AND a disagreeing lock report BOTH', () => {
    const caret = { ...manifest, dependencies: { ...manifest.dependencies, zod: '~3.25.0' } };
    const wrongLock = { ...lock, packages: { ...lock.packages, '': { ...lock.packages[''], dependencies: { zod: '3.24.1' } } } };
    const problems = manifestLockProblems(caret, wrongLock);
    expect(problems.length).toBe(2);
    expect(problems.join('\n')).toContain('not pinned');
    expect(problems.join('\n')).toContain('disagrees with the manifest');
  });

  test('provision-sidecar.mjs uses `npm ci`, not `npm install`', () => {
    // `npm install` re-resolves ranges against the registry, which is the defect.
    const src = readFileSync(resolve('scripts/provision-sidecar.mjs'), 'utf8');
    expect(src).toMatch(/'ci'/);
    expect(src).not.toMatch(/npm'\s*,\s*\['install'/);
  });

  test('build:tauri provisions first — the W16 DoD, in the npm manifest', () => {
    // W16's cause: `provision-sidecar.mjs` was called from one place and from no
    // npm script, so `build:tauri` shipped whatever was on disk.
    const desktop = JSON.parse(readFileSync(resolve('apps/desktop/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(desktop.scripts['prebuild:tauri']).toBeDefined();
    expect(desktop.scripts['prebuild:tauri']).toContain('provision-sidecar.mjs');
    // npm runs `pre<script>` automatically, so `build:tauri` cannot skip it.
    expect(desktop.scripts['build:tauri']).toBe('tauri build');
  });

  test('BREAK: the payload node.exe must EXIST, be non-trivial, and RUN', () => {
  // The three conditions, each proven independently. A single "node.exe looks
  // fine" assertion would pass on a zero-byte file and on a 3 MB block of 0x41.
  //
  // The `run` probe is INJECTED throughout, and the real binary is exercised once
  // in its own test below. Copying an 87 MB `node.exe` into a temp dir per case
  // is what made this test time out at 11 s, and it tested nothing the injection
  // does not: the interesting variables are the FILE's size and the run's outcome.
  const dir = scratch();
  try {
    const nx = join(dir, 'node.exe');
    const never = () => { throw new Error('the run probe must not be reached'); };

    // 1. absent
    expect(nodeExeProblem(nx, process.version, never)).toContain('absent');

    // 2. present but truncated — existsSync is TRUE here, which is the gap a
    // presence-only check would leave open. The probe must NOT be reached, so the
    // rejection is attributable to the size floor alone.
    writeFileSync(nx, '', 'utf8');
    expect(existsSync(nx)).toBe(true);
    expect(nodeExeProblem(nx, process.version, never)).toContain('below the');

    // 3. large enough to clear the floor but not runnable.
    writeFileSync(nx, Buffer.alloc(3 * 1024 * 1024, 0x41));
    expect(statSync(nx).size).toBeGreaterThan(1024 * 1024);
    expect(nodeExeProblem(nx, process.version, never)).toContain('did not run');
    expect(nodeExeProblem(nx, process.version)).toContain('did not run'); // real spawn

    // 4. runs, reports the expected version → accepted. Reports the wrong one →
    // rejected by name, which is a different failure from "did not run".
    expect(nodeExeProblem(nx, process.version, () => ` ${process.version} `)).toBeNull();
    expect(nodeExeProblem(nx, 'v0.0.0-mismatch', () => 'v25.0.0')).toContain('this interpreter is');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

  test('BREAK: the run probe fires independently of the size floor', () => {
  // A file that clears the 1 MiB floor comfortably and still cannot start is the
  // case a size-only check waves through. The two rejections are independent, and
  // this proves the second exists by name rather than by elimination.
  const dir = scratch();
  try {
    const nx = join(dir, 'node.exe');
    writeFileSync(nx, Buffer.alloc(2 * 1024 * 1024, 0x41));
    expect(statSync(nx).size).toBeGreaterThan(1024 * 1024);

    // Real spawn of 2 MB of 0x41.
    expect(nodeExeProblem(nx, process.version)).toContain('did not run');

    // The injection is the FILE, not the spawn: stub the run to succeed and report
    // the right version and the same junk file is accepted. So the rejection above
    // came from the probe, and this stub is not what caused it.
    expect(nodeExeProblem(nx, process.version, () => ` ${process.version} `)).toBeNull();

    // The probe's failure mode is distinct from a version mismatch, and the probe
    // is reached exactly once — a double-call would mean the guard retried a
    // spawn it had already been told fails.
    let calls = 0;
    expect(nodeExeProblem(nx, process.version, () => { calls += 1; throw new Error('not a valid Win32 application'); }))
      .toContain('not a valid Win32 application');
    expect(calls).toBe(1);
    expect(nodeExeProblem(nx, process.version, () => 'v1.2.3')).toContain('this interpreter is');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

  // HONEST GATE — was `if (!existsSync(nx)) return;`.
  test.runIf(existsSync(join(resolve('apps/desktop/src-tauri/sidecar'), 'node.exe')))(
    'the REAL payload node.exe passes all three checks [skipped unless `npm run sidecar:provision` has run]',
    () => {
      const nx = join(resolve('apps/desktop/src-tauri/sidecar'), 'node.exe');
      expect(nodeExeProblem(nx, process.version)).toBeNull();
    },
  );

  test('the root manifest exposes the provision and check scripts', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['sidecar:provision']).toContain('provision-sidecar.mjs');
    expect(pkg.scripts['sidecar:check']).toContain('--check');
    expect(pkg.scripts['sidecar:audit']).toContain('sidecar-payload-audit.mjs');
  });

  test('release:verify provisions AND re-checks before bundling', () => {
    // Three independently sufficient wirings were chosen deliberately: the
    // prebuild hook, the self-check inside provisioning, and this. If one is
    // removed the others still hold.
    const src = readFileSync(resolve('scripts/release-verify.mjs'), 'utf8');
    expect(src).toMatch(/run\('node', \['scripts\/provision-sidecar\.mjs'\]\)/);
    expect(src).toMatch(/run\('node', \['scripts\/provision-sidecar\.mjs', '--check'\]\)/);
    expect(src).toMatch(/does not match the dist\/ just built/);
  });
});