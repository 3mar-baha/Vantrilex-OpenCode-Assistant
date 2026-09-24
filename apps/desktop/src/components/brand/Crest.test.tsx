import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'vitest';
import { Crest } from './Crest.js';

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

describe('Crest', () => {
  test.each([24, 48, 96] as const)('renders vector-crisp at %ipx', (size) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(<Crest size={size} />);
    });
    const svg = document.body.querySelector('[data-testid="voxaura-crest"]');
    expect(svg?.getAttribute('width')).toBe(String(size));
    expect(svg?.getAttribute('viewBox')).toBe('0 0 48 48');
    expect(svg?.querySelectorAll('rect,circle,path').length).toBeGreaterThan(0);
  });
});
