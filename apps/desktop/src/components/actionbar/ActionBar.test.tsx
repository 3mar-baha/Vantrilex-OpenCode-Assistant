import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ActionBar } from './ActionBar.js';
import { IconCluster } from '../sidebar/IconCluster.js';

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

describe('IconCluster', () => {
  test('every action has an accessible name; icons inherit currentColor', () => {
    const onAction = vi.fn();
    mount(<IconCluster muted={false} deafened={false} onAction={onAction} />);
    for (const id of ['action-mute', 'action-abort', 'action-deafen', 'action-settings']) {
      const btn = document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement;
      expect(btn.getAttribute('aria-label')?.length ?? 0).toBeGreaterThan(0);
    }
    const svg = document.body.querySelector('[data-testid="action-mute"] svg');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    act(() => {
      (document.body.querySelector('[data-testid="action-abort"]') as HTMLElement).click();
    });
    expect(onAction).toHaveBeenCalledWith('abort');
  });
});

describe('ActionBar mute presets', () => {
  test('first mute opens the picker; preset emits minutes', () => {
    const onAction = vi.fn();
    mount(<ActionBar onAction={onAction} />);
    act(() => {
      (document.body.querySelector('[data-testid="action-mute"]') as HTMLElement).click();
    });
    expect(document.body.querySelector('[data-testid="mute-picker"]')).not.toBeNull();
    act(() => {
      (document.body.querySelector('[data-testid="mute-15m"]') as HTMLElement).click();
    });
    expect(onAction).toHaveBeenCalledWith('mute', 15);
    expect(document.body.querySelector('[data-testid="mute-picker"]')).toBeNull();
  });

  test('custom minutes accept digits only', () => {
    const onAction = vi.fn();
    mount(<ActionBar onAction={onAction} />);
    act(() => {
      (document.body.querySelector('[data-testid="action-mute"]') as HTMLElement).click();
    });
    const input = document.body.querySelector('[data-testid="mute-custom"]') as HTMLInputElement;
    act(() => {
      input.focus();
      document.execCommand?.('selectAll');
    });
    expect(input.getAttribute('aria-label')).toBe('Custom minutes');
    expect(onAction).not.toHaveBeenCalled();
  });
});
