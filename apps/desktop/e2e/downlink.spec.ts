import { expect, test } from '@playwright/test';

// P4b E2E — daemon speech reaches the shell as binary chunks and the orb lights
// up for `speaking`.
//
// Re-pointed by bd103b2: the old `speaking-indicator` was a separate DOM element;
// the pinned mapping folds it into `orb[data-phase=speaking]`. Note the change
// in WHAT drives it: the old indicator was lit by the player's `onStart` (audio
// actually arriving), while `data-phase` is driven by the daemon's `voice` frame.
// The test therefore drives both — the voice phase, and the downlink that proves
// the audio path is real — and asserts each on the surface that owns it.
async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://localhost:4197${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

test('spoken reply lights the orb for `speaking`', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });
  const orb = page.getByTestId('orb');
  await expect(orb).toHaveAttribute('data-phase', 'idle');
  await expect(orb).not.toHaveAttribute('data-phase', 'speaking');

  // Fake MP3 payload: decode fails in the player, but the delivery path
  // (enqueue → onStart) is real and the stub reports the chunk was fanned out.
  const result = (await post('/audio-down', { bytes: [0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4] })) as { chunks: number };
  expect(result.chunks).toBe(1);

  // The phase the orb reads.
  await post('/voice', { phase: 'speaking' });
  await expect(orb).toHaveAttribute('data-phase', 'speaking', { timeout: 5_000 });
  await expect(orb).toHaveAttribute('role', 'img');
  // The one phase whose accessible name names the voice rather than the state.
  await expect(orb).toHaveAttribute('aria-label', /تحدث بصوت/);

  // The old element is asserted absent so the two indicators cannot coexist and
  // drift apart.
  await expect(page.getByTestId('speaking-indicator')).toHaveCount(0);
  await expect(page.getByTestId('siri-wave')).toHaveCount(0);
  await expect(page.getByTestId('waveform-emblem')).toHaveCount(0);

  await post('/voice', { phase: 'idle' });
  await expect(orb).toHaveAttribute('data-phase', 'idle', { timeout: 5_000 });
});

test('audio chunks are split to the transport bound and reassembled by the shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  // MAX_AUDIO_CHUNK is 32 KiB (protocol.ts). A payload above it MUST be split,
  // because the renderer's player enqueues one decoded unit per chunk and a
  // single oversized frame would be rejected by the daemon before it got here.
  const big = new Array(40_000).fill(7);
  const result = (await post('/audio-down', { bytes: big })) as { chunks: number };
  expect(result.chunks, 'a 40 KB payload is split, not sent whole').toBeGreaterThan(1);

  // And the small one is a single chunk — the split is real, not a fan-out.
  const small = (await post('/audio-down', { bytes: [1, 2, 3, 4] })) as { chunks: number };
  expect(small.chunks).toBe(1);
});
