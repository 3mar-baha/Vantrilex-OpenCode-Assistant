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

describe('SessionChip', () => {
  test('renders the session list with active marked; select emits the id', () => {
    const onSelect = vi.fn();
    mount(
      <SessionChip
        sessions={[
          { id: 'ses_a', state: 'running' },
          { id: 'ses_b', state: 'idle' },
        ]}
        activeId="ses_a"
        onSelect={onSelect}
      />,
    );
    expect(document.body.querySelectorAll('[data-testid^="session-ses_"]')).toHaveLength(2);
    expect(document.body.querySelector('[data-testid="session-ses_a"]')?.getAttribute('aria-current')).toBe('true');
    act(() => {
      (document.body.querySelector('[data-testid="session-ses_b"]') as HTMLElement).click();
    });
    expect(onSelect).toHaveBeenCalledWith('ses_b');
  });

  test('empty list renders the active id only — never fabricated sessions', () => {
    mount(<SessionChip sessions={[]} activeId={null} onSelect={() => undefined} />);
    expect(document.body.querySelector('[data-testid="session-active-only"]')?.textContent).toBe('غير معيّنة');
    expect(document.body.querySelector('[data-testid="session-list"]')).toBeNull();
  });
});
