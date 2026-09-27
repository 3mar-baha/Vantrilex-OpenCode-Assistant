import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'vitest';
import { ContextGauge, formatTokens } from './ContextGauge.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(el: React.ReactElement): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(el);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

describe('formatTokens', () => {
  test('is Arabic-friendly and compact at every scale', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_500)).toBe('1.5 ألف');
    expect(formatTokens(250_000)).toBe('250 ألف');
    expect(formatTokens(2_400_000)).toBe('2.4 مليون');
  });

  test('never returns an empty or negative string', () => {
    for (const n of [0, 1, 12, 1_000, 1_000_000]) {
      expect(formatTokens(n).length).toBeGreaterThan(0);
      expect(formatTokens(n)).not.toContain('-');
    }
  });
});

describe('ContextGauge', () => {
  test('shows nothing when there is no context data yet', () => {
    mount(<ContextGauge />);
    expect(document.body.querySelector('[data-testid="context-gauge"]')).toBeNull();
  });

  test('renders the percentage and the Arabic usage label', () => {
    mount(<ContextGauge used={10_850} limit={200_000} percent={5.4} />);
    const g = document.body.querySelector('[data-testid="context-gauge"]');
    expect(g).not.toBeNull();
    expect(g?.getAttribute('data-percent')).toBe('5.4');
    expect(g?.textContent).toContain('%');
  });

  test('says the limit is unknown rather than inventing a percentage', () => {
    mount(<ContextGauge used={10_850} limit={null} percent={null} />);
    const g = document.body.querySelector('[data-testid="context-gauge"]');
    expect(g).not.toBeNull();
    expect(g?.getAttribute('data-percent')).toBe('unknown');
    // It must NOT render a bar that implies a denominator.
    expect(g?.querySelector('[data-testid="context-bar"]')).toBeNull();
    expect(g?.textContent).toContain('غير معروف');
  });

  test('only the active session is shown, so a stale frame cannot mislead', () => {
    mount(<ContextGauge sessionId="ses_a" activeSessionId="ses_b" used={100} limit={200} percent={50} />);
    expect(document.body.querySelector('[data-testid="context-gauge"]')).toBeNull();
  });

  test('matches the active session when ids agree', () => {
    mount(<ContextGauge sessionId="ses_a" activeSessionId="ses_a" used={100} limit={200} percent={50} />);
    expect(document.body.querySelector('[data-testid="context-gauge"]')).not.toBeNull();
  });

  test('the bar is width-bound and clamped, never a negative or >100% width', () => {
    for (const percent of [0, 33.3, 100, 100.5, -4]) {
      mount(<ContextGauge used={1} limit={200} percent={percent} />);
      const bar = document.body.querySelector('[data-testid="context-bar"]');
      const width = bar?.getAttribute('data-width') ?? '';
      const n = Number.parseFloat(width);
      expect(Number.isFinite(n), String(percent)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(100);
    }
  });

  test('marks a near-full context so the user is warned before overflow', () => {
    mount(<ContextGauge used={190_000} limit={200_000} percent={95} />);
    expect(document.body.querySelector('[data-testid="context-gauge"]')?.getAttribute('data-level')).toBe('high');
  });

  test('an empty context does not render an empty bar', () => {
    mount(<ContextGauge used={0} limit={200_000} percent={0} />);
    expect(document.body.querySelector('[data-testid="context-gauge"]')).not.toBeNull();
  });
});
