import { expect, test } from '@playwright/test';
import { openSettingsWindow, searchOf } from './keys-window.js';

// The two auxiliary windows. Off-Tauri each opens as its own same-origin popup,
// so these assertions run against that page.
//
// bd103b2: the shell's `open-settings` button is gone (the pill is pinned at
// exactly three buttons and the third opens the KEYS window), so the settings
// window is reachable by `Ctrl+,` only — see the note in `keys-window.ts`. The
// settings window's own contents are untouched: 4 tabs, a chain roster, the
// voice/persona tab.
test('settings opens in its own window, tabs swap content, Esc closes', async ({ page, context }) => {
  const settings = await openSettingsWindow(page, context);

  await expect(settings.getByTestId('settings-view')).toBeVisible();
  await expect(settings.getByRole('tab')).toHaveCount(4);
  // Keys are decoupled from general settings.
  await expect(settings.getByTestId('apikey-groq')).toHaveCount(0);
  // Anchored on `chain-list`, the container, not a per-agent testid. This
  // asserted `chain-nemotron` until dc84866 moved the coordinator role to
  // Inkling and the id became `chain-inkling-coordinator`; a roster change must
  // not be able to break this again, so assert the list and that it is populated
  // rather than pinning one agent's name.
  const chain = settings.getByTestId('chain-list');
  await expect(chain).toBeVisible();
  await expect(chain.locator('[data-testid^="chain-"]')).not.toHaveCount(0);

  await settings.getByRole('tab', { name: /الصوت/ }).click();
  await settings.getByTestId('persona-nour').click();
  await expect(settings.getByTestId('persona-nour')).toHaveAttribute('aria-checked', 'true');
  await expect(settings.getByTestId('persona-kareem')).toHaveAttribute('aria-checked', 'false');

  await settings.keyboard.press('Escape').catch(() => undefined);
  await expect.poll(() => settings.isClosed(), { timeout: 5_000 }).toBe(true);

  // The widget is untouched by the settings window closing.
  await expect(page.getByTestId('voxaura-shell')).toBeVisible();
  await expect(page.getByTestId('orb')).toBeVisible();
});

test('API keys open in a dedicated focused window', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  const [keys] = await Promise.all([context.waitForEvent('page'), page.getByTestId('open-keys').click()]);
  await keys.waitForLoadState('domcontentloaded');
  expect(searchOf(keys.url())).toBe('?view=keys');

  await expect(keys.getByTestId('keys-view')).toBeVisible();
  // Dedicated: no tab bar, unlike the settings window.
  await expect(keys.getByRole('tab')).toHaveCount(0);
  await expect(keys.getByTestId('apikey-groq')).toBeVisible();
  await expect(keys.getByTestId('apikey-fish')).toBeVisible();
  await expect(keys.getByTestId('apikey-openrouter')).toBeVisible();
  // The retired trigger is asserted absent; the pill's third button replaced it.
  await expect(page.getByTestId('open-apikeys')).toHaveCount(0);
  await expect(page.getByTestId('open-settings')).toHaveCount(0);
  await keys.close();
});
