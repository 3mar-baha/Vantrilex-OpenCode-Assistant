// M4 C.3 — the TTS-credit banner.
//
// WHAT THIS IS FOR. The daemon's credit interceptor turns a Fish 402/429 into
// `ui.notice(credit.noticeCode, credit.noticeDetailAr, 'warn')` — the GENERIC
// notice pipe, which is indistinguishable in the shell from a transient STT
// timeout. Before this component the only credit surface was that strip, so
// "your Fish balance is gone, top up" and "that window was skipped" rendered
// identically and one of them was permanently true.
//
// SHAPE, and the window auto-sizes to its content (`useAutoSize` measures
// `scrollHeight`), so an absolutely-positioned overlay would be the wrong
// instrument: a fixed banner would either be clipped by the measured height or
// would push the HUD out of the frame. This renders IN FLOW, above the generic
// notice strip — it takes a row of the card's own height and is part of what is
// measured. That is also why the text truncates rather than wraps.
//
// THE DAY COUNT IS NOT OURS. It comes from the daemon's `noticeDetailAr`,
// verbatim, character for character. `TtsCreditMonitor` is the only clock that
// knows when the FIRST fault happened (`recordFault` never resets it) and the
// only one that owns the escalation threshold. A renderer that re-derived the
// count from `Date.now()` would own a second clock and a second wording, and
// the two would disagree the moment a boundary moved.
//
// REACHABILITY, stated because a branch that reads live is worse than no branch:
//
//   REACHABLE     `tts-credit-exhausted`          daemon.ts: the credit
//                 interceptor calls `recordFault` on every FishCreditError and
//                 publishes `status().noticeCode`; below `TOPUP_ADVISORY_DAYS`
//                 (7) that is this code. Emitted on the first fault.
//
//   REACHABLE     `tts-credit-exhausted-overdue`  the same branch once a fault
//                 arrives `TOPUP_ADVISORY_DAYS` or more after the first one. Two
//                 honest caveats: `status()` is only consulted at FAULT time, so
//                 a quiet week does not escalate on its own; and the monitor's
//                 first-fault clock is per daemon process, so a restart inside
//                 the week restarts it. Both belong to the daemon, not here.
//
//   UNREACHABLE   `tts-renewal-soon`              emitted only by the
//                 `renewalAt !== null` branch of `TtsCreditMonitor.status()`,
//                 and `setRenewalAt()` has NO production caller anywhere in the
//                 tree — only `src/voice/tts-credit.test.ts` calls it. Fish
//                 publishes no renewal date or allowance for the API tier, so
//                 there is no date to set. The arm is mapped and pinned so the
//                 hook is honest the day an owner supplies one; nothing can
//                 reach it today and this file claims no daemon change.
//
// THE CLEAR PATH IS THE ONLY AUTO-CLEAR, and it needs no daemon change. A
// `voice` frame with phase `speaking` arrives when the daemon reaches the TTS
// call (`daemon.ts:1166`, BEFORE synthesis, so a fault can still follow it in
// the same turn). Read precisely: it proves the turn got as far as synthesis
// without the credit fault reproducing — not that audio was rendered. That is
// the strongest credit signal the shell has without asking the provider, and if
// the fault does still reproduce the interceptor re-emits the notice, which
// re-arms the banner. No command is sent and `announce` is not written: a
// silent banner clearing is not a status line, and a voice-first user would
// hear a canned sentence about nothing.

/** Severity arms. Only `escalate` is latched. */
export type CreditArm = 'warn' | 'escalate' | 'advisory';

/**
 * Code -> arm. Keys are the `noticeCode` values `TtsCreditMonitor.status()`
 * can return; see the reachability notes above.
 */
export const CREDIT_ARMS: Readonly<Record<string, CreditArm>> = {
  'tts-credit-exhausted': 'warn',
  'tts-credit-exhausted-overdue': 'escalate',
  'tts-renewal-soon': 'advisory',
};

/** The arm for a code, or null when the code is not a credit code at all. */
export function creditArm(code: string): CreditArm | null {
  return Object.prototype.hasOwnProperty.call(CREDIT_ARMS, code) ? (CREDIT_ARMS[code] ?? null) : null;
}

/** True only for codes the credit monitor can emit. */
export function isCreditNotice(code: string): boolean {
  return creditArm(code) !== null;
}

/**
 * The overdue arm is LATCHED: a user who has been without voice for a week
 * must not be able to close the one thing telling them so. It clears when audio
 * demonstrably comes back, not when they ask.
 */
export function isArmDismissible(arm: CreditArm): boolean {
  return arm !== 'escalate';
}

export interface CreditEntry {
  /** Machine code, verbatim — never re-derived, never mapped to a label. */
  readonly code: string;
  /** The daemon's Arabic text, verbatim. Day counts included, unowned. */
  readonly detail: string;
  readonly arm: CreditArm;
  /**
   * Monotonic per banner INSTANCE. An identical repeat keeps the old id, which
   * is how "same banner" is told from "a second banner" — an assertive live
   * region that is torn down and rebuilt re-announces itself to a screen
   * reader, and a 402 repeats on every turn the user speaks.
   */
  readonly id: number;
}

export interface CreditState {
  readonly entry: CreditEntry | null;
  readonly nextId: number;
}

export const INITIAL_CREDIT: CreditState = { entry: null, nextId: 1 };

/**
 * Fold one `notice` frame in. Non-credit codes are a no-op returned by
 * identity, so an unrelated notice cannot re-render the banner.
 */
export function creditNotice(state: CreditState, code: string, detail: string): CreditState {
  const arm = creditArm(code);
  if (arm === null) return state;
  const current = state.entry;
  if (current !== null && current.code === code && current.detail === detail) return state;
  return { entry: { code, detail, arm, id: state.nextId }, nextId: state.nextId + 1 };
}

/**
 * Fold a `voice` frame in. ONLY `speaking` clears — `thinking` and `listening`
 * say nothing about the provider balance, and clearing on them would let a turn
 * that died in intake hide a top-up the user still owes.
 */
export function creditVoice(state: CreditState, phase: 'idle' | 'listening' | 'thinking' | 'speaking'): CreditState {
  if (phase !== 'speaking') return state;
  if (state.entry === null) return state;
  return { ...state, entry: null };
}

/** The close control. A no-op on a latched arm, so the UI and the reducer agree. */
export function creditDismiss(state: CreditState): CreditState {
  const current = state.entry;
  if (current === null || !isArmDismissible(current.arm)) return state;
  return { ...state, entry: null };
}

// Colour only. The words are the daemon's — see the header.
const ARM_STYLE: Readonly<Record<CreditArm, { readonly text: string; readonly bg: string }>> = {
  warn: { text: 'text-[#fbbf24]', bg: 'bg-[#0e0f12]' },
  escalate: { text: 'text-[#f87171]', bg: 'bg-[#1a1012]' },
  advisory: { text: 'text-[#38bdf8]', bg: 'bg-[#0b1418]' },
};

export interface CreditBannerProps {
  readonly state: CreditState;
  readonly onDismiss: () => void;
}

export function CreditBanner({ state, onDismiss }: CreditBannerProps): JSX.Element | null {
  const entry = state.entry;
  if (entry === null) return null;
  const dismissible = isArmDismissible(entry.arm);
  const style = ARM_STYLE[entry.arm];

  return (
    <div
      data-testid="credit-banner"
      data-code={entry.code}
      data-arm={entry.arm}
      data-banner-id={String(entry.id)}
      data-dismissible={String(dismissible)}
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      dir="rtl"
      // Verbatim, so the truncated text is recoverable on hover without the
      // renderer owning a second wording of the same sentence.
      title={entry.detail}
      className={`flex items-center gap-2 border-b border-[#26282e] px-4 py-2 text-xs ${style.bg} ${style.text}`}
    >
      <span data-testid="credit-banner-text" className="min-w-0 flex-1 truncate">
        {entry.detail}
      </span>
      {dismissible ? (
        <button
          data-testid="credit-banner-dismiss"
          type="button"
          aria-label="إخفاء تنبيه رصيد الصوت"
          title="إخفاء"
          onClick={onDismiss}
          className="shrink-0 px-1 opacity-70 hover:opacity-100"
        >
          ✕
        </button>
      ) : (
        <span data-testid="credit-banner-latched" aria-hidden="true" className="shrink-0 text-[#f87171]">
          🔒
        </span>
      )}
    </div>
  );
}
