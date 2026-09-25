import { expect, test } from '@playwright/test';

// 3-key intake lives in the settings window. The modal gates on all three
// fields (fail-closed) and the daemon records a saveApiKeys command carrying
// all three values.
async function commands(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch('http://localhost:4197/commands');
  return (await res.json()) as Array<Record<string, unknown>>;
}

test('API key intake mandates all three keys, then dispatches saveApiKeys', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('في وضع الاستعداد', { timeout: 10_000 });

  const [settings] = await Promise.all([context.waitForEvent('page'), page.getByTestId('open-apikeys').click()]);
  await settings.waitForLoadState('domcontentloaded');

  await expect(settings.getByTestId('apikey-banner')).toContainText('All 3 API keys are required');

  const save = settings.getByTestId('apikey-save');
  await expect(save).toBeDisabled();

  await settings.getByTestId('apikey-groq').fill('gsk-e2e-groq');
  await expect(save).toBeDisabled();
  await settings.getByTestId('apikey-fish').fill('sk-fish-e2e');
  await expect(save).toBeDisabled();
  await settings.getByTestId('apikey-openrouter').fill('sk-or-e2e');
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

  await settings.close();
});