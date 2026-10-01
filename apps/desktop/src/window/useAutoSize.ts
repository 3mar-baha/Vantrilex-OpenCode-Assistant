import { useEffect, type RefObject } from 'react';

// Dynamic content auto-sizing for Voxaura windows.
//
// ── STOOD DOWN, AND WHY IT IS NOT DELETED ────────────────────────────────────
//
// This hook is now OPT-IN. It does nothing unless a caller passes
// `enabled: true`. That is a behaviour change with a dated cause:
//
//   The window stopped being content-driven. `tauri.conf.json` now sets
//   `resizable: true` with `minWidth: 380` / `minHeight: 380` — a fixed square
//   edge — so nothing can expand without the user's own drag.
//   A minimum-bounds window and a content-driven window are mutually
//   exclusive instruments: this hook pushes `scrollHeight` into
//   `setSize()`, which fights the minimum on every frame (the clamp in
//   `apply()` below would let content BELOW the minimum through, and the
//   OS would refuse the rest), and it fights the user's own drag on every
//   frame after that. Whichever wins, the window is no longer honest.
//
//   So the default is `enabled: false`. The window is now sized by the
//   minimum bounds plus the user's drag, and the drawer lives INSIDE a
//   bounded column instead of resizing the OS frame.
//
// THREE REASONS IT IS STILL HERE rather than deleted:
//
//   1. The clamp arithmetic is load-bearing history and it is TESTED. The
//      2px resize-feedback tolerance, the `scrollWidth`-over-border-box
//      choice and the `min`/`max` sandwich in `apply()` are each the
//      documented answer to a bug someone actually hit. `useAutoSize.test.tsx`
//      exercises all of them. Deleting the module deletes the only executable
//      statement of why those numbers are what they are.
//   2. Other windows still want it. The settings and API-keys portals are
//      separate frames with their own content and no minimum-bounds story;
//      a re-enable there is one flag, not a re-derivation.
//   3. It is inert by construction, not by hope. `enabled` defaults false, so
//      a call site that forgets the flag is a no-op — not a window that
//      silently resizes. The failure mode of forgetting is silence, which is
//      the recoverable direction.
//
// Measurement uses scrollWidth/scrollHeight (full content extent, including
// anything that would otherwise overflow) rather than the border box, and adds
// explicit frame padding so the OS chrome never crops content. No-op outside
// Tauri / without ResizeObserver, so web, E2E and unit tests are unaffected.
/** Injectable seam: production passes the Tauri call; tests pass a spy. */
export type SetWindowSize = (width: number, height: number) => void | Promise<void>;

async function defaultSetWindowSize(width: number, height: number): Promise<void> {
  const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setSize(new LogicalSize(width, height));
}

/**
 * Why the default is off, as a value rather than a comment, so a caller can
 * read the reason at the call site and a test can assert the stand-down is
 * still standing.
 */
export const AUTO_SIZE_STAND_DOWN =
  'window is min-bounded (380x380) and user-resizable; content must not drive the OS frame';

export interface AutoSizeOptions {
  /**
   * Opt in to content-driven sizing. `false` by default — see
   * `AUTO_SIZE_STAND_DOWN`. A caller must ask for this behaviour explicitly.
   */
  readonly enabled?: boolean;
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  /** Extra space added to the measured content (window frame / shadow gutter). */
  readonly paddingX?: number;
  readonly paddingY?: number;
  /**
   * Legacy inverse of `enabled`, kept so an existing caller passing
   * `disabled: true` still means "off". When both are supplied `enabled` wins,
   * because it is the current name and `disabled` is the compatibility shim.
   *
   * @deprecated pass `enabled: false` (or nothing at all) instead.
   */
  readonly disabled?: boolean;
  /** Injected for tests; defaults to the real Tauri window call. */
  readonly setWindowSize?: SetWindowSize;
}

export function useAutoSize(ref: RefObject<HTMLElement | null>, options: AutoSizeOptions = {}): void {
  const {
    enabled = false,
    minWidth = 320,
    minHeight = 200,
    maxWidth = 1600,
    maxHeight = 1400,
    paddingX = 0,
    paddingY = 0,
    disabled = false,
    setWindowSize = defaultSetWindowSize,
  } = options;

  // `enabled` is the current name; `disabled` only survives as a shim for
  // callers written before the stand-down. Either spelling means "off".
  const active = enabled && !disabled;

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (el === null) return;
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    if (typeof ResizeObserver === 'undefined') return;

    let raf = 0;
    let last = { w: 0, h: 0 };
    let cancelled = false;

    const apply = (): void => {
      if (cancelled) return;
      // scrollWidth/Height capture the full content extent; fall back to the
      // rect for environments that report 0 (detached/hidden elements).
      const rect = el.getBoundingClientRect();
      const rawW = el.scrollWidth > 0 ? el.scrollWidth : rect.width;
      const rawH = el.scrollHeight > 0 ? el.scrollHeight : rect.height;
      const w = Math.min(maxWidth, Math.max(minWidth, Math.ceil(rawW + paddingX)));
      const h = Math.min(maxHeight, Math.max(minHeight, Math.ceil(rawH + paddingY)));
      // Tolerance guard: sizing the window re-triggers layout, so ignore
      // sub-pixel churn to avoid a resize feedback loop.
      if (Math.abs(w - last.w) < 2 && Math.abs(h - last.h) < 2) return;
      last = { w, h };
      void (async () => {
        try {
          await setWindowSize(w, h);
        } catch {
          // Fail soft: a sizing failure must never break the UI.
        }
      })();
    };

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    });
    observer.observe(el);
    apply();
    return () => {
      cancelled = true;
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ref, active, minWidth, minHeight, maxWidth, maxHeight, paddingX, paddingY, setWindowSize]);
}
