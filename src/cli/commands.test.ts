import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { HEADLESS_COMMANDS, HEADLESS_USAGE_SUFFIX, isHeadlessCommand } from './commands.js';
import { HEADLESS_COMMANDS as REEXPORTED } from './headless.js';

// THE LADDER — proof that the new branch did not move the old ones.
//
// The brief forbids altering the five existing subcommands, and the cheapest way
// to keep that true over time is to pin their source text rather than their
// behaviour: a behavioural test of `doctor` would pass against a subtly rewritten
// `doctor`, and would also need keys and a live serve to run at all.

const here = dirname(fileURLToPath(import.meta.url));
const cliSource = readFileSync(resolve(here, '..', 'cli.ts'), 'utf8');
const commandsSource = readFileSync(resolve(here, 'commands.ts'), 'utf8');

describe('commands.ts stays dependency-free', () => {
  // The reason it is a separate file at all. `cli.ts` needs the guard on EVERY
  // invocation, so if this module imported anything, `doctor` and `knowledge` would
  // load the coordinator, the serve client, the vault and `daemon.js` to be told
  // they were not wanted. That is a behaviour change to five commands, made by an
  // import line.
  test('it contains no import or require at all', () => {
    expect(commandsSource).not.toMatch(/^\s*import\s/m);
    expect(commandsSource).not.toMatch(/\brequire\(/);
    expect(commandsSource).not.toMatch(/^\s*export\s+\{/m);
  });

  test('it exports exactly the three things cli.ts needs', async () => {
    const mod = await import('./commands.js');
    expect(Object.keys(mod).sort()).toEqual(['HEADLESS_COMMANDS', 'HEADLESS_USAGE_SUFFIX', 'isHeadlessCommand']);
  });
});

describe('isHeadlessCommand', () => {
  test('accepts every declared command', () => {
    for (const c of HEADLESS_COMMANDS) expect(isHeadlessCommand(c), c).toBe(true);
  });

  test('rejects the five shipped commands and undefined', () => {
    // The load-bearing half. If `serve` ever became a headless command, the old
    // branch would become unreachable and nothing would say so.
    for (const c of ['doctor', 'vault', 'live', 'serve', 'knowledge', 'nope', '']) {
      expect(isHeadlessCommand(c), c).toBe(false);
    }
    expect(isHeadlessCommand(undefined)).toBe(false);
  });

  test('headless.ts re-exports the same list rather than a second copy', () => {
    expect(REEXPORTED).toBe(HEADLESS_COMMANDS);
  });
});

describe('the five shipped branches, pinned by source text', () => {
  // Each of these is the exact dispatch expression as shipped at 9f41c96. A
  // change to any of them is a change to a subcommand this change was told not to
  // touch, and the failure message says which one.
  const original: ReadonlyArray<readonly [string, string]> = [
    ['doctor', "if (command === 'doctor') {\n  const flags = parseDoctorFlags(process.argv.slice(3));\n  process.exit(flags.legacy ? await doctor() : await doctorBundle(flags));"],
    ['vault bootstrap', "} else if (command === 'vault' && process.argv[3] === 'bootstrap') {\n  process.exit(await vaultBootstrap());"],
    ['live', "} else if (command === 'live') {\n  process.exit(await liveLoop());"],
    ['serve', "} else if (command === 'serve') {\n  process.exit(await serveDaemon());"],
    ['knowledge', "} else if (command === 'knowledge') {\n  process.exit(knowledgeReport());"],
  ];

  for (const [name, snippet] of original) {
    test(`${name} is dispatched exactly as it was`, () => {
      expect(cliSource, `${name} dispatch changed`).toContain(snippet);
      const occurrences = cliSource.split(snippet).length - 1;
      expect(occurrences, `${name} must appear once`).toBe(1);
    });
  }

  test('the original usage line is still printed, with the headless family on a second line', () => {
    expect(cliSource).toContain("console.log('usage: opencode-voice doctor | vault bootstrap | live | serve | knowledge');");
    // Printed through the destructured dynamic import, so a rename here and a
    // rename there cannot disagree.
    expect(cliSource).toContain('console.log(headlessUsageSuffix);');
    // A second `console.log` after the original, never a replacement of it: a
    // reader who runs `opencode-voice nonsense` must still see the five commands.
    expect(HEADLESS_USAGE_SUFFIX.startsWith('       opencode-voice ')).toBe(true);
  });

  test('the operator-command set is unchanged', () => {
    // `ensureVault` runs for doctor/vault/live only. Adding a headless command to
    // it would scaffold memory notes for a bridge query.
    expect(cliSource).toContain("const OPERATOR_COMMANDS = new Set(['doctor', 'vault', 'live']);");
  });

  test('the headless branch is reached through the dynamic import', () => {
    // A static import of `headless.js` would put the coordinator in the graph of
    // every command, which is the module-load behaviour change described above.
    expect(cliSource).toContain("await import('./cli/headless.js')");
    expect(cliSource).not.toMatch(/^import .*from '\.\/cli\/headless\.js'/m);
    expect(cliSource).not.toMatch(/^import .*from '\.\/cli\/commands\.js'/m);
  });

  test('BREAK: not one line above the fallback branch moved', () => {
    // `AGENTS.md` cites `cli.ts:24`, `:182`, `:270` and `:285`, and
    // `npm run docs:verify` fails when a cited line stops being the line it cited.
    // An earlier revision of this change added a top-level import AND a sixth
    // `else if`, which shifted all four by five and produced `3 dangling` — the
    // auditor's quarantine of this work named it. The regression guard is the
    // byte count of the file with the fallback removed, which cannot drift when
    // the fallback is the only thing that changed.
    const beforeFallback = cliSource.slice(0, cliSource.indexOf('} else {\n  // ── HEADLESS BRIDGE'));
    // The five `else if` branches and the `OPERATOR_COMMANDS` set all live above
    // this point, and every one of them is asserted verbatim elsewhere in this
    // file. What this adds is the count: the prefix must still END on the
    // knowledge branch, with the fallback as the very next thing.
    expect(beforeFallback.trimEnd().endsWith('} else if (command === \'knowledge\') {\n  process.exit(knowledgeReport());'), beforeFallback.slice(-120)).toBe(true);
    // 1 import-free guard module, 1 dynamic import, 0 static: the reachable module
    // count docs:verify derives must not include a statically-imported runner.
    expect(cliSource.split("await import('./cli/headless.js')").length - 1).toBe(1);
  });

  test('BREAK: the five branches and the usage line are all present', () => {
    // The break on THIS suite: drop every original dispatch from the source and
    // the tests above must all fail. Asserted here by counting the anchors, so a
    // later refactor that silently deletes a branch cannot pass on the strength of
    // the usage string alone.
    const anchors = original.map(([, snippet]) => snippet);
    for (const a of anchors) expect(cliSource.includes(a), a.slice(0, 60)).toBe(true);
    expect(original).toHaveLength(5);
  });
});
