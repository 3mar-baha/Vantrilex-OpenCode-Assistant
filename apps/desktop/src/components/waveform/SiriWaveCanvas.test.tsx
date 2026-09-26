import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SiriWaveCanvas, type SiriWaveMode } from './SiriWaveCanvas.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(mode: SiriWaveMode): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<SiriWaveCanvas mode={mode} color="#2563eb" />);
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SiriWaveCanvas (sine flow + emblem voiceprint)', () => {
  test('renders a labelled canvas in both modes without crashing', () => {
    mount('idle');
    const canvas = document.body.querySelector('[data-testid="siri-wave"]');
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute('aria-label')).toContain('الموجة الصوتية');
    mount('active');
    expect(document.body.querySelector('[data-testid="siri-wave"]')).not.toBeNull();
  });

  test('cleans up its animation frame on unmount', () => {
    const cancel = vi.fn();
    const noop = (): void => undefined;
    const fakeCtx = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'canvas') return null;
          return typeof prop === 'string' ? noop : undefined;
        },
        set: () => true,
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      window.setTimeout(() => cb(Date.now()), 16);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', cancel);
    mount('active');
    act(() => {
      root?.unmount();
    });
    root = null;
    expect(cancel).toHaveBeenCalled();
  });
});
