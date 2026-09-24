import { expect, test } from '@playwright/test';

// G5 E2E — settings portal: 5 tabs, persona select, Esc closes.
test('settings portal opens, shows tabs + personas, Esc closes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('bridge: live', { timeout: 10_000 });

  await page.getByTestId('open-settings').click();
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(5);
  await expect(page.getByTestId('persona-kareem')).toBeVisible();
  await expect(page.getByTestId('persona-nour')).toBeVisible();

  await page.getByTestId('persona-nour').click();
  await expect(page.getByTestId('persona-nour')).toHaveAttribute('aria-checked', 'true');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('portal-shell')).toHaveCount(0);
});
