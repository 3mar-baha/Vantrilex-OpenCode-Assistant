import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'vitest';
import { SettingsView } from './SettingsView.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const chain = [
  { id: 'dots3', name: 'Dots3', role: 'الاستقبال الحواري' },
  { id: 'inkling-coordinator', name: 'Inkling', role: 'المنسق الرئيسي' },
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
});

describe('SettingsView (general settings window; keys are decoupled)', () => {
  test('renders four sidebar tabs, opens on models, and no key intake', () => {
    mount(<SettingsView chain={chain} />);
    expect(document.body.querySelector('[data-testid="settings-view"]')).not.toBeNull();
    expect(document.body.querySelectorAll('[role="tab"]')).toHaveLength(4);
    expect(document.body.querySelector('[data-testid="apikey-groq"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="chain-inkling-coordinator"]')).not.toBeNull();
  });

  test('tab selection swaps content without unmounting the view', () => {
    mount(<SettingsView chain={chain} />);
    act(() => {
      (document.body.querySelector('[data-testid="tab-skills"]') as HTMLButtonElement).click();
    });
    expect(document.body.querySelector('[data-testid="mcp-servers"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="settings-view"]')).not.toBeNull();
  });

  test('every sidebar tab carries an Arabic tooltip', () => {
    mount(<SettingsView chain={chain} />);
    for (const tab of document.body.querySelectorAll('[role="tab"]')) {
      const tip = tab.getAttribute('title') ?? '';
      expect(tip.length).toBeGreaterThan(0);
      expect(/[\u0600-\u06FF]/.test(tip)).toBe(true);
    }
  });

  test('technical acronyms stay Latin verbatim', () => {
    mount(<SettingsView chain={chain} />);
    const modelsText = document.body.textContent ?? '';
    // The coordinator is served by the Inkling model, so 'Nemotron' no longer
    // appears; the Latin-verbatim rule is checked against the slugs that do.
    for (const token of ['OpenCode', 'Dots3', 'Inkling', 'Groq', 'Fish Audio', 'whisper-large-v3-turbo']) {
      expect(modelsText).toContain(token);
    }
    act(() => {
      (document.body.querySelector('[data-testid="tab-system"]') as HTMLButtonElement).click();
    });
    expect(document.body.textContent ?? '').toContain('WS-4097');
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