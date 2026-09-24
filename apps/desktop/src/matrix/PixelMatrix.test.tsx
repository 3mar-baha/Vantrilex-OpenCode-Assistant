import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'vitest';
import { PixelMatrix } from './PixelMatrix.js';

// Host lifecycle: canvas mounts with the state attribute; worker absence
// (happy-dom has no Worker) degrades silently instead of throwing.
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

function mount(state: 0 | 1 | 2 | 3 | 4): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<PixelMatrix state={state} energy={0.5} />);
  });
}

describe('PixelMatrix host', () => {
  test('mounts a 48x48 canvas carrying the state attribute', () => {
    mount(3);
    const canvas = document.body.querySelector('[data-testid="pixel-matrix"]');
    expect(canvas?.getAttribute('width')).toBe('48');
    expect(canvas?.getAttribute('height')).toBe('48');
    expect(canvas?.getAttribute('data-state')).toBe('3');
  });

  test('state changes propagate to the attribute without remount', () => {
    mount(0);
    act(() => {
      root!.render(<PixelMatrix state={4} energy={0.5} />);
    });
    expect(document.body.querySelector('[data-testid="pixel-matrix"]')?.getAttribute('data-state')).toBe('4');
  });
});
