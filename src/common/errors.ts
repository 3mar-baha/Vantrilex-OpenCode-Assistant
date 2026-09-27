// Typed errors — only secretSafeMessage may reach logs/ledger/UI.
// See docs/05-DATA-MODEL.md §5.7 and docs/12-SECURITY.md I-5.
export type ErrorCode =
  | 'SERVE_UNREACHABLE' | 'CONTRACT_DRIFT' | 'SSE_DISCONNECTED'
  | 'SESSION_NOT_FOUND' | 'SESSION_BUSY' | 'STT_FAILED' | 'BRAIN_TIMEOUT'
  // L24: six distinct brain failures (auth rejection, 429, 5xx, provider error,
  // empty completion, timeout) were all reported as BRAIN_TIMEOUT, which made an
  // expired key indistinguishable from a slow network and hid quota exhaustion
  // from anything keying off the code. BRAIN_REJECTED covers a refusal the
  // provider actually returned; 401/403 and 429 get their own codes because the
  // user action differs (rotate the key vs wait for quota).
  | 'BRAIN_REJECTED' | 'BRAIN_AUTH'
  | 'TTS_FAILED' | 'AUDIO_DEVICE_MISSING' | 'VAULT_CORRUPT'
  | 'POOL_EXHAUSTED' | 'RATE_LIMITED' | 'APPROVAL_EXPIRED'
  | 'CONFIG_INVALID' | 'ALREADY_RUNNING' | 'HIGH_STAKES_CONFIRM_REQUIRED';

export class OrchestratorError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly secretSafeMessage: string;

  constructor(code: ErrorCode, retryable: boolean, secretSafeMessage: string) {
    super(secretSafeMessage);
    this.name = 'OrchestratorError';
    this.code = code;
    this.retryable = retryable;
    this.secretSafeMessage = secretSafeMessage;
  }
}

/**
 * L17: recover the HTTP status from a thrown value, for key rotation.
 *
 * `Keyring.release(key, ok, status)` advances the pool only on 429/401/403. Every
 * call site in the daemon and the CLI passed an unconditional `true`, so a
 * rejected key never rotated: the same dead credential was retried until STT and
 * the brain went silent, and a dead key looked exactly like a healthy one.
 *
 * The status has to be recovered from the error because no error type carries
 * it directly. `OrchestratorError` has a `code` but not a status, and the two
 * provider SDKs differ: `openRouterChat` goes through `fetch` and collapses the
 * response into a code, while STT goes through `groq-sdk`, whose `APIError`
 * exposes `readonly status`. Both shapes are handled, and anything unrecognised
 * returns `undefined` — which means "do not rotate", the safe direction: a
 * network blip or a 5xx must not burn through a valid key pool.
 *
 * 401 and 403 both collapse to 401 on purpose. They are distinct HTTP statuses
 * but the same user action and the same rotation, and `release` only branches on
 * 429 vs auth.
 */
export function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof OrchestratorError) {
    // 401 and 403 are the same failure here; RATE_LIMITED is only ever 429.
    if (err.code === 'BRAIN_AUTH') return 401;
    if (err.code === 'RATE_LIMITED') return 429;
    // Everything else is a provider, network or parse failure: not a key fault.
    return undefined;
  }
  // groq-sdk APIError, and anything else shaped like a fetch Response error.
  if (typeof err === 'object' && err !== null) {
    const direct = (err as { status?: unknown }).status;
    if (typeof direct === 'number') return direct;
    // openai/groq SDKs wrap the payload: { error: { status } }.
    const nested = (err as { error?: { status?: unknown } }).error;
    if (typeof nested === 'object' && nested !== null && typeof nested.status === 'number') {
      return nested.status;
    }
  }
  return undefined;
}
