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
  // A.4: HTTP 402 is an exhausted balance, which is NOT the same fault as 429.
  // Collapsing it into RATE_LIMITED would look right at the throw site and be
  // wrong everywhere else: `httpStatusOf` maps RATE_LIMITED to 429, and
  // `Keyring.release` advances the pool on 429, so a 402 would rotate a key that
  // is perfectly valid and spend three requests per turn on an empty balance.
  // Its own code is what makes "do not retry" and "do not rotate" independent.
  | 'BRAIN_CREDIT'
  | 'TTS_FAILED' | 'AUDIO_DEVICE_MISSING' | 'VAULT_CORRUPT'
  | 'POOL_EXHAUSTED' | 'RATE_LIMITED' | 'APPROVAL_EXPIRED'
  | 'CONFIG_INVALID' | 'ALREADY_RUNNING' | 'HIGH_STAKES_CONFIRM_REQUIRED'
  // M1 — three failures that are not "the session is busy" and were all filed
  // under it. `SESSION_BUSY` means ONE thing: serve answered 409 because the
  // session is mid-turn. These three are daemon-side, and each has a different
  // user action, which is the same reason `BRAIN_REJECTED`/`BRAIN_AUTH`/
  // `BRAIN_CREDIT` are three codes and not one:
  //
  //   TASK_TIMEOUT   — the DAEMON stopped waiting (the task engine's deadline).
  //                    The command may STILL be running inside serve; we only
  //                    know we gave up. Reporting this as "busy" tells the user
  //                    to wait, which is exactly the wrong advice: waiting is
  //                    what already happened and it did not help.
  //   CANCELLED      — the user (or the queue) ended the work before it
  //                    completed. The action is deliberate, not a fault, and a
  //                    shell that words it as a failure invites a retry of
  //                    something the user just declined to finish.
  //   DAEMON_STOPPED — the process went away with the command in flight. The
  //                    user needs to know the app closed, not that a session
  //                    is busy.
  //
  // None of the three is retryable in the `SESSION_BUSY` sense: retrying the
  // same call against the same session is not what any of them needs. The
  // task-timeout arm is the one place where that is subtle — the engine marks
  // it retryable because the *command* may still complete — so the retryable
  // flag is a property of the THROW SITE, and these codes exist so the ack can
  // name the condition even when the flag says a retry might help.
  | 'TASK_TIMEOUT' | 'CANCELLED' | 'DAEMON_STOPPED';

/**
 * WHY A STOPPED WAITER IS A DISCRIMINANT AND NOT A CODE.
 *
 * The throw sites for the three codes above live in `daemon/shell-tasks.ts`.
 * Widening the union alone left every one of them still constructing
 * `OrchestratorError('SESSION_BUSY', …)` and the shell still seeing
 * `SESSION_BUSY`, so the discrimination was made where the fact exists — the
 * stop reason — and the CODE is derived from it at the boundary where a code
 * becomes user-visible.
 *
 * `stopReason` on the class is that mechanism, and it is now the ONLY one.
 *
 * THE MESSAGE-PREFIX SHIM IS GONE, and this paragraph is why it can be. While
 * the throw sites were un-migrated there was a compatibility table here:
 * `SHELL_STOP_MESSAGE_PREFIXES`, and a `startsWith` loop in `stopReasonOf` that
 * recovered the reason by matching `secretSafeMessage` against prose authored
 * in another file. It needed a pin test to keep from rotting silently, it made
 * a user-facing code depend on a rewording in `shell-tasks.ts`, and a
 * substring search over free text is one provider message away from firing on
 * the wrong error.
 *
 * Every stop site now passes the fourth constructor argument, so `stopReasonOf`
 * returns at the typed field and the table could not decide anything even while
 * it existed. `daemon/shell-task-stop-reason.test.ts` is the guard that keeps
 * that true — it fails if a throw site stops setting the reason — and
 * `ack-truth.test.ts` asserts the consequence at the ack, including the case a
 * re-added loop would silently reverse: an error carrying one of the legacy
 * prefix strings and NO reason is now reported as `SESSION_BUSY`, because text
 * is no longer consulted.
 *
 * `code` remains `SESSION_BUSY` at the throw sites, and that is deliberate: the
 * observable code is `SHELL_STOP_REASON_CODES[stopReason]` at every sink, so
 * re-coding the literal at the site would change nothing a caller can see.
 */
export type ShellStopReason = 'timeout' | 'cancelled' | 'daemon-stopped';

/** The code each stop reason is reported as. One map, one direction. */
export const SHELL_STOP_REASON_CODES: Readonly<Record<ShellStopReason, ErrorCode>> = {
  timeout: 'TASK_TIMEOUT',
  cancelled: 'CANCELLED',
  'daemon-stopped': 'DAEMON_STOPPED',
};

/**
 * The reason a waiter stopped, or `null` when it is not one of the three.
 *
 * ONE FIELD, ONE LOOK. It reads `stopReason` and nothing else — no message text,
 * no table, no fallback. A throw site that knows why it stopped says so at
 * construction; a throw site that does not is not a stop, and `null` is the
 * honest answer for it rather than a guess made from its wording.
 */
export function stopReasonOf(err: unknown): ShellStopReason | null {
  if (!(err instanceof OrchestratorError)) return null;
  return err.stopReason;
}

/**
 * The code a thrown value should be REPORTED as.
 *
 * `SESSION_BUSY` is preserved for serve's own 409 and nothing else: the three
 * daemon-side stop conditions are re-coded here from `stopReason` rather than at
 * the throw site, because the throw site is not this change's to edit and
 * re-coding at the sink is the same discipline `UiServer.notice()` already uses
 * for redaction — one place, so the next throw site cannot forget.
 *
 * A non-`OrchestratorError` is `'internal'`, unchanged: an unrecognised throw
 * has no code and inventing one would be a guess. `'internal'` is deliberately
 * NOT an `ErrorCode` member — it is the router's own literal for "something
 * threw that this layer cannot classify", and folding it into the union would
 * put a catch-all inside the taxonomy it is supposed to sit beside.
 */
export function errorCodeFor(err: unknown): ErrorCode | 'internal' {
  if (!(err instanceof OrchestratorError)) return 'internal';
  const stop = stopReasonOf(err);
  return stop === null ? err.code : SHELL_STOP_REASON_CODES[stop];
}

export class OrchestratorError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly secretSafeMessage: string;
  /**
   * Set when the throw site KNOWS it stopped waiting, and for what reason.
   *
   * `null` (the default) means exactly one thing: "not a stop". There is no
   * longer a text-matching fallback for a throw site that has not been
   * migrated, so setting this field is the only way to be classified as a
   * timeout, a cancellation or the daemon going away — which is the point. Every
   * stop site in `daemon/shell-tasks.ts` passes it, and the classification of a
   * failure cannot be changed by rewording a message in another file.
   */
  readonly stopReason: ShellStopReason | null;

  constructor(
    code: ErrorCode,
    retryable: boolean,
    secretSafeMessage: string,
    stopReason: ShellStopReason | null = null,
  ) {
    super(secretSafeMessage);
    this.name = 'OrchestratorError';
    this.code = code;
    this.retryable = retryable;
    this.secretSafeMessage = secretSafeMessage;
    this.stopReason = stopReason;
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
    // A.4, and it must precede the RATE_LIMITED arm: 402 is an empty balance,
    // not a throttle, so it must never be reported as 429 (which `release` treats
    // as a rotation trigger). It is returned as 402 only so the status is visible
    // to callers; `release` branches on 429/401/403, so 402 does not rotate.
    if (err.code === 'BRAIN_CREDIT') return 402;
    if (err.code === 'RATE_LIMITED') return 429;
    // EXPLICIT, not implied by the fallthrough: a stopped waiter is not a
    // provider fault and must never advance the pool. `TASK_TIMEOUT` is the one
    // arm where that would have been silent and expensive — a 15-minute task
    // deadline expiring looks nothing like a credential problem, and a key
    // rotation here would spend the user's remaining keys on a command that was
    // never going to be authenticated differently.
    //
    // IT TESTS `stopReasonOf`, NOT `err.code`, and that is a correction. An
    // earlier version listed the three code literals here, which is DEAD CODE
    // for the case that exists: a throw site that knows it stopped sets
    // `stopReason` and still carries `code: 'SESSION_BUSY'` (that is what
    // `shell-tasks.ts` constructs today), so a `err.code === 'TASK_TIMEOUT'`
    // arm never fires and the guarantee it was written to give is an accident of
    // the fallthrough. The break-guard for it was written against the
    // code-keyed form first, went green when it should have gone red, and that
    // is the only reason this is stated here. `stopReasonOf` reads the typed
    // field only, so a caller holding a re-coded `TASK_TIMEOUT` with no reason
    // on it is NOT covered here — which is correct, because that shape does not
    // exist: every stop site sets the field.
    if (stopReasonOf(err) !== null) return undefined;
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
