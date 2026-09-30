// The 440 px budget, as an instrument rather than a comment.
//
// ── WHY A STATIC AUDIT AND NOT A MEASUREMENT ─────────────────────────────────
//
// The brief asks for "a test that renders each component at 440 px and asserts
// no horizontal overflow". The honest version of that test cannot be a
// measurement, and writing one anyway would be the worst kind of lie: a test
// that cannot fail. happy-dom has no layout engine — `scrollWidth`,
// `clientWidth` and `getBoundingClientRect()` are all 0 for every element — so
// `expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth)` compares 0 to 0,
// passes forever, and proves nothing. A *real* measurement needs a real
// browser at a real 440 px viewport, which is Playwright's job (owned by
// another wave; `apps/desktop/e2e/`).
//
// So this module audits the two things that ACTUALLY cause horizontal overflow
// in this component set, both of which are decidable from the rendered DOM:
//
//   1. AN AUTHORED WIDTH OVER BUDGET — a `w-[480px]` or `min-w-[500px]` on any
//      node. That is a hard overflow by construction, regardless of viewport.
//   2. AN UNCONTAINED LONG TEXT NODE — Arabic prose that can out-run 440 px
//      with nothing to clip, wrap or scroll it. This is the mechanism the
//      brief names ("long Arabic strings must truncate, not overflow"), and it
//      is the one that actually bites: a 90-character task title in a flex row
//      with no `min-w-0` pushes the window wider on a real machine and is
//      invisible in happy-dom.
//
// Both are decidable statically, both fail for the right reason, and both are
// real defects in this repo's history rather than hypotheticals. The
// instrument is itself unit-tested against a known-bad fixture in
// `layoutBudget.test.ts` — an audit that cannot detect an overflow is worse
// than no audit, because it is read as coverage.
//
// WHAT IT DOES NOT COVER, stated rather than implied: it cannot see an
// intrinsic-width table, an unbreakable Latin token inside a wrapping box, a
// negative margin, or a CSS custom property that resolves to a width. It is a
// guard on the two dominant mechanisms, not a layout engine.

/**
 * The base window width, in CSS px. Mirrors `width` / `minWidth` in
 * `src-tauri/tauri.conf.json`, which are documented as LOGICAL pixels — the
 * same unit this audit works in, so the two are directly comparable.
 */
export const BENTO_BASE_WIDTH_PX = 440;

/** The base/minimum window height. Same source, same unit. */
export const BENTO_BASE_HEIGHT_PX = 600;

/**
 * A text node longer than this is assumed able to out-run 440 px and so is
 * required to be contained. Set well clear of the shortest labels in the HUD
 * ("الجلسة النشطة", "Voxaura", "جارٍ التنفيذ") so an ordinary short static
 * label never trips it — the audit is for the length that actually overflows,
 * not for text being text.
 */
export const LONG_TEXT_CHARS = 40;

/** One finding. `node` is kept for the message, never for control flow. */
export interface BudgetViolation {
  readonly kind: 'authored-width' | 'min-width' | 'uncontained-text';
  /** The offending declaration or a short excerpt of the text. */
  readonly detail: string;
  /** The element's tag, lowercase, for a readable failure. */
  readonly tag: string;
  /** Best-effort identifying attribute, e.g. a `data-testid`. */
  readonly marker: string;
}

/**
 * Classes that make a box SAFE at 440 px: it clips, it wraps, or it scrolls.
 *
 * `max-w-[900px]` is deliberately absent from the width audit below but present
 * here, because a max-width is a CEILING, not a floor: it never forces a box
 * past 440. That asymmetry is why `max-w` over budget is not a violation while
 * `w-` and `min-w-` over budget are.
 */
const CONTAINMENT_RE = /(?:^|\s)(?:truncate|break-words|break-all|break-normal|overflow-hidden|overflow-x-auto|overflow-x-hidden|overflow-auto|whitespace-pre-wrap)(?:$|\s)/;

/** True when a class list clips, wraps or scrolls its content. */
export function isWidthContained(className: string): boolean {
  return CONTAINMENT_RE.test(className);
}

/**
 * The px width an arbitrary-value Tailwind class pins, or `null`.
 *
 * Only `w-[Npx]` and `min-w-[Npx]` are returned, and only for the `px` unit:
 * `w-[100%]` and `w-[20rem]` are viewport-relative or unknown here, so the
 * audit abstains rather than guessing. `w-full` and `w-1/2` are unaffected.
 */
export function declaredWidthPx(className: string): { readonly value: number; readonly property: 'width' | 'min-width' } | null {
  const match = /(?:^|\s)(min-)?w-\[(\d+)px\](?=$|\s)/.exec(className);
  if (match === null) return null;
  const raw = match[2];
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return null;
  return { value, property: match[1] === undefined ? 'width' : 'min-width' };
}

/** A stable, short identity for a node, so failures name something. */
function markerFor(el: Element): string {
  const testid = el.getAttribute('data-testid');
  if (testid !== null) return `[data-testid="${testid}"]`;
  const taskKey = el.getAttribute('data-task-key');
  if (taskKey !== null) return `[data-task-key="${taskKey}"]`;
  return el.tagName.toLowerCase();
}

/** Every element in the subtree, including `root` itself. */
function walk(root: Element): Element[] {
  return [root, ...Array.from(root.querySelectorAll('*'))];
}

/**
 * An inline px width or min-width on the element, or `null`.
 *
 * Only the inline `style` attribute is read. A stylesheet rule is out of reach
 * from happy-dom without a cascade engine, which is the honest limit of the
 * instrument rather than an oversight.
 */
function inlineWidthPx(el: Element): { readonly value: number; readonly property: 'width' | 'min-width' } | null {
  if (!(el instanceof HTMLElement)) return null;
  const style = el.style;
  if (style === undefined || typeof style.width !== 'string') return null;
  const read = (value: string, property: 'width' | 'min-width'): { readonly value: number; readonly property: 'width' | 'min-width' } | null => {
    const m = /^(\d+)px$/.exec(value.trim());
    if (m === null || m[1] === undefined) return null;
    return { value: Number.parseInt(m[1], 10), property };
  };
  return read(style.width, 'width') ?? read(style.minWidth, 'min-width');
}

/**
 * Audit a rendered subtree against the width budget.
 *
 * @param budget the px width nothing may exceed. Defaults to the base window.
 * @returns one entry per violation; empty means clean. Deliberately a LIST, not
 *   a boolean, so a failure names every offender instead of only the first.
 */
export function auditWidthBudget(root: Element, budget: number = BENTO_BASE_WIDTH_PX): BudgetViolation[] {
  const found: BudgetViolation[] = [];
  for (const el of walk(root)) {
    const className = el.getAttribute('class') ?? '';
    for (const declared of [declaredWidthPx(className), inlineWidthPx(el)]) {
      if (declared === null) continue;
      if (declared.value <= budget) continue;
      found.push({
        kind: declared.property === 'width' ? 'authored-width' : 'min-width',
        detail: `${declared.property}: ${declared.value}px exceeds the ${budget}px budget`,
        tag: el.tagName.toLowerCase(),
        marker: markerFor(el),
      });
    }
  }
  return found;
}

/**
 * Audit a rendered subtree for text that can out-run the budget with nothing
 * containing it.
 *
 * Scope is DELIBERATELY narrow: an element with a direct, non-blank text child
 * longer than `minChars` and no containment class. Children are audited in
 * their own right, so a long string inside a clipping parent is still reported
 * — the parent clipping is a containment decision the author made for the
 * wrong child, and hiding it here would make the audit report "fine" for a box
 * that is fine only by accident of the parent.
 */
export function auditTextContainment(
  root: Element,
  minChars: number = LONG_TEXT_CHARS,
  budget: number = BENTO_BASE_WIDTH_PX,
): BudgetViolation[] {
  void budget;
  const found: BudgetViolation[] = [];
  for (const el of walk(root)) {
    const text = directText(el);
    if (text.length <= minChars) continue;
    const className = el.getAttribute('class') ?? '';
    // An inline `white-space: pre-wrap` / `overflow-wrap` counts as containment
    // too, for the same reason the class form does.
    const inline = el instanceof HTMLElement ? el.style : undefined;
    const inlineContained =
      inline !== undefined &&
      (inline.whiteSpace === 'pre-wrap' ||
        inline.overflowWrap === 'anywhere' ||
        inline.overflowWrap === 'break-word' ||
        inline.wordBreak === 'break-all');
    if (isWidthContained(className) || inlineContained) continue;
    found.push({
      kind: 'uncontained-text',
      detail: `${text.length} chars with no truncate/break/scroll class: "${text.slice(0, 32)}…"`,
      tag: el.tagName.toLowerCase(),
      marker: markerFor(el),
    });
  }
  return found;
}

/** The concatenated DIRECT text children of an element, trimmed. */
export function directText(el: Element): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) out += node.textContent ?? '';
  }
  return out.trim();
}

/** Both audits at once — what the component suites actually call. */
export function auditBento(root: Element, budget: number = BENTO_BASE_WIDTH_PX): BudgetViolation[] {
  return [...auditWidthBudget(root, budget), ...auditTextContainment(root, LONG_TEXT_CHARS, budget)];
}

/** A failure message that names every offender. */
export function formatViolations(violations: readonly BudgetViolation[], width: number): string {
  if (violations.length === 0) return `no violations at ${width}px`;
  return violations.map((v) => `  ${v.kind} @ ${v.marker} (${v.tag}): ${v.detail}`).join('\n');
}
