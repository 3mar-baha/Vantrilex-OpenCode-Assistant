// sidecar-payload-audit.mjs — can the shipped payload actually LOAD?
//
// WHY THIS EXISTS. W19: `sidecar/dist/runtime/laya/laya-engine.js:1` statically
// imported `onnxruntime-node`, which is not in the payload. It did not crash
// only because all seven laya modules are unreachable from `cli.js` — an
// accident, not a guard. That accident is worth two lines of thought, because
// "it works" and "it is checked" are different claims:
//
//   - An UNREACHABLE module with an unresolvable import is a landmine. It is
//     invisible today and fatal the day someone wires it — the v0.6.0 shape,
//     one `import` away.
//   - A DYNAMICALLY REACHED module with an unresolvable import is a DIFFERENT
//     thing, and it can be legitimate. Measured: `dist/runtime/vad.js:2` also
//     statically imports `onnxruntime-node`, it IS reachable from `cli.js`
//     through `import('./runtime/vad.js')`, and nothing crashes because
//     `src/daemon.ts:1157` puts that import inside a promise whose `.catch`
//     returns `null`, degrading the gate to RMS. `src/policy/sidecar-safety.test.ts`
//     pins exactly that. A grep-based guard would have failed the build on
//     vad.js too, and a guard that cries wolf is a guard nobody reads.
//
// So this audit classifies by REACHABILITY, not by grep:
//
//   unreachable        + unresolvable  -> FATAL. Dead payload that explodes if wired.
//   statically reached + unresolvable  -> FATAL. The v0.6.0 shape exactly.
//   dynamically reached + unresolvable -> allowed ONLY if declared in
//                                        DYNAMIC_MISSING_OK, with the reason and
//                                        the source anchor that makes it safe.
//
// It also resolves every RELATIVE specifier, because a payload can be
// internally inconsistent in the same way (a file copied without its sibling),
// and because the freshness check that runs beside it proves the two trees
// match — which means a relative import can only break if the FILE ITSELF is
// wrong, which is exactly what must not ship.
//
// WHAT THIS IS NOT. Not a reachability report for humans; it returns a verdict
// and a list of offenders. `scripts/test-blindspots.mjs` and `scripts/docs-verify.mjs`
// already own the "which modules ship" question for the SOURCE tree. This one
// asks the narrower question the installer alone can answer: given these bytes
// on disk, does the entrypoint's module graph resolve?
//
// HOW IT PARSES. A regex over emitted JS, not a real parser — `dist/` ships no
// source maps for the audit's benefit and pulling in a parser would add a
// dependency to a repo whose whole point here is that the payload's contents
// are pinned (W18). The regex anchors on `import`/`export ... from`,
// `import(...)` and `require(...)`, and string/comment bodies are skipped so a
// prose mention of a package name in a comment cannot be read as an import.
// This was verified against the real payload: the naive version reported three
// phantom bare specifiers — "a stranger on 4097", "answered usefully",
// "we gave up" — all from doc comments, which is exactly how a guard like this
// dies.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

/**
 * Bare specifiers a DYNAMIC import may legitimately fail to resolve, each with
 * the reason and the anchor that keeps the failure non-fatal.
 *
 * Add an entry only with a comment naming (a) why the package is absent from
 * the payload and (b) the source line whose try/catch or `.catch` makes the
 * failure survivable. An entry without an anchor is a hole with a comment on
 * it.
 */
export const DYNAMIC_MISSING_OK = [
  {
    spec: 'onnxruntime-node',
    module: 'runtime/vad.js',
    // Absent: it is a NATIVE module (onnxruntime binaries) and the payload
    // carries no native addons — the whole v0.6.0 lesson. Non-fatal:
    // `src/daemon.ts:1157` calls `import('./runtime/vad.js')` INSIDE the
    // promise, so `.catch(() => null)` on the next line converts the missing
    // package into `speechGate === null` and the pipeline falls back to the RMS
    // energy gate. Pinned by `src/policy/sidecar-safety.test.ts`.
    reason: 'native module, absent by design; src/daemon.ts:1157 wraps the import in .catch(() => null)',
  },
];

/** Node builtins, with and without the `node:` prefix. `node:` needs no list. */
const BUILTIN = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os',
  'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

const isBuiltin = (s) => s.startsWith('node:') || s.startsWith('data:')
  || s.startsWith('file:') || s.startsWith('https:') || s.startsWith('http:')
  || BUILTIN.has(s);

/**
 * Blank out comments while preserving string and template bodies verbatim, so
 * an import specifier survives but a doc comment cannot invent one.
 *
 * This is the fix for the phantom-import bug described at the top of the file,
 * and it is the reason the function looks more careful than a regex deserves.
 */
function scan(src) {
  // A template body is not a string body: `${ … }` is CODE, and it may contain a
  // nested template with its own backticks. Scanning a backtick to the NEXT
  // backtick — the obvious implementation — ends the template early on
  // `` `${ "`" }` `` and then swallows the rest of the file as one long string.
  // That was silent before the inString mask existed (the text survived
  // unmangled by luck); with the mask it becomes a DROPPED import. Hence a real
  // mode stack rather than a flat loop.
  const out = [];
  // Positions of the OUTPUT that came from a string or template BODY. A
  // `${ … }` interpolation is code and is deliberately NOT marked, so an
  // `import` inside one is still an import.
  const inString = new Uint8Array(src.length);
  const emit = (s, inStr) => {
    if (inStr) for (let k = 0; k < s.length; k++) inString[out.length + k] = 1;
    for (const ch of s) out.push(ch);
  };
  let i = 0;
  const n = src.length;
  const stack = [{ mode: 'code', quote: '', brace: 0, interp: false }];
  const top = () => (stack.length > 0 ? stack[stack.length - 1] : null);

  while (i < n) {
    const t = top();
    const c = src[i];
    const c2 = src[i + 1];

    if (t.mode === 'string') {
      if (c === '\\') { emit(src.substr(i, 2), true); i += 2; continue; }
      emit(c, true);
      i++;
      if (c === t.quote) stack.pop();
      continue;
    }

    if (t.mode === 'template') {
      if (c === '\\') { emit(src.substr(i, 2), true); i += 2; continue; }
      if (c === '`') { emit(c, true); i++; stack.pop(); continue; }
      if (c === '$' && c2 === '{') {
        // Leave the template body: the interpolation is code until its `}`.
        emit(src.substr(i, 2), true);
        i += 2;
        stack.push({ mode: 'code', quote: '', brace: 0, interp: true });
        continue;
      }
      emit(c, true);
      i++;
      continue;
    }

    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') {
      i += 2;
      const close = src.indexOf('*/', i);
      if (close < 0) {
        // Unterminated block comment. Real JS would not parse this file at all,
        // but DISCARDING the remainder silently drops real imports, and a
        // dropped import is the dangerous direction for an audit: a genuinely
        // missing module would go unreported. Preserve the tail verbatim so the
        // failure is loud (it will not resolve) rather than invisible.
        emit(src.slice(i - 2), false);
        i = n;
        continue;
      }
      emit(' ', false);
      i = close + 2;
      continue;
    }
    if (c === "'" || c === '"') { emit(c, false); i++; stack.push({ mode: 'string', quote: c, brace: 0, interp: false }); continue; }
    if (c === '`') { emit(c, true); i++; stack.push({ mode: 'template', quote: '', brace: 0, interp: false }); continue; }
    if (c === '{') { t.brace++; emit(c, false); i++; continue; }
    if (c === '}') {
      // `}` closes a `${` ONLY when this frame was opened by one. In ordinary
      // top-level code a brace is just a brace; popping there empties the stack
      // and every later character throws on an undefined frame.
      if (t.interp && t.brace === 0) { emit(c, true); i++; stack.pop(); continue; }
      if (t.brace > 0) t.brace--;
      emit(c, false);
      i++;
      continue;
    }
    emit(c, false);
    i++;
  }
  return { code: out.join(''), inString };
}

/**
 * Blank out comments while preserving string and template bodies verbatim, so
 * an import specifier survives but a doc comment cannot invent one.
 *
 * `scan` additionally reports which output positions came from inside a string,
 * because `const s = "import 'phantom'"` is NOT an import while `import 'x'` is,
 * and both look identical to a regex over the stripped text. The mask makes that
 * decidable instead of heuristic.
 */
export function stripComments(src) {
  return scan(src).code;
}

/**
 * Static: `import x from 's'` / `export * from 's'` / bare `import 's'`.
 * Dynamic: `import('s')`. The two are captured separately because the verdict
 * for an unresolvable specifier depends on which one it was.
 */
const SPEC_RE = /(?:^|[\s;)(=,{])(?:import|export)\s+(?:[^'"]*?\s*from\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
/** The keyword inside a match. No /g — `.exec` here must not carry lastIndex. */
const KEYWORD_RE = /\b(?:import|export)\b/;

/** @returns {{static: string[], dynamic: string[]}} specifiers, static first. */
export function specifiersOf(source) {
  const { code, inString } = scan(source);
  const stat = [];
  const dyn = [];
  SPEC_RE.lastIndex = 0;
  let m;
  while ((m = SPEC_RE.exec(code)) !== null) {
    // The match begins with a boundary character class, so the keyword sits a few
    // characters in. If the KEYWORD is inside a string literal, the whole match
    // is text, not an import — the specifier sits in a string either way, so the
    // keyword is the only thing that can tell the two apart.
    const kw = KEYWORD_RE.exec(m[0]);
    const kwAt = m.index + (kw ? kw.index : 0);
    if (inString[kwAt] === 1) continue;
    if (m[1] !== undefined) stat.push(m[1]);
    else if (m[2] !== undefined) dyn.push(m[2]);
  }
  return { static: stat, dynamic: dyn };
}

function listJs(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listJs(p, base, out);
    else if (e.name.endsWith('.js')) out.push(p.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return out;
}

/** A bare package resolves only if the PAYLOAD carries it — never via a parent dir. */
function payloadHas(nodeModules, spec, available) {
  if (available) {
    // A scoped name must match its scope exactly; `pkg/sub` is a deep import and
    // resolves through the package's own `exports`, which is not modelled here,
    // so it is judged by its package name.
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    return available.has(name);
  }
  const p = join(nodeModules, ...spec.split('/'));
  return existsSync(join(p, 'package.json')) || existsSync(p);
}

/**
 * @param {{payloadDir: string, entrypoints?: string[]}} opts
 *   `payloadDir` is the sidecar root (the dir holding `dist/` and `node_modules/`).
 *   `entrypoints` are paths RELATIVE TO `dist/`, not to `payloadDir`. They are
 *   dist-relative on purpose: the walk starts from emitted JS and every path it
 *   produces comes out of the same `dist/` listing, so mixing the two bases
 *   would make `cli.js` unreachable from itself and report the whole payload
 *   dead. That bug is what the first run of this file did, and it is the reason
 *   the default is not `dist/cli.js`.
 *
 *   The default is BOTH production roots, not `cli.js` alone, and the second one
 *   is load-bearing. The installed app runs `node dist/cli.js serve`, and
 *   `cli.js:185` reaches the daemon through `await import('./daemon.js')` — so
 *   from `cli.js` alone, the ENTIRE daemon graph is dynamically reachable and
 *   nothing in it is statically reachable. Auditing only `cli.js` therefore
 *   understates the graph and cannot distinguish "the daemon statically pulls a
 *   native package" (fatal, v0.6.0) from "the daemon dynamically pulls one
 *   behind a .catch" (fine, vad.js). Both roots are audited.
 *
 * @param {string} [opts.distDir]
 *   The emitted `dist/` to audit. Defaults to `<payloadDir>/dist`. Pass it when
 *   auditing an assembled payload BEFORE `node_modules` exists, or when the
 *   dist tree has just been pruned in place — `node_modules` is still resolved
 *   as a sibling of `payloadDir`, so a caller holding `.../sidecar/dist` must
 *   pass `.../sidecar` as `payloadDir` too. Getting this wrong is usually a
 *   crash (`scandir` on a doubled path) and, where it is not, a wrong answer,
 *   which is worse.
 * @param {string[]} [opts.availablePackages]
 *   The set of bare specifiers that ARE installable in the payload under audit.
 *   Defaults to what actually sits in `<payloadDir>/node_modules`. Pass it
 *   explicitly to audit `dist/` BEFORE the install, using the pinned manifest's
 *   dependency names — that is the question that matters pre-install ("will the
 *   installer carry every package this code imports?"), and answering it
 *   against the ROOT `node_modules` instead would be a different and much weaker
 *   question: the root tree holds packages the payload deliberately omits, so
 *   the same audit that must flag the omission would wave it through.
 * @returns {{ok: boolean, modules: number, staticReachable: number, unreachable: string[], fatal: string[], allowed: string[]}}
 */
export function auditPayload({ payloadDir, distDir, entrypoints = ['cli.js', 'daemon.js'], availablePackages }) {
  const dist = distDir ?? join(payloadDir, 'dist');
  const nodeModules = join(payloadDir, 'node_modules');
  const available = availablePackages ? new Set(availablePackages) : null;
  const modules = listJs(dist);

  const specCache = new Map();
  const specFor = (rel) => {
    if (!specCache.has(rel)) specCache.set(rel, specifiersOf(readFileSync(join(dist, rel), 'utf8')));
    return specCache.get(rel);
  };
  const relTarget = (rel, spec) => {
    const abs = resolve(dirname(join(dist, rel)), spec).replace(/\\/g, '/');
    const base = dist.replace(/\\/g, '/');
    return abs.startsWith(`${base}/`) ? abs.slice(base.length + 1) : null;
  };

  // Two walks. `followDynamic: false` answers "must resolve at load time";
  // `true` answers "can be reached at all". They are computed separately on
  // purpose — computing one from the other is how the previous reachability
  // checker in this repo diverged (see src/policy/sidecar-safety.test.ts:61).
  const moduleSet = new Set(modules);
  // An entrypoint that does not exist is reported rather than absorbed. The walk
  // below skips non-modules, so a typo'd entrypoint would otherwise produce a
  // confident `staticReachable: 0` and a verdict of "everything is dead" —
  // technically consistent, silently catastrophic, and indistinguishable from a
  // genuinely empty graph.
  const absentEntrypoints = entrypoints.filter((e) => !moduleSet.has(e));

  const walk = (followDynamic) => {
    const seen = new Set();
    const stack = [...entrypoints];
    while (stack.length > 0) {
      const rel = stack.pop();
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (!moduleSet.has(rel)) continue;
      const { static: st, dynamic: dy } = specFor(rel);
      for (const s of st) if (s.startsWith('.')) { const t = relTarget(rel, s); if (t) stack.push(t); }
      if (followDynamic) for (const s of dy) if (s.startsWith('.')) { const t = relTarget(rel, s); if (t) stack.push(t); }
    }
    return seen;
  };

  const staticReach = walk(false);
  const anyReach = walk(true);
  const unreachable = modules.filter((m) => !anyReach.has(m)).sort();

  const fatal = [];
  const allowed = [];

  for (const rel of modules) {
    const { static: st } = specFor(rel);
    for (const spec of st) {
      if (spec.startsWith('.')) {
        const t = relTarget(rel, spec);
        if (t !== null && !existsSync(join(dist, t))) {
          fatal.push(`${rel} -> ${spec} (relative target absent from the payload)`);
        }
        continue;
      }
      if (isBuiltin(spec)) continue;
      if (payloadHas(nodeModules, spec, available)) continue;
      // Unresolvable. Reachability decides the severity.
      if (staticReach.has(rel)) {
        fatal.push(`${rel} -> ${spec} (STATICALLY reachable from dist/${entrypoints.join(',dist/')}; this is the v0.6.0 shape)`);
      } else if (anyReach.has(rel)) {
        const ok = DYNAMIC_MISSING_OK.find((d) => d.spec === spec && d.module === rel);
        if (ok) allowed.push(`${rel} -> ${spec} (${ok.reason})`);
        else fatal.push(`${rel} -> ${spec} (reachable only dynamically and NOT declared in DYNAMIC_MISSING_OK)`);
      } else {
        fatal.push(`${rel} -> ${spec} (UNREACHABLE dead payload carrying an unresolvable import — fatal the day it is wired)`);
      }
    }
  }

  for (const e of absentEntrypoints) {
    fatal.push(`entrypoint dist/${e} does not exist in the payload — the graph was walked from nothing`);
  }

  return {
    ok: fatal.length === 0,
    modules: modules.length,
    staticReachable: staticReach.size,
    absentEntrypoints,
    unreachable,
    fatal,
    allowed,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Provisioning calls this in-process; the CLI exists so a human (or CI) can
// ask the question of an existing payload without re-provisioning it, and so
// the failure is reproducible by hand.
if (process.argv[1] && process.argv[1].endsWith('sidecar-payload-audit.mjs')) {
  const root = resolve(process.argv[2] ?? '.');
  const payloadDir = existsSync(join(root, 'apps/desktop/src-tauri/sidecar/dist'))
    ? join(root, 'apps/desktop/src-tauri/sidecar')
    : root;
  if (!existsSync(join(payloadDir, 'dist'))) {
    console.error(`audit: no dist/ under ${payloadDir}`);
    process.exit(1);
  }
  const r = auditPayload({ payloadDir });
  console.log(`payload ${payloadDir}`);
  console.log(`  shipped .js modules : ${r.modules}`);
  console.log(`  statically reachable: ${r.staticReachable}`);
  console.log(`  unreachable         : ${r.unreachable.length}`);
  if (r.absentEntrypoints.length > 0) {
    console.log(`  MISSING ENTRYPOINTS : ${r.absentEntrypoints.join(', ')}`);
  }
  console.log(`  declared dynamic misses (allowed): ${r.allowed.length}`);
  for (const a of r.allowed) console.log(`    ALLOW  ${a}`);
  if (r.ok) {
    console.log('  VERDICT: OK — every statically reachable import resolves inside the payload');
    process.exit(0);
  }
  console.log(`  VERDICT: FAIL (${r.fatal.length})`);
  for (const f of r.fatal) console.log(`    FATAL  ${f}`);
  process.exit(1);
}