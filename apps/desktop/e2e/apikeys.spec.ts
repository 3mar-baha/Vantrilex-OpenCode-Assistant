import { expect, test } from '@playwright/test';

// 3-key intake E2E — the modal gates on all three fields (fail-closed) and
// the daemon records a saveApiKeys command carrying all three values.
async function commands(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch('http://localhost:4197/commands');
  return (await res.json()) as Array<Record<string, unknown>>;
}

test('API key intake mandates all three keys, then dispatches saveApiKeys', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('bridge: live', { timeout: 10_000 });

  await page.getByTestId('open-apikeys').click();
  await expect(page.getByTestId('apikey-banner')).toContainText('All 3 API keys are required');

  const save = page.getByTestId('apikey-save');
  await expect(save).toBeDisabled();

  await page.getByTestId('apikey-groq').fill('gsk-e2e-groq');
  await expect(save).toBeDisabled();
  await page.getByTestId('apikey-fish').fill('sk-fish-e2e');
  await expect(save).toBeDisabled();
  await page.getByTestId('apikey-openrouter').fill('sk-or-e2e');
  await expect(save).toBeEnabled();

  await save.click();
  await expect
    .poll(
      async () =>
        (await commands()).some(
          (c) =>
            c['kind'] === 'saveApiKeys' &&
            c['groqKey'] === 'gsk-e2e-groq' &&
            c['fishKey'] === 'sk-fish-e2e' &&
            c['openrouterKey'] === 'sk-or-e2e',
        ),
      { timeout: 5_000 },
    )
    .toBe(true);
});
