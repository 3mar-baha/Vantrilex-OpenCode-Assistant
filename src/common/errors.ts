// Typed errors — only secretSafeMessage may reach logs/ledger/UI.
// See docs/05-DATA-MODEL.md §5.7 and docs/12-SECURITY.md I-5.
export type ErrorCode =
  | 'SERVE_UNREACHABLE' | 'CONTRACT_DRIFT' | 'SSE_DISCONNECTED'
  | 'SESSION_NOT_FOUND' | 'SESSION_BUSY' | 'STT_FAILED' | 'BRAIN_TIMEOUT'
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
