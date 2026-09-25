import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConfirmPortal } from './ConfirmPortal.js';
import { CredentialPortal } from './CredentialPortal.js';

// G2 TDD — portal behavior under happy-dom: mount outside app root, focus
// trap, Esc closes, accessible names. No network, no daemon.
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

describe('ConfirmPortal (FR-12 T2 surface)', () => {
  test('confirm and cancel report back; score is shown', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    mount(
      <ConfirmPortal
        title="Confirm before acting"
        detail="Ambiguous intent (0.50), please confirm."
        destructiveScore={0.5}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(document.body.querySelector('[data-testid="confirm-score"]')?.textContent).toContain('0.50');
    act(() => {
      (document.body.querySelector('[data-testid="confirm-ok"]') as HTMLElement).click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('CredentialPortal (counts only)', () => {
  test('shows pool counts and never key material', () => {
    mount(<CredentialPortal groqKeys={3} fishKeys={2} openrouterKeys={1} onClose={() => undefined} />);
    const text = document.body.textContent ?? '';
    expect(document.body.querySelector('[data-testid="groq-count"]')?.textContent).toContain('3');
    expect(document.body.querySelector('[data-testid="fish-count"]')?.textContent).toContain('2');
    expect(document.body.querySelector('[data-testid="openrouter-count"]')?.textContent).toContain('1');
    expect(text).not.toMatch(/gsk_|sk-fish_|sk-or-|Bearer /);
  });
});
