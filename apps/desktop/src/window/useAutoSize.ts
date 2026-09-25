import { useEffect, type RefObject } from 'react';

// Dynamic content auto-sizing for Voxaura windows. The windows are not
// user-resizable, so the React tree owns the dimensions: a ResizeObserver on
// the measured wrapper pushes the exact size to Tauri.
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

export interface AutoSizeOptions {
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  /** Extra space added to the measured content (window frame / shadow gutter). */
  readonly paddingX?: number;
  readonly paddingY?: number;
  /** Skip the size push entirely. */
  readonly disabled?: boolean;
  /** Injected for tests; defaults to the real Tauri window call. */
  readonly setWindowSize?: SetWindowSize;
}

export function useAutoSize(ref: RefObject<HTMLElement | null>, options: AutoSizeOptions = {}): void {
  const {
    minWidth = 320,
    minHeight = 200,
    maxWidth = 1600,
    maxHeight = 1400,
    paddingX = 0,
    paddingY = 0,
    disabled = false,
    setWindowSize = defaultSetWindowSize,
  } = options;

  useEffect(() => {
    if (disabled) return;
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
  }, [ref, minWidth, minHeight, maxWidth, maxHeight, paddingX, paddingY, disabled, setWindowSize]);
}