import { expect, test } from '@playwright/test';

// G5 E2E — action bar intents reach the daemon; abort snaps the wave idle.
test('abort: wave snaps to idle and the daemon receives the command', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('في وضع الاستعداد', { timeout: 10_000 });
  const wave = page.getByTestId('siri-wave');

  await fetch('http://localhost:4197/fire', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'complete' }),
  });
  await expect(wave).toHaveAttribute('data-mode', 'active', { timeout: 5_000 });

  await page.getByTestId('action-abort').click();
  await expect(wave).toHaveAttribute('data-mode', 'idle', { timeout: 5_000 });

  const res = await fetch('http://localhost:4197/commands');
  const commands = (await res.json()) as Array<{ kind: string }>;
  expect(commands.some((c) => c.kind === 'abort')).toBe(true);
});
