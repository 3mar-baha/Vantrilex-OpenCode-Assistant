// Cross-platform "close this window" for the Esc affordance.
//
// The bug this fixes: an Esc handler that only unmounted the React tree left
// the native window alive showing a blank (white) webview. Closing the OS
// window is the correct action; the dark canvas in tokens.css is the belt to
// this suspenders.
export async function closeCurrentWindow(): Promise<void> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
      return;
    } catch {
      // fall through to the DOM close
    }
  }
  window.close();
}