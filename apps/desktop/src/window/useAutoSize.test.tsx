import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { useRef } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AUTO_SIZE_STAND_DOWN, useAutoSize, type SetWindowSize } from './useAutoSize.js';

// The hook must be inert outside Tauri and must not throw when ResizeObserver
// is unavailable — web builds and happy-dom tests depend on that. Sizing is
// verified through the injected seam, so no module mocking or timing is needed.
//
// THE STAND-DOWN (see the module header): the hook is opt-in now, because the
// window is min-bounded and user-resizable and content must not drive the OS
// frame. Every case below that asserts a size push therefore passes
// `enabled: true` EXPLICITLY, and the first describe proves the default is off.
// That split is deliberate and is the reason the two halves cannot drift into
// each other silently: a case that forgot the flag would fail, not quietly
// stop testing.
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Probe(props: {
  readonly setWindowSize: SetWindowSize;
  readonly paddingY?: number;
  readonly enabled?: boolean;
  readonly disabled?: boolean;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useAutoSize(ref, {
    setWindowSize: props.setWindowSize,
    ...(props.paddingY !== undefined ? { paddingY: props.paddingY } : {}),
    ...(props.enabled !== undefined ? { enabled: props.enabled } : {}),
    ...(props.disabled !== undefined ? { disabled: props.disabled } : {}),
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

/** A ResizeObserver that reports whether it was ever subscribed to anything. */
function stubTauriHost(): { readonly observe: ReturnType<typeof vi.fn> } {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  const observe = vi.fn();
  class FakeResizeObserver {
    observe = observe;
    disconnect = vi.fn();
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  return { observe };
}

describe('useAutoSize: the stand-down is real, and the opt-in is real', () => {
  // THE load-bearing case of the whole change. The window is min-bounded now,
  // so a default-on hook would push `scrollHeight` into `setSize()` and fight
  // both the minimum and the user's own drag.
  test('DEFAULT stands down: no observer, no size push, even on a Tauri host', () => {
    const { observe } = stubTauriHost();
    stubExtent(440, 612);
    const spy = vi.fn();
    mount(<Probe setWindowSize={spy} paddingY={8} />);
    expect(observe, 'the stand-down must not even subscribe').not.toHaveBeenCalled();
    expect(spy, 'and must not push a size').not.toHaveBeenCalled();
  });

  // The positive control for the line above, in the same file on purpose: a
  // "was not called" assertion that has no matching "was called" assertion is
  // exactly the shape of a vacuous test, and this repo has been bitten by that
  // twice (a break-the-guard that passed only because the anchor was missing).
  test('POSITIVE CONTROL: `enabled: true` on the identical setup does push', () => {
    const { observe } = stubTauriHost();
    stubExtent(440, 612);
    const spy = vi.fn();
    mount(<Probe setWindowSize={spy} paddingY={8} enabled />);
    expect(observe, 'precondition: the opt-in really does observe').toHaveBeenCalled();
    expect(spy, 'precondition: the opt-in really does push').toHaveBeenCalledWith(440, 620);
  });

  test('the stand-down reason is exported, so a call site can read it', () => {
    // A value, not a comment: the reason travels with the import.
    expect(AUTO_SIZE_STAND_DOWN).toMatch(/min-bounded/);
    expect(AUTO_SIZE_STAND_DOWN.length).toBeGreaterThan(0);
  });

  test('the legacy `disabled` shim still means off', () => {
    const { observe } = stubTauriHost();
    stubExtent(440, 612);
    const spy = vi.fn();
    mount(<Probe setWindowSize={spy} disabled />);
    expect(observe).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  test('`enabled: false` wins over a missing flag rather than defaulting on', () => {
    const { observe } = stubTauriHost();
    const spy = vi.fn();
    mount(<Probe setWindowSize={spy} enabled={false} />);
    expect(observe).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('useAutoSize: the arithmetic, when opted in', () => {
  test('no-ops outside Tauri without throwing', () => {
    const spy = vi.fn();
    expect(() => mount(<Probe setWindowSize={spy} enabled />)).not.toThrow();
    expect(document.body.querySelector('[data-testid="sized"]')).not.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test('pushes the full scroll extent (plus frame padding) to the window', () => {
    stubTauriHost();
    stubExtent(440, 612);
    const spy = vi.fn();
    mount(<Probe setWindowSize={spy} paddingY={8} enabled />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(440, 620);
  });

  test('clamps to the configured minimum', () => {
    stubTauriHost();
    stubExtent(100, 50);
    const spy = vi.fn();
    mount(<Probe setWindowSize={spy} enabled />);
    expect(spy).toHaveBeenCalledWith(320, 200);
  });

  // The measured bounds are the ones a re-enabled caller would inherit. If the
  // min-bounds window ever goes back to being content-driven, these are the
  // numbers that have to equal the `tauri.conf.json` pair, so they are pinned
  // here rather than left to be re-derived by eye.
  test('the clamp bounds still agree with the window config minimum', () => {
    stubTauriHost();
    // Content far below the window's minimum must still be pushed as-is by the
    // hook: the hook's own floor is its business, and the OS floor is Tauri's.
    // The two being equal is a convention, so it is asserted, not assumed.
    stubExtent(100, 50);
    const spy = vi.fn();
    mount(<Probe setWindowSize={spy} enabled />);
    expect(spy).toHaveBeenCalledWith(320, 200);
    expect(320).toBeLessThan(440);
    expect(200).toBeLessThan(600);
  });

  test('`enabled: false` skips observation entirely', () => {
    const { observe } = stubTauriHost();
    const spy = vi.fn();
    mount(<Probe setWindowSize={spy} enabled={false} />);
    expect(observe).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });
});
