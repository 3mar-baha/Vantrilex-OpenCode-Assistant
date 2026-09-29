import { FishCreditError } from './tts.js';

// The Fish Audio credit state the shell needs, and the rules for when to nag.
//
// WHY THIS IS NOT A TIMER. `s2.1-pro-free` is "$0 under unpublished fair-use
// limits" — Fish publishes no renewal date, no allowance and no reset time for
// the API tier. The website's "8,000 credits / ~7 minutes" plan is a DIFFERENT
// account and does not apply to an API caller. So there is no date in this
// product's data to count down to, and inventing one would be a fictional
// deadline shown to the user as fact.
//
// What can be known is factual:
//   - the tier is free-use and can be withdrawn without notice (the real risk);
//   - a 402 or 429 has already happened, which is proof the quota is gone.
//
// So the banner triggers on OBSERVED exhaustion, and the "7 days" the owner
// asked for becomes what it can honestly be: a countdown that starts from the
// first credit fault and warns that top-up is overdue, plus a standing advisory
// that the free tier carries no renewal guarantee. A countdown to a date Fish
// does not publish would be a lie with a progress bar.

/** Days of continued use after the first credit fault before the nag escalates. */
export const TOPUP_ADVISORY_DAYS = 7;

export type TtsCreditState = 'ok' | 'advisory' | 'topup-required';

export interface TtsCreditStatus {
  readonly state: TtsCreditState;
  /** Days since the first credit fault, or null if there has never been one. */
  readonly daysSinceFirstFault: number | null;
  /** Machine code for the notice frame; null while healthy. */
  readonly noticeCode: string | null;
  /** Arabic text for the shell. Never key material. */
  readonly noticeDetailAr: string | null;
  /** The tier is fair-use with no published renewal date. */
  readonly noRenewalGuarantee: true;
}

const DAY_MS = 86_400_000;

export class TtsCreditMonitor {
  private firstFaultAt: number | null = null;
  private lastFault: FishCreditError | null = null;
  private faults = 0;
  /** Set when the owner configures a known renewal date; null otherwise. */
  private renewalAt: number | null = null;

  constructor(
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Record a credit/rate-limit fault. Returns the resulting status so a caller
   * can emit a notice immediately without re-reading state.
   *
   * Idempotent in effect: repeated faults do not reset the first-fault clock,
   * because the operator needs to know how long they have been without voice,
   * not how many times the app noticed.
   */
  recordFault(err: FishCreditError): TtsCreditStatus {
    if (this.firstFaultAt === null) this.firstFaultAt = this.now();
    this.lastFault = err;
    this.faults += 1;
    return this.status();
  }

  /** Supply a renewal date if one becomes known. Not published by Fish today. */
  setRenewalAt(ts: number | null): void {
    this.renewalAt = ts;
  }

  status(): TtsCreditStatus {
    if (this.firstFaultAt === null && this.renewalAt === null) {
      return {
        state: 'ok',
        daysSinceFirstFault: null,
        noticeCode: null,
        noticeDetailAr: null,
        noRenewalGuarantee: true,
      };
    }

    // A known renewal date drives the countdown the owner asked for.
    if (this.renewalAt !== null) {
      const daysLeft = Math.ceil((this.renewalAt - this.now()) / DAY_MS);
      if (daysLeft > 0) {
        const urgent = daysLeft <= TOPUP_ADVISORY_DAYS;
        return {
          state: urgent ? 'advisory' : 'ok',
          daysSinceFirstFault: null,
          noticeCode: urgent ? 'tts-renewal-soon' : null,
          noticeDetailAr: urgent
            ? `اشتراك TTS ينتهي بعد ${daysLeft} يوم — شحن مسبقاً لتفادي انقطاع الصوت`
            : null,
          noRenewalGuarantee: true,
        };
      }
    }

    const days = Math.floor((this.now() - (this.firstFaultAt ?? this.now())) / DAY_MS);
    const escalated = days >= TOPUP_ADVISORY_DAYS;

    return {
      state: 'topup-required',
      daysSinceFirstFault: days,
      // A distinct code per escalation so the shell can change its wording and
      // so telemetry can tell "first fault" from "still broken after a week".
      noticeCode: escalated ? 'tts-credit-exhausted-overdue' : 'tts-credit-exhausted',
      noticeDetailAr: escalated
        ? `نفدت رصيد TTS منذ ${days} يوم ولم يُشحن — الصوت متوقف. اشحن رصيد Fish لتشغيله.`
        : 'نفد رصيد TTS — اشحن رصيد Fish لتشغيل الصوت. الاشتراك المجاني لا يحمل ضمان تجديد.',
      noRenewalGuarantee: true,
    };
  }

  get faultCount(): number {
    return this.faults;
  }

  /** Test and operator hook: forget everything. */
  reset(): void {
    this.firstFaultAt = null;
    this.lastFault = null;
    this.faults = 0;
  }
}
