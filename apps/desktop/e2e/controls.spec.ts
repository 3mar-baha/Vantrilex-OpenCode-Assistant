import { expect, test } from '@playwright/test';

// Phase 3 E2E — agent/model switch intents travel the real bridge typed and
// complete, and the daemon records them with session scope.
async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://localhost:4197${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function commands(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch('http://localhost:4197/commands');
  return (await res.json()) as Array<Record<string, unknown>>;
}

test('agent/model switch round-trips with session scope', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('bridge: live', { timeout: 10_000 });

  await post('/inventory', { sessions: [{ sessionId: 'ses_a', state: 'running' }] });
  await page.getByTestId('session-ses_a').click();
  await expect(page.getByTestId('agent-model-badge')).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept('build'));
  await page.getByTestId('badge-switch-agent').click();
  await expect
    .poll(
      async () =>
        (await commands()).some((c) => c['kind'] === 'setSessionAgent' && c['sessionId'] === 'ses_a' && c['agent'] === 'build'),
      { timeout: 5_000 },
    )
    .toBe(true);

  page.once('dialog', (dialog) => void dialog.accept('opus'));
  await page.getByTestId('badge-switch-model').click();
  await expect
    .poll(
      async () =>
        (await commands()).some((c) => c.kind === 'setSessionModel' && c.sessionId === 'ses_a' && c.model === 'opus'),
      { timeout: 5_000 },
    )
    .toBe(true);

  await expect(page.getByTestId('badge-agent')).toContainText('build');
  await expect(page.getByTestId('badge-model')).toContainText('opus');
});

test('discovered agents populate a live selector and drive setSessionAgent', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('bridge: live', { timeout: 10_000 });
  await post('/inventory', { sessions: [{ sessionId: 'ses_a', state: 'running' }] });
  await page.getByTestId('session-ses_a').click();

  await post('/agents', {
    agents: [
      { id: 'build', name: 'Build' },
      { id: 'architect', name: 'Architect' },
    ],
  });
  const select = page.getByTestId('agent-select');
  await expect(select).toBeVisible({ timeout: 5_000 });
  await expect(select.locator('option')).toHaveCount(3); // placeholder + 2

  await select.selectOption('architect');
  await expect
    .poll(
      async () =>
        (await commands()).some((c) => c['kind'] === 'setSessionAgent' && c['sessionId'] === 'ses_a' && c['agent'] === 'architect'),
      { timeout: 5_000 },
    )
    .toBe(true);
});
