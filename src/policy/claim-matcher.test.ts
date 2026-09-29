import { describe, expect, test } from 'vitest';
import { hasClaimIn } from './claim-matcher.js';

// The claim matcher's own tests. It was rewritten from a four-shape list to a
// shape test, and a shape test needs behavioural cases — including the shapes it
// does not know about yet, which is the entire reason for the rewrite.
//
// The two failures that forced the design are recorded here because both are
// tempting to "fix" by narrowing again:
//   - a template literal, pass(`persona refs: ${label}`, ...), has NO closing
//     quote after the label, so a matcher that requires one reports a claim that
//     plainly exists as missing;
//   - an object key, register({ 'new claim': fn }), is followed by `:`, so a
//     binder list of `[\s,)]` rejects it.
//
// Both were found by running cases rather than by reading the pattern.

const SRC = "  ['dead modules', /x/, reach.dead],";

describe('hasClaimIn', () => {
  test('a single-line tuple entry is a claim', () => {
    expect(hasClaimIn(SRC, 'dead modules')).toBe(true);
  });

  test('a wrapped multi-line entry is a claim', () => {
    // Prettier wraps the entries whose regex is long, so the label lands on the
    // line after the bracket. Requiring the two to be adjacent reported these as
    // absent - the second time that assumption cost a real check.
    expect(hasClaimIn("  [\n    'earcon pitch constants',\n    /x/,\n  ],", 'earcon pitch constants')).toBe(true);
  });

  test('a string-literal call is a claim', () => {
    expect(hasClaimIn("  pass('cargo tests', a, b);", 'cargo tests')).toBe(true);
  });

  test('a double-quoted call is a claim', () => {
    expect(hasClaimIn('  fail("live modules", a, b);', 'live modules')).toBe(true);
  });

  test('a template-literal PREFIX is a claim', () => {
    // The case that forced the rewrite. The label is followed by ` ${label}` —
    // there is no closing quote, so demanding one makes a real claim vanish.
    expect(hasClaimIn('  pass(`persona refs: ${label}`, a, b)', 'persona refs:')).toBe(true);
  });

  test('shapes nobody has written yet are accepted', () => {
    // The reason the matcher is a shape test. If this file has to be edited to
    // add a shape, the guard is a shape list again.
    expect(hasClaimIn("  register({ 'new claim': derive });", 'new claim')).toBe(true);
    expect(hasClaimIn("  checks.set('brand new', fn);", 'brand new')).toBe(true);
    expect(hasClaimIn('  add("future thing", 1);', 'future thing')).toBe(true);
  });

  test('a prose mention is NOT a claim', () => {
    // The false positive that let the first guard pass while a check was gone.
    expect(hasClaimIn('// AGENTS.md claimed "0 dead modules" when 7 were dead', 'dead modules')).toBe(false);
    expect(hasClaimIn('// docs:verify checks dead modules every run', 'dead modules')).toBe(false);
  });

  test('an absent label is not a claim', () => {
    expect(hasClaimIn(SRC, 'a label nobody registered')).toBe(false);
  });

  test('a label that merely starts the same is not a claim', () => {
    // Prefix discipline: `dead modules` must not match inside `dead modulesX`.
    expect(hasClaimIn("  ['dead modulesX', /x/],", 'dead modules')).toBe(false);
  });

  test('regex metacharacters in a label are escaped, not interpreted', () => {
    // A label containing a dot must not match an arbitrary character. Without the
    // escape `a.c` would match `abc`, and the guard would be satisfiable by an
    // unrelated claim.
    expect(hasClaimIn("  ['abc', /x/],", 'a.c')).toBe(false);
    expect(hasClaimIn("  ['a.c', /x/],", 'a.c')).toBe(true);
  });
});
