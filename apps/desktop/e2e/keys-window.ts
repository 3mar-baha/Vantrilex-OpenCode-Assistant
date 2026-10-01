import { expect, type BrowserContext, type Page } from '@playwright/test';

// Shared harness for the dedicated keys window (?view=keys). Lives outside the
// specs so the DACL shim cannot drift between them: two copies of a fake host
// is how a spec ends up asserting against a shape the real host never sends.

/** What the fake `restrict_vault_file` command answers. */
export type DaclAnswer = boolean | 'reject';

/**
 * A window URL's query string, for EXACT comparison.
 *
 * `toContain('view=keys')` is the check that let the doubled query parameter ship
 * for a month: `'?view=keys&view=keys'` contains `view=keys`, so every popup
 * assertion in this suite was blind to it. `open-settings.test.ts` now counts
 * occurrences, and these two helpers compare the whole search string, so a
 * regression fails here too instead of only in one unit.
 */
export function searchOf(url: string): string {
  return new URL(url).search;
}

async function waitForBridge(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });
}

/**
 * Open the keys window from the widget and return the popup page.
 *
 * The trigger was renamed by the Orb-shell rewrite (`bd103b2`): the bento's
 * `open-apikeys` button is gone and the pill's THIRD button, `open-keys`, opens
 * the same `?view=keys` window. This is a rename, not a retirement — the window,
 * the three-field form and the DACL receipt all still exist, which is why this
 * helper changed one selector and no assertion.
 */
export async function openKeysWindow(page: Page, context: BrowserContext): Promise<Page> {
  await waitForBridge(page);
  const [keys] = await Promise.all([context.waitForEvent('page'), page.getByTestId('open-keys').click()]);
  await keys.waitForLoadState('domcontentloaded');
  expect(searchOf(keys.url())).toBe('?view=keys');
  return keys;
}

/**
 * The settings window, reached the only way the Orb shell offers: `Ctrl+,`.
 *
 * This replaced a fourth button on the pill. The brief for the rewrite pins the
 * pill at EXACTLY three buttons and spends the third on the keys window, so the
 * general settings surface is reachable by keyboard only — see `orb-shell.spec.ts`,
 * which asserts that route end to end.
 */
export async function openSettingsWindow(page: Page, context: BrowserContext): Promise<Page> {
  await waitForBridge(page);
  const [settings] = await Promise.all([context.waitForEvent('page'), page.keyboard.press('Control+Comma')]);
  await settings.waitForLoadState('domcontentloaded');
  expect(searchOf(settings.url())).toBe('?view=settings&persona=kareem');
  return settings;
}

/**
 * A `__TAURI_INTERNALS__` shim so the keys window takes the REAL invoke
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
export async function installVaultDaclShim(keys: Page, daclResult: DaclAnswer): Promise<void> {
  await keys.addInitScript((cfg: { daclResult: DaclAnswer }) => {
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
          // A rejection is what Tauri does with a Rust `Err`, and
          // `restrict_vault_file` fails closed by deleting `keyring.dat`.
          if (cfg.daclResult === 'reject') throw new Error('keyring.dat: acl: SetNamedSecurityInfoW failed (5)');
          return cfg.daclResult;
        }
        throw new Error(`unexpected tauri command: ${cmd}`);
      },
    };
  }, { daclResult });
  await keys.reload();
  await expect(keys.getByTestId('keys-view')).toBeVisible();
}

export function shimLog(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as unknown as Record<string, unknown>)['__daclShimLog'] as unknown[]);
}

export async function fillKeys(keys: Page): Promise<void> {
  await keys.getByTestId('apikey-groq').fill('gsk-e2e-groq');
  await keys.getByTestId('apikey-fish').fill('sk-fish-e2e');
  await keys.getByTestId('apikey-openrouter').fill('sk-or-e2e');
  await expect(keys.getByTestId('apikey-save')).toBeEnabled();
}
