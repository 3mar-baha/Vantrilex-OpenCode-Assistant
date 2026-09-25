import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { KeysView } from './KeysView.js';

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
  vi.restoreAllMocks();
});

describe('KeysView (dedicated API-keys window)', () => {
  test('renders the focused 3-key intake with no settings tabs', () => {
    mount(<KeysView />);
    expect(document.body.querySelector('[data-testid="keys-view"]')).not.toBeNull();
    expect(document.body.querySelectorAll('[role="tab"]')).toHaveLength(0);
    for (const id of ['apikey-groq', 'apikey-fish', 'apikey-openrouter'] as const) {
      expect(document.body.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    expect(document.body.querySelector('[data-testid="apikey-save"]')).not.toBeNull();
  });

  test('save stays disabled until all three fields are filled', () => {
    mount(<KeysView />);
    const save = document.body.querySelector('[data-testid="apikey-save"]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});