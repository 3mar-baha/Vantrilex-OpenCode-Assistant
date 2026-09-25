import { expect, test } from '@playwright/test';

// 3-key intake lives in the dedicated keys window. The form gates on all three
// fields (fail-closed) and the daemon records a saveApiKeys command with all
// three values — never echoing them back into the page.
async function commands(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch('http://localhost:4197/commands');
  return (await res.json()) as Array<Record<string, unknown>>;
}

test('API key intake mandates all three keys, then dispatches saveApiKeys', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });

  const [keys] = await Promise.all([context.waitForEvent('page'), page.getByTestId('open-apikeys').click()]);
  await keys.waitForLoadState('domcontentloaded');

  await expect(keys.getByTestId('apikey-banner')).toContainText('All 3 API keys are required');

  const save = keys.getByTestId('apikey-save');
  await expect(save).toBeDisabled();

  await keys.getByTestId('apikey-groq').fill('gsk-e2e-groq');
  await expect(save).toBeDisabled();
  await keys.getByTestId('apikey-fish').fill('sk-fish-e2e');
  await expect(save).toBeDisabled();
  await keys.getByTestId('apikey-openrouter').fill('sk-or-e2e');
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

  await keys.close();
});