import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, test } from 'vitest';
import { TaskCards, TASK_GLYPH } from './TaskCards.js';
import { TASK_CHIP_CLASS, TASK_LABEL_AR, TASK_STATES, taskCardsFromInventory, queuedCard, type TaskCard } from '../../matrix/task-state.js';
import { auditBento, formatViolations, BENTO_BASE_WIDTH_PX } from '../bento/layoutBudget.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function cleanup(): void {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
}

function render(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
}

afterEach(cleanup);

function cardsFor(states: readonly string[]): TaskCard[] {
  return taskCardsFromInventory(
    states.map((s, i) => ({ sessionId: `ses_${i}`, state: s })),
    'ses_0',
  );
}
const chip = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[data-testid="task-chip"]');
const row = (key: string): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(`[data-task-key="${key}"]`);

describe('TaskCards: the DOM contract App already asserts', () => {
  // `App.task-cards.test.tsx` mounts the real `App` and pins every one of these
  // attributes against `TASK_CHIP_CLASS`. This component is a drop-in for that
  // JSX block, so the contract is re-asserted HERE too — a component that is
  // never wired yet would otherwise drift from the suite that will pin it.
  test('the chip keeps TASK_CHIP_CLASS byte-for-byte, so the existing suite holds', () => {
    for (const state of TASK_STATES) {
      // One tree at a time: the queries below are document-wide, so a previous
      // iteration's chip still in the body would answer for this one.
      cleanup();
      render(<TaskCards cards={[{ key: 'k', state, rawState: 'x' }]} />);
      expect(chip()?.getAttribute('class'), `chip class drifted for ${state}`).toBe(TASK_CHIP_CLASS[state]);
    }
  });

  test('rows carry the state in three machine-readable attributes', () => {
    render(<TaskCards cards={[{ key: 'ses_a', state: 'failed', rawState: 'error' }]} />);
    const el = row('ses_a');
    expect(el?.getAttribute('data-task-card')).toBe('');
    expect(el?.getAttribute('data-state')).toBe('failed');
    expect(el?.getAttribute('data-tone')).toBe('bad');
  });

  test('the row tooltip is Arabic and carries the raw wire token', () => {
    render(<TaskCards cards={[{ key: 'ses_a', state: 'done', rawState: 'succeeded' }]} />);
    const title = row('ses_a')?.getAttribute('title') ?? '';
    expect(title).toMatch(/\p{sc=Arabic}/u);
    expect(title).toContain('succeeded');
  });

  test('a card is still NOT a control — no button anywhere in the row', () => {
    render(<TaskCards cards={[{ key: 'ses_a', state: 'running', rawState: 'running' }]} />);
    expect(row('ses_a')?.querySelector('button')).toBeNull();
  });

  test('an empty strip renders nothing rather than an empty box', () => {
    render(<TaskCards cards={[]} />);
    expect(document.body.querySelector('[data-testid="task-strip"]')).toBeNull();
  });

  test('it renders what taskCardsFromInventory decides — no second mapper here', () => {
    // The end-to-end path a wiring wave will use: raw inventory rows in, the
    // same card set `App` produces today, rendered. If someone reintroduced a
    // local state mapping, the states below would stop matching the module's.
    // `ses_3` is the ACTIVE session here, which is what makes its `idle` arm
    // visible at all — a non-active `unknown` row is filtered out as history.
    const cards = taskCardsFromInventory(
      [
        { sessionId: 'ses_0', state: 'running' },
        { sessionId: 'ses_1', state: 'succeeded' },
        { sessionId: 'ses_2', state: 'error' },
        { sessionId: 'ses_3', state: 'idle' },
      ],
      'ses_3',
    );
    render(<TaskCards cards={cards} />);
    const rendered = Array.from(document.body.querySelectorAll('[data-task-card]')).map(
      (el) => `${el.getAttribute('data-task-key')}=${el.getAttribute('data-state')}`,
    );
    expect(rendered).toEqual(cards.map((c) => `${c.key}=${c.state}`));
    // `idle` is the serve client's "I could not read a state" fallback, not a
    // resting session, so it must land neutral rather than green.
    expect(document.body.querySelector('[data-task-key="ses_3"]')?.getAttribute('data-state')).toBe('unknown');
    expect(document.body.querySelector('[data-task-key="ses_3"]')?.getAttribute('data-tone')).toBe('neutral');
  });

  test('the overflow marker is visible, so a trim is never silent', () => {
    render(<TaskCards cards={[{ key: 'overflow', state: 'unknown', rawState: '', count: 3 }]} />);
    const el = row('overflow');
    expect(el?.textContent ?? '').toContain('3');
    expect(el?.getAttribute('data-state')).toBe('unknown');
  });
});

describe('TaskCards: state is legible with colour removed entirely', () => {
  // THE requirement: colour-only state is unreadable to a red-green colourblind
  // reader and illegible at 440 px. So this does not check that colour exists —
  // it STRIPS every colour declaration from the rendered chip and asserts the
  // state is still fully determinable. If someone removes the Arabic word or the
  // glyph, this fails; if they only change a colour, it cannot.
  test('with all colour tokens deleted, every arm is still readable', () => {
    for (const state of TASK_STATES) {
      cleanup();
      render(<TaskCards cards={[{ key: 'ses_a', state, rawState: 'x' }]} />);
      const c = chip();
      expect(c, `no chip for ${state}`).not.toBeNull();

      // Remove every class that could carry a colour: hex, rgb/hsl, and the
      // `text-`/`bg-`/`border-` families.
      const stripped = (c?.getAttribute('class') ?? '')
        .split(/\s+/)
        .filter((t) => t.length > 0 && !/#[0-9a-fA-F]{3,8}/.test(t) && !/^(?:text|bg|border)-/.test(t))
        .join(' ');
      c?.setAttribute('class', stripped);

      // 1. the word, 2. the glyph, 3. the machine attribute.
      expect(c?.textContent ?? '', `no Arabic word for ${state}`).toContain(TASK_LABEL_AR[state]);
      expect(c?.textContent ?? '', `no glyph for ${state}`).toContain(TASK_GLYPH[state]);
      expect(row('ses_a')?.getAttribute('data-state')).toBe(state);
      // And the glyph survived the strip, i.e. it is content and not a class.
      expect(TASK_GLYPH[state].length).toBeGreaterThan(0);
    }
  });

  test('the glyphs are distinct per arm, so none is a colour-only twin', () => {
    const glyphs = TASK_STATES.map((s) => TASK_GLYPH[s]);
    expect(new Set(glyphs).size, `two arms share a glyph: ${glyphs.join(' ')}`).toBe(TASK_STATES.length);
  });

  test('the two failure-ish and the two unknown-ish arms differ by SILHOUETTE', () => {
    // `✕` and `?` must not be fills of the same disc, or they would be
    // distinguishable only by hue.
    const discs = ['○', '◐', '●'];
    for (const g of [TASK_GLYPH.failed, TASK_GLYPH.unknown]) {
      expect(discs, `${g} is a disc, so it needs colour to stand out`).not.toContain(g);
    }
  });

  test('the glyph is hidden from screen readers — the Arabic word is the name', () => {
    render(<TaskCards cards={[{ key: 'ses_a', state: 'queued', rawState: '' }]} />);
    const glyphEl = chip()?.querySelector('[aria-hidden="true"]');
    expect(glyphEl?.textContent).toBe(TASK_GLYPH.queued);
  });
});

describe('TaskCards: 440 px', () => {
  /**
   * `queuedCard` returns `null` for a blank transcript by design, so it cannot
   * be dropped straight into a `TaskCard[]`. Asserting the precondition beats a
   * non-null assertion: if the mapping ever stops producing a card, this fails
   * with a reason instead of rendering `null` into a card list.
   */
  function receipt(transcript: string): TaskCard {
    const card = queuedCard(transcript);
    if (card === null) throw new Error('precondition: a non-empty transcript must yield a card');
    return card;
  }

  test('a 90-character Arabic transcript does not break the width budget', () => {
    // The named defect: a long Arabic string in a flex row with no `min-w-0`
    // pushes the window wider, and is invisible in happy-dom's 0×0 layout.
    const long = 'شغّل الفحص الشامل على المستودع المحلي مع تحديث الفهرس ثم أعد تشغيل خدمة المنفذ ٤٠٩٦';
    expect(long.length).toBeGreaterThan(80);
    const container = render(<TaskCards cards={[receipt(long)]} />);
    const found = auditBento(container, BENTO_BASE_WIDTH_PX);
    expect(found, formatViolations(found, BENTO_BASE_WIDTH_PX)).toEqual([]);
  });

  test('the label element carries the containment classes, not just the audit', () => {
    render(<TaskCards cards={[receipt('نص طويل جدا '.repeat(12))]} />);
    const label = row('local')?.querySelector('span');
    expect(label?.className).toContain('truncate');
    expect(label?.className).toContain('min-w-0');
  });

  test('a full inventory nests every row inside the bounded scroll container', () => {
    // The structural check, because a class name cannot fake it: a strip that
    // rendered the rows as SIBLINGS of the scroll box would pass the class
    // assertions and still grow the column. `cardsFor` builds a real overflow
    // set-up (12 running sessions, more than the 88 px box shows) rather than
    // a hand-made card list.
    const container = render(<TaskCards cards={cardsFor(Array(12).fill('running'))} />);
    const strip = document.body.querySelector('[data-testid="task-strip"]');
    const rows = Array.from(document.body.querySelectorAll('[data-task-card]'));
    expect(rows.length, 'precondition: the overflow set-up is real').toBeGreaterThan(3);
    for (const r of rows) {
      expect(strip?.contains(r), 'every row is inside the bounded container').toBe(true);
    }
    // And the whole strip still fits the width budget at 440 px.
    expect(auditBento(container, BENTO_BASE_WIDTH_PX)).toEqual([]);
  });
});
