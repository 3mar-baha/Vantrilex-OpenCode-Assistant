import { expect, test } from '@playwright/test';

// P4b E2E — daemon speech reaches the shell as binary chunks and the speaking
// indicator appears; the indicator latches briefly so fast queues don't flicker.
async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://localhost:4197${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

test('spoken reply lights the speaking indicator', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });
  await expect(page.getByTestId('speaking-indicator')).toHaveCount(0);

  // Fake MP3 payload: decode fails in the player, but the indicator path
  // (enqueue → onStart) is what this proves end to end.
  const result = (await post('/audio-down', { bytes: [0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4] })) as { chunks: number };
  expect(result.chunks).toBe(1);
  await expect(page.getByTestId('speaking-indicator')).toBeVisible({ timeout: 5_000 });
});
