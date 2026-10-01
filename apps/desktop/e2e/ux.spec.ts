import { expect, test } from '@playwright/test';

// UX signals — notices and voice phases must reach the widget and render.
async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://localhost:4197${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

test('voice phases drive the status line (thinking → speaking → listening)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });
  await expect(page.getByTestId('bridge-status')).toHaveAttribute('data-state', 'ready');

  await post('/voice', { phase: 'thinking', transcript: 'اعرض الملخص' });
  await expect(page.getByTestId('bridge-status')).toContainText('التفكير', { timeout: 5_000 });
  await expect(page.getByTestId('bridge-status')).toHaveAttribute('data-state', 'processing');
  await expect(page.getByTestId('orb')).toHaveAttribute('data-phase', 'thinking', { timeout: 5_000 });

  await post('/voice', { phase: 'speaking' });
  await expect(page.getByTestId('bridge-status')).toContainText('يتحدث', { timeout: 5_000 });
  await expect(page.getByTestId('bridge-status')).toHaveAttribute('data-state', 'speaking');
  await expect(page.getByTestId('orb')).toHaveAttribute('data-phase', 'speaking', { timeout: 5_000 });

  // `last-transcript` was retired with the bento: the widget renders ONE
  // message line and it is the notice/announce channel, not a transcript feed.
  // The transcript still arrives on the `voice` frame — the daemon needs it — it
  // is simply not displayed. Asserted absent so it cannot come back unnoticed.
  await expect(page.getByTestId('last-transcript')).toHaveCount(0);

  await post('/voice', { phase: 'idle' });
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 5_000 });
  await expect(page.getByTestId('bridge-status')).toHaveAttribute('data-state', 'ready');
});

test('a listening phase reads as listening on the status line', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  await post('/voice', { phase: 'listening', transcript: 'ما الدوال المتاحة؟' });
  await expect(page.getByTestId('bridge-status')).toHaveAttribute('data-state', 'listening', { timeout: 5_000 });
  await expect(page.getByTestId('bridge-status')).toContainText('الاستماع', { timeout: 5_000 });

  await post('/voice', { phase: 'idle' });
  await expect(page.getByTestId('bridge-status')).toHaveAttribute('data-state', 'ready', { timeout: 5_000 });
});

test('the keyless notice renders with its CTA sentence on the single message line', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  await post('/notice', {
    code: 'voice-disabled-no-keys',
    detail: 'الصوت معطّل — لم تُهيّأ المفاتيح بعد.',
    level: 'warn',
  });

  // The retired `notice-open-keys` button is replaced by an APPENDED SENTENCE
  // naming the same action — the pill's third button opens the identical
  // window, so the CTA path is intact even though the control is not. The strip
  // is what says a key is missing, so it is where the instruction has to be.
  // Scoped to THIS sentence: the strip is a single slot any later notice
  // overwrites, and the shared stub emits a `resume-gap` notice per connection.
  const banner = page.getByTestId('notice-banner').filter({ hasText: 'افتح الإعدادات لإدخال المفاتيح' });
  await expect(banner).toBeVisible({ timeout: 5_000 });
  await expect(banner).toContainText('المفاتيح');
  await expect(banner).toHaveAttribute('data-level', 'warn');
  // The full sentence, so truncation costs a hover and never the text.
  expect(await banner.getAttribute('title')).toContain('افتح الإعدادات لإدخال المفاتيح');

  // The follow-through the old CTA performed: the pill's `open-keys` reaches the
  // keys window, which is where the keys are actually entered.
  await expect(page.getByTestId('open-keys')).toBeVisible();
  await expect(page.getByTestId('notice-open-keys')).toHaveCount(0);

  // `notice-dismiss` is RETIRED, not renamed: the widget renders one message
  // line with no dismiss control, and the pill is pinned at three buttons. The
  // line is replaced by the next notice rather than closed by the user. Recorded
  // here so the absence is a decision on record rather than an oversight.
  await expect(page.getByTestId('notice-dismiss')).toHaveCount(0);
  await expect(page.locator('button')).toHaveCount(3);

  // The line is overwritten, not stacked: a second notice replaces it.
  await post('/notice', { code: 'stt-timeout', detail: 'تجاوز تحويل الصوت المهلة', level: 'warn' });
  const replaced = page.getByTestId('notice-banner').filter({ hasText: 'تجاوز تحويل الصوت المهلة' });
  await expect(replaced).toHaveCount(1);
  await expect(replaced).not.toContainText('المفاتيح');
});

test('a credit notice takes the credit banner INSTEAD of the message line', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  // C.3: the two surfaces are mutually exclusive by construction — `onNotice`
  // returns early for a credit code, so the same Arabic sentence must never be
  // shown twice. Asserted on THE SENTENCE, not on the strip's emptiness: the
  // stub is shared by the whole run and replays retained frames, so an unrelated
  // notice may legitimately already be in the strip (the note in `credit.spec.ts`
  // records the same trap).
  const CREDIT = 'نفد رصيد TTS — اشحن رصيد Fish لتشغيل الصوت.';
  await post('/notice', { code: 'tts-credit-exhausted', detail: CREDIT, level: 'warn' });
  await expect(page.getByTestId('credit-banner')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('credit-banner-text')).toHaveText(CREDIT);
  await expect(page.getByTestId('notice-banner').filter({ hasText: CREDIT })).toHaveCount(0);

  await post('/notice', { code: 'stt-timeout', detail: 'تجاوز تحويل الصوت المهلة', level: 'warn' });
  await expect(page.getByTestId('notice-banner')).toHaveCount(1);
  await expect(page.getByTestId('notice-banner')).toContainText('تجاوز تحويل الصوت المهلة');
  // The credit sentence never migrates into the generic line.
  await expect(page.getByTestId('notice-banner')).not.toContainText('نفد رصيد TTS');
});
