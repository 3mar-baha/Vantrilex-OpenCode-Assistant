import { expect, test } from '@playwright/test';

// P4 E2E — the mic toggle starts real capture (fake device) and PCM frames
// reach the daemon over the binary WS channel; toggling again stops it.
async function audio(): Promise<{ frames: number; bytes: number }> {
  const res = await fetch('http://localhost:4197/audio');
  return (await res.json()) as { frames: number; bytes: number };
}

test('mic toggle streams PCM frames to the daemon, then stops', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });

  await fetch('http://localhost:4197/audio/reset', { method: 'POST' });

  const mic = page.getByTestId('mic-toggle');
  // Mic starts muted (privacy-safe default); unmuting begins capture.
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'false');

  await expect
    .poll(
      async () => (await audio()).frames,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  const during = await audio();
  expect(during.bytes).toBeGreaterThan(0);

  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  const countAtStop = (await audio()).frames;
  await page.waitForTimeout(1500);
  // No more than one in-flight frame may land after stop.
  expect((await audio()).frames).toBeLessThanOrEqual(countAtStop + 1);
});
