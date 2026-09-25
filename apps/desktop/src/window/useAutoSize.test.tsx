import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { useRef } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useAutoSize, type SetWindowSize } from './useAutoSize.js';

// The hook must be inert outside Tauri and must not throw when ResizeObserver
// is unavailable — web builds and happy-dom tests depend on that. Sizing is
// verified through the injected seam, so no module mocking or timing is needed.
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Probe(props: { readonly setWindowSize: SetWindowSize; readonly paddingY?: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useAutoSize(ref, {
    setWindowSize: props.setWindowSize,
    ...(props.paddingY !== undefined ? { paddingY: props.paddingY } : {}),
  });
  return <div ref={ref} data-testid="sized" />;
}

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Stub the measured extents the hook reads. */
function stubExtent(w: number, h: number): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => w });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => h });
}

function stubTauriHost(): void {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  class FakeResizeObserver {
    observe = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
}

describe('useAutoSize', () => {
  test('no-ops outside Tauri without throwing', () => {
    const spy = vi.fn();
    expect(() => mount(<Probe setWindowSize={spy} />)).not.toThrow();
    expect(document.body.querySelector('[data-testid="sized"]')).not.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test('pushes the full scroll extent (plus frame padding) to the window', () => {
    stubTauriHost();
    stubExtent(440, 612);
    const spy = vi.fn();
    mount(<Probe setWindowSize={spy} paddingY={8} />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(440, 620);
  });

  test('clamps to the configured minimum', () => {
    stubTauriHost();
    stubExtent(100, 50);
    const spy = vi.fn();
    mount(<Probe setWindowSize={spy} />);
    expect(spy).toHaveBeenCalledWith(320, 200);
  });

  test('disabled option skips observation entirely', () => {
    stubTauriHost();
    const observe = vi.fn();
    class FakeResizeObserver {
      observe = observe;
      disconnect = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const spy = vi.fn();
    function Disabled(): JSX.Element {
      const ref = useRef<HTMLDivElement>(null);
      useAutoSize(ref, { disabled: true, setWindowSize: spy });
      return <div ref={ref} />;
    }
    mount(<Disabled />);
    expect(observe).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });
});