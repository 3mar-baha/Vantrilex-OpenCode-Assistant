import { expect, test } from '@playwright/test';

// Compact HUD regression — a long session history must never stretch the
// window. The chip shows one row; the history lives in a dropdown whose
// entries are only in the DOM while open.
async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://localhost:4197${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

test('many historical sessions keep the HUD compact and the mic visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });

  // 30 sessions — the old stacked list would have grown the card ~1000px.
  const sessions = Array.from({ length: 30 }, (_, i) => ({
    sessionId: `ses_hist_${String(i).padStart(2, '0')}`,
    state: 'idle',
  }));
  await post('/inventory', { sessions });

  // One compact trigger, no stacked list in the DOM.
  await expect(page.getByTestId('session-chip-trigger')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('session-list')).toHaveCount(0);

  const bar = await page.getByTestId('session-chip').boundingBox();
  expect(bar?.height ?? 999).toBeLessThanOrEqual(48);

  // The mic and the 5-bar visualizer stay on screen.
  await expect(page.getByTestId('mic-toggle')).toBeVisible();
  await expect(page.getByTestId('siri-wave')).toBeVisible();
  const mic = await page.getByTestId('mic-toggle').boundingBox();
  expect(mic).not.toBeNull();
  expect((mic?.y ?? 0) + (mic?.height ?? 0)).toBeLessThan(1400);

  // Opening the dropdown reveals the history without moving the layout.
  const micBefore = mic?.y ?? 0;
  await page.getByTestId('session-chip-trigger').click();
  await expect(page.getByTestId('session-ses_hist_00')).toBeVisible({ timeout: 5_000 });
  const micAfter = (await page.getByTestId('mic-toggle').boundingBox())?.y ?? 0;
  expect(Math.abs(micAfter - micBefore)).toBeLessThan(2);
});
