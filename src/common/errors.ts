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
