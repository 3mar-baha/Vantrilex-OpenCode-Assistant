import { expect, test } from '@playwright/test';

// G5 E2E — daemon events drive the matrix through the real WS bridge.
async function fire(state: string): Promise<unknown> {
  const res = await fetch('http://localhost:4197/fire', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  return res.json();
}

test('matrix follows daemon lifecycle: running→thinking, complete→kareem', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('bridge: live', { timeout: 10_000 });
  const matrix = page.getByTestId('pixel-matrix');

  await fire('running');
  await expect(matrix).toHaveAttribute('data-state', '2', { timeout: 5_000 });

  await fire('complete');
  await expect(matrix).toHaveAttribute('data-state', '3', { timeout: 5_000 });
});
