import { expect, test, type Page } from '@playwright/test';

// M4 C.6 — the microphone calibration wizard, end to end.
//
// WHAT IS ASSERTED HERE IS DELIBERATELY THIN, and the reason is written down
// rather than hidden behind a green tick: the wizard's only real input is
// microphone audio, and this project launches Chromium with
// `--use-fake-device-for-media-stream` (playwright.config.ts). Chromium's fake
// device emits a synthetic tone, and NOBODY HAS MEASURED what energy that tone
// puts through this pipeline on this machine. So a spec that asserted a floor
// value, or even that the room reads `quiet`, would be asserting a number this
// suite invented — the exact defect class this item is not allowed to ship.
//
// WHAT IS DETERMINISTIC AND THEREFORE ASSERTED: the surface. The footer
// control opens a `PortalShell`; the three phases run in order over the real
// 10 s clock; Esc closes it; the panel is bounded; the deferred-threshold
// control is absent; and the stub records no command, so a measurement cannot
// have reached the daemon. None of that depends on what the fake device emits,
// and the run completes whether or not the device opened.
//
// WHAT IS NOT COVERED HERE: every verdict band. The band table, both gate
// boundaries, the unmeasured arm and the purity of the meter are
// `src/audio/calibration-meter.test.ts`; the verdict copy and the absent
// threshold control are `src/components/portals/CalibrationWizard.test.tsx`.

async function open(page: Page): Promise<void> {
  // Cold Vite transform of the whole graph is harness cost, not product
  // behaviour — see credit.spec.ts for the same reasoning.
  await page.goto('/', { timeout: 90_000 });
}

async function commandCount(): Promise<number> {
  const res = await fetch('http://localhost:4197/commands');
  const rows = (await res.json()) as unknown[];
  return rows.length;
}

test('the footer opens the calibration portal and the three phases run in order', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  const trigger = page.getByTestId('open-calibration');
  await expect(trigger).toBeVisible();
  // Every control carries an Arabic title. The visible label is the roadmap's.
  await expect(trigger).toHaveText('معايرة الميكروفون');
  expect(await trigger.getAttribute('title')).toMatch(/\p{sc=Arabic}/u);

  await trigger.click();
  const portal = page.getByTestId('calibration-portal');
  await expect(portal).toBeVisible();
  await expect(portal).toHaveAttribute('data-phase', 'listen');

  // The real clock, the real 10 s. Recorded as a sequence so the ORDER is what
  // is asserted — a portal that skipped to the verdict would fail here.
  const seen: string[] = ['listen'];
  const current = (): string | null => portal.getAttribute('data-phase');
  for (const want of ['measure', 'verdict', 'done']) {
    await expect
      .poll(current, { timeout: 15_000, message: `phase ${want}` })
      .toBe(want);
    seen.push(want);
  }
  expect(seen).toEqual(['listen', 'measure', 'verdict', 'done']);
  // A verdict is shown for all three bands, measured or not — which is exactly
  // why its TEXT is not asserted here.
  await expect(page.getByTestId('calibration-verdict')).toHaveCount(1);
});

test('the deferred-threshold control is absent and the panel is bounded', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });
  await page.getByTestId('open-calibration').click();

  const body = page.getByTestId('calibration-body');
  await expect(body).toBeVisible();
  // Persistence is SPECULATIVE and deferred, and the renderer holds no durable
  // state at all. A control that could not work must not be rendered.
  await expect(body.locator('input')).toHaveCount(0);
  await expect(body.locator('select')).toHaveCount(0);
  await expect(body.locator('textarea')).toHaveCount(0);

  const box = await body.evaluate((el) => {
    const style = window.getComputedStyle(el);
    return { maxHeight: style.maxHeight, width: style.width };
  });
  expect(parseFloat(box.maxHeight)).toBeGreaterThan(0);
  expect(parseFloat(box.maxHeight)).toBeLessThanOrEqual(600);
  expect(parseFloat(box.width)).toBeLessThanOrEqual(440);
});

test('Esc closes the portal and the daemon is sent nothing', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  // Snapshot, do not assert zero: the stub is shared by the whole run and
  // earlier specs in the same worker have already sent their own commands.
  const before = await commandCount();

  await page.getByTestId('open-calibration').click();
  await expect(page.getByTestId('calibration-portal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('calibration-portal')).toHaveCount(0);

  // A measurement is a local act. No command, no canned reply.
  expect(await commandCount()).toBe(before);
  await expect(page.getByTestId('announce')).toHaveText('');
});
