import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SettingsView } from './SettingsView.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const chain = [
  { id: 'dots3', name: 'Dots3', role: 'الاستقبال الحواري' },
  { id: 'nemotron', name: 'Nemotron', role: 'المنسق الرئيسي' },
  { id: 'inkling', name: 'Inkling', role: 'المنفذ داخل الجلسة' },
];

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

describe('SettingsView (dedicated settings window surface)', () => {
  test('renders five sidebar tabs and opens on the API keys tab', () => {
    mount(<SettingsView chain={chain} />);
    expect(document.body.querySelector('[data-testid="settings-view"]')).not.toBeNull();
    expect(document.body.querySelectorAll('[role="tab"]')).toHaveLength(5);
    expect(document.body.querySelector('[data-testid="apikey-groq"]')).not.toBeNull();
  });

  test('tab selection swaps content without unmounting the view', () => {
    mount(<SettingsView chain={chain} />);
    act(() => {
      (document.body.querySelector('[data-testid="tab-models"]') as HTMLButtonElement).click();
    });
    expect(document.body.querySelector('[data-testid="apikey-groq"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="chain-nemotron"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="settings-view"]')).not.toBeNull();
  });

  test('technical acronyms stay Latin verbatim', () => {
    mount(<SettingsView chain={chain} />);
    const keysText = document.body.textContent ?? '';
    for (const token of ['API', 'Groq', 'Fish Audio', 'OpenRouter', 'Whisper']) {
      expect(keysText).toContain(token);
    }
    act(() => {
      (document.body.querySelector('[data-testid="tab-models"]') as HTMLButtonElement).click();
    });
    const modelsText = document.body.textContent ?? '';
    expect(modelsText).toContain('OpenCode');
    act(() => {
      (document.body.querySelector('[data-testid="tab-system"]') as HTMLButtonElement).click();
    });
    expect(document.body.textContent ?? '').toContain('WS-4097');
    act(() => {
      (document.body.querySelector('[data-testid="tab-skills"]') as HTMLButtonElement).click();
    });
    const skillsText = document.body.textContent ?? '';
    for (const token of ['MCP', 'mission-handoff', 'vault-sync']) {
      expect(skillsText).toContain(token);
    }
  });

  test('persona radios report the chosen persona', () => {
    mount(<SettingsView chain={chain} initialPersona="nour" />);
    act(() => {
      (document.body.querySelector('[data-testid="tab-voice"]') as HTMLButtonElement).click();
    });
    expect(document.body.querySelector('[data-testid="persona-nour"]')?.getAttribute('aria-checked')).toBe('true');
    expect(document.body.querySelector('[data-testid="persona-kareem"]')?.getAttribute('aria-checked')).toBe('false');
  });
});