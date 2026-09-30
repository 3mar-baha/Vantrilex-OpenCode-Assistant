import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SessionBar, DEFAULT_MAX_VISIBLE_TABS } from './SessionBar.js';
import type { ChipSession } from './SessionChip.js';
import { auditBento, formatViolations, BENTO_BASE_WIDTH_PX } from '../bento/layoutBudget.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
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
  { id: 'ses_epsilon', state: 'idle' },
];

const tab = (id: string): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(`[data-testid="session-tab-${id}"]`);

describe('SessionBar: it composes the chip, it does not replace it', () => {
  test('the canonical switcher is still mounted and still owns the list', () => {
    // If this ever goes, a trimmed tab row would be the ONLY way to reach a
    // session, and the tab budget would be a silent session limit.
    render(<SessionBar sessions={sessions} activeId="ses_alpha" onSelect={() => undefined} />);
    expect(document.body.querySelector('[data-testid="session-chip"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="session-chip-trigger"]')).not.toBeNull();
  });

  test('the chip still receives the FULL list, not the trimmed one', () => {
    render(<SessionBar sessions={sessions} activeId="ses_alpha" onSelect={() => undefined} maxVisibleTabs={1} />);
    act(() => {
      document.body.querySelector<HTMLElement>('[data-testid="session-chip-trigger"]')?.click();
    });
    // All five are reachable through the dropdown, including the four not tabbed.
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(sessions.length);
  });

  test('it consumes ChipSession, so a session is one object with one identity', () => {
    // Compile-time claim: this file will not build if the two drift apart.
    const one: ChipSession = { id: 'ses_x', state: 'running' };
    render(<SessionBar sessions={[one]} activeId="ses_x" onSelect={() => undefined} />);
    expect(tab('ses_x'), 'the active session is named, not tabbed').toBeNull();
  });
});

describe('SessionBar: the active session is named, the others are tabs', () => {
  test('the current session is shown by name', () => {
    render(<SessionBar sessions={sessions} activeId="ses_alpha" onSelect={() => undefined} />);
    expect(document.body.querySelector('[data-testid="session-bar-current"]')?.textContent).toBe('ses_alpha');
  });

  test('the active session gets NO tab — a tab for it would be a no-op control', () => {
    render(<SessionBar sessions={sessions} activeId="ses_alpha" onSelect={() => undefined} />);
    expect(tab('ses_alpha')).toBeNull();
    expect(tab('ses_beta')).not.toBeNull();
  });

  test('a tab is a real control and reports its id', () => {
    const picked: string[] = [];
    render(<SessionBar sessions={sessions} activeId="ses_alpha" onSelect={(id) => picked.push(id)} />);
    const b = tab('ses_beta');
    expect(b?.getAttribute('role')).toBe('tab');
    act(() => {
      b?.click();
    });
    expect(picked).toEqual(['ses_beta']);
  });

  test('every tab carries an Arabic tooltip naming the session', () => {
    render(<SessionBar sessions={sessions} activeId="ses_alpha" onSelect={() => undefined} />);
    const title = tab('ses_beta')?.getAttribute('title') ?? '';
    expect(title).toMatch(/\p{sc=Arabic}/u);
    expect(title).toContain('ses_beta');
  });

  test('a session id that is not in the list does not fabricate a tab', () => {
    render(<SessionBar sessions={sessions} activeId="ses_ghost" onSelect={() => undefined} />);
    // Named, because that is what the shell believes — but NOT invented into
    // the list, and not tabbed as if it were one of the real sessions.
    expect(document.body.querySelector('[data-testid="session-bar-current"]')?.textContent).toBe('ses_ghost');
    expect(tab('ses_ghost')).toBeNull();
    // …and the ghost did not steal a slot: the real sessions are all still
    // tabbed, subject to the normal budget.
    expect(document.body.querySelectorAll('[role="tab"]')).toHaveLength(DEFAULT_MAX_VISIBLE_TABS);
    expect(tab('ses_alpha')).not.toBeNull();
  });
});

describe('SessionBar: the trim is shown, never silent', () => {
  test('the overflow chip states how many sessions are behind it', () => {
    // The `totalSessions` lesson from `protocol.ts`: a silent trim is
    // indistinguishable from a workspace that only has a few sessions.
    // 5 sessions, one of them active and named above, leaves 4 "others"; a
    // budget of 2 tabs therefore hides exactly 2.
    expect(sessions.length - 1).toBe(4);
    render(<SessionBar sessions={sessions} activeId="ses_alpha" onSelect={() => undefined} maxVisibleTabs={2} />);
    expect(document.body.querySelectorAll('[role="tab"]')).toHaveLength(2);
    const chipEl = document.body.querySelector('[data-testid="session-tabs-overflow"]');
    expect(chipEl?.textContent).toBe('+2');
    expect(chipEl?.getAttribute('title') ?? '').toMatch(/\p{sc=Arabic}/u);
  });

  test('no overflow chip when everything fits', () => {
    render(<SessionBar sessions={sessions} activeId="ses_alpha" onSelect={() => undefined} maxVisibleTabs={9} />);
    expect(document.body.querySelector('[data-testid="session-tabs-overflow"]')).toBeNull();
  });

  test('a zero budget is safe, and still shows the overflow chip', () => {
    render(<SessionBar sessions={sessions} activeId="ses_alpha" onSelect={() => undefined} maxVisibleTabs={0} />);
    expect(document.body.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(document.body.querySelector('[data-testid="session-tabs-overflow"]')?.textContent).toBe('+4');
  });

  test('a negative budget is clamped, not sliced into nonsense', () => {
    // `slice(0, -1)` would silently drop from the END and show the wrong set.
    render(<SessionBar sessions={sessions} activeId="ses_alpha" onSelect={() => undefined} maxVisibleTabs={-2} />);
    expect(document.body.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });

  test('the default budget is the documented one', () => {
    expect(DEFAULT_MAX_VISIBLE_TABS).toBe(3);
  });
});

describe('SessionBar: 440 px', () => {
  test('twelve long session ids stay inside the width budget', () => {
    const many: readonly ChipSession[] = Array.from({ length: 12 }, (_, i) => ({
      id: `ses_${'معرف_طويل_'.repeat(6)}${i}`,
      state: 'running',
    }));
    const container = render(<SessionBar sessions={many} activeId={many[0]?.id ?? null} onSelect={() => undefined} />);
    const found = auditBento(container, BENTO_BASE_WIDTH_PX);
    expect(found, formatViolations(found, BENTO_BASE_WIDTH_PX)).toEqual([]);
  });

  test('the tab row scrolls sideways instead of wrapping into window height', () => {
    // Vertical growth is the same defect on the other axis, and the window now
    // has a 600 px floor that an unbounded column would fight.
    render(<SessionBar sessions={sessions} activeId="ses_alpha" onSelect={() => undefined} />);
    const row = document.body.querySelector('[data-testid="session-tabs"]');
    expect(row?.className).toContain('overflow-x-auto');
    expect(row?.className).toContain('min-w-0');
  });

  test('the current-session label truncates rather than pushing the row', () => {
    const long = `ses_${'ا'.repeat(200)}`;
    render(<SessionBar sessions={[{ id: long, state: 'running' }]} activeId={long} onSelect={() => undefined} />);
    const label = document.body.querySelector('[data-testid="session-bar-current"]');
    expect(label?.className).toContain('truncate');
    expect(label?.className).toContain('min-w-0');
  });

  test('an individual tab is capped, so one long id cannot own the whole row', () => {
    const long = `ses_${'ب'.repeat(200)}`;
    render(<SessionBar sessions={[{ id: 'ses_a', state: 'idle' }, { id: long, state: 'idle' }]} activeId="ses_a" onSelect={() => undefined} />);
    const t = tab(long);
    expect(t?.className).toContain('max-w-[140px]');
    expect(t?.className).toContain('truncate');
    // 140 px is a CEILING, so the width audit must not flag it as a violation.
    expect(auditBento(document.body, BENTO_BASE_WIDTH_PX)).toEqual([]);
  });
});
