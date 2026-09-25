// Window launcher — Tauri v2 native windows when running inside the app, a
// same-origin popup during web/E2E runs. Each surface has its own label so the
// OS keeps them independent; the settings and keys views never share a window.
export const SETTINGS_LABEL = 'settings';
export const KEYS_LABEL = 'api-keys';

export function isTauriHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

interface SpawnOptions {
  readonly label: string;
  readonly title: string;
  readonly query?: string;
}

async function spawn({ label, title, query = '' }: SpawnOptions): Promise<string> {
  const suffix = query.length > 0 ? `&${query}` : '';
  if (isTauriHost()) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel(label);
    if (existing !== null) {
      await existing.setFocus();
      return label;
    }
    const win = new WebviewWindow(label, {
      url: `index.html?${query}${suffix}`,
      title,
      width: 720,
      height: 600,
      minWidth: 560,
      minHeight: 460,
      resizable: true,
      decorations: true,
      center: true,
    });
    return win.label;
  }
  window.open(`index.html?${query}${suffix}`, `voxaura-${label}`, 'width=720,height=600,menubar=no,toolbar=no');
  return label;
}

/** General settings window (?view=settings). */
export function openSettingsWindow(persona?: 'kareem' | 'nour'): Promise<string> {
  return spawn({
    label: SETTINGS_LABEL,
    title: 'Voxaura — الإعدادات',
    query: persona !== undefined ? `view=settings&persona=${persona}` : 'view=settings',
  });
}

/** Dedicated API-keys window (?view=keys). */
export function openKeysWindow(): Promise<string> {
  return spawn({ label: KEYS_LABEL, title: 'Voxaura — مفاتيح الـ API', query: 'view=keys' });
}

/** True when this document is the dedicated settings surface. */
export function isSettingsView(search: string = window.location.search): boolean {
  return search.includes('view=settings');
}

/** True when this document is the dedicated API-keys surface. */
export function isKeysView(search: string = window.location.search): boolean {
  return search.includes('view=keys');
}