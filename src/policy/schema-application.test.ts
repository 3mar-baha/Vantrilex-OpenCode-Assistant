import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// W29 (a) — THE SCHEMA-APPLICATION AUDIT.
//
// `src/ipc/protocol.ts` declares 17 `*Schema` exports. `AckFrameSchema` was
// declared, re-exported from the barrel, documented in a comment as "parsed
// nowhere" — and parsed nowhere. It was found not by reading for it but by
// DECIDING NOT TO COPY `ack`'s handling when closing `error`: copying it would
// have meant shipping a green suite over a schema that applies to nothing, which
// is the shape this repository keeps hunting.
//
// So this file makes the question mechanical: does every declared schema have
// somewhere it is APPLIED? Three states, and only three:
//
//   direct  — a production `.parse`/`.safeParse` call site exists.
//   nested  — no call site of its own, but it is REFERENCED from the declaration
//             of a `direct` schema, so the parent's parse applies its rules.
//             (`InventorySessionSchema` is only ever reached through
//             `InventoryFrameSchema.parse`; a call site of its own would be
//             redundant, not missing.)
//   ORPHAN  — neither. FAIL.
//
// WHY `src/policy/` AND NOT `scripts/`. `scripts/` holds `docs-verify.mjs` and
// `test-blindspots.mjs`, neither of which is a gate: `test:blindspots` exits 0
// deliberately and is wired into nothing. A check nothing runs is a measurement,
// and this one is a GATE — it belongs in `vitest.config.ts`'s include set, which
// is where this file is. `docs-verify-coverage.test.ts` is the same shape: a
// structural guard on a claim set, sitting in `src/policy/` because that is where
// this repo puts structural guards.
//
// WHY IT READS SOURCE TEXT INSTEAD OF IMPORTING. `protocol.ts` is re-derived from
// the tree on every run rather than read from an import list, because an audit
// that consumed the very constants it is auditing cannot notice one being
// deleted — and "UNVERIFIED is a warning" is the failure this file exists to
// prevent. It also imports no production module, so adding it moves no
// reachability figure (module counts are derived by `test:blindspots` and pinned
// in AGENTS.md).
//
// THE VACUITY RULE, APPLIED TO THIS FILE'S OWN CLAIMS. Every "all X satisfy P"
// below is paired with a non-emptiness or expected-count assertion on X, because
// `every()`/`for..of` over an empty set is vacuously true and a subject that
// silently stops matching then reports PASS. This is the THIRD occurrence of that
// pattern in this codebase (a `.rs` citation gap, then this file's predecessor's
// `every()` over a parsed anchor set, now every guard written for W29).
// ─────────────────────────────────────────────────────────────────────────────

const PROTOCOL = 'src/ipc/protocol.ts';

/**
 * The instrument: source with COMMENTS and STRING/TEMPLATE BODIES blanked to
 * spaces of equal length, so offsets and line numbers survive.
 *
 * WHY IT EXISTS, and it is not tidiness. The first version of this audit matched
 * `Name.parse` against raw source and reported a schema as applied when the only
 * occurrence was PROSE — caught by break-mutation M2, which deleted
 * `AckFrameSchema.parse(` from `buildAckFrame` and left the audit GREEN, because
 * a doc comment in the same file says "`AckFrameSchema.parse` directly gets a
 * refusal". An audit that trusts a comment about a call site is the exact shape
 * of the defect it exists to find: `protocol.ts` spent months carrying a comment
 * asserting it was "parsed nowhere" beside a schema nothing parsed.
 *
 * So the census reads CODE. Strings go too, because `'Foo.parse(1)'` is as much a
 * lie as `// Foo.parse(1)`.
 *
 * KNOWN LIMIT, STATED RATHER THAN DISCOVERED: REGEX LITERALS are not tracked, so
 * a `/Foo\.parse/` pattern in a scanned file would count as a call site. There is
 * none in `src/` today, and no `*Schema` name contains a `.`, so a regex can only
 * produce a false POSITIVE for a schema it names — the failure direction that
 * makes the audit quieter, which is why the `codeOnly` self-test below pins the
 * behaviour that is load-bearing rather than leaving it to inspection.
 *
 * BLANKING IS LENGTH- AND LINE-PRESERVING: a masked run keeps its newlines and
 * its width, so a diagnostic can still quote a line and column into the ORIGINAL
 * source. (The `sidecar-payload-audit.mjs` original collapses a comment to one
 * space; that is fine for a boolean and wrong for a report.)
 *
 * The technique (walk characters, blank comments, skip string bodies) is
 * `stripComments` from `scripts/sidecar-payload-audit.mjs`, written there for the
 * identical phantom-import bug. It is re-implemented rather than imported because
 * that script is not part of this package's type surface, and an audit should not
 * depend on a file whose owner may move.
 */
const codeOnly = (source: string): string => {
  /** Same width and same line count as `run`; every non-newline char becomes a space. */
  const mask = (run: string): string => run.replace(/[^\n]/g, ' ');
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && source[i] !== '\n') i += 1;
      out += mask(source.slice(start, i));
      continue;
    }
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      out += mask(source.slice(start, Math.min(i, n)));
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = i;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') i += 2;
        else {
          const done = source[i] === c;
          i += 1;
          if (done) break;
        }
      }
      out += mask(source.slice(start, Math.min(i, n)));
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
};

const schemaSource = codeOnly(readFileSync(PROTOCOL, 'utf8'));

/** Every production `.ts` under `src/`. Test files are excluded BY THE CLAIM. */
const productionFiles = ((): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      // A `.parse` reachable only from a test proves nothing about the producer.
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(p);
    }
  };
  walk('src');
  return out;
})();

const productionText = new Map(productionFiles.map((f) => [f.replace(/\\/g, '/'), codeOnly(readFileSync(f, 'utf8'))]));

/**
 * Subject derivation #1: the declaration form itself. `export const XSchema =`
 * at the start of a line.
 */
const DECLARED = [...schemaSource.matchAll(/^export const (\w*Schema)\b/gm)].map((m) => m[1]!);

/**
 * Subject derivation #2, INDEPENDENT of #1: every top-level `export const`
 * whose name ends in `Schema`. Two derivations of the same subject that must
 * agree is the only non-vacuous way to assert the subject is non-empty — a
 * single regex that stops matching (a reformat, a new declaration form)
 * shrinks the subject silently and every `every()` over it still passes.
 */
const DECLARED_INDEPENDENT = [...schemaSource.matchAll(/^export const (\w+)/gm)]
  .map((m) => m[1]!)
  .filter((n) => n.endsWith('Schema'));

/**
 * Split `protocol.ts` into top-level declaration blocks, each attributed to the
 * name it declares. Every declaration in this file starts at column 0 with
 * `export `, so a lookahead split on that is exact for this file's shape and is
 * what lets "referenced from the declaration of a `direct` schema" be asked
 * without a parser.
 */
const BLOCKS = new Map<string, string>();
for (const block of schemaSource.split(/(?=^export )/m)) {
  const declared = /^export (?:const|function|class|interface|type|enum)\s+(\w+)/.exec(block);
  if (declared) BLOCKS.set(declared[1]!, block);
}

interface Applied {
  readonly name: string;
  readonly state: 'direct' | 'nested';
  readonly via: readonly string[];
}

const census = ((): { applied: Applied[]; orphans: string[] } => {
  const applied: Applied[] = [];
  const orphans: string[] = [];
  const sitesOf = (name: string): string[] => {
    const re = new RegExp(`\\b${name}\\s*\\.\\s*(safeParse|parse)\\b`);
    return [...productionText.entries()].filter(([, text]) => re.test(text)).map(([file]) => file);
  };
  for (const name of DECLARED) {
    const direct = sitesOf(name);
    if (direct.length > 0) {
      applied.push({ name, state: 'direct', via: direct });
      continue;
    }
    // Transitive: named inside the declaration block of a schema that IS parsed
    // directly. `typeof X` is excluded — `z.infer<typeof X>` is a TYPE use and
    // validates nothing, so counting it would mark a schema applied on the
    // strength of a `type` alias.
    const nested = DECLARED.filter((other) => {
      if (other === name) return false;
      if (sitesOf(other).length === 0) return false;
      const block = (BLOCKS.get(other) ?? '').split(new RegExp(`typeof\\s+${name}\\b`)).join(' ');
      return new RegExp(`\\b${name}\\b`).test(block);
    });
    if (nested.length > 0) applied.push({ name, state: 'nested', via: nested });
    else orphans.push(name);
  }
  return { applied, orphans };
})();

/** The parent each nested schema is reached through. Pinned as data, see below. */
const NESTED_PARENT: Readonly<Record<string, string>> = {
  AgentEntrySchema: 'AgentFrameSchema',
  InventorySessionSchema: 'InventoryFrameSchema',
  ShellOutputOutcomeSchema: 'OutputFrameSchema',
  ShellOutputStatusSchema: 'OutputFrameSchema',
  VoicePhaseSchema: 'VoiceFrameSchema',
};

describe('W29 (a) · the audit instruments itself before it instruments the tree', () => {
  // The M2 hole, pinned. An audit whose own matcher can be satisfied by a comment
  // is an audit that reports PASS on a tree it has stopped reading, so the matcher
  // gets a test of its own rather than a reviewer's trust.
  test('codeOnly keeps the real call and drops the comment and the string that imitate it', () => {
    const fixture = [
      "const quoted = 'FooSchema.parse(1)';",
      '// FooSchema.parse(2)',
      '/* FooSchema.parse(3) */',
      'const tpl = `FooSchema.parse(9)`;',
      'FooSchema.parse(4);',
    ].join('\n');
    const cleaned = codeOnly(fixture);
    const survivors = [...cleaned.matchAll(/FooSchema\s*\.\s*(safeParse|parse)/g)].map((m) => m[0]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toBe('FooSchema.parse');
    // The survivor is the CALL, not the imitate — pinned by what follows it,
    // because a stripper that dropped the wrong one would also leave one match.
    expect(cleaned.slice(cleaned.indexOf('FooSchema.parse'))).toMatch(/^FooSchema\.parse\(4\);/);
    // Length and line count preserved, so a diagnostic can still quote a line and
    // a column into the ORIGINAL source.
    expect(cleaned.length).toBe(fixture.length);
    expect(cleaned.split('\n').length).toBe(fixture.split('\n').length);
  });

  test('codeOnly is what makes THIS audit immune to the M2 hole', () => {
    // The specific regression: `protocol.ts` documents `AckFrameSchema.parse` in
    // prose, and an audit matching raw source would still call the schema applied
    // after the call was deleted. Assert both halves against the real file.
    const raw = readFileSync(PROTOCOL, 'utf8');
    const cleaned = codeOnly(raw);
    const count = (text: string): number => [...text.matchAll(/AckFrameSchema\s*\.\s*parse\b/g)].length;
    expect(count(raw), 'the prose mention this test depends on has been reworded away').toBeGreaterThan(count(cleaned));
    expect(count(cleaned), 'protocol.ts should contain exactly one real AckFrameSchema.parse').toBe(1);
    // And it is the one inside the constructor, not a stray elsewhere.
    expect(cleaned.slice(cleaned.indexOf('export function buildAckFrame'))).toMatch(/AckFrameSchema\.parse\(/);
  });
});

describe('W29 (a) · every declared *Schema in src/ipc/protocol.ts is applied', () => {
  test('the subject is non-empty and both derivations of it agree', () => {
    // If DECLARED were empty, every assertion below would pass while checking
    // nothing at all — the vacuity trap, caught at the source.
    expect(DECLARED.length).toBeGreaterThan(0);
    expect(DECLARED.length).toBe(17);
    expect(productionFiles.length).toBeGreaterThan(50);
    expect([...DECLARED].sort()).toEqual([...DECLARED_INDEPENDENT].sort());
    // Every declared name must also have a block, or "referenced from a
    // declaration" silently degrades to "referenced from nothing".
    const missingBlock = DECLARED.filter((n) => !BLOCKS.has(n));
    expect(missingBlock, 'a declared schema has no top-level block to search').toEqual([]);
  });

  test('no schema is declared, exported and applied nowhere', () => {
    expect(census.orphans).toEqual([]);
    // Expected count, so an audit that silently stopped finding orphans cannot
    // pass by finding none.
    expect(census.orphans).toHaveLength(0);
  });

  test('the three states partition the subject — every schema is accounted for', () => {
    const named = [...census.applied.map((a) => a.name), ...census.orphans];
    expect(new Set(named).size).toBe(DECLARED.length);
    expect(named.sort()).toEqual([...DECLARED].sort());
  });

  test('every applied schema names WHY it is applied', () => {
    // `every()` needs its subject asserted first, and so does this one: a census
    // that classified nothing would leave `applied` empty and pass.
    expect(census.applied.length).toBeGreaterThan(0);
    expect(census.applied).toHaveLength(DECLARED.length);
    // `via` names FILES for a `direct` schema and PARENT SCHEMAS for a `nested`
    // one, so the two are validated differently — asserting both as files would
    // be the kind of check that passes because the list is empty.
    const direct = census.applied.filter((a) => a.state === 'direct');
    const nested = census.applied.filter((a) => a.state === 'nested');
    expect(direct.length).toBeGreaterThan(0);
    expect(nested.length).toBeGreaterThan(0);
    expect(direct.length + nested.length).toBe(census.applied.length);
    for (const entry of direct) {
      for (const via of entry.via) {
        expect(productionText.has(via), `${entry.name} claims a parse site in a file that is not in src/: ${via}`).toBe(true);
      }
    }
    for (const entry of nested) {
      for (const via of entry.via) {
        expect(DECLARED, `${entry.name} names a parent that is not a declared schema: ${via}`).toContain(via);
      }
    }
  });

  test('a `z.infer` type alias is not an application', () => {
    // The trap the transitive rule could fall into: `export type AgentEntry =
    // z.infer<typeof AgentEntrySchema>` names the schema, so a naive "is it
    // referenced anywhere" check would call it applied. It validates nothing.
    const aliasBlocks = [...BLOCKS.entries()].filter(([, block]) => /^export type\b/.test(block));
    expect(aliasBlocks.length).toBeGreaterThan(0);
    for (const [name, block] of aliasBlocks) {
      expect(new RegExp(`^export type ${name}\\b`).test(block), `${name} is not a type alias`).toBe(true);
    }
    // `UiEvent` is exactly this shape and is still `direct`, because
    // `broadcast()` parses the value as well as inferring the type.
    const uiEventBlock = BLOCKS.get('UiEvent') ?? '';
    expect(uiEventBlock).toMatch(/z\.infer<typeof UiEventSchema>/);
  });

  test('the census is the one W29 measured — the two orphans it found are now applied', () => {
    // Pinned as DATA, not as a live expectation of emptiness: `AckFrameSchema` and
    // `UiEventSchema` are the two that were declared, exported and applied
    // nowhere when this audit was written, and both are now `direct`. If a future
    // schema joins that list, this test fails with its name instead of the audit
    // going quiet.
    const direct = census.applied.filter((a) => a.state === 'direct');
    expect(direct.map((a) => a.name)).toContain('AckFrameSchema');
    expect(direct.map((a) => a.name)).toContain('UiEventSchema');
    expect(direct.filter((a) => a.name === 'AckFrameSchema')[0]?.via).toEqual(['src/ipc/protocol.ts']);
    expect(direct.filter((a) => a.name === 'UiEventSchema')[0]?.via).toEqual(['src/ipc/ui-server.ts']);
    // The nested set is exactly the five schemas reachable only through a parent,
    // and each must name that parent. This is the state a careless audit would
    // call five more orphans.
    const nested = census.applied.filter((a) => a.state === 'nested');
    expect(nested.length).toBeGreaterThan(0);
    expect(nested.map((a) => a.name).sort()).toEqual(Object.keys(NESTED_PARENT).sort());
    for (const entry of nested) {
      expect(entry.via, `${entry.name} names no parsed parent`).toContain(NESTED_PARENT[entry.name]!);
    }
  });
});
