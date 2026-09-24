import { expect, test } from '@playwright/test';

// Phase 2b E2E — inventory snapshot populates the chip; click dispatches
// switchSession over the real bridge and the daemon acks it.
async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://localhost:4197${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

test('inventory snapshot populates chip; switch executes and acks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('bridge: live', { timeout: 10_000 });

  await post('/inventory', {
    sessions: [
      { sessionId: 'ses_a', state: 'running' },
      { sessionId: 'ses_b', state: 'idle' },
    ],
  });
  await expect(page.getByTestId('session-ses_a')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('session-ses_b')).toBeVisible({ timeout: 5_000 });

  await page.getByTestId('session-ses_b').click();
  await expect
    .poll(
      async () => {
        const res = await fetch('http://localhost:4197/commands');
        const commands = (await res.json()) as Array<{ kind: string; sessionId?: string }>;
        return commands.some((c) => c.kind === 'switchSession' && c.sessionId === 'ses_b');
      },
      { timeout: 5_000 },
    )
    .toBe(true);

  // Empty snapshot returns the chip to active-only (no fabrication).
  await post('/inventory', { sessions: [] });
  await expect(page.getByTestId('session-list')).toHaveCount(0, { timeout: 5_000 });
});
