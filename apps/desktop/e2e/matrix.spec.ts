import { expect, test } from '@playwright/test';

// DAEMON LIFECYCLE — RETIRED as a visual subject, and this is the record.
//
// WHAT CHANGED. The bento rendered `SiriWaveCanvas` with a `data-mode` that
// tracked the daemon's `event` frames (`running` → active, `complete` → idle).
// That canvas is gone, replaced by the Orb, and the Orb's `data-phase` is driven
// by the `voice` frame — a DIFFERENT signal. `App.tsx` registers no `onEvent`
// handler at all, so a lifecycle `event` frame now reaches the bridge and is
// dropped: the shell has no `onEvent` subscription to route it to.
//
// So this is not a rename. `matrix.spec.ts` asserted "lifecycle event → wave
// mode", and that causal chain no longer exists anywhere in the renderer. The
// property is asserted below in its new form — the lifecycle event must not
// CORRUPT the orb's phase, which is the failure a dropped-but-observed handler
// would cause.
async function fire(state: string): Promise<unknown> {
  const res = await fetch('http://localhost:4197/fire', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  return res.json();
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://localhost:4197${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

test('the Orb is NOT driven by lifecycle events — only by voicePhase', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });
  const orb = page.getByTestId('orb');
  await expect(orb).toHaveAttribute('data-phase', 'idle');

  // Lifecycle events are published by the real UiServer to every client. They
  // must leave the orb alone: the orb speaks for the VOICE phase, and a daemon
  // session going `running` is not the assistant talking.
  await fire('running');
  await expect(orb).toHaveAttribute('data-phase', 'idle', { timeout: 5_000 });
  await fire('complete');
  await expect(orb).toHaveAttribute('data-phase', 'idle', { timeout: 5_000 });

  // The signal that DOES drive it.
  await post('/voice', { phase: 'listening', transcript: 'ما الدوال المتاحة؟' });
  await expect(orb).toHaveAttribute('data-phase', 'listening', { timeout: 5_000 });

  // And a lifecycle event mid-utterance must not knock it off the voice phase.
  await fire('running');
  await expect(orb).toHaveAttribute('data-phase', 'listening', { timeout: 5_000 });

  await post('/voice', { phase: 'idle' });
  await expect(orb).toHaveAttribute('data-phase', 'idle', { timeout: 5_000 });

  // Close out the shared stub's retained event so the next spec's fresh page
  // replays an `idle` rather than a stale `running` (the B.2c resume-gap note in
  // delivery.spec.ts).
  await fire('idle');
});

test('a daemon lifecycle event does not fabricate a speaking indication', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });
  const orb = page.getByTestId('orb');

  await fire('running');
  // `speaking` is persona-coloured, so a false positive here would paint the orb
  // in a voice's colour while nobody is talking.
  await expect(orb).not.toHaveAttribute('data-phase', 'speaking');
  await expect(orb).toHaveAttribute('data-phase', 'idle', { timeout: 5_000 });
  await fire('idle');
});
