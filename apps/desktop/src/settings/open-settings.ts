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

/**
 * The window URL for a launcher query.
 *
 * `query` is the COMPLETE query string (e.g. `view=settings&persona=kareem`), so
 * it is appended exactly once. It previously read `?${query}${suffix}` where
 * `suffix` was `&${query}` — producing `?view=keys&view=keys` on EVERY call,
 * in both the Tauri and the web path (present since 7d3bc68, 2026-09-25).
 *
 * WHY IT SURVIVED: every consumer here reads the query with
 * `search.includes('view=keys')`, and `'?view=keys&view=keys'.includes('view=keys')`
 * is true. A duplicated parameter is indistinguishable from a correct one under
 * a substring test, so the bug was invisible to every caller and to the E2E
 * suite, which asserts `url()).toContain('view=keys')`.
 *
 * The `includes()` predicates are left alone: they are lenient, not wrong, and
 * the values they match are caller-supplied and controlled. The test that now
 * pins this counts OCCURRENCES, which is what a substring assertion cannot do.
 *
 * A bare `?` is avoided when there is no query, so the result stays a
 * well-formed `index.html` rather than `index.html?`.
 */
function windowUrl(query: string): string {
  return query.length > 0 ? `index.html?${query}` : 'index.html';
}

async function spawn({ label, title, query = '' }: SpawnOptions): Promise<string> {
  const url = windowUrl(query);
  if (isTauriHost()) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel(label);
    if (existing !== null) {
      await existing.setFocus();
      return label;
    }
    const win = new WebviewWindow(label, {
      url,
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
  window.open(url, `voxaura-${label}`, 'width=720,height=600,menubar=no,toolbar=no');
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