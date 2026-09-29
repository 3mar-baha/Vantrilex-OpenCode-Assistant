import { describe, expect, test } from 'vitest';
import { FishCreditError } from './tts.js';
import { TtsCreditMonitor, TOPUP_ADVISORY_DAYS } from './tts-credit.js';

// The Fish top-up path. Two separate claims, both about the OWNER's time-to-act:
//
//   1. a 402/429 must be distinguishable from any other TTS failure, because
//      the fixes are opposite — top up vs rotate a key, and L17 already knows
//      that rotating for a credit fault is wrong;
//   2. after a week of no voice the instruction must escalate, or a banner that
//      looks the same on day 1 and day 30 gets ignored.
//
// The reason this cannot be a string match on the error message: the message is
// prose that someone will reword, and the branch would silently stop firing.

describe('FishCreditError', () => {
  test('402 and 429 are credit faults, and 401/500 are not', () => {
    expect(new FishCreditError(402, 'x').isCreditFault).toBe(true);
    expect(new FishCreditError(429, 'x').isCreditFault).toBe(true);
    // A plain Error has no such property, which is the whole point: the
    // interceptor's `instanceof` test is what separates them.
    expect((new Error('x') as { isCreditFault?: boolean }).isCreditFault).toBeUndefined();
  });

  test('remediation text differs for balance vs rate limit', () => {
    // Both need a top-up, but they are different instructions: an empty balance
    // needs money now, a rate limit may clear on its own. Collapsing them into
    // one string loses the distinction the operator needs.
    const a = new FishCreditError(402, 'x').remediation;
    const b = new FishCreditError(429, 'x').remediation;
    expect(a).not.toBe(b);
    expect(a).toMatch(/top up/i);
    expect(b).toMatch(/quota|wait/i);
  });

  test('carries the HTTP status for telemetry', () => {
    expect(new FishCreditError(402, 'x').status).toBe(402);
    expect(new FishCreditError(429, 'x').status).toBe(429);
    expect(new FishCreditError(402, 'x').name).toBe('FishCreditError');
  });
});

describe('TtsCreditMonitor', () => {
  test('healthy before any fault, and says so', () => {
    const m = new TtsCreditMonitor(() => 0);
    const s = m.status();
    expect(s.state).toBe('ok');
    expect(s.noticeCode).toBeNull();
    expect(s.noticeDetailAr).toBeNull();
    // Fish publishes no renewal date, so the absence is part of the state and
    // is surfaced rather than papered over with an invented date.
    expect(s.noRenewalGuarantee).toBe(true);
  });

  test('a credit fault immediately demands a top-up', () => {
    const m = new TtsCreditMonitor(() => 0);
    const s = m.recordFault(new FishCreditError(402, 'out of credit'));
    expect(s.state).toBe('topup-required');
    expect(s.noticeCode).toBe('tts-credit-exhausted');
    expect(s.noticeDetailAr).toMatch(/اشحن/);
    expect(s.daysSinceFirstFault).toBe(0);
  });

  test('the notice escalates after 7 days', () => {
    // The owner's requirement, expressed as an observable: on day 1 the user is
    // told to top up; by day 7 the wording must differ, or a permanent banner is
    // indistinguishable from a transient one and gets ignored.
    const now = { t: 0 };
    const m = new TtsCreditMonitor(() => now.t);
    m.recordFault(new FishCreditError(402, 'x'));
    const day1 = m.status();
    now.t = TOPUP_ADVISORY_DAYS * 86_400_000;
    const day8 = m.status();
    expect(day1.noticeCode).toBe('tts-credit-exhausted');
    expect(day8.noticeCode).toBe('tts-credit-exhausted-overdue');
    expect(day8.noticeDetailAr).not.toBe(day1.noticeDetailAr);
    expect(day8.daysSinceFirstFault).toBe(TOPUP_ADVISORY_DAYS);
  });

  test('repeated faults do NOT reset the first-fault clock', () => {
    // The operator needs to know how long voice has been down, not how often the
    // app noticed. Resetting on each fault would keep the banner on "day 0"
    // forever and defeat the escalation above.
    const now = { t: 0 };
    const m = new TtsCreditMonitor(() => now.t);
    m.recordFault(new FishCreditError(402, 'x'));
    now.t = 5 * 86_400_000;
    m.recordFault(new FishCreditError(402, 'x'));
    now.t = 9 * 86_400_000;
    m.recordFault(new FishCreditError(429, 'x'));
    const s = m.status();
    expect(s.daysSinceFirstFault).toBe(9);
    expect(s.noticeCode).toBe('tts-credit-exhausted-overdue');
    expect(m.faultCount).toBe(3);
  });

  test('a known renewal date drives a countdown before any fault', () => {
    // This is the 7-day warning the owner asked for, and it only works if Fish
    // publishes a date. It does not today, so this path is driven by an injected
    // date and is honest about being a hook rather than a claim.
    const now = { t: 0 };
    const m = new TtsCreditMonitor(() => now.t);
    m.setRenewalAt(30 * 86_400_000);
    expect(m.status().state).toBe('ok'); // 30 days out: no nagging
    m.setRenewalAt(5 * 86_400_000);
    const s = m.status();
    expect(s.state).toBe('advisory');
    expect(s.noticeCode).toBe('tts-renewal-soon');
    expect(s.noticeDetailAr).toMatch(/5/);
  });

  test('a past renewal date does not nag when there has been no fault', () => {
    // Otherwise a stale date would nag forever with no actionable cause. The
    // fault path is what escalates; an expired date alone is not a problem yet.
    const m = new TtsCreditMonitor(() => 10 * 86_400_000);
    m.setRenewalAt(0);
    const s = m.status();
    expect(s.state).toBe('topup-required');
    // ...and it is a top-up demand, not a countdown warning.
    expect(s.noticeCode).not.toBe('tts-renewal-soon');
  });

  test('reset returns to healthy', () => {
    const m = new TtsCreditMonitor(() => 0);
    m.recordFault(new FishCreditError(402, 'x'));
    m.reset();
    expect(m.status().state).toBe('ok');
    expect(m.faultCount).toBe(0);
  });
});
