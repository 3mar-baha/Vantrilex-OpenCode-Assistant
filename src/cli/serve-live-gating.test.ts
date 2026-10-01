import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, test } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
//
// The live tier is `src/**/*.live.test.ts`. `vitest.config.ts` must not collect
// it and no gate script may name it, or the root total stops being a property of
// the tree and becomes a property of whether something happens to be listening
// on 127.0.0.1:4096.
//
// Measured before the split, same tree, same tree state, only the gate's inputs
// differed: 1394 passed + 1 skipped (serve up, credential resolvable) versus
// 1392 passed + 3 skipped (credential unreachable). Both exit 0. That is the
// defect — not the skip, which was honest, but the fact that the number meant
// two different things.
//
// WHAT IS DERIVED AND WHAT IS SPELLED OUT, stated plainly because a guard that
// cannot fail is worse than no guard:
//
//   DERIVED FROM DISK — the set of live files (walk `src/`), and the assertion
//     that it is non-empty. The live set is recomputed here, so a new live file
//     or a renamed one is picked up rather than missed.
//
//   DERIVED FROM package.json — that no script references the live config or the
//     opt-in variable. This is the prong with nothing to rot: the property is
//   "the live tier is unreachable from a gate", and both halves of it are read
//   out of the file that defines the gates.
//
//   SPELLED OUT — the exact negated `include` entry and the exact body of
//   `liveGate`. These are exact-string checks on one line each, not a
//   reimplementation of Vitest's glob engine: the negation is proven to work by
//   measurement (`vitest list --filesOnly` reports 87 files with it and 88
//   without), not by trusting the matcher used here.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const LIVE_SUFFIX = '.live.test.ts';
const HERMETIC_CONFIG = 'vitest.config.ts';
const LIVE_CONFIG = 'vitest.live.config.ts';
/** The human opt-in. Set by a person, or only by a live-only script. */
const LIVE_ENV_VAR = 'VOXAURA_LIVE_SERVE';
/** Substrings that identify reaching the live tier from a command line. */
const LIVE_NEEDLES = ['vitest.live.config', '.live.test'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Repo-relative, forward-slashed — the form an `include` glob is written in. */
function repoRelative(absolute: string): string {
  return relative(ROOT, absolute).split(sep).join('/');
}

const liveFiles = walk(join(ROOT, 'src'))
  .filter((f) => f.endsWith(LIVE_SUFFIX))
  .map(repoRelative)
  .sort();

const hermeticConfig = readFileSync(join(ROOT, HERMETIC_CONFIG), 'utf8');
const liveConfig = existsSync(join(ROOT, LIVE_CONFIG)) ? readFileSync(join(ROOT, LIVE_CONFIG), 'utf8') : '';
const liveSource = liveFiles.map((f) => readFileSync(join(ROOT, f), 'utf8'));
const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};

describe('the live tier is a live tier', () => {
  test('at least one live file exists on disk (fail-closed: an empty set proves nothing)', () => {
    expect(liveFiles.length, 'the live tier must not quietly become zero files').toBeGreaterThan(0);
    expect(liveFiles).toEqual(['src/cli/serve.live.test.ts']);
  });

  test('the hermetic config negates exactly the live suffix', () => {
    // Derived from the discovered suffix, so renaming the tier breaks here.
    const required = `'!src/**/*${LIVE_SUFFIX}'`;
    expect(hermeticConfig, `${HERMETIC_CONFIG} must carry ${required}`).toContain(required);
  });

  test('the live config collects the live suffix, and nothing else', () => {
    expect(existsSync(join(ROOT, LIVE_CONFIG)), `${LIVE_CONFIG} must exist`).toBe(true);
    expect(liveConfig).toContain(`'src/**/*${LIVE_SUFFIX}'`);
    // The hermetic globs must NOT be here. If they were, `--config` would be
    // pointing at the whole suite and the "second config" would be a lie.
    for (const hermeticGlob of ["'src/**/*.test.ts'", "'test/**/*.test.ts'", "'bench/**/*.bench.ts'"]) {
      expect(liveConfig, `the live config must not collect ${hermeticGlob}`).not.toContain(hermeticGlob);
    }
  });
});

describe('no gate can reach the live tier', () => {
  test('no GATE script names the live config or a live file', () => {
    // "Gate script" is derived, not guessed: a script is a gate script when
    // `test:vantrilex` runs it, directly or by name. A dedicated `test:live`
    // entry point is NOT a gate — it is the deliberate run the ruling asks for,
    // and forbidding it would make the tier runnable only by memorising a
    // command line. What must never happen is the gate chain reaching it.
    const chain = scripts['test:vantrilex'] ?? '';
    const gateScripts = Object.entries(scripts).filter(
      ([name, cmd]) => name === 'test:vantrilex' || chain.includes(`run ${name}`) || cmd.includes('vitest run') && chain.includes(name),
    );
    const offenders = gateScripts.filter(([, cmd]) => LIVE_NEEDLES.some((needle) => cmd.includes(needle)));
    expect(offenders, 'a gate script must not reach the live tier').toEqual([]);
  });

  test('the opt-in variable is set only by a live-only script', () => {
    // The opt-in is meant to be typed by a person. The single acceptable
    // exception is a script that runs the live config and NOTHING else, because
    // that is the deliberate run wearing a name. Anything that sets it and also
    // runs the hermetic suite would open the tier inside a gate.
    const setters = Object.entries(scripts).filter(([, cmd]) => cmd.includes(LIVE_ENV_VAR));
    const offenders = setters.filter(([, cmd]) => !cmd.includes('vitest.live.config') || cmd.includes('vitest.config.ts'));
    expect(offenders, `${LIVE_ENV_VAR} must be set by a person, or only by a live-only script`).toEqual([]);
    expect(Object.keys(scripts)).toContain('test');
  });

  test('and the gate chain itself does not mention the live config', () => {
    const vantrilex = scripts['test:vantrilex'] ?? '';
    expect(vantrilex).not.toContain('vitest.live.config');
    expect(vantrilex).not.toContain(LIVE_ENV_VAR);
    expect(vantrilex, 'the gate chain must still contain the hermetic root run').toContain('run test');
  });
});

describe('the live file cannot open without the opt-in', () => {
  test('liveGate is exactly the three-way AND', () => {
    // An exact-string check on a one-line function, not a glob engine. If the
    // opt-in conjunct is dropped, this goes red — verified by breaking it.
    for (const src of liveSource) {
      expect(
        src,
        'the gate must be the human opt-in AND a credential AND a live serve',
      ).toMatch(/return optedIn && hasCredential && serveHealthy;/);
    }
  });

  test('the gate is applied to the block, and the env var is what feeds it', () => {
    for (const src of liveSource) {
      expect(src, 'the opt-in must be read from the environment').toContain('process.env[LIVE_ENV_VAR]');
      expect(src, `LIVE_ENV_VAR must be ${LIVE_ENV_VAR}`).toContain(`LIVE_ENV_VAR = '${LIVE_ENV_VAR}'`);
      expect(src).toMatch(/describe\.skipIf\(!live\)\(/);
      // The skip must be driven by the composed gate, not by the raw probe.
      // `skipIf(!serveHealthy)` would re-open exactly the door this file closes.
      expect(src, 'the skip must read the composed gate').toContain('liveGate(optedIn, hasCredential, serveHealthy)');
    }
  });
});

describe('the hermetic tier kept the claim the live tier moved out of it', () => {
  test('serve.test.ts no longer probes 4096 at module scope', () => {
    const hermetic = readFileSync(join(ROOT, 'src/cli/serve.test.ts'), 'utf8');
    // The half of the defect that was invisible in a summary: a top-level
    // `await probeHealth` runs while the module is being imported, so a
    // "hermetic" suite opened a socket to 4096 and read the operator's
    // `serve.pass`. Presence of the probe is fine; presence at module scope is
    // not, and the assertion below is about the shape, not the number.
    expect(hermetic).not.toMatch(/^const liveServeUp/m);
    expect(hermetic).not.toMatch(/^await probeHealth/m);
    expect(hermetic, 'the hermetic file must not import the live probe').not.toContain('probeHealth');
    // …and the byte-identity claim it used to defer to the live tier is here,
    // modelled on a fake Response, so nothing is lost from the gate.
    expect(hermetic).toContain("'two unknown paths both read as the fallback, not as routes'");
  });
});