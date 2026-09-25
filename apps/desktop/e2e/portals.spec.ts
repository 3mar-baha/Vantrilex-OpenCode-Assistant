import { expect, test } from '@playwright/test';

// Settings runs in its own window (?view=settings). Off-Tauri the launcher
// opens a same-origin popup, so these assertions run against that page.
test('settings opens in a separate window, tabs swap content, Esc closes', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('في وضع الاستعداد', { timeout: 10_000 });

  const [settings] = await Promise.all([context.waitForEvent('page'), page.getByTestId('open-settings').click()]);
  await settings.waitForLoadState('domcontentloaded');
  expect(settings.url()).toContain('view=settings');

  await expect(settings.getByTestId('settings-view')).toBeVisible();
  await expect(settings.getByRole('tab')).toHaveCount(5);
  await expect(settings.getByTestId('apikey-groq')).toBeVisible();

  await settings.getByRole('tab', { name: /النماذج/ }).click();
  await expect(settings.getByTestId('chain-nemotron')).toBeVisible();

  await settings.getByRole('tab', { name: /الصوت/ }).click();
  await settings.getByTestId('persona-nour').click();
  await expect(settings.getByTestId('persona-nour')).toHaveAttribute('aria-checked', 'true');

  // Esc closes the settings window; the handler can tear the page down mid-press,
  // so tolerate the race and assert closure explicitly.
  await settings.keyboard.press('Escape').catch(() => undefined);
  await expect.poll(() => settings.isClosed(), { timeout: 5_000 }).toBe(true);

  // The companion HUD stays open and untouched alongside it.
  await expect(page.getByTestId('voxaura-shell')).toBeVisible();
});