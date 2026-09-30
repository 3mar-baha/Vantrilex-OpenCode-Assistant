import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { BentoGrid } from './BentoGrid.js';
import { INITIAL_RECONNECT, actionsBlocked, reconnectReducer } from './ReconnectBanner.js';
import { BENTO_BASE_HEIGHT_PX, BENTO_BASE_WIDTH_PX, auditBento, formatViolations } from './layoutBudget.js';
import { taskCardsFromInventory, type TaskCard } from '../../matrix/task-state.js';
import type { ChipSession } from '../session/SessionChip.js';
import type { TerminalLine } from '../terminal/TerminalDrawer.js';

// THE 440 px SUITE. The brief's bar is "a test that renders each component at
// 440 px and asserts no horizontal overflow", and the honest caveat is stated in
// `layoutBudget.ts`: happy-dom has no layout engine, so a scrollWidth/clientWidth
// comparison is 0 ≤ 0 and proves nothing. What is asserted here instead is the
// two mechanisms that DO cause horizontal overflow in this component set, on a
// host explicitly sized to 440 px so the intent is on the record even though the
// assertion is static. The measured proof is a Playwright pass at a real
// viewport (owned by the E2E wave), and this suite is the guard that makes such
// a pass worth running.
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  // The base window width, stated on the host as well as asserted on the grid.
  host.style.width = `${BENTO_BASE_WIDTH_PX}px`;
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const sessions: readonly ChipSession[] = [
  { id: 'ses_alpha', state: 'running' },
  { id: 'ses_beta', state: 'succeeded' },
  { id: 'ses_gamma', state: 'error' },
  { id: 'ses_delta', state: 'idle' },
];

const lines: readonly TerminalLine[] = [
  { id: 'l1', text: 'شغّل npm run build', kind: 'command' },
  {
    id: 'l2',
    text: 'أخرج الفحص الشامل على المستودع المحلي مع تحديث الفهرس ثم أعد تشغيل خدمة المنفذ ٤٠٩٦',
    kind: 'output',
  },
  { id: 'l3', text: 'error TS2345: Argument of type string', kind: 'error' },
  { id: 'l4', text: 'const bundle = "' + 'A'.repeat(2000) + '";', kind: 'output' },
];

const cards: TaskCard[] = [
  ...taskCardsFromInventory(
    sessions.map((s) => ({ sessionId: s.id, state: s.state })),
    'ses_alpha',
  ),
];

interface Overrides {
  readonly sessions?: readonly ChipSession[];
  readonly taskCards?: readonly TaskCard[];
  readonly lines?: readonly TerminalLine[];
  readonly terminalOpen?: boolean;
  readonly dropped?: boolean;
}

function bento(o: Overrides = {}): HTMLElement {
  const dropped = o.dropped === true;
  return render(
    <BentoGrid
      sessions={o.sessions ?? sessions}
      activeSessionId={(o.sessions ?? sessions)[0]?.id ?? null}
      onSelectSession={() => undefined}
      taskCards={o.taskCards ?? cards}
      terminalOpen={o.terminalOpen ?? true}
      onToggleTerminal={() => undefined}
      terminalLines={o.lines ?? lines}
      reconnect={dropped ? reconnectReducer(INITIAL_RECONNECT, { kind: 'dropped', episode: 1 }) : INITIAL_RECONNECT}
      onDismissReconnect={() => undefined}
    >
      <button type="button" title="ابدأ الإيقاف">
        ابدأ
      </button>
    </BentoGrid>,
  );
}

describe('BentoGrid: 440 × 600 — no horizontal overflow', () => {
  // THE headline case: every surface present, everything populated, at the
  // base width. If this passes, each individual component is safe in
  // composition, which is the failure that is invisible until a real 440 px
  // window is opened.
  test('every surface at once, fully populated, stays inside 440 px', () => {
    const container = bento();
    const found = auditBento(container, BENTO_BASE_WIDTH_PX);
    expect(found, formatViolations(found, BENTO_BASE_WIDTH_PX)).toEqual([]);
  });

  test('the 600 px height is respected WITHOUT an unbounded column', () => {
    // The height obligation is structural, not measurable here: `min-h-0` on
    // every flex child in the chain is what permits a child to shrink below its
    // content, and a child missing it refuses and overflows the window.
    bento();
    const grid = document.body.querySelector('[data-testid="bento-grid"]');
    expect(grid?.getAttribute('data-base-height')).toBe(String(BENTO_BASE_HEIGHT_PX));
    expect(grid?.getAttribute('data-base-width')).toBe(String(BENTO_BASE_WIDTH_PX));
    for (const id of ['bento-grid', 'bento-actions', 'bento-scroll']) {
      const el = document.body.querySelector(`[data-testid="${id}"]`);
      expect(el?.className, `${id} must be able to shrink`).toContain('min-h-0');
    }
    // The scroll container is the thing that absorbs the overflow, not the
    // window frame the user never asked to resize.
    expect(document.body.querySelector('[data-testid="bento-scroll"]')?.className).toContain('overflow-y-auto');
  });

  test('nothing in the grid masks horizontal overflow with a clip', () => {
    // `overflow-x-hidden` on the root would make this suite pass by HIDING the
    // defect. If a future change needs it to go green, the layout is wrong and
    // the clip is the bug — so it is a hard failure, on purpose.
    bento();
    const grid = document.body.querySelector('[data-testid="bento-grid"]');
    expect(grid).not.toBeNull();
    expect(grid?.className).not.toContain('overflow-x-hidden');
    expect(grid?.className).toContain('min-w-0');
  });

  test('nothing pins a width larger than the budget', () => {
    // The specific, greppable failure mode: a `w-[Npx]` or `min-w-[Npx]` with
    // N > 440 anywhere in the composed tree.
    bento();
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const cls = el.getAttribute('class') ?? '';
      for (const m of cls.matchAll(/(?:^|\s)(min-)?w-\[(\d+)px\]/g)) {
        expect(Number.parseInt(m[2] ?? '0', 10), `${cls} is wider than the window`).toBeLessThanOrEqual(
          BENTO_BASE_WIDTH_PX,
        );
      }
    }
  });

  test.each([
    ['a long session history', { sessions: Array.from({ length: 12 }, (_, i) => ({ id: `ses_${'طويل_'.repeat(8)}${i}`, state: 'running' })) }],
    ['a full task inventory', { taskCards: taskCardsFromInventory(Array.from({ length: 30 }, (_, i) => ({ sessionId: `ses_${i}`, state: 'running' })), 'ses_0') }],
    ['a huge terminal log', { lines: Array.from({ length: 200 }, (_, i) => ({ id: `l${i}`, text: `سطر ${i} من المخرجات الطويلة التي قد تتجاوز عرض النافذة`, kind: 'output' as const })) }],
    ['a dropped serve connection', { dropped: true }],
    ['the terminal collapsed', { terminalOpen: false }],
  ])('%s stays inside 440 px', (_label, overrides) => {
    const container = bento(overrides as Overrides);
    const found = auditBento(container, BENTO_BASE_WIDTH_PX);
    expect(found, formatViolations(found, BENTO_BASE_WIDTH_PX)).toEqual([]);
  });

  test('an EMPTY bento — no sessions, no cards, no output — is still clean', () => {
    // The common case for most users on most days, and the one with the least
    // test pressure behind it.
    const container = bento({ sessions: [], taskCards: [], lines: [] });
    expect(auditBento(container, BENTO_BASE_WIDTH_PX)).toEqual([]);
  });
});

describe('BentoGrid: the reconnect block is a real block', () => {
  test('a live drop makes the action surface INERT, not merely dimmed', () => {
    bento({ dropped: true });
    const slot = document.body.querySelector('[data-testid="bento-actions"]');
    expect(slot?.getAttribute('data-blocked')).toBe('true');
    // `inert` is the mechanism: in a WebView2/Chromium host it removes the
    // subtree from the a11y tree AND blocks focus, pointer and click. A class
    // that only greys things out is the "merely warns" failure.
    expect(slot?.hasAttribute('inert'), 'the action surface must actually be inert').toBe(true);
    expect(slot?.querySelector('button')?.hasAttribute('inert')).toBe(false);
  });

  test('a clean connection leaves the action surface fully live', () => {
    bento();
    const slot = document.body.querySelector('[data-testid="bento-actions"]');
    expect(slot?.getAttribute('data-blocked')).toBe('false');
    expect(slot?.hasAttribute('inert')).toBe(false);
    expect(slot?.className).not.toContain('pointer-events-none');
  });

  test('the block tracks the state, not the banner — dismissing cannot unlock it', () => {
    // Render with the banner DISMISSED and the drop still live. The words are
    // gone; the controls must still be inert, because 4096 is still dead.
    const dismissed = { ...reconnectReducer(INITIAL_RECONNECT, { kind: 'dropped', episode: 1 }), dismissed: true };
    expect(actionsBlocked(dismissed)).toBe(true);
    render(
      <BentoGrid
        sessions={sessions}
        activeSessionId="ses_alpha"
        onSelectSession={() => undefined}
        taskCards={cards}
        terminalOpen
        onToggleTerminal={() => undefined}
        terminalLines={lines}
        reconnect={dismissed}
        onDismissReconnect={() => undefined}
      >
        <button type="button" title="ابدأ الإيقاف">
          ابدأ
        </button>
      </BentoGrid>,
    );
    expect(document.body.querySelector('[data-testid="reconnect-banner"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="bento-actions"]')?.hasAttribute('inert')).toBe(true);
  });
});

describe('BentoGrid: composition', () => {
  test('all four surfaces are present exactly once', () => {
    bento({ dropped: true });
    for (const id of ['session-bar', 'terminal-drawer', 'reconnect-banner', 'task-strip']) {
      expect(document.body.querySelectorAll(`[data-testid="${id}"]`), `${id} must appear once`).toHaveLength(1);
    }
  });

  test('with no cards there is no task strip — the "no strip, no height" rule survives', () => {
    // An empty in-flow box would still take a row of the HUD for every user with
    // no live work, and the column now has a 600 px floor to fight.
    bento({ taskCards: [] });
    expect(document.body.querySelector('[data-testid="task-strip"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="session-bar"]')).not.toBeNull();
  });

  test('the grid is RTL, and every surface inside it declares its own direction', () => {
    bento({ dropped: true });
    expect(document.body.querySelector('[data-testid="bento-grid"]')?.getAttribute('dir')).toBe('rtl');
    for (const id of ['session-bar', 'terminal-drawer', 'reconnect-banner', 'task-strip']) {
      expect(document.body.querySelector(`[data-testid="${id}"]`)?.getAttribute('dir'), `${id} must be RTL`).toBe('rtl');
    }
  });

  test('the action slot stays a separate element from the scrolling middle', () => {
    // The slot is what the reconnect block targets. Folding it into the scroll
    // container would make a dead 4096 block the session bar and the log too.
    bento();
    const actions = document.body.querySelector('[data-testid="bento-actions"]');
    const scroll = document.body.querySelector('[data-testid="bento-scroll"]');
    expect(scroll?.contains(actions ?? null)).toBe(false);
    expect(document.body.querySelector('[data-testid="session-bar"]')?.closest('[data-testid="bento-scroll"]')).not.toBeNull();
  });
});
