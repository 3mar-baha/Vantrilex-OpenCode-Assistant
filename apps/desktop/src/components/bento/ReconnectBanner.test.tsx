import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  INITIAL_RECONNECT,
  RECONNECT_DETAIL_AR,
  ReconnectBanner,
  actionsBlocked,
  reconnectReducer,
  type ReconnectState,
} from './ReconnectBanner.js';
import { auditBento, formatViolations, BENTO_BASE_WIDTH_PX } from './layoutBudget.js';

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

const banner = (state: ReconnectState, onDismiss: () => void = () => undefined): HTMLElement =>
  render(<ReconnectBanner state={state} onDismiss={onDismiss} />);

const dropped = (episode: number): ReconnectState => reconnectReducer(INITIAL_RECONNECT, { kind: 'dropped', episode });

describe('ReconnectBanner: dismissal hides the words, never frees the actions', () => {
  // THE asymmetry that decides this component. A dismissed banner that unlocked
  // the controls would make one click turn a dead 4096 into a HUD that looks
  // healthy and fails every press.
  test('actions are blocked whenever the drop is live — dismissed or not', () => {
    const live = dropped(1);
    expect(actionsBlocked(live)).toBe(true);
    const closed = reconnectReducer(live, { kind: 'dismissed' });
    expect(closed.dismissed).toBe(true);
    expect(actionsBlocked(closed), 'dismissal must not unlock a dead port').toBe(true);
  });

  test('actions are only free once the connection is genuinely restored', () => {
    const restored = reconnectReducer(reconnectReducer(dropped(1), { kind: 'dismissed' }), { kind: 'restored' });
    expect(actionsBlocked(restored)).toBe(false);
  });

  test('the banner reports that it blocks, so a caller cannot wire it as a warning', () => {
    banner(dropped(1));
    const el = document.body.querySelector('[data-testid="reconnect-banner"]');
    expect(el?.getAttribute('data-blocks-actions')).toBe('true');
  });
});

describe('ReconnectBanner: a dismissal is scoped to its episode', () => {
  test('a repeat notification of the SAME outage does not resurrect it', () => {
    // A 15 s health probe re-notifies. If that re-armed the banner, dismissal
    // would be impossible and the ✕ would be a false affordance.
    const closed = reconnectReducer(dropped(1), { kind: 'dismissed' });
    const again = reconnectReducer(closed, { kind: 'dropped', episode: 1 });
    expect(again).toBe(closed);
    banner(again);
    expect(document.body.querySelector('[data-testid="reconnect-banner"]')).toBeNull();
  });

  test('a NEW outage re-arms it, so "close it" is not permanent', () => {
    const closed = reconnectReducer(dropped(1), { kind: 'dismissed' });
    const next = reconnectReducer(closed, { kind: 'dropped', episode: 2 });
    expect(next.dismissed).toBe(false);
    expect(actionsBlocked(next)).toBe(true);
    banner(next);
    expect(document.body.querySelector('[data-testid="reconnect-banner"]')).not.toBeNull();
  });

  test('a restore clears the episode, so the next drop is new again', () => {
    const restored = reconnectReducer(dropped(1), { kind: 'restored' });
    expect(restored).toEqual(INITIAL_RECONNECT);
    const after = reconnectReducer(restored, { kind: 'dropped', episode: 1 });
    expect(after.dismissed, 'reusing an episode number after a restore still re-arms').toBe(false);
  });

  test('a dismissal with nothing to dismiss is a no-op by identity', () => {
    // Otherwise a stray click allocates a new object and re-renders the HUD.
    const same = reconnectReducer(INITIAL_RECONNECT, { kind: 'dismissed' });
    expect(same).toBe(INITIAL_RECONNECT);
  });

  test('a dropped event for the current episode keeps the existing detail', () => {
    const withDetail = reconnectReducer(INITIAL_RECONNECT, {
      kind: 'dropped',
      episode: 1,
      detailAr: 'تعذّر الوصول إلى المنفذ ٤٠٩٦',
    });
    const repeat = reconnectReducer(withDetail, { kind: 'dropped', episode: 1 });
    expect(repeat.detailAr).toBe('تعذّر الوصول إلى المنفذ ٤٠٩٦');
  });
});

describe('ReconnectBanner: amber, and distinct from success and error', () => {
  test('it announces once, assertively, because a dead 4096 invalidates everything', () => {
    banner(dropped(1));
    const el = document.body.querySelector('[data-testid="reconnect-banner"]');
    expect(el?.getAttribute('role')).toBe('alert');
    expect(el?.getAttribute('aria-live')).toBe('assertive');
  });

  test('the arm differs from success and error by hue, texture, glyph AND words', () => {
    banner(dropped(1));
    const el = document.body.querySelector('[data-testid="reconnect-banner"]');
    const cls = el?.getAttribute('class') ?? '';
    const text = el?.textContent ?? '';
    // Hue: amber, and neither of the other two semantic tokens.
    expect(cls).toContain('#fbbf24');
    expect(cls, 'must not read as success').not.toContain('#34d399');
    expect(cls, 'must not read as error').not.toContain('#f87171');
    // Texture: a dashed border survives greyscale and colour blindness.
    expect(cls).toContain('border-dashed');
    // Glyph: a link marker, not a warning triangle and not a check.
    expect(text).toContain('⇄');
    // Words.
    expect(text).toMatch(/\p{sc=Arabic}/u);
  });

  test('the default line names the port, so the cause is not a guess', () => {
    banner(dropped(1));
    const text = document.body.querySelector('[data-testid="reconnect-banner-text"]')?.textContent ?? '';
    expect(text).toBe(RECONNECT_DETAIL_AR);
    expect(text).toContain('٤٠٩٦');
  });

  test('a caller-supplied detail wins, verbatim', () => {
    // Verbatim means character for character, including odd whitespace: a
    // renderer that re-wrapped or re-worded the daemon's line would own a
    // second phrasing of the same sentence.
    const detail = 'انقطع الاتصال — جارٍ التبديل إلى نسخة احتياطية';
    render(<ReconnectBanner state={dropped(1)} onDismiss={() => undefined} detailAr={detail} />);
    const text = document.body.querySelector('[data-testid="reconnect-banner-text"]')?.textContent ?? '';
    expect(text).toBe(detail);
  });

  test('the dismiss control is a labelled button, not a bare glyph', () => {
    banner(dropped(1));
    const btn = document.body.querySelector<HTMLElement>('[data-testid="reconnect-dismiss"]');
    expect(btn?.tagName).toBe('BUTTON');
    expect(btn?.getAttribute('aria-label') ?? '').toMatch(/\p{sc=Arabic}/u);
    expect(btn?.getAttribute('title') ?? '').toMatch(/\p{sc=Arabic}/u);
  });

  test('dismissing calls back once', () => {
    let n = 0;
    banner(dropped(1), () => {
      n += 1;
    });
    act(() => {
      document.body.querySelector<HTMLElement>('[data-testid="reconnect-dismiss"]')?.click();
    });
    expect(n).toBe(1);
  });

  test('nothing renders when the connection is fine', () => {
    banner(INITIAL_RECONNECT);
    expect(document.body.querySelector('[data-testid="reconnect-banner"]')).toBeNull();
  });
});

describe('ReconnectBanner: 440 px', () => {
  test('a long Arabic detail truncates rather than widening the window', () => {
    const long = 'انقطع الاتصال بالخادم على المنفذ ٤٠٩٦ وجارٍ إعادة المحاولة تلقائياً مع_backoff_متدرّج'.repeat(3);
    const container = render(
      <ReconnectBanner state={reconnectReducer(INITIAL_RECONNECT, { kind: 'dropped', episode: 1, detailAr: long })} onDismiss={() => undefined} />,
    );
    const found = auditBento(container, BENTO_BASE_WIDTH_PX);
    expect(found, formatViolations(found, BENTO_BASE_WIDTH_PX)).toEqual([]);
  });

  test('the text element truncates and the button cannot be squeezed', () => {
    banner(dropped(1));
    const text = document.body.querySelector('[data-testid="reconnect-banner-text"]');
    const btn = document.body.querySelector('[data-testid="reconnect-dismiss"]');
    expect(text?.className).toContain('truncate');
    expect(text?.className).toContain('min-w-0');
    expect(btn?.className).toContain('shrink-0');
  });
});
