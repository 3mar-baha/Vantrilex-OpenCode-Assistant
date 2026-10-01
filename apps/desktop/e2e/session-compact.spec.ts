import { expect, test } from '@playwright/test';

// WINDOW COMPACTNESS — the property is RETAINED, the mechanism is rewritten.
//
// This spec used to prove "30 sessions do not stretch the HUD": the session chip
// stayed ≤48 px tall and opening its dropdown moved nothing. That mechanism is
// gone with the chip (see `inventory.spec.ts` for the capability retirement).
//
// The PROPERTY it was defending is still exactly right, and the Orb shell has a
// NEW and harder version of it: the window is a fixed 380 px square and the root
// is `fixed … overflow-hidden`, so anything that grows is CLIPPED rather than
// merely ugly. The composer guards that with `shrink-0` + `truncate` on every
// region below the orb. This spec now proves the guard, against real content.
async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://localhost:4197${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

test('a long message and a full session history both stay inside the fixed frame', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  // The worst case the root comment budgets for: a long notice line, which is
  // the only element with unbounded text. `title` carries the full string, so
  // the visible line truncates instead of pushing the pill down.
  const LONG = 'تعذّر تنفيذ الطلب لأن الخادم رفض الاتصال بمفتاح غير صالح ولا يمكن المتابعة من دون إعادة إدخال المفاتيح';
  await post('/notice', { code: 'tts-failed', detail: LONG, level: 'error' });
  // Scoped to THIS sentence, and read in one shot. The strip is a single slot
  // that any later notice overwrites, and the shared stub emits a
  // `resume-gap` notice per connection — so polling `title` on the bare element
  // races a foreign writer and fails intermittently (seen once in ~10 full
  // runs). Waiting for OUR text first, then reading its `title`, is immune: if a
  // competing notice has taken the slot, the wait fails on OUR text, which is a
  // true statement, rather than on someone else's.
  const mine = page.getByTestId('notice-banner').filter({ hasText: LONG });
  await expect(mine).toBeVisible({ timeout: 5_000 });
  expect(await mine.getAttribute('title'), 'truncation costs a hover, never the text').toBe(LONG);

  // 30 sessions — the payload that used to grow the card by ~1000 px.
  await post('/inventory', {
    sessions: Array.from({ length: 30 }, (_, i) => ({
      sessionId: `ses_hist_${String(i).padStart(2, '0')}`,
      state: 'idle',
    })),
  });

  // Nothing moved: the pill is still where it was, in frame, at full size.
  const pill = await page.getByTestId('control-row').boundingBox();
  expect(pill, 'the control row still has a box').not.toBeNull();
  expect(pill?.height).toBeGreaterThan(0);
  const vp = page.viewportSize();
  expect(vp).not.toBeNull();
  expect((pill?.y ?? 0) + (pill?.height ?? 0)).toBeLessThanOrEqual(vp?.height ?? 0);
  await expect(page.getByTestId('mic-toggle')).toBeVisible();
  await expect(page.getByTestId('orb')).toBeVisible();

  // Every region below the orb is `shrink-0`, so the ORB is the only thing that
  // yields — and it must still be wholly on screen.
  const orb = await page.getByTestId('orb').boundingBox();
  expect(orb).not.toBeNull();
  expect(orb?.height).toBeGreaterThan(200);
  expect((orb?.y ?? 0) + (orb?.height ?? 0)).toBeLessThanOrEqual(vp?.height ?? 0);
  // The pill is BELOW the orb, and still reachable.
  expect(pill?.y ?? 0).toBeGreaterThan((orb?.y ?? 0) + (orb?.height ?? 0));

  // The credit banner shares the frame with the notice line. Only one of the two
  // is ever shown (App.tsx returns early for a credit code), so the sum of
  // worst-case heights is not a real state — but each alone must fit.
  // The credit banner REPLACES the line rather than stacking with it — and it has
  // to FIT, since it shares the same fixed frame. A DISTINCT sentence, not LONG:
  // LONG is already in the strip from the generic notice above, so reusing it
  // would assert "the strip is empty" when the property is "the credit sentence
  // is not duplicated". (Asserting on the strip's emptiness is the trap
  // `credit.spec.ts` documents — the stub is shared and replays retained frames.)
  const CREDIT = 'نفد رصيد TTS — اشحن رصيد Fish لتشغيل الصوت.';
  await post('/notice', { code: 'tts-credit-exhausted', detail: CREDIT, level: 'warn' });
  await expect(page.getByTestId('credit-banner')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('notice-banner').filter({ hasText: CREDIT })).toHaveCount(0);
  const pillAfter = await page.getByTestId('control-row').boundingBox();
  expect((pillAfter?.y ?? 0) + (pillAfter?.height ?? 0)).toBeLessThanOrEqual(vp?.height ?? 0);
  await expect(page.getByTestId('mic-toggle')).toBeVisible();
});
