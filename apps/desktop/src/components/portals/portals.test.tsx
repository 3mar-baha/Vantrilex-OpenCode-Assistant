import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConfirmPortal } from './ConfirmPortal.js';
import { CredentialPortal } from './CredentialPortal.js';
import { SettingsPortal } from './SettingsPortal.js';

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

const TABS = [
  { id: 'identity', title: 'Persona (Kareem / Nour)' },
  { id: 'audio', title: 'Audio & hardware' },
  { id: 'bridge', title: 'OpenCode bridge' },
  { id: 'keyring', title: 'Key pools' },
  { id: 'system', title: 'System & telemetry' },
];

describe('SettingsPortal', () => {
  test('renders outside the app root with 5 tabs + Kareem/Nour personas', () => {
    mount(
      <SettingsPortal
        tabs={TABS}
        activeTab="identity"
        persona={[
          { id: 'kareem', label: 'Kareem (كريم)', selected: true },
          { id: 'nour', label: 'Nour (نور)', selected: false },
        ]}
        onSelectTab={() => undefined}
        onSelectPersona={() => undefined}
        onClose={() => undefined}
      />,
    );
    const shell = document.body.querySelector('[data-testid="portal-shell"]');
    expect(shell).not.toBeNull();
    expect(shell?.parentElement).toBe(document.body); // portalled out
    expect(document.body.querySelectorAll('[role="tab"]')).toHaveLength(5);
    expect(document.body.querySelector('[data-testid="persona-kareem"]')?.getAttribute('aria-checked')).toBe('true');
    expect(document.body.querySelector('[data-testid="persona-nour"]')?.getAttribute('aria-checked')).toBe('false');
  });

  test('Escape closes the portal', () => {
    const onClose = vi.fn();
    mount(
      <SettingsPortal
        tabs={TABS}
        activeTab="identity"
        persona={[{ id: 'kareem', label: 'Kareem (كريم)', selected: true }]}
        onSelectTab={() => undefined}
        onSelectPersona={() => undefined}
        onClose={onClose}
      />,
    );
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Tab on the last focusable wraps to the first', () => {
    mount(
      <SettingsPortal
        tabs={TABS.slice(0, 1)}
        activeTab="identity"
        persona={[{ id: 'kareem', label: 'Kareem (كريم)', selected: true }]}
        onSelectTab={() => undefined}
        onSelectPersona={() => undefined}
        onClose={() => undefined}
      />,
    );
    const buttons = [...document.body.querySelectorAll<HTMLElement>('button')];
    expect(buttons.length).toBeGreaterThan(1);
    const first = buttons[0] as HTMLElement;
    const last = buttons[buttons.length - 1] as HTMLElement;
    act(() => {
      last.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(first);
  });
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
    mount(<CredentialPortal groqKeys={3} fishKeys={2} onClose={() => undefined} />);
    const text = document.body.textContent ?? '';
    expect(document.body.querySelector('[data-testid="groq-count"]')?.textContent).toContain('3');
    expect(document.body.querySelector('[data-testid="fish-count"]')?.textContent).toContain('2');
    expect(text).not.toMatch(/gsk_|sk-fish_|Bearer /);
  });
});
