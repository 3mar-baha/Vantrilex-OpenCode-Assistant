import { expect, test } from '@playwright/test';

// UX signals — notices and voice phases must reach the HUD and render.
async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://localhost:4197${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

test('voice phases drive the status pill (thinking → speaking)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });

  await post('/voice', { phase: 'thinking', transcript: 'اعرض الملخص' });
  await expect(page.getByTestId('bridge-status')).toContainText('التفكير', { timeout: 5_000 });
  await expect(page.getByTestId('last-transcript')).toContainText('اعرض الملخص');

  await post('/voice', { phase: 'speaking' });
  await expect(page.getByTestId('bridge-status')).toContainText('يتحدث', { timeout: 5_000 });

  await post('/voice', { phase: 'idle' });
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 5_000 });
});

test('keyless notice renders a CTA banner and can be dismissed', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  await post('/notice', {
    code: 'voice-disabled-no-keys',
    detail: 'الصوت معطّل — لم تُهيّأ المفاتيح بعد.',
    level: 'warn',
  });
  await expect(page.getByTestId('notice-banner')).toContainText('المفاتيح', { timeout: 5_000 });
  await expect(page.getByTestId('notice-open-keys')).toBeVisible();

  await page.getByTestId('notice-dismiss').click();
  await expect(page.getByTestId('notice-banner')).toHaveCount(0);
});
