import { expect, test } from '@playwright/test';

// G5 E2E — shell boots against the stub daemon and the bridge goes live.
test('boot: shell renders, bridge live, crest + matrix mounted', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('voxaura-shell')).toBeVisible();
  await expect(page.getByTestId('bridge-status')).toContainText('bridge: live', { timeout: 10_000 });
  await expect(page.getByTestId('voxaura-crest')).toBeVisible();
  await expect(page.getByTestId('pixel-matrix')).toBeVisible();
  await expect(page.getByTestId('icon-cluster')).toBeVisible();
});
