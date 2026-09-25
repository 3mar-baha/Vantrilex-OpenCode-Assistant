import { expect, test } from '@playwright/test';

// G5 E2E — square settings dialog: sidebar tabs swap content, persona select
// reports, Esc closes.
test('settings dialog opens, tabs swap content, Esc closes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('في وضع الاستعداد', { timeout: 10_000 });

  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(5);
  await expect(page.getByTestId('apikey-groq')).toBeVisible();

  await page.getByTestId('tab-models').click();
  await expect(page.getByTestId('chain-nemotron')).toBeVisible();

  await page.getByTestId('tab-voice').click();
  await expect(page.getByTestId('persona-kareem')).toBeVisible();
  await expect(page.getByTestId('persona-nour')).toBeVisible();

  await page.getByTestId('persona-nour').click();
  await expect(page.getByTestId('persona-nour')).toHaveAttribute('aria-checked', 'true');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('portal-shell')).toHaveCount(0);
});
