import { expect, test, type Page } from '@playwright/test';

// 3-key intake lives in the dedicated keys window. The form gates on all three
// fields (fail-closed) and the daemon records a saveApiKeys command with all
// three values — never echoing them back into the page.
async function commands(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch('http://localhost:4197/commands');
  return (await res.json()) as Array<Record<string, unknown>>;
}

/**
 * A.2 — a `__TAURI_INTERNALS__` shim so the keys window takes the REAL invoke
 * path (no module mock: the import, the call and the result handling are the
 * shipped ones).
 *
 * Installed on the POPUP page, not the context: the HUD must keep seeing no
 * Tauri host, or `openKeysWindow` would try a native `WebviewWindow` and there
 * would be no popup to assert against. A context-level `addInitScript` is also
 * measurably not enough here — the popup is a `window.open` navigation, and
 * only its `about:blank` document is covered, so the shim never reaches the
 * real `index.html?view=keys` document. `addInitScript` + `reload()` does.
 */
async function installVaultDaclShim(keys: Page, daclResult: boolean | 'reject'): Promise<void> {
  await keys.addInitScript((cfg: { daclResult: boolean | 'reject' }) => {
    const log: string[] = [];
    const w = window as unknown as Record<string, unknown>;
    w['__daclShimLog'] = log;
    w['__TAURI_INTERNALS__'] = {
      transformCallback: (cb: unknown) => {
        const id = Math.floor(Math.random() * 1e9);
        w[`_cb_${id}`] = cb;
        return id;
      },
      unregisterCallback: () => undefined,
      invoke: async (cmd: string): Promise<unknown> => {
        log.push(cmd);
        if (cmd === 'ipc_token') return 'e2e-token';
        if (cmd === 'restrict_vault_file') {
          if (cfg.daclResult === 'reject') throw new Error('SetNamedSecurityInfoW failed');
          return cfg.daclResult;
        }
        throw new Error(`unexpected tauri command: ${cmd}`);
      },
    };
  }, { daclResult });
  await keys.reload();
  await expect(keys.getByTestId('keys-view')).toBeVisible();
}

function shimLog(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as unknown as Record<string, unknown>)['__daclShimLog'] as unknown[]);
}

async function fillKeys(keys: Page): Promise<void> {
  await keys.getByTestId('apikey-groq').fill('gsk-e2e-groq');
  await keys.getByTestId('apikey-fish').fill('sk-fish-e2e');
  await keys.getByTestId('apikey-openrouter').fill('sk-or-e2e');
  await expect(keys.getByTestId('apikey-save')).toBeEnabled();
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

test('A.2 — a host-confirmed DACL re-lock rides alongside the saved receipt', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });

  const [keys] = await Promise.all([context.waitForEvent('page'), page.getByTestId('open-apikeys').click()]);
  await keys.waitForLoadState('domcontentloaded');
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

test('A.2 — an unconfirmed DACL warns amber but never retracts the save receipt', async ({ page, context }) => {
  // The guard arm. A `false` (or a throwing command) is a lock that could not
  // be confirmed — it is NOT a failed save, and collapsing the two would tell
  // the operator to re-enter credentials that are already on disk.
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });

  const [keys] = await Promise.all([context.waitForEvent('page'), page.getByTestId('open-apikeys').click()]);
  await keys.waitForLoadState('domcontentloaded');
  await installVaultDaclShim(keys, 'reject');
  await fillKeys(keys);
  await keys.getByTestId('apikey-save').click();

  await expect(keys.getByTestId('keys-dacl-warn')).toBeVisible({ timeout: 5_000 });
  // The save receipt stands: the daemon really did record the three keys.
  await expect(keys.getByTestId('keys-saved')).toBeVisible();
  await expect(keys.getByTestId('keys-dacl-ok')).toHaveCount(0);
  // A DACL warn must never reach saveError — that would tell the operator the
  // keys were rejected. (`apikey-banner` is the permanent all-3-required hint,
  // not an error; the error surface is `apikey-error`.)
  await expect(keys.getByTestId('apikey-error')).toHaveCount(0);

  await keys.close();
});