// Runtime IPC identity (H4). The token is never compiled into the bundle:
// inside Tauri the shell asks the Rust host for the per-install token the
// daemon wrote to `~/.opencode-voice-runtime/ipc.token`. During web/E2E runs
// the operator-provided VITE variable is the fallback, because there is no
// Rust host in a plain browser.
export function envToken(): string | undefined {
  const token = import.meta.env['VOICE_RUNTIME_IPC_TOKEN'] as string | undefined;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

export function isTauriHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Resolve the IPC token for this window; undefined when unavailable (fail-closed). */
export async function resolveIpcToken(): Promise<string | undefined> {
  const fromEnv = envToken();
  if (fromEnv !== undefined) return fromEnv;
  if (!isTauriHost()) return undefined;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const token = await invoke<string>('ipc_token');
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}