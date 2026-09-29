import { expect, test } from '@playwright/test';

// Barge-in E2E — while the assistant talks (speech downlink active), the live
// mic's voice frames halt playback and deliver a `stopSpeech` to the daemon.
// Ducking/energy gating is unit-proven (vad.test.ts); this proves the full
// renderer → WS-4097 → stub path with the real capture + player wiring.
//
// M2 Pattern 2: this spec used to assert `abort` here, which was the bug — a
// barge cancelled the whole turn, discarding a plan the user was already paying
// for. The button's `abort` is still covered, in `abort.spec.ts`; the split is
// also pinned renderer-side in `src/App.test.ts`.
async function commands(): Promise<Array<{ kind: string }>> {
  const res = await fetch('http://localhost:4197/commands');
  return (await res.json()) as Array<{ kind: string }>;
}

async function audio(): Promise<{ frames: number; bytes: number }> {
  const res = await fetch('http://localhost:4197/audio');
  return (await res.json()) as { frames: number; bytes: number };
}

test('voice during playback stops the daemon SPEECH, without cancelling the turn', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });

  const stopsBefore = (await commands()).filter((c) => c.kind === 'stopSpeech').length;
  const abortsBefore = (await commands()).filter((c) => c.kind === 'abort').length;
  await fetch('http://localhost:4197/audio/reset', { method: 'POST' });

  // Unmute: the fake mic starts streaming PCM to the daemon.
  const mic = page.getByTestId('mic-toggle');
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(async () => (await audio()).frames, { timeout: 15_000 })
    .toBeGreaterThan(0);

  // Keep speech playing (each broadcast relatches the speaking state) while
  // the mic runs; the fake device's tone bursts must trip barge-in.
  const deadline = Date.now() + 25_000;
  let stopsAfter = stopsBefore;
  while (Date.now() < deadline) {
    await fetch('http://localhost:4197/audio-down', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytes: [0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4] }),
    });
    await page.waitForTimeout(1000);
    stopsAfter = (await commands()).filter((c) => c.kind === 'stopSpeech').length;
    if (stopsAfter > stopsBefore) break;
  }
  expect(stopsAfter).toBeGreaterThan(stopsBefore);

  // The point of the split: a barge must NOT be the turn cancel.
  const abortsAfter = (await commands()).filter((c) => c.kind === 'abort').length;
  expect(abortsAfter, 'a barge must not cancel the turn — that is the abort button').toBe(abortsBefore);

  // Mic was genuinely live during the window (frames kept flowing or ducked).
  expect((await audio()).frames).toBeGreaterThan(0);

  // Restore the privacy-safe default for the specs that follow.
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
});
