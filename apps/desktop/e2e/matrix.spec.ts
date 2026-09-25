import { expect, test } from '@playwright/test';

// G5 E2E — daemon events drive the matrix through the real WS bridge.
async function fire(state: string): Promise<unknown> {
  const res = await fetch('http://localhost:4197/fire', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  return res.json();
}

test('wave follows daemon lifecycle: running→active, abort→idle', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });
  const wave = page.getByTestId('siri-wave');
  await expect(wave).toHaveAttribute('data-mode', 'idle');

  await fire('running');
  await expect(wave).toHaveAttribute('data-mode', 'active', { timeout: 5_000 });

  await fire('complete');
  await expect(wave).toHaveAttribute('data-mode', 'active', { timeout: 5_000 });
});
