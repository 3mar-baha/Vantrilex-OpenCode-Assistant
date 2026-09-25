import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SettingsDialog } from './SettingsDialog.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const base = {
  onClose: () => undefined,
  keysSaving: false,
  keysError: undefined as string | undefined,
  onSaveKeys: () => undefined,
  chain: [
    { id: 'dots3', name: 'Dots3', role: 'الاستقبال الحواري' },
    { id: 'nemotron', name: 'Nemotron', role: 'المنسق الرئيسي' },
    { id: 'inkling', name: 'Inkling', role: 'المنفذ داخل الجلسة' },
  ],
  activeModel: null as string | null,
  agents: [] as ReadonlyArray<{ id: string; name: string }>,
  onSelectAgent: () => undefined,
  persona: 'kareem' as const,
  onSelectPersona: () => undefined,
  bridgeStatus: 'live',
};

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

describe('SettingsDialog (square tabbed dialog)', () => {
  test('renders five Arabic sidebar tabs and opens on the API keys tab', () => {
    mount(<SettingsDialog {...base} />);
    const dialog = document.body.querySelector('[data-testid="settings-dialog"]');
    expect(dialog).not.toBeNull();
    for (const id of ['tab-keys', 'tab-models', 'tab-skills', 'tab-voice', 'tab-system'] as const) {
      expect(document.body.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    expect(document.body.querySelector('[data-testid="apikey-groq"]')).not.toBeNull();
  });

  test('tab selection swaps content without unmounting the dialog', () => {
    const onSelectPersona = vi.fn();
    mount(<SettingsDialog {...base} onSelectPersona={onSelectPersona} />);
    act(() => {
      (document.body.querySelector('[data-testid="tab-voice"]') as HTMLButtonElement).click();
    });
    expect(document.body.querySelector('[data-testid="apikey-groq"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="persona-kareem"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="settings-dialog"]')).not.toBeNull();
    act(() => {
      (document.body.querySelector('[data-testid="persona-nour"]') as HTMLButtonElement).click();
    });
    expect(onSelectPersona).toHaveBeenCalledWith('nour');
  });

  test('models tab shows the 3-agent chain with Latin tokens verbatim', () => {
    mount(<SettingsDialog {...base} />);
    act(() => {
      (document.body.querySelector('[data-testid="tab-models"]') as HTMLButtonElement).click();
    });
    const text = document.body.querySelector('[data-testid="settings-content"]')?.textContent ?? '';
    for (const token of ['Dots3', 'Nemotron', 'Inkling', 'WS-4097', 'MCP', 'JSON']) {
      expect(text).toContain(token);
    }
  });

  test('technical acronyms are never translated', () => {
    mount(<SettingsDialog {...base} />);
    const keysText = document.body.textContent ?? '';
    for (const token of ['API', 'MCP', 'Groq', 'Fish Audio', 'OpenRouter', 'Whisper']) {
      expect(keysText).toContain(token);
    }
    act(() => {
      (document.body.querySelector('[data-testid="tab-models"]') as HTMLButtonElement).click();
    });
    const modelsText = document.body.querySelector('[data-testid="settings-content"]')?.textContent ?? '';
    for (const token of ['OpenCode', 'JSON', 'WS-4097']) {
      expect(modelsText).toContain(token);
    }
  });
});
