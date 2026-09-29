/**
 * Whether a label is REGISTERED as a claim in a docs-verify source file.
 *
 * EXTENSIBLE BY CONSTRUCTION, deliberately. Earlier versions of this guard pinned
 * a fixed list of registration shapes - a single-line tuple entry, a wrapped
 * multi-line entry, a string-literal call, a template-literal call - and a claim
 * added in a FIFTH shape was reported as a MISSING CLAIM. A guard that punishes
 * the codebase for growing is the wrong guard: at the call site "you added a
 * check" and "a check was deleted" are indistinguishable.
 *
 * The rule is therefore a PROPERTY of the label, not a list of spellings: a
 * claim is registered when the label appears QUOTED and in a position that BINDS
 * it to a check - followed by a comma (an array or tuple entry) or by a closing
 * paren (a call argument). Requiring the binder is what separates a registered
 * claim from a mention.
 *
 * What it must NOT do is match prose. The docs-verify header explains the tool's
 * history and names claims it once checked, and a substring search over a file
 * that talks about itself counts the talking as coverage - which is how the
 * original guard passed while a check was gone.
 *
 * It is also a SHAPE test, not a semantics test, and honestly labelled as one: it
 * cannot tell whether a registered claim derives correctly. Break-testing and
 * `docs-verify --self-test` cover that; this only proves the label is wired in.
 */
const QUOTE = "['\\\"\\`]";

export function hasClaimIn(source: string, label: string): boolean {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Quoted label, then a BINDER: comma, or a paren that closes a call argument.
  // Two accepted forms, because docs-verify genuinely uses both:
  //
  //   1. a CLOSED literal   - pass('cargo tests', a, b)
  //      ['dead modules', /x/, r.dead],
  //   2. a TEMPLATE PREFIX  - pass(`persona refs: ${label}`, a, b)
  //      where the quoted text opens a template and the label continues into an
  //      interpolation. There is no closing quote after the label, so a matcher
  //      that demands one reports a claim that plainly exists as missing.
  //
  // The opener rejects prose. The trailing rule is deliberately NEGATIVE - "not
  // a word character" - because a fixed separator list is a shape list wearing a
  // disguise, and accepting a shape nobody has written yet is the entire point.
  // The template form additionally requires an interpolation to follow. The gap
  // between the label and `${` may be a space (`persona refs: ${label}`) or
  // nothing, so it is matched as one non-word character rather than assumed.
  const closed = new RegExp(
    '(?:^|[\\s=(\\{[,])' + QUOTE + esc + QUOTE + '(?![\\w-])',
    'm',
  );
  const template = new RegExp(
    '(?:^|[\\s=(\\{[,])' + QUOTE + esc + '[^\\w]\\$\\{',
    'm',
  );
  return closed.test(source) || template.test(source);
}
