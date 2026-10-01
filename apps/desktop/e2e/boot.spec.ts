import { expect, test } from '@playwright/test';

// G5 E2E — the companion widget boots and its three controls are real.
//
// Re-pointed by bd103b2: the bento's `waveform-emblem` / `siri-wave` cells are
// the Orb, and the bento's fourth `abort-button` is gone (see the retirement
// note in `orb-shell.spec.ts` and the inventory in the commit message).
test('boot: the Orb renders, the status line is live, and all three controls are wired', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('voxaura-shell')).toBeVisible();
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });
  await expect(page.getByTestId('bridge-status')).toHaveAttribute('data-state', 'ready');
  // `waveform-emblem` + `siri-wave` collapsed into ONE element: the Orb.
  await expect(page.getByTestId('orb')).toBeVisible();
  await expect(page.getByTestId('orb-region')).toBeVisible();
  await expect(page.getByTestId('mic-toggle')).toBeVisible();
  await expect(page.getByTestId('bot-toggle')).toBeVisible();
  await expect(page.getByTestId('open-keys')).toBeVisible();
  // The old duplicate icon strip is gone, and so is every bento cell.
  await expect(page.getByTestId('icon-cluster')).toHaveCount(0);
  await expect(page.getByTestId('action-bar')).toHaveCount(0);
  await expect(page.getByTestId('abort-button')).toHaveCount(0);
  await expect(page.getByTestId('session-chip')).toHaveCount(0);
  await expect(page.getByTestId('agent-model-badge')).toHaveCount(0);
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
  // `announce` merged into `notice-banner` — the widget renders ONE message
  // line, and the pinned mapping is `announce` → `notice-banner`.
  const banner = page.getByTestId('notice-banner');
  await expect(banner).toContainText('كتمت الميكروفون', { timeout: 10_000 });
  await expect(banner).not.toContainText('تم إيقاف');
  await expect(banner).not.toContainText('بنجاح');

  const bot = page.getByTestId('bot-toggle');
  await expect(bot).toHaveAttribute('title', /صوت المساعد/);
  await bot.click();
  await expect(bot).toHaveAttribute('aria-pressed', 'true');
});
