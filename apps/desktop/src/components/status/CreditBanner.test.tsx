import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CreditBanner,
  INITIAL_CREDIT,
  creditDismiss,
  creditNotice,
  creditVoice,
  isCreditNotice,
  type CreditState,
} from './CreditBanner.js';

// M4 C.3 — the TTS-credit banner. RED FIRST.
//
// Before this the daemon's credit interceptor emitted a `warn` notice through
// the GENERIC pipe (`daemon.ts` → `ui.notice(credit.noticeCode, …)`), so the
// shell could not tell "your Fish balance is gone, top up" apart from a
// transient STT timeout — same level, same slot, same one-line strip.
//
// What is pinned here, in order of how badly it would hurt if it rotted:
//   1. the ARM MAPPING and the arm semantics (which arm may be dismissed),
//   2. one banner, not a stack — a 402 fires on EVERY turn, so a repeat must
//      not re-announce an `aria-live="assertive"` region to a voice-first user,
//   3. the clear path (a later `speaking` phase proves the fault is not
//      reproducing), including the ORDERING — speaking precedes the fault,
//   4. the negative: a non-credit notice must render no banner at all,
//   5. the day count is the daemon's, verbatim.
//
// Every guard here has been broken by hand and watched fail; see the report.

/** The daemon's OWN strings, copied from `src/voice/tts-credit.ts`. */
const DETAIL_EXHAUSTED = 'نفد رصيد TTS — اشحن رصيد Fish لتشغيل الصوت. الاشتراك المجاني لا يحمل ضمان تجديد.';
const DETAIL_OVERDUE_9D = 'نفدت رصيد TTS منذ 9 يوم ولم يُشحن — الصوت متوقف. اشحن رصيد Fish لتشغيله.';
const DETAIL_RENEWAL_3D = 'اشتراك TTS ينتهي بعد 3 يوم — شحن مسبقاً لتفادي انقطاع الصوت';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(state: CreditState, onDismiss: () => void = (): void => {}): void {
  // A second `mount` replaces the first host. Without this a remount leaves two
  // hosts in `body` and a count-based assertion reads 2 banners where the
  // component rendered 1 — a green test for the wrong reason.
  act(() => {
    root?.unmount();
  });
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<CreditBanner state={state} onDismiss={onDismiss} />);
  });
}

function rerender(state: CreditState, onDismiss: () => void = (): void => {}): void {
  act(() => {
    root!.render(<CreditBanner state={state} onDismiss={onDismiss} />);
  });
}

function banners(): NodeListOf<Element> {
  return document.body.querySelectorAll('[data-testid="credit-banner"]');
}

function banner(): Element | null {
  return banners()[0] ?? null;
}

/** Feed one `notice` frame through the reducer, exactly as `App.onNotice` does. */
function withNotice(state: CreditState, code: string, detail: string): CreditState {
  return creditNotice(state, code, detail);
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

describe('credit arm mapping', () => {
  // REACHABLE TODAY. `daemon.ts` calls `ttsCredit.recordFault(err)` on every
  // FishCreditError (402/429) and publishes `status().noticeCode`, which is
  // `tts-credit-exhausted` below `TOPUP_ADVISORY_DAYS` (7) and
  // `tts-credit-exhausted-overdue` at or above it. Both are produced by the
  // one interceptor; nothing else in the tree emits either code.
  test('tts-credit-exhausted is the warn arm and IS dismissible', () => {
    mount(withNotice(INITIAL_CREDIT, 'tts-credit-exhausted', DETAIL_EXHAUSTED));
    const el = banner();
    expect(el?.getAttribute('data-code')).toBe('tts-credit-exhausted');
    expect(el?.getAttribute('data-arm')).toBe('warn');
    expect(el?.getAttribute('data-dismissible')).toBe('true');
    expect(el?.getAttribute('aria-live')).toBe('assertive');
    expect(el?.querySelector('[data-testid="credit-banner-dismiss"]')).not.toBeNull();
  });

  test('tts-credit-exhausted-overdue escalates and is LATCHED — not dismissible', () => {
    mount(withNotice(INITIAL_CREDIT, 'tts-credit-exhausted-overdue', DETAIL_OVERDUE_9D));
    const el = banner();
    expect(el?.getAttribute('data-code')).toBe('tts-credit-exhausted-overdue');
    expect(el?.getAttribute('data-arm')).toBe('escalate');
    expect(el?.getAttribute('data-dismissible')).toBe('false');
    // No close control at all — a dismiss affordance on this arm would hide the
    // only signal a user has that their voice has been dead for a week.
    expect(el?.querySelector('[data-testid="credit-banner-dismiss"]')).toBeNull();
    // And the reducer agrees: a dismiss action on the latched arm is a no-op.
    const latched = withNotice(INITIAL_CREDIT, 'tts-credit-exhausted-overdue', DETAIL_OVERDUE_9D);
    expect(creditDismiss(latched)).toBe(latched);
  });

  // UNREACHABLE TODAY — mapped anyway, and pinned as mapped so it cannot rot.
  // `tts-renewal-soon` is produced ONLY by the `renewalAt !== null` branch of
  // `TtsCreditMonitor.status()`, and `setRenewalAt()` has NO production caller
  // in the tree (only `tts-credit.test.ts` calls it). Fish publishes no renewal
  // date for the API tier, so the arm is here to make the hook honest the day an
  // owner supplies a date — not because anything can emit it now. No daemon
  // change is involved: the day count still comes from `noticeDetailAr`.
  test('tts-renewal-soon is the advisory arm and is dismissible', () => {
    mount(withNotice(INITIAL_CREDIT, 'tts-renewal-soon', DETAIL_RENEWAL_3D));
    const el = banner();
    expect(el?.getAttribute('data-code')).toBe('tts-renewal-soon');
    expect(el?.getAttribute('data-arm')).toBe('advisory');
    expect(el?.getAttribute('data-dismissible')).toBe('true');
    expect(el?.querySelector('[data-testid="credit-banner-dismiss"]')).not.toBeNull();
  });

  // The day count is the DAEMON's. A renderer that re-derived it would own a
  // second clock and a second wording, and the two would disagree the moment a
  // boundary moved — the exact drift this component exists to avoid.
  test('the day count and the wording pass through VERBATIM', () => {
    mount(withNotice(INITIAL_CREDIT, 'tts-credit-exhausted-overdue', DETAIL_OVERDUE_9D));
    const el = banner();
    expect(el?.querySelector('[data-testid="credit-banner-text"]')?.textContent).toBe(DETAIL_OVERDUE_9D);
    expect(el?.getAttribute('title')).toBe(DETAIL_OVERDUE_9D);
    // Nothing else in the rendered banner carries a number the renderer added.
    const text = el?.textContent ?? '';
    expect(text.split('9').length - 1).toBe(1);
  });
});

describe('one banner, not a stack', () => {
  // A 402 fires on EVERY turn the user speaks, so the same notice arrives
  // repeatedly. Re-announcing an assertive live region each time is worse than
  // showing nothing, and stacking duplicates would grow the auto-sized window.
  test('two identical notices in a row produce ONE banner and do not re-announce', () => {
    const first = withNotice(INITIAL_CREDIT, 'tts-credit-exhausted', DETAIL_EXHAUSTED);
    mount(first);
    expect(banners().length).toBe(1);
    const idBefore = banner()?.getAttribute('data-banner-id');

    rerender(withNotice(first, 'tts-credit-exhausted', DETAIL_EXHAUSTED));
    expect(banners().length).toBe(1);
    // Same id => the SAME banner instance, so the live region is not
    // torn down and rebuilt (which is what re-announces it).
    expect(banner()?.getAttribute('data-banner-id')).toBe(idBefore);

    // A genuinely different notice IS a new banner — the guard must not be a
    // "ignore everything after the first" that hides the escalation.
    rerender(withNotice(first, 'tts-credit-exhausted-overdue', DETAIL_OVERDUE_9D));
    expect(banners().length).toBe(1);
    expect(banner()?.getAttribute('data-code')).toBe('tts-credit-exhausted-overdue');
    expect(banner()?.getAttribute('data-banner-id')).not.toBe(idBefore);
  });

  // The negative. These are real codes the shell receives; none may grow a
  // credit banner, or the escalation would stop meaning anything.
  test('an unrelated notice code renders NO banner', () => {
    for (const code of [
      'assistant-said',
      'tts-failed',
      'voice-disabled-no-keys',
      'stt-timeout',
      'transport',
      'persona-changed',
      '',
    ]) {
      mount(INITIAL_CREDIT);
      expect(isCreditNotice(code), code).toBe(false);
      rerender(withNotice(INITIAL_CREDIT, code, 'نص عربي عادي'));
      expect(banners().length, code).toBe(0);
    }
  });
});

describe('clear path', () => {
  // The daemon sets phase `speaking` at `daemon.ts:1166`, BEFORE synthesis, and
  // a credit fault arrives after it. So a `speaking` frame proves the turn got
  // as far as TTS without the fault reproducing — which is the only credit
  // signal the shell can act on, and it needs no daemon change and no command.
  test('a speaking phase clears a shown banner', () => {
    const shown = withNotice(INITIAL_CREDIT, 'tts-credit-exhausted', DETAIL_EXHAUSTED);
    mount(shown);
    expect(banners().length).toBe(1);

    rerender(creditVoice(shown, 'speaking'));
    expect(banners().length).toBe(0);
  });

  test('a non-speaking phase does NOT clear a shown banner', () => {
    const shown = withNotice(INITIAL_CREDIT, 'tts-credit-exhausted-overdue', DETAIL_OVERDUE_9D);
    mount(shown);
    for (const phase of ['idle', 'listening', 'thinking'] as const) {
      rerender(creditVoice(shown, phase));
      expect(banner()?.getAttribute('data-code'), phase).toBe('tts-credit-exhausted-overdue');
    }
  });

  test('speaking BEFORE the fault must not swallow the banner', () => {
    const spoken = creditVoice(INITIAL_CREDIT, 'speaking');
    const faulted = withNotice(spoken, 'tts-credit-exhausted-overdue', DETAIL_OVERDUE_9D);
    mount(faulted);
    expect(banner()?.getAttribute('data-code')).toBe('tts-credit-exhausted-overdue');
    // It stays up until audio actually comes back.
    mount(creditVoice(faulted, 'speaking'));
    expect(banners().length).toBe(0);
  });

  test('a speaking phase with no banner shown is a no-op', () => {
    expect(creditVoice(INITIAL_CREDIT, 'speaking')).toBe(INITIAL_CREDIT);
    mount(INITIAL_CREDIT);
    expect(banners().length).toBe(0);
  });

  test('dismissing a dismissible arm calls back and clears it', () => {
    let calls = 0;
    const shown = withNotice(INITIAL_CREDIT, 'tts-credit-exhausted', DETAIL_EXHAUSTED);
    mount(shown, () => {
      calls += 1;
    });
    const btn = banner()?.querySelector('[data-testid="credit-banner-dismiss"]');
    expect(btn).not.toBeNull();
    act(() => {
      (btn as HTMLButtonElement).click();
    });
    expect(calls).toBe(1);
    // The parent owns the state; this component owns nothing it cannot undo.
    expect(banners().length).toBe(1);
  });
});
