import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { KeysView } from './KeysView.js';

// The bridge and the token are the only way a save happens; both are mocked so
// the DACL verdict is the ONLY variable in these cases. `@tauri-apps/api/core`
// is mocked (not `settings/vault-dacl.js`) on purpose: the discrimination
// between an unconfirmed answer and a host failure lives in the real module,
// and mocking it away would let KeysView render a receipt the module cannot
// actually produce.
let saveResult: boolean = true;
const invoke = vi.fn();

// The save is a promise chain (bridge ack → DACL invoke → setState), and this
// suite has no setup file, so `act` must be told it is in a React environment
// or it refuses to flush the async work and every assertion below races a
// render that has not happened yet.
(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

vi.mock('../../settings/ipc-token.js', () => ({
  envToken: () => 'test-token',
  isTauriHost: () => '__TAURI_INTERNALS__' in window,
  resolveIpcToken: async () => 'test-token',
  resolveIpcTokenWithRetry: async () => 'test-token',
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('../../bridge/ws.js', () => ({
  UI_WS_URL: 'ws://127.0.0.1:4097/v1/ui',
  UI_SUBPROTOCOL: 'voice-ui.v1',
  VoxauraBridge: class VoxauraBridge {
    connect(): void {
      /* nothing to do */
    }
    dispose(): void {
      /* nothing to do */
    }
    async sendCommand(): Promise<boolean> {
      return saveResult;
    }
  },
}));

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
  invoke.mockReset();
  saveResult = true;
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  vi.restoreAllMocks();
});

/** Stand in for a Tauri host; `restrictVaultFile` gates on exactly this key. */
function enterTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function el(id: string): HTMLElement {
  const found = document.body.querySelector(`[data-testid="${id}"]`);
  if (found === null) throw new Error(`no element ${id}`);
  return found as HTMLElement;
}

function count(id: string): number {
  return document.body.querySelectorAll(`[data-testid="${id}"]`).length;
}

/** React's value tracker dedupes a plain `el.value = x`; go through the setter. */
function typeInto(id: string, value: string): void {
  const input = el(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function fillKeys(): Promise<void> {
  await act(async () => {
    typeInto('apikey-groq', 'gsk-test');
    typeInto('apikey-fish', 'sk-fish');
    typeInto('apikey-openrouter', 'sk-or');
  });
}

/** Drain the save → ack → DACL → setState promise chain inside `act`. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function saveAndSettle(): Promise<void> {
  await act(async () => {
    (el('apikey-save') as HTMLButtonElement).click();
  });
  await settle();
}

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

  // ── C.1 — the DACL receipt has THREE outcomes, not two ────────────────────
  // `restrict_vault_file` (main.rs:907) returns Err on a failed
  // `restrict_to_owner`, and that path is FAIL-CLOSED: it deletes
  // `keyring.dat` (main.rs:917-919). Tauri surfaces Err as a REJECTED invoke,
  // so the rejection is not a softer warning — it is the host reporting that
  // the encrypted keyring may no longer be on disk. A passive amber line under
  // a green "keys saved" receipt understates that and leaves the only copy of
  // the secrets sitting in the form.
  test('C.1 — a host FAILURE is an error that re-prompts; it is never the passive warn', async () => {
    enterTauri();
    invoke.mockRejectedValue(new Error('keyring.dat: acl: owner size query failed (5)'));
    mount(<KeysView />);
    await settle();
    await fillKeys();
    await saveAndSettle();

    // The error surface exists and names the file the host failed on.
    expect(count('keys-dacl-error')).toBe(1);
    expect(el('keys-dacl-error').textContent).toContain('keyring.dat');
    // NOT the warn, and NOT a green receipt claiming a save that may no
    // longer exist on disk.
    expect(count('keys-dacl-warn')).toBe(0);
    expect(count('keys-saved')).toBe(0);
    expect(count('keys-dacl-ok')).toBe(0);
    // Re-prompt: the three inputs are cleared and Save is disabled until the
    // keys are entered again.
    for (const id of ['apikey-groq', 'apikey-fish', 'apikey-openrouter'] as const) {
      expect((el(id) as HTMLInputElement).value).toBe('');
    }
    expect((el('apikey-save') as HTMLButtonElement).disabled).toBe(true);
    // And the form is live again: a re-entry can actually be saved.
    await fillKeys();
    expect((el('apikey-save') as HTMLButtonElement).disabled).toBe(false);
  });

  test('C.1 — an UNCONFIRMED lock warns and keeps the receipt, the keys and the form intact', async () => {
    enterTauri();
    invoke.mockResolvedValue(false); // Ok(false) — the host did not confirm.
    mount(<KeysView />);
    await settle();
    await fillKeys();
    await saveAndSettle();

    // The visible difference from the failure above: amber, receipt stands.
    expect(count('keys-dacl-warn')).toBe(1);
    expect(count('keys-saved')).toBe(1);
    expect(count('keys-dacl-error')).toBe(0);
    // `apikey-error` is the SAVE-rejection surface. A DACL verdict must never
    // reach it — the daemon really did record the three keys.
    expect(count('apikey-error')).toBe(0);
    // No re-prompt: the values are still on disk, so telling the operator to
    // re-enter them would be false.
    expect((el('apikey-groq') as HTMLInputElement).value).toBe('gsk-test');
    expect((el('apikey-save') as HTMLButtonElement).disabled).toBe(false);
  });

  test('C.1 — no Tauri host renders NO dacl line at all, and never calls the host', async () => {
    // A browser has no ACL to re-apply, so `restrictVaultFile` is a no-op
    // returning null. Rendering nothing is the point: an unverified lock must
    // not be drawn in the same place as a confirmed one.
    mount(<KeysView />);
    await settle();
    await fillKeys();
    await saveAndSettle();

    expect(count('keys-saved')).toBe(1);
    expect(count('keys-dacl-ok')).toBe(0);
    expect(count('keys-dacl-warn')).toBe(0);
    expect(count('keys-dacl-error')).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });
});
