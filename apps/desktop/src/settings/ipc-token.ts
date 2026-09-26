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

export interface TokenRetryOptions {
  /** Resolution probe; defaults to `resolveIpcToken`. */
  readonly resolve?: () => Promise<string | undefined>;
  /** Attempts before giving up (default 20 ≈ 10 s at the default delay). */
  readonly attempts?: number;
  /** Delay between attempts in ms. */
  readonly delayMs?: number;
  /** Injected sleep for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Cold-start token resolution. On a fresh install the daemon writes
 * `ipc.token` a moment after the webview mounts; resolving once raced it and
 * left the HUD permanently disconnected with no retry. This polls a bounded
 * number of times so a slow bring-up converges without the user.
 */
export async function resolveIpcTokenWithRetry(options: TokenRetryOptions = {}): Promise<string | undefined> {
  const resolve = options.resolve ?? resolveIpcToken;
  const usingDefault = options.resolve === undefined;
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i += 1) {
    const token = await resolve();
    if (token !== undefined) return token;
    // Outside a Tauri host with no env token there is nothing to wait for: the
    // per-install file will never appear in a plain browser. Don't stall.
    if (usingDefault && !isTauriHost()) return undefined;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return undefined;
}