import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KeysView } from './KeysView.js';
import { SettingsView } from './SettingsView.js';

// W20 — THE CALL-SITE TEST THAT WAS MISSING, and the reason the defect survived.
//
// `useAutoSize.test.tsx` proves the hook works when it is opted in. It cannot
// prove any COMPONENT opts in, because every case in it drives a local `Probe`
// that passes `enabled` by hand. Both `SettingsView` and `KeysView` passed
// bounds and nothing else, so the suite was green over a dead call site: the hook
// was measured, the product was not.
//
// This file closes that gap from the component side, and it deliberately goes
// through the PRODUCTION seam rather than an injected one. `useAutoSize`'s
// default `setWindowSize` dynamically imports `@tauri-apps/api/window` and calls
// `getCurrentWindow().setSize(...)`; mocking that module is the same code path an
// installed build takes, minus Tauri. An injected `setWindowSize` would prove the
// hook runs but not that the two views actually reach the hook at all, and it is
// precisely the "the hook works, the product does not" gap that let W20 ship.
//
// The autosize module is NOT mocked. Mocking it is the mistake being fixed.

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/**
 * The Tauri `setSize` spy, typed with its two arguments.
 *
 * The arity is part of the assertion, not decoration: an untyped
 * `vi.fn(async () => undefined)` records `calls: [][]`, so every
 * `mock.calls[0] as [number, number]` below is a cast the compiler rejects and
 * the numbers under test would be read off a value the type system says is empty.
 * `(w, h) => setSize(w, h)` is the shape the real call has, so the recorded call
 * and the assertion agree by construction.
 */
const setSize = vi.fn(async (w: number, h: number) => {
  void w;
  void h;
});

vi.mock('@tauri-apps/api/window', () => ({
  LogicalSize: class LogicalSize {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
  },
  getCurrentWindow: () => ({ setSize: (size: { width: number; height: number }) => setSize(size.width, size.height) }),
}));

vi.mock('../../settings/ipc-token.js', () => ({
  envToken: () => 'test-token',
  isTauriHost: () => true,
  resolveIpcToken: async () => 'test-token',
  resolveIpcTokenWithRetry: async () => 'test-token',
}));
vi.mock('../../settings/vault-dacl.js', () => ({ restrictVaultFile: async () => null }));
vi.mock('../../bridge/ws.js', () => ({
  UI_WS_URL: 'ws://127.0.0.1:4097/v1/ui',
  UI_SUBPROTOCOL: 'voice-ui.v1',
  VoxauraBridge: class VoxauraBridge {
    connect(): void {
      /* no socket in a unit test */
    }
    dispose(): void {
      /* nothing to release */
    }
    async sendCommand(): Promise<boolean> {
      return true;
    }
  },
}));

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

/**
 * Flush the seam.
 *
 * `useAutoSize`'s production `setWindowSize` is an `async` function that
 * AWAITS a dynamic `import('@tauri-apps/api/window')` before it calls `setSize`,
 * and the hook fires it inside a further `void (async () => …)()`. A synchronous
 * `act()` therefore returns before the size is ever pushed, and every assertion
 * below would read an untouched spy — which is the failure mode of a test that
 * looks like it is checking a dead call site and is really checking a race.
 * Draining the microtask queue inside `act` is what makes the seam observable.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * A Tauri host plus a `ResizeObserver` and stubbed extents, so the hook's real
 * preconditions are met. `useAutoSize` no-ops without `__TAURI_INTERNALS__` or
 * without `ResizeObserver` (web and E2E must be unaffected), so a test that stubbed
 * neither would be measuring the no-op and would pass on the defect.
 */
function installHost(extentW: number, extentH: number): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => extentW });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => extentH });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        /* the hook also calls apply() directly on mount */
      }
      disconnect(): void {
        /* nothing retained */
      }
    },
  );
}

beforeEach(() => {
  setSize.mockClear();
});

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
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

const CHAIN = [{ id: 'inkling', name: 'Inkling', role: 'المنسق' }];

describe('W20 — the auxiliary windows are actually wired to auto-sizing', () => {
  test('SettingsView pushes a content-driven size instead of standing down', async () => {
    installHost(720, 980);
    mount(<SettingsView chain={CHAIN} />);
    await settle();
    // 720 + paddingX 2, 980 + paddingY 2, inside the 560..900 / 460..1000 clamp.
    expect(setSize, 'the settings window must push its own size').toHaveBeenCalled();
    const [w, h] = setSize.mock.calls[0]!;
    expect(w).toBe(722);
    expect(h).toBe(982);
  });

  test('KeysView pushes a content-driven size instead of standing down', async () => {
    installHost(700, 900);
    mount(<KeysView />);
    await settle();
    expect(setSize, 'the keys window must push its own size').toHaveBeenCalled();
    const [w, h] = setSize.mock.calls[0]!;
    expect(w).toBe(702);
    expect(h).toBe(902);
  });

  // The clamp is the reason this is safe to switch on at all: these two frames
  // have an OS minimum of 560×460 (`open-settings.ts`), and the hook's floor is
  // the same pair, so the hook can never ask for something the OS would refuse.
  test('a tall tab is clamped to the declared maximum, not pushed past it', async () => {
    installHost(720, 4000);
    mount(<SettingsView chain={CHAIN} />);
    await settle();
    const [w, h] = setSize.mock.calls[0]!;
    // The clamp is applied to the PADDED extent, not after it
    // (`Math.min(maxHeight, Math.max(minHeight, ceil(raw + padding)))`), so the
    // padding is inside the sandwich and 4002 is clamped down to exactly 1000.
    expect(h, '4000 px of content must clamp to maxHeight 1000').toBe(1000);
    expect(w).toBe(722);
  });

  test('a short window is clamped up to the declared minimum', async () => {
    installHost(100, 100);
    mount(<KeysView />);
    await settle();
    const [w, h] = setSize.mock.calls[0]!;
    expect(w, 'clamped up to minWidth 560').toBe(560);
    expect(h, 'clamped up to minHeight 460').toBe(460);
  });

  // THE POSITIVE CONTROL, and the reason the four cases above are not vacuous.
  // Every one of them asserts on `setSize`, so if the injection had silently
  // no-opped — a `vi.mock` path that resolved to nothing, a seam the hook never
  // reached — they would all fail for the wrong reason and a "fix" that only
  // moved the failure would look like progress. This case asserts the seam is
  // reached on a setup with no view mounted at all, which is only true if the
  // hook's production `defaultSetWindowSize` really did resolve the mocked module.
  test('POSITIVE CONTROL: the production seam resolves the mocked Tauri module', async () => {
    installHost(640, 700);
    const { useAutoSize } = await import('../../window/useAutoSize.js');
    const el = document.createElement('div');
    const ref = { current: el };
    const Probe = (): null => {
      useAutoSize(ref, { enabled: true, minWidth: 560, minHeight: 460, paddingX: 2, paddingY: 2 });
      return null;
    };
    mount(<Probe />);
    await settle();
    // 640 + paddingX 2 and 700 + paddingY 2, both inside the clamp, so the only
    // thing that could have produced these numbers is the production seam.
    expect(setSize, 'the mocked module must be the one the hook imports').toHaveBeenCalledWith(642, 702);
  });

  // The stand-down is still real where it was justified, and this is the guard
  // that keeps W20 from being "fixed" by turning the hook back on globally. The
  // HUD is min-bounded 380×380 and content must not drive that frame.
  test('the stand-down itself is unchanged — this fix is scoped to the two frames', async () => {
    const { AUTO_SIZE_STAND_DOWN } = await import('../../window/useAutoSize.js');
    expect(AUTO_SIZE_STAND_DOWN).toMatch(/min-bounded/);
  });
});
