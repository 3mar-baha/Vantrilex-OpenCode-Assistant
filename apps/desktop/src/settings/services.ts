// Zero-click bring-up: ask the Tauri host to nudge `opencode serve` (4096) and
// the Node daemon (4097) into existence. Outside Tauri (web/E2E) this is a
// no-op, because a browser has no business spawning host processes.
export interface EnsureResult {
  readonly ok: boolean;
  readonly detail: string;
}

export async function ensureServices(): Promise<EnsureResult | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const lines = await invoke<string[]>('ensure_all_services');
    return { ok: true, detail: lines.join(' · ') };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}