// Zero-click bring-up: ask the Tauri host to nudge `opencode serve` (4096) and
// the Node daemon (4097) into existence. Outside Tauri (web/E2E) this is a
// no-op, because a browser has no business spawning host processes.
//
// L11: the host used to answer with `string[]`, which made "already bringing
// up", "worked" and "failed" indistinguishable. It now answers with a typed
// status carrying `state` and `retriable`; `in-flight` is retried a bounded
// number of times, and anything unrecognised fails closed rather than being
// reported as success.
export interface EnsureResult {
  readonly ok: boolean;
  readonly detail: string;
}

interface BringUpStatus {
  readonly state: 'ready' | 'in-flight' | 'failed';
  readonly detail: string;
  readonly retriable: boolean;
  readonly steps: readonly string[];
}

/** Bounded retry budget for `in-flight`. Not a polling loop: bring-up is seconds. */
const IN_FLIGHT_RETRIES = 3;
const RETRY_DELAY_MS = 400;

function isBringUpStatus(value: unknown): value is BringUpStatus {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['state'] === 'string' && typeof v['detail'] === 'string';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function ensureServices(): Promise<EnsureResult | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  let invoke: <T>(cmd: string) => Promise<T>;
  try {
    ({ invoke } = await import('@tauri-apps/api/core'));
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  try {
    for (let attempt = 0; ; attempt += 1) {
      const raw: unknown = await invoke('ensure_all_services');
      if (!isBringUpStatus(raw)) {
        // Fail closed: an unrecognised payload is not evidence of success.
        return { ok: false, detail: 'unrecognised bring-up response' };
      }
      if (raw.state === 'ready') {
        const detail = raw.steps.length > 0 ? raw.steps.join(' · ') : raw.detail;
        return { ok: true, detail };
      }
      if (raw.state === 'failed') {
        return { ok: false, detail: raw.detail };
      }
      // in-flight
      if (!raw.retriable || attempt >= IN_FLIGHT_RETRIES) {
        return { ok: false, detail: `${raw.detail} (gave up after ${attempt + 1} attempts)` };
      }
      await sleep(RETRY_DELAY_MS);
    }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
