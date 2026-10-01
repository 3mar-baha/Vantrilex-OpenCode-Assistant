import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

// W24 — the renderer's command type against the daemon's real validator.
//
// `UiCommandSchema` is `.strict()` (`src/ipc/protocol.ts:543`), so the set of
// keys a shell may put on the wire is exactly the set the schema declares: an
// extra key is a VALIDATION FAILURE, not an ignored field, and a missing key is a
// capability the shell cannot reach. `CommandMsg` in `bridge/ws.ts` is a hand-
// written mirror of that object, and nothing in the build compared them — the
// desktop tsconfig cannot import `src/ipc/protocol.ts` (it would drag zod into
// the renderer bundle), so the two can drift with no signal at all. That is how
// `title` and `contextLimit` came to be absent.
//
// So this reads the schema as TEXT and compares the key SETS. Reading is a real
// check here for the reason `ws-output-bound.test.ts` gives: what has to hold is
// a property of a declaration in another package, and the set of keys in that
// declaration IS the property.
describe('W24 — CommandMsg is a faithful mirror of the strict UiCommandSchema', () => {
  const REPO_ROOT = (() => {
    let dir = resolve(process.cwd());
    for (let hop = 0; hop < 6; hop += 1) {
      if (existsSync(join(dir, 'src', 'ipc', 'protocol.ts')) && existsSync(join(dir, 'apps', 'desktop'))) return dir;
      dir = resolve(dir, '..');
    }
    throw new Error(`repo root not found from ${process.cwd()}`);
  })();

  /** The object literal inside `UiCommandSchema`, i.e. before `.strict()`. */
  function schemaKeys(): string[] {
    const source = readFileSync(join(REPO_ROOT, 'src', 'ipc', 'protocol.ts'), 'utf8');
    const start = source.indexOf('export const UiCommandSchema = z');
    if (start < 0) throw new Error('UiCommandSchema not found in src/ipc/protocol.ts');
    const body = /z\s*\.\s*object\(\{([\s\S]*?)\}\s*\)\s*\.\s*strict\(\)/.exec(source.slice(start))?.[1];
    if (body === undefined) throw new Error('could not isolate the UiCommandSchema object literal');
    // FOUR spaces of indentation, matching how prettier/the formatter lays this
    // literal out. Two spaces reads an empty set here, which would make the
    // `missing` assertion vacuously true — the exact "reads nothing and passes"
    // shape this repo keeps auditing for. The indentation is also what keeps the
    // `z.enum([...])` members inside `kind` from being counted as keys.
    return [...body.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1] as string).sort();
  }

  /** The declared members of `CommandMsg`, read from the type literal. */
  function commandMsgKeys(): string[] {
    const source = readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'src', 'bridge', 'ws.ts'), 'utf8');
    const start = source.indexOf('export interface CommandMsg {');
    if (start < 0) throw new Error('CommandMsg not found in apps/desktop/src/bridge/ws.ts');
    const body = /export interface CommandMsg \{([\s\S]*?)\n\}/.exec(source.slice(start))?.[1];
    if (body === undefined) throw new Error('could not isolate the CommandMsg interface body');
    return [...body.matchAll(/^ {2}readonly (\w+)\??:/gm)].map((m) => m[1] as string).sort();
  }

  test('every schema key is declared on CommandMsg, and nothing else is', () => {
    // The direction that matters. A schema key the renderer does not declare is a
    // command the shell CANNOT send — `createSession` had no way to carry a title
    // and `sessionContext` no way to carry a limit, which is W24 exactly.
    const missing = schemaKeys().filter((k) => !commandMsgKeys().includes(k));
    expect(missing, 'schema keys the renderer cannot send').toEqual([]);
    // …and the reverse: a renderer key the schema rejects under `.strict()` would
    // fail validation on EVERY command carrying it, not only the optional ones.
    const extra = commandMsgKeys().filter((k) => !schemaKeys().includes(k));
    expect(extra, 'renderer keys a .strict() schema would reject').toEqual([]);
  });

  // The two W24 fields, named individually, so a future edit that drops one of
  // them produces a readable failure rather than a diff of two sorted arrays.
  test('`title` and `contextLimit` are both declared', () => {
    const keys = commandMsgKeys();
    expect(keys, 'W24: createSession cannot carry a title without this').toContain('title');
    expect(keys, 'W24: sessionContext cannot carry a limit without this').toContain('contextLimit');
  });

  // The `kind` union is the other half of the contract, and it is checked
  // separately because a mismatch there is a command the daemon refuses with
  // `unsupported command` — a runtime failure rather than a compile failure,
  // because `CommandKind` and the zod enum are declared independently.
  test('the CommandKind union and the schema enum are the same set', () => {
    const wsSource = readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'src', 'bridge', 'ws.ts'), 'utf8');
    // Bounded by the NEXT declaration rather than by the first `;`: the union
    // carries comments that contain semicolons, so a lazy `=([\s\S]*?);` stops
    // inside a comment and yields a one-member "union" that compares unequal for
    // the wrong reason. Measured: that regex returned only `['abort']`.
    const unionStart = wsSource.indexOf('export type CommandKind =');
    const unionEnd = wsSource.indexOf('export interface CommandMsg');
    if (unionStart < 0 || unionEnd < unionStart) throw new Error('could not isolate the CommandKind union');
    const union = wsSource.slice(unionStart, unionEnd);
    const kinds = [...union.matchAll(/\|\s*'([a-zA-Z]+)'/g)].map((m) => m[1] as string).sort();
    // Non-vacuity precondition, in the same file: a regex that matched nothing
    // would make the `toEqual` below fail loudly rather than pass, so this only
    // has to prove the extraction found the union at all.
    expect(kinds.length, 'the CommandKind union must have been read').toBeGreaterThan(5);
    const protocol = readFileSync(join(REPO_ROOT, 'src', 'ipc', 'protocol.ts'), 'utf8');
    const start = protocol.indexOf('export const UiCommandSchema = z');
    const enumBody = /kind: z\s*\.\s*enum\(\[([\s\S]*?)\]\)/.exec(protocol.slice(start))?.[1] ?? '';
    const schemaKinds = [...enumBody.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1] as string).sort();
    expect(kinds).toEqual(schemaKinds);
  });
});
