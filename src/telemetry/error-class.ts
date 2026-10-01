import { OrchestratorError, httpStatusOf } from '../common/errors.js';
import type { SanitizedErrorClass } from './writer.js';

// THE ERROR CLASSIFIER — one pure function, shared by every telemetry row.
//
// WHY IT IS ITS OWN MODULE AND NOT A CLOSURE. It used to be a `const classify`
// defined inside `startDaemon`, which has two costs and both were paid: it could
// not be imported by a test, so the only way to learn what it did with a given
// error was to boot a whole daemon and read the JSONL; and nothing in the suite
// exercised it with a REAL error object, which is why `SttTimeoutError` was
// classified `Unknown` for the daemon's entire life while every row it wrote
// looked plausible. A closure over nothing is a testing liability, not a design.
//
// `daemon.ts` keeps the name `classify` and every `classify(err)` call site, and
// delegates here, so the telemetry-wiring guard keeps matching the call it pins.
//
// NEVER LEAKS A MESSAGE. The closed union is the whole point: there is no free
// text on this path, so a provider error string cannot reach the JSONL through
// the class. Message text is read in exactly one place, below, and only to
// recognise a fetch-shaped `TypeError`.

/**
 * The timeout/abort NAME FAMILY, matched as an anchored SUFFIX.
 *
 * The predecessor was `name === 'AbortError' || name === 'TimeoutError'` — a
 * two-string list. It was wrong for every provider timeout in this codebase:
 * `SttTimeoutError` and `TtsTimeoutError` both end in `TimeoutError`, and both
 * logged as `Unknown`. A list of names rots the instant a module adds a class,
 * and nothing noticed, because the list was only ever fed names that happened
 * to be in it.
 *
 * WHY A SUFFIX AND NOT A SUBSTRING. `/timeout/i` would also match a future
 * `TimeoutPolicyError`, an unrelated `TimeoutPolicy` value, or a message. The
 * `$` anchor means a name must DECLARE itself a timeout or an abort, which is
 * the convention this codebase and the platform both already follow. Measured
 * against every error class this tree can produce, the suffix matches the four
 * timeouts and nothing else.
 *
 * WHY NOT `instanceof`, which the recorded fix note for A.11 suggested. The SDK
 * errors are the reason, and they cut against instanceof: the Groq/Stainless
 * classes set NO `name` at all, so `err.name` is the literal string `'Error'` for
 * every one of them, and `instanceof` would need an import of each provider's
 * error module to see them at all. `constructor.name` reaches them with no
 * dependency. instanceof also fails across a duplicated module copy, which
 * matters because this ships as a bundled sidecar.
 *
 * THE RESIDUAL, STATED RATHER THAN HANDED OFF: an error deliberately NAMED
 * `SomethingTimeoutError` that is not a timeout lands here. That is a naming bug
 * at its source obeying the convention, not a hole in the rule.
 */
const TIMEOUT_FAMILY = /(?:Timeout|Abort)Error$/;

/**
 * The name-shaped signals of an error, as a union.
 *
 * `err.name` and `constructor.name` are NOT interchangeable, and taking either
 * one alone loses a real class. Measured:
 *
 *   DOMException (AbortController, `AbortSignal.timeout`) → name `AbortError` /
 *     `TimeoutError`, constructor `DOMException`
 *   groq `APIConnectionTimeoutError` / `APIUserAbortError` → name **`'Error'`**,
 *     constructor carries the whole truth
 *
 * So the platform's two and the SDK's two are mirror images, and the union is
 * the only rule that classifies all four. Both halves are break-tested.
 */
function timeoutFamilyName(err: Error): string[] {
  const ctorName = err.constructor?.name;
  return typeof ctorName === 'string' && ctorName !== '' ? [err.name, ctorName] : [err.name];
}

/**
 * Map a thrown value to the closed error-class union.
 *
 * Total: every input returns a member, including a non-`Error` throw. The
 * `Unknown` arm is a real answer — it means "the code saw a shape it does not
 * recognise" — and it is deliberately not removable, because a classifier with
 * no fallback would have to throw inside an error handler.
 */
export function classifyError(err: unknown): SanitizedErrorClass {
  if (err instanceof OrchestratorError) {
    // Keyed on `code`, which is a closed union, so this arm cannot rot the way a
    // name list does. Before the brain stopped reporting every failure as
    // BRAIN_TIMEOUT (L24), quota exhaustion — the live blocker — was
    // indistinguishable from a slow network here.
    if (err.code === 'RATE_LIMITED') return 'QuotaExceeded';
    if (err.code === 'BRAIN_AUTH') return 'AuthError';
    if (err.code === 'BRAIN_REJECTED') return 'FetchError';
    if (err.code === 'SERVE_UNREACHABLE' || err.code === 'SSE_DISCONNECTED') return 'FetchError';
    if (err.code === 'CONFIG_INVALID' || err.code === 'HIGH_STAKES_CONFIRM_REQUIRED') return 'AuthError';
    if (err.code === 'CONTRACT_DRIFT') return 'ContractDrift';
    return 'Unknown';
  }
  if (!(err instanceof Error)) return 'Unknown';
  if (timeoutFamilyName(err).some((name) => TIMEOUT_FAMILY.test(name))) return 'TimeoutError';
  if (err.name === 'ZodError') return 'ZodError';
  // The one place a message is read, and it is read as a SHAPE test, never
  // copied out. A `TypeError` from undici's fetch is the only one that means a
  // network fault; a `TypeError` from our own code is a bug and stays Unknown.
  if (err.name === 'TypeError' && /fetch|network|socket/i.test(err.message)) return 'FetchError';
  // A provider status, when the error carries one. `httpStatusOf` is the
  // existing recovery used for key rotation, and it returns `undefined` for a
  // stopped waiter — a deadline that expired must never be read as a provider
  // fault, which is the same distinction the timeout family draws above.
  const status = httpStatusOf(err);
  if (status === 401) return 'AuthError';
  // 402 and 429 are BOTH an exhausted allowance and both mean the same thing to
  // whoever reads this: the balance is gone, the key is fine. `A.4` split them
  // on the ROTATION path because 429 rotates and 402 must not — but that
  // distinction is about which key to try next, not about what class the failure
  // is, and folding them here would put a 402 back in the rate-limit bucket.
  // 402 is the case the census caught: `FishCreditError` carries `.status`, so
  // the `TTS_CREDIT_402` row used to be filed `Unknown` — a credit fault
  // reported as an unidentified error.
  if (status === 402 || status === 429) return 'QuotaExceeded';
  if (status !== undefined && status >= 500) return 'FetchError';
  return 'Unknown';
}
