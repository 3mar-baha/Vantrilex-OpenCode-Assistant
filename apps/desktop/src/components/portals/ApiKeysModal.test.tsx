import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiKeysModal } from './ApiKeysModal.js';

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

function typeInto(el: HTMLInputElement, text: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function fillAll(): { groq: HTMLInputElement; fish: HTMLInputElement; openrouter: HTMLInputElement } {
  const q = (id: string): HTMLInputElement => {
    const el = document.body.querySelector(`[data-testid="${id}"]`);
    if (!(el instanceof HTMLInputElement)) throw new Error(`missing ${id}`);
    return el;
  };
  const groq = q('apikey-groq');
  const fish = q('apikey-fish');
  const openrouter = q('apikey-openrouter');
  typeInto(groq, 'gsk-test-groq-value');
  typeInto(fish, 'sk-fish-test-value');
  typeInto(openrouter, 'sk-or-test-value');
  return { groq, fish, openrouter };
}

describe('ApiKeysModal (3-key mandatory intake)', () => {
  test('renders three masked fields with labels, badges, and the bilingual banner', () => {
    mount(<ApiKeysModal onSave={() => undefined} onClose={() => undefined} />);
    for (const id of ['apikey-groq', 'apikey-fish', 'apikey-openrouter'] as const) {
      const el = document.body.querySelector(`[data-testid="${id}"]`);
      expect(el?.getAttribute('type')).toBe('password');
    }
    expect(document.body.querySelector('[data-testid="apikey-banner"]')?.textContent).toContain('All 3 API keys are required');
    expect(document.body.querySelector('[data-testid="apikey-banner"]')?.textContent).toContain('يرجى إدخال جميع المفاتيح الثلاثة');
    for (const id of ['badge-groq', 'badge-fish', 'badge-openrouter'] as const) {
      expect(document.body.querySelector(`[data-testid="${id}"]`)?.textContent).toContain('missing');
    }
  });

  test('eye toggles reveal each field independently', () => {
    mount(<ApiKeysModal onSave={() => undefined} onClose={() => undefined} />);
    const btn = document.body.querySelector('[data-testid="toggle-groq"]') as HTMLButtonElement;
    act(() => {
      btn.click();
    });
    expect(document.body.querySelector('[data-testid="apikey-groq"]')?.getAttribute('type')).toBe('text');
    expect(document.body.querySelector('[data-testid="apikey-fish"]')?.getAttribute('type')).toBe('password');
  });

  test('save stays disabled until all three fields are non-empty (fail-closed)', () => {
    const onSave = vi.fn();
    mount(<ApiKeysModal onSave={onSave} onClose={() => undefined} />);
    const save = document.body.querySelector('[data-testid="apikey-save"]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const groq = document.body.querySelector('[data-testid="apikey-groq"]') as HTMLInputElement;
    typeInto(groq, 'only-one');
    expect(save.disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  test('save emits the three values and never leaks them into markup', () => {
    const onSave = vi.fn();
    mount(<ApiKeysModal onSave={onSave} onClose={() => undefined} />);
    fillAll();
    const save = document.body.querySelector('[data-testid="apikey-save"]') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    act(() => {
      save.click();
    });
    expect(onSave).toHaveBeenCalledWith({
      groq: 'gsk-test-groq-value',
      fish: 'sk-fish-test-value',
      openrouter: 'sk-or-test-value',
    });
    // Input values live in DOM properties, never serialized into markup.
    expect(document.body.innerHTML).not.toContain('gsk-test-groq-value');
    expect(document.body.innerHTML).not.toContain('sk-fish-test-value');
    expect(document.body.innerHTML).not.toContain('sk-or-test-value');
  });

  test('server-side save errors surface without echoing values', () => {
    mount(<ApiKeysModal onSave={() => undefined} onClose={() => undefined} saving={false} saveError="vault unreachable" />);
    expect(document.body.querySelector('[data-testid="apikey-error"]')?.textContent).toContain('vault unreachable');
  });
});
