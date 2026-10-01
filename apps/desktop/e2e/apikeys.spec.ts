import { expect, test } from '@playwright/test';
import { fillKeys, installVaultDaclShim, openKeysWindow, shimLog } from './keys-window.js';

// 3-key intake lives in the dedicated keys window. The form gates on all three
// fields (fail-closed) and the daemon records a saveApiKeys command with all
// three values — never echoing them back into the page.
//
// bd103b2 renamed only the TRIGGER (`open-apikeys` → `open-keys`, see
// `keys-window.ts`). The window, the form and the DACL receipt below are all
// still live product code, so none of these three tests is weakened by the Orb
// rewrite — they were failing purely on the stale selector.
async function commands(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch('http://localhost:4197/commands');
  return (await res.json()) as Array<Record<string, unknown>>;
}

test('API key intake mandates all three keys, then dispatches saveApiKeys', async ({ page, context }) => {
  const keys = await openKeysWindow(page, context);

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

test('A.2 — a host-confirmed DACL re-lock rides alongside the saved receipt', async ({ page, context }) => {
  const keys = await openKeysWindow(page, context);
  await installVaultDaclShim(keys, true);
  await fillKeys(keys);
  await keys.getByTestId('apikey-save').click();

  await expect(keys.getByTestId('keys-saved')).toBeVisible({ timeout: 5_000 });
  await expect(keys.getByTestId('keys-dacl-ok')).toBeVisible({ timeout: 5_000 });
  await expect(keys.getByTestId('keys-dacl-warn')).toHaveCount(0);
  // Break-guard: the shim proves the real invoke reached the host by name.
  expect(await shimLog(keys)).toContain('restrict_vault_file');

  await keys.close();
});

test('A.2/C.1 — an UNCONFIRMED lock warns amber but never retracts the save receipt', async ({ page, context }) => {
  // The guard arm. An `Ok(false)` is a lock that could not be confirmed — it is
  // NOT a failed save, and collapsing the two would tell the operator to
  // re-enter credentials that are already on disk.
  //
  // C.1 split this case in two. It used to be driven by a REJECTING command,
  // which conflated `Ok(false)` with a Rust `Err`; but `restrict_vault_file`
  // fails closed by DELETING `keyring.dat` on `Err`, so the rejection arm is a
  // keyring-loss error plus a re-prompt and lives in `keys-dacl.spec.ts`.
  const keys = await openKeysWindow(page, context);
  await installVaultDaclShim(keys, false);
  await fillKeys(keys);
  await keys.getByTestId('apikey-save').click();

  await expect(keys.getByTestId('keys-dacl-warn')).toBeVisible({ timeout: 5_000 });
  // The save receipt stands: the daemon really did record the three keys.
  await expect(keys.getByTestId('keys-saved')).toBeVisible();
  await expect(keys.getByTestId('keys-dacl-ok')).toHaveCount(0);
  await expect(keys.getByTestId('keys-dacl-error')).toHaveCount(0);
  // A DACL warn must never reach saveError — that would tell the operator the
  // keys were rejected. (`apikey-banner` is the permanent all-3-required hint,
  // not an error; the error surface is `apikey-error`.)
  await expect(keys.getByTestId('apikey-error')).toHaveCount(0);

  await keys.close();
});
