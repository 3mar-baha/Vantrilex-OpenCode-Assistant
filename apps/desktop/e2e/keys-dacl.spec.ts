import { expect, test } from '@playwright/test';
import { fillKeys, installVaultDaclShim, openKeysWindow, shimLog } from './keys-window.js';

// C.1 — the negative half of the DACL receipt.
//
// The receipt is only meaningful if its ABSENCE is also asserted. In a plain
// browser there is no Tauri host, so `restrictVaultFile()` returns null and
// nothing about `keyring.dat` is knowable. The failure this guards is subtle
// and one-directional: a "probably fine" default would render a lock line that
// looks identical to the confirmed one, and no positive-path assertion in the
// suite can catch it. Hence count 0, asserted on both lines.

test('C.1 — no Tauri host renders NO dacl line: an unverified lock must never read as a confirmed one', async ({
  page,
  context,
}) => {
  // No shim anywhere: the popup is a real browser document with no host, which
  // is exactly the case under test.
  const keys = await openKeysWindow(page, context);
  await fillKeys(keys);
  await keys.getByTestId('apikey-save').click();

  await expect(keys.getByTestId('keys-saved')).toBeVisible({ timeout: 5_000 });
  await expect(keys.getByTestId('keys-dacl-ok')).toHaveCount(0);
  await expect(keys.getByTestId('keys-dacl-warn')).toHaveCount(0);
  await expect(keys.getByTestId('keys-dacl-error')).toHaveCount(0);

  await keys.close();
});

test('C.1 — a host FAILURE (Err) errors and re-prompts; it never renders the passive warn', async ({
  page,
  context,
}) => {
  // `restrict_vault_file` returns Err when the owner-only DACL cannot be
  // applied, and that path DELETES `keyring.dat` fail-closed. Tauri delivers
  // Err as a rejected invoke, so this arm must read as "the keyring is gone,
  // enter the keys again" — not as an amber footnote under a green receipt.
  const keys = await openKeysWindow(page, context);
  await installVaultDaclShim(keys, 'reject');
  await fillKeys(keys);
  await keys.getByTestId('apikey-save').click();

  await expect(keys.getByTestId('keys-dacl-error')).toBeVisible({ timeout: 5_000 });
  await expect(keys.getByTestId('keys-dacl-warn')).toHaveCount(0);
  // A green "keys saved" receipt would be claiming an encrypted file that the
  // host just deleted.
  await expect(keys.getByTestId('keys-saved')).toHaveCount(0);
  // Re-prompt: the three inputs are emptied and Save is disabled again.
  await expect(keys.getByTestId('apikey-groq')).toHaveValue('');
  await expect(keys.getByTestId('apikey-fish')).toHaveValue('');
  await expect(keys.getByTestId('apikey-openrouter')).toHaveValue('');
  await expect(keys.getByTestId('apikey-save')).toBeDisabled();
  // Break-guard: the shim proves the real invoke reached the host by name.
  expect(await shimLog(keys)).toContain('restrict_vault_file');

  await keys.close();
});
