import { expect, test } from '@playwright/test';

// G5 E2E — shell boots against the stub daemon and the bridge goes live.
test('boot: shell renders, status pill live, emblem + wave mounted', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('voxaura-shell')).toBeVisible();
  await expect(page.getByTestId('bridge-status')).toContainText('في وضع الاستعداد', { timeout: 10_000 });
  await expect(page.getByTestId('waveform-emblem')).toBeVisible();
  await expect(page.getByTestId('siri-wave')).toBeVisible();
  await expect(page.getByTestId('mic-core')).toBeVisible();
  await expect(page.getByTestId('icon-cluster')).toBeVisible();
});
