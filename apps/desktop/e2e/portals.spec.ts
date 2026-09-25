import { expect, test } from '@playwright/test';

// Settings and keys are separate windows. Off-Tauri each opens as its own
// same-origin popup, so these assertions run against that page.
test('settings opens in its own window, tabs swap content, Esc closes', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });

  const [settings] = await Promise.all([context.waitForEvent('page'), page.getByTestId('open-settings').click()]);
  await settings.waitForLoadState('domcontentloaded');
  expect(settings.url()).toContain('view=settings');

  await expect(settings.getByTestId('settings-view')).toBeVisible();
  await expect(settings.getByRole('tab')).toHaveCount(4);
  // Keys are decoupled from general settings.
  await expect(settings.getByTestId('apikey-groq')).toHaveCount(0);
  await expect(settings.getByTestId('chain-nemotron')).toBeVisible();

  await settings.getByRole('tab', { name: /الصوت/ }).click();
  await settings.getByTestId('persona-nour').click();
  await expect(settings.getByTestId('persona-nour')).toHaveAttribute('aria-checked', 'true');

  await settings.keyboard.press('Escape').catch(() => undefined);
  await expect.poll(() => settings.isClosed(), { timeout: 5_000 }).toBe(true);

  await expect(page.getByTestId('voxaura-shell')).toBeVisible();
});

test('API keys open in a dedicated focused window', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });

  const [keys] = await Promise.all([context.waitForEvent('page'), page.getByTestId('open-apikeys').click()]);
  await keys.waitForLoadState('domcontentloaded');
  expect(keys.url()).toContain('view=keys');

  await expect(keys.getByTestId('keys-view')).toBeVisible();
  await expect(keys.getByRole('tab')).toHaveCount(0);
  await expect(keys.getByTestId('apikey-groq')).toBeVisible();
  await keys.close();
});