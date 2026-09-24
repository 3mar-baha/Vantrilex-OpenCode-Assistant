import { expect, test } from '@playwright/test';

// G5 E2E — action bar intents reach the daemon; abort snaps the matrix idle.
test('abort: matrix snaps to idle and the daemon receives the command', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('bridge: live', { timeout: 10_000 });
  const matrix = page.getByTestId('pixel-matrix');

  await fetch('http://localhost:4197/fire', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'complete' }),
  });
  await expect(matrix).toHaveAttribute('data-state', '3', { timeout: 5_000 });

  await page.getByTestId('action-abort').click();
  await expect(matrix).toHaveAttribute('data-state', '0', { timeout: 5_000 });

  const res = await fetch('http://localhost:4197/commands');
  const commands = (await res.json()) as Array<{ kind: string }>;
  expect(commands.some((c) => c.kind === 'abort')).toBe(true);
});
