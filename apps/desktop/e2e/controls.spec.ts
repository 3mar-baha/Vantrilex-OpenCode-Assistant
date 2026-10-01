import { expect, test } from '@playwright/test';

// Phase 3 E2E — the model switch that still EXISTS, from the surface that now
// owns it.
//
// RETIREMENT NOTE (bd103b2). This file used to hold two tests against the bento's
// `agent-model-badge`: "agent/model switch round-trips with session scope" and
// "discovered agents populate a live selector". Both are capability retirements,
// not renames, and they are catalogued in the hand-off report:
//
//   · SESSION SWITCHING is unreachable. `session-chip`, `session-chip-trigger`,
//     `session-list` and every `session-<id>` measure ZERO in the live DOM, and
//     nothing in the renderer sends `switchSession`. The user can no longer
//     change which session the companion talks to.
//   · AGENT SWITCHING (`setSessionAgent`) is unreachable — `badge-switch-agent`
//     and `agent-select` are gone and no surface sends the command. The
//     `agents` inventory frame still exists on the wire and the daemon still
//     implements the verb; only the control is missing.
//   · MODEL SWITCHING (`setSessionModel`) SURVIVES, but moved: the settings
//     window's Models tab has a `model-input` + `switch-model` pair. That is
//     what this file now proves.
//
// The dropped session-scope assertion is real loss, not a technicality: the
// router resolves `cmd.sessionId ?? deps.activeSessionId()`, so the settings
// switch always applies to the ACTIVE session and cannot target another one.
async function commands(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch('http://localhost:4197/commands');
  return (await res.json()) as Array<Record<string, unknown>>;
}

test('the model switch sends setSessionModel from the settings window', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  const [settings] = await Promise.all([context.waitForEvent('page'), page.keyboard.press('Control+Comma')]);
  await settings.waitForLoadState('domcontentloaded');
  await expect(settings.getByTestId('settings-view')).toBeVisible();

  const input = settings.getByTestId('model-input');
  const swap = settings.getByTestId('switch-model');
  await expect(input).toBeVisible();
  await expect(swap).toBeVisible();
  // An empty target is not a switch: the control refuses rather than sending a
  // blank model id at the daemon.
  await swap.click();
  await expect
    .poll(async () => (await commands()).filter((c) => c['kind'] === 'setSessionModel').length, { timeout: 3_000 })
    .toBe(0);

  await input.fill('provider/model-e2e');
  const before = (await commands()).filter((c) => c['kind'] === 'setSessionModel').length;
  await swap.click();
  await expect
    .poll(async () => (await commands()).filter((c) => c['kind'] === 'setSessionModel').length, { timeout: 5_000 })
    .toBe(before + 1);

  const row = (await commands()).filter((c) => c['kind'] === 'setSessionModel').pop();
  expect(row?.['model']).toBe('provider/model-e2e');
  // The field clears after a dispatch, so a second accidental click is inert.
  await expect(input).toHaveValue('');

  // The retired control is asserted absent so it cannot silently come back.
  await expect(page.getByTestId('agent-model-badge')).toHaveCount(0);
  await expect(page.getByTestId('badge-switch-model')).toHaveCount(0);
  await expect(page.getByTestId('agent-select')).toHaveCount(0);
  await settings.close();
});
