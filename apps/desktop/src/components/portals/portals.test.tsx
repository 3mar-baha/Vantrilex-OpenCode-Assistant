import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConfirmPortal } from './ConfirmPortal.js';

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

// W6 — `CredentialPortal.tsx` was deleted. It rendered key POOL COUNTS, and no
// channel carries counts to the renderer: the only place they exist is CLI
// console output (`src/cli.ts:71`, `src/voice/key-store.ts:71`). The API-keys
// window renders `ApiKeysModal` (KeysView.tsx:93), which shows per-field
// presence, not counts. Wiring it would have meant a new daemon->renderer frame,
// which is outside the desktop write set. Its test went with it: a green test
// on unreachable code is the defect, not the mitigation.
