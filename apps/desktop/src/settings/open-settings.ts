// Settings window launcher — Tauri v2 native window when running inside the
// app; a same-origin browser popup during web/E2E runs. The settings UI itself
// is identical in both, because it lives at ?view=settings.
export const SETTINGS_LABEL = 'settings';

export function isTauriHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Focus the existing settings window or create it; resolves to its URL. */
export async function openSettingsWindow(query = ''): Promise<string> {
  const suffix = query.length > 0 ? `&${query}` : '';
  if (isTauriHost()) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel(SETTINGS_LABEL);
    if (existing !== null) {
      await existing.setFocus();
      return existing.label;
    }
    const win = new WebviewWindow(SETTINGS_LABEL, {
      url: `index.html?view=settings${suffix}`,
      title: 'Voxaura — الإعدادات',
      width: 720,
      height: 600,
      minWidth: 640,
      minHeight: 500,
      resizable: true,
      decorations: true,
      center: true,
    });
    return win.label;
  }
  window.open(
    `index.html?view=settings${suffix}`,
    'voxaura-settings',
    'width=720,height=600,menubar=no,toolbar=no',
  );
  return SETTINGS_LABEL;
}

/** True when this document is the dedicated settings surface. */
export function isSettingsView(search: string = window.location.search): boolean {
  return search.includes('view=settings');
}