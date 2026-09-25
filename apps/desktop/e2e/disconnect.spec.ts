import { expect, test } from '@playwright/test';

// G5 E2E — daemon death surfaces as degraded instead of a frozen shell.
test('disconnect: killing the daemon degrades the bridge', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('في وضع الاستعداد', { timeout: 10_000 });

  await fetch('http://localhost:4197/kill', { method: 'POST' });
  await expect(page.getByTestId('bridge-status')).toContainText('غير متصل', { timeout: 15_000 });

  // Revive for file-order independence (shared stub daemon per run).
  await fetch('http://localhost:4197/revive', { method: 'POST' });
});
