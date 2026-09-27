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
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  // Phase 5 — ZERO CANNED REPLIES. The toggle no longer announces a literal
  // like 'تم إيقاف الميكروفون': success feedback is whatever line the model
  // wrote, delivered by the daemon as an `assistant-said` notice. So we assert
  // the model-supplied line is rendered, and that it is NOT a canned template.
  const announce = page.getByTestId('announce');
  const banner = page.getByTestId('notice-banner');
  await expect(banner).toContainText('كتمت الميكروفون', { timeout: 10_000 });
  await expect(announce).not.toContainText('تم إيقاف');
  await expect(banner).not.toContainText('تم إيقاف');
  await expect(banner).not.toContainText('بنجاح');

  const bot = page.getByTestId('bot-toggle');
  await expect(bot).toHaveAttribute('title', /صوت المساعد/);
  await bot.click();
  await expect(bot).toHaveAttribute('aria-pressed', 'true');
});