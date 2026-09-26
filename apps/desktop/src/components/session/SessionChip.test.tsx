import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SessionChip } from './SessionChip.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: React.ReactNode): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
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

const TWO = [
  { id: 'ses_a', state: 'running' },
  { id: 'ses_b', state: 'idle' },
] as const;

describe('SessionChip (compact dropdown)', () => {
  test('collapsed by default: shows the active session, no list in the DOM', () => {
    mount(<SessionChip sessions={TWO} activeId="ses_a" onSelect={() => undefined} />);
    expect(document.body.querySelector('[data-testid="session-active-label"]')?.textContent).toContain('ses_a');
    // The stack must NOT be in the DOM while collapsed — this is the bug fix.
    expect(document.body.querySelector('[data-testid="session-list"]')).toBeNull();
    expect(document.body.querySelectorAll('[data-testid^="session-ses_"]')).toHaveLength(0);
  });

  test('the trigger stays a single compact line (one trigger element)', () => {
    mount(<SessionChip sessions={TWO} activeId="ses_a" onSelect={() => undefined} />);
    const triggers = document.body.querySelectorAll('[data-testid="session-chip-trigger"]');
    expect(triggers).toHaveLength(1);
  });

  test('opening reveals every session; selecting emits the id and closes the menu', () => {
    const onSelect = vi.fn();
    mount(<SessionChip sessions={TWO} activeId="ses_a" onSelect={onSelect} />);
    act(() => {
      (document.body.querySelector('[data-testid="session-chip-trigger"]') as HTMLElement).click();
    });
    expect(document.body.querySelectorAll('[data-testid^="session-ses_"]')).toHaveLength(2);
    expect(document.body.querySelector('[data-testid="session-ses_a"]')?.getAttribute('aria-current')).toBe('true');
    act(() => {
      (document.body.querySelector('[data-testid="session-ses_b"]') as HTMLElement).click();
    });
    expect(onSelect).toHaveBeenCalledWith('ses_b');
    // Closed again: the list is gone, keeping the HUD compact.
    expect(document.body.querySelector('[data-testid="session-list"]')).toBeNull();
  });

  test('Escape closes the menu without selecting', () => {
    mount(<SessionChip sessions={TWO} activeId="ses_a" onSelect={() => undefined} />);
    act(() => {
      (document.body.querySelector('[data-testid="session-chip-trigger"]') as HTMLElement).click();
    });
    expect(document.body.querySelector('[data-testid="session-list"]')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.body.querySelector('[data-testid="session-list"]')).toBeNull();
  });

  test('empty list renders the active id only — never fabricated sessions', () => {
    mount(<SessionChip sessions={[]} activeId={null} onSelect={() => undefined} />);
    expect(document.body.querySelector('[data-testid="session-active-only"]')?.textContent).toBe('غير معيّنة');
    expect(document.body.querySelector('[data-testid="session-list"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="session-chip-trigger"]')).toBeNull();
  });
});
