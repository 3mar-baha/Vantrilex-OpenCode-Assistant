import { expect, test } from '@playwright/test';

// G5 E2E — the companion HUD boots, cells are backed by live daemon state, and
// every control is real (no duplicated toolbars).
test('boot: HUD renders, status pill live, controls wired', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('voxaura-shell')).toBeVisible();
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });
  await expect(page.getByTestId('bridge-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('waveform-emblem')).toBeVisible();
  await expect(page.getByTestId('siri-wave')).toBeVisible();
  await expect(page.getByTestId('mic-toggle')).toBeVisible();
  await expect(page.getByTestId('bot-toggle')).toBeVisible();
  await expect(page.getByTestId('abort-button')).toBeVisible();
  // The old duplicate icon strip is gone.
  await expect(page.getByTestId('icon-cluster')).toHaveCount(0);
  await expect(page.getByTestId('action-bar')).toHaveCount(0);
});

test('controls expose Arabic tooltips and toggle their pressed state', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });

  const mic = page.getByTestId('mic-toggle');
  await expect(mic).toHaveAttribute('title', /الميكروفون/);
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('announce')).not.toHaveText('');

  const bot = page.getByTestId('bot-toggle');
  await expect(bot).toHaveAttribute('title', /صوت المساعد/);
  await bot.click();
  await expect(bot).toHaveAttribute('aria-pressed', 'true');
});