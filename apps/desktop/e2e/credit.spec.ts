import { expect, test, type Page } from '@playwright/test';

// M4 C.3 — the TTS-credit banner, end to end against the REAL `UiServer` in
// `e2e/stub-daemon.mjs` driven through its existing `/notice` route. The credit
// interceptor lives in `daemon.ts` and cannot be reached from the stub (no Fish
// call), so the FRAME is the stubbed boundary and everything downstream of it —
// the real `UiServer.notice`, the real WS-4097 encode, the real bridge parse, the
// real arm mapping — is production code. The one thing NOT proven here is that
// the daemon emits the code, and `src/voice/tts-credit.test.ts` covers that side.

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://localhost:4197${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * `page.goto` waits for `load` on a VITE DEV SERVER, so the FIRST spec in a run
 * pays the cold transform of the whole graph and can blow Playwright's 30 s
 * default before a single assertion runs. Measured here: 6 passed in 16 s warm,
 * but the same file then failed its first `goto` at 30.9 s cold. That is harness
 * cost, not product behaviour — so the budget goes on NAVIGATION only, and every
 * behavioural assertion keeps the default timeout.
 */
async function open(page: Page): Promise<void> {
  await page.goto('/', { timeout: 90_000 });
}

const EXHAUSTED = 'نفد رصيد TTS — اشحن رصيد Fish لتشغيل الصوت. الاشتراك المجاني لا يحمل ضمان تجديد.';
const OVERDUE_9D = 'نفدت رصيد TTS منذ 9 يوم ولم يُشحن — الصوت متوقف. اشحن رصيد Fish لتشغيله.';

test('an exhausted-credit notice renders the warn banner with the daemon wording', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });
  await expect(page.getByTestId('credit-banner')).toHaveCount(0);

  await post('/notice', { code: 'tts-credit-exhausted', detail: EXHAUSTED, level: 'warn' });

  const banner = page.getByTestId('credit-banner');
  await expect(banner).toHaveCount(1, { timeout: 5_000 });
  await expect(banner).toHaveAttribute('data-code', 'tts-credit-exhausted');
  await expect(banner).toHaveAttribute('data-arm', 'warn');
  await expect(banner).toHaveAttribute('data-dismissible', 'true');
  await expect(banner).toHaveAttribute('aria-live', 'assertive');
  // The generic strip must NOT ALSO carry this sentence — one sentence, one
  // surface. Assert the SENTENCE, not the strip's emptiness: the stub is one
  // process for the whole run, and an earlier spec (`abort`) fires a lifecycle
  // event that the real UiServer retains, so this page legitimately receives
  // the B.2c `resume-gap` notice in the generic strip. A `toHaveCount(0)` there
  // failed for a correct, unrelated notice — the same shared-state trap
  // `delivery.spec` hit, and the fix is the same shape.
  const generic = page.getByTestId('notice-banner');
  await expect(generic).not.toContainText(EXHAUSTED);
  await expect(page.getByText(EXHAUSTED)).toHaveCount(1);

  await page.getByTestId('credit-banner-dismiss').click();
  await expect(page.getByTestId('credit-banner')).toHaveCount(0);
});

test('the overdue arm is latched: no dismiss control, and it survives a dismiss attempt', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  await post('/notice', { code: 'tts-credit-exhausted-overdue', detail: OVERDUE_9D, level: 'warn' });
  const banner = page.getByTestId('credit-banner');
  await expect(banner).toHaveCount(1, { timeout: 5_000 });
  await expect(banner).toHaveAttribute('data-arm', 'escalate');
  await expect(banner).toHaveAttribute('data-dismissible', 'false');
  await expect(page.getByTestId('credit-banner-dismiss')).toHaveCount(0);
  // The day count is the daemon's, verbatim.
  await expect(page.getByTestId('credit-banner-text')).toHaveText(OVERDUE_9D);
});

test('a repeated identical notice does not stack a second banner', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  await post('/notice', { code: 'tts-credit-exhausted-overdue', detail: OVERDUE_9D, level: 'warn' });
  await expect(page.getByTestId('credit-banner')).toHaveCount(1, { timeout: 5_000 });
  const id = await page.getByTestId('credit-banner').getAttribute('data-banner-id');

  for (let i = 0; i < 3; i += 1) {
    await post('/notice', { code: 'tts-credit-exhausted-overdue', detail: OVERDUE_9D, level: 'warn' });
  }
  await expect(page.getByTestId('credit-banner')).toHaveCount(1);
  expect(await page.getByTestId('credit-banner').getAttribute('data-banner-id')).toBe(id);
});

test('a speaking phase clears a shown banner', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  await post('/notice', { code: 'tts-credit-exhausted', detail: EXHAUSTED, level: 'warn' });
  await expect(page.getByTestId('credit-banner')).toHaveCount(1, { timeout: 5_000 });

  await post('/voice', { phase: 'speaking' });
  await expect(page.getByTestId('credit-banner')).toHaveCount(0, { timeout: 5_000 });
});

test('the credit banner sits ABOVE the generic notice strip in the DOM', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  // Both surfaces at once: a credit fault and an unrelated warn.
  await post('/notice', { code: 'stt-timeout', detail: 'تجاوز تحويل الصوت المهلة', level: 'warn' });
  await post('/notice', { code: 'tts-credit-exhausted-overdue', detail: OVERDUE_9D, level: 'warn' });
  await expect(page.getByTestId('credit-banner')).toHaveCount(1, { timeout: 5_000 });
  await expect(page.getByTestId('notice-banner')).toHaveCount(1);

  const order = await page.evaluate(() => {
    const all = [...document.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid'));
    return {
      credit: all.indexOf('credit-banner'),
      generic: all.indexOf('notice-banner'),
    };
  });
  expect(order.credit).toBeGreaterThanOrEqual(0);
  expect(order.generic).toBeGreaterThanOrEqual(0);
  // In flow, above the generic strip — not a modal and not a toast. The window
  // auto-sizes to content, so an overlay would be clipped or would push the HUD
  // out of frame.
  expect(order.credit).toBeLessThan(order.generic);
});

test('an unrelated notice renders NO credit banner', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  await post('/notice', { code: 'assistant-said', detail: 'عملت', level: 'info' });
  await post('/notice', { code: 'stt-timeout', detail: 'تجاوز تحويل الصوت المهلة', level: 'warn' });
  await post('/notice', { code: 'tts-failed', detail: 'تعذّر توليد الصوت', level: 'error' });
  await expect(page.getByTestId('notice-banner')).toHaveCount(1, { timeout: 5_000 });
  await expect(page.getByTestId('credit-banner')).toHaveCount(0);
});

