import { expect, test } from '@playwright/test';

// MICROPHONE CALIBRATION — RETIRED as a UI capability, and this is the record.
//
// WHAT WAS RETIRED. The bento footer carried `open-calibration`, which opened a
// `PortalShell` wrapping `CalibrationWizard`. The trigger is gone; there is no
// other entry point anywhere in the renderer. Confirmed in the live DOM:
// `open-calibration`, `calibration-portal` and `calibration-body` all measure
// ZERO, and the only non-test references to `CalibrationWizard` are its own
// source file, `calibration-meter.ts` and a comment in App.tsx. No JSX mounts it.
//
// WHAT SURVIVES. `src/audio/calibration-meter.ts` and `CalibrationWizard.tsx`
// both still exist with their own unit suites (`CalibrationWizard.test.tsx`,
// `calibration-meter.test.ts`) — 14 unit tests over the phase order, the verdict
// bands, the absent threshold control and the purity of the meter. So the LOGIC
// is still tested; what the user lost is the way to reach it.
//
// WHY IT MATTERS MORE THAN A COSMETIC LOSS. First-run mic/VAD calibration was
// the queued mitigation for "a voice-first user on a bad room gets mis-heard and
// has no recourse". With no trigger, that recourse does not exist. The daemon
// still holds a speech gate and still drops quiet windows (`ingest.ts`), so the
// failure mode it was meant to fix is still live.
//
// The three tests this file replaces asserted the wizard's phase order over the
// real 10 s clock, the absent threshold control, and Esc-closes-with-no-command.
// All three are unreachable through the product, so they are retired rather than
// weakened. The negative invariant they protected — "a calibration measurement
// sends the daemon nothing" — is restated below against the shell as it stands,
// because that is still enforceable.
test('there is NO calibration trigger anywhere in the widget', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  await expect(page.getByTestId('open-calibration')).toHaveCount(0);
  await expect(page.getByTestId('calibration-portal')).toHaveCount(0);
  await expect(page.getByTestId('calibration-body')).toHaveCount(0);
  await expect(page.getByTestId('calibration-verdict')).toHaveCount(0);

  // The trigger is not hidden behind a tab or a scroll either — the whole shell
  // is three buttons, and this is all of them.
  await expect(page.locator('button')).toHaveCount(3);

  // The settings window is the only other surface, and it has no calibration tab.
  const [settings] = await Promise.all([page.context().waitForEvent('page'), page.keyboard.press('Control+Comma')]);
  await settings.waitForLoadState('domcontentloaded');
  await expect(settings.getByTestId('settings-view')).toBeVisible();
  for (const id of ['open-calibration', 'calibration-portal', 'calibration-body', 'calibration-verdict']) {
    await expect(settings.getByTestId(id)).toHaveCount(0);
  }
  await settings.close();
});

test('the mic toggle still sends only `deafen` — no measurement command exists', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  // The invariant the retired Esc test guarded: a local measurement must never
  // reach the daemon. There is no measurement surface left, so the only mic
  // command the shell can emit is the mute.
  const rows = () => fetch('http://localhost:4197/commands').then((r) => r.json() as Promise<Array<{ kind: string }>>);
  const before = await rows();

  const mic = page.getByTestId('mic-toggle');
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await rows()).filter((c) => c.kind === 'deafen').length, { timeout: 5_000 })
    .toBe(before.filter((c) => c.kind === 'deafen').length + 1);

  const after = await rows();
  const kinds = after.slice(before.length).map((c) => c.kind);
  expect(new Set(kinds), 'only the mute travels').toEqual(new Set(['deafen']));

  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
});
