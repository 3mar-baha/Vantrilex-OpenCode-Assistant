import { describe, expect, test } from 'vitest';
import {
  BENTO_BASE_HEIGHT_PX,
  BENTO_BASE_WIDTH_PX,
  LONG_TEXT_CHARS,
  auditBento,
  auditTextContainment,
  auditWidthBudget,
  declaredWidthPx,
  directText,
  formatViolations,
  isWidthContained,
  type BudgetViolation,
} from './layoutBudget.js';

// THE POINT OF THIS FILE: `layoutBudget.ts` is an instrument, and an audit that
// cannot detect the thing it audits is worse than no audit — it is read as
// coverage. So every rule is proven against a KNOWN-BAD fixture, not only
// against the clean components. The fixtures below are the real defects: an
// oversized box, and Arabic prose with nothing to contain it.

function el(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  // happy-dom does not run scripts, so nothing here can execute; the fixture is
  // still a real DOM with real attributes, which is all the audit reads.
  const first = host.firstElementChild;
  if (!(first instanceof HTMLElement)) throw new Error('fixture must have an element');
  return first;
}

const LONG_AR =
  'طلب المستخدم تشغيل الفحص الشامل على المستودع المحلي وتحديث الفهرس مع إعادة تشغيل الخدمة';

describe('layoutBudget: the numbers', () => {
  test('the base width equals the window config minimum', () => {
    // If these drift apart the component tests are auditing a window that does
    // not exist, so the value is asserted rather than assumed. 380/380 since
    // the HUD became the square companion widget — see `layoutBudget.ts`.
    expect(BENTO_BASE_WIDTH_PX).toBe(380);
    expect(BENTO_BASE_HEIGHT_PX).toBe(380);
  });

  test('LONG_TEXT_CHARS clears the shortest real labels in the HUD', () => {
    // A threshold that trips on "جارٍ التنفيذ" would make the audit noise.
    for (const label of ['الجلسة النشطة', 'جارٍ التنفيذ', 'في الانتظار', 'فتح الطرفية']) {
      expect(label.length).toBeLessThan(LONG_TEXT_CHARS);
    }
  });
});

describe('layoutBudget: containment detection', () => {
  test.each(['truncate', 'break-words', 'break-all', 'overflow-hidden', 'overflow-x-auto', 'whitespace-pre-wrap'])(
    'treats %s as containment',
    (cls) => {
      expect(isWidthContained(`flex items-center ${cls} gap-2`)).toBe(true);
    },
  );

  test('does not mistake a substring for a class', () => {
    // `truncate` inside a longer word is not the utility, and reading it as one
    // would let an uncontained label pass.
    expect(isWidthContained('wholesale-truncated')).toBe(false);
    expect(isWidthContained('flex items-center')).toBe(false);
  });
});

describe('layoutBudget: declared widths', () => {
  test('reads an arbitrary px width, and tells width from min-width', () => {
    expect(declaredWidthPx('w-[480px]')).toEqual({ value: 480, property: 'width' });
    expect(declaredWidthPx('min-w-[500px]')).toEqual({ value: 500, property: 'min-width' });
  });

  test('abstains on non-px and fractional values rather than guessing', () => {
    expect(declaredWidthPx('w-full')).toBeNull();
    expect(declaredWidthPx('w-1/2')).toBeNull();
    expect(declaredWidthPx('w-[100%]')).toBeNull();
    expect(declaredWidthPx('max-w-[900px]')).toBeNull();
  });
});

describe('layoutBudget: the width audit detects a real overflow', () => {
  test('a KNOWN-BAD `w-[480px]` is caught', () => {
    const root = el('<div data-testid="bad"><span class="w-[480px] block">x</span></div>');
    const found = auditWidthBudget(root);
    expect(found.length, formatViolations(found, BENTO_BASE_WIDTH_PX)).toBe(1);
    expect(found[0]?.kind).toBe('authored-width');
    expect(found[0]?.marker).toBe('span');
  });

  test('a KNOWN-BAD inline width is caught', () => {
    const root = el('<div><span style="width:520px" data-testid="inline">x</span></div>');
    const found = auditWidthBudget(root);
    expect(found.length, formatViolations(found, BENTO_BASE_WIDTH_PX)).toBe(1);
    expect(found[0]?.kind).toBe('authored-width');
    expect(found[0]?.marker).toBe('[data-testid="inline"]');
  });

  test('a KNOWN-BAD min-width is caught and named as a min-width', () => {
    const root = el('<div><span class="min-w-[600px] block">x</span></div>');
    const found = auditWidthBudget(root);
    expect(found.length, formatViolations(found, BENTO_BASE_WIDTH_PX)).toBe(1);
    expect(found[0]?.kind).toBe('min-width');
  });

  test('a width exactly AT the budget is not a violation', () => {
    // Off-by-one on the boundary would either hide a real one or cry wolf.
    expect(auditWidthBudget(el(`<div><span class="w-[${BENTO_BASE_WIDTH_PX}px] block">x</span></div>`))).toHaveLength(0);
  });

  test('a ceiling over budget is NOT a violation', () => {
    // A max-width never forces a box wider than the budget, so flagging it
    // would be a false positive on a legitimate responsive utility.
    expect(auditWidthBudget(el('<div><span class="max-w-[900px] block">x</span></div>'))).toHaveLength(0);
  });
});

describe('layoutBudget: the text audit detects a real overflow', () => {
  test('a KNOWN-BAD uncontained Arabic run is caught', () => {
    const root = el(`<div><span class="text-xs">${LONG_AR}</span></div>`);
    const found = auditTextContainment(root);
    expect(found.length, formatViolations(found, BENTO_BASE_WIDTH_PX)).toBe(1);
    expect(found[0]?.kind).toBe('uncontained-text');
  });

  test('the SAME text inside a `truncate` is clean', () => {
    const root = el(`<div><span class="min-w-0 flex-1 truncate text-xs">${LONG_AR}</span></div>`);
    expect(auditTextContainment(root)).toHaveLength(0);
  });

  test('the SAME text with an inline `white-space: pre-wrap` is clean', () => {
    const root = el(`<div><span style="white-space:pre-wrap">${LONG_AR}</span></div>`);
    expect(auditTextContainment(root)).toHaveLength(0);
  });

  test('a short label is never flagged, however uncontained', () => {
    expect(auditTextContainment(el('<div><span class="text-xs">الجلسة النشطة</span></div>'))).toHaveLength(0);
  });

  test('a child is audited in its own right, not excused by a clipping parent', () => {
    // The parent clipping is a decision made about the wrong box; reporting
    // "fine" here would make the audit pass by accident of structure.
    const root = el(`<div class="truncate"><span class="text-xs">${LONG_AR}</span></div>`);
    const found = auditTextContainment(root);
    expect(found.length, formatViolations(found, BENTO_BASE_WIDTH_PX)).toBe(1);
  });
});

describe('layoutBudget: helpers', () => {
  test('directText reads only DIRECT text, so a parent is not charged for its children', () => {
    const root = el('<div><span>child text</span>tail</div>');
    expect(directText(root)).toBe('tail');
  });

  test('auditBento is the union of both audits', () => {
    const root = el(`<div><span class="w-[600px] block"><b class="text-xs">${LONG_AR}</b></span></div>`);
    const all: BudgetViolation[] = auditBento(root);
    expect(all.map((v) => v.kind).sort()).toEqual(['authored-width', 'uncontained-text']);
  });

  test('a clean subtree is clean, and the message says so', () => {
    const root = el('<div class="min-w-0 flex flex-col gap-2"><span class="truncate">ok</span></div>');
    const found = auditBento(root);
    expect(found).toEqual([]);
    expect(formatViolations(found, BENTO_BASE_WIDTH_PX)).toBe(`no violations at ${BENTO_BASE_WIDTH_PX}px`);
  });
});
