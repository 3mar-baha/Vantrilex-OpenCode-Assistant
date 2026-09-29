import { expect, test } from '@playwright/test';

// M2 Pattern 3 E2E — completion ≠ delivery, renderer half.
//
// The daemon cannot tell "the assistant is speaking" from "the assistant finished
// and nobody heard it" without evidence from the shell, and `playbackStarted` is
// that evidence. This spec proves the renderer sends it, ONCE per utterance, from
// the player's `onStart` — and not once per chunk, which is the failure the
// `AudioPlayer` `started` latch exists to prevent.
//
// It needs NO new stub route: the stub already records every command the real
// `UiServer` parsed and serves them from `/commands` (this is how
// `bargein.spec.ts` asserts `stopSpeech`). Adding `/playback-started` would have
// been a second, redundant way to observe the same thing.

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://localhost:4197${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function commands(): Promise<Array<{ kind: string; playbackId?: string }>> {
  const res = await fetch('http://localhost:4197/commands');
  return (await res.json()) as Array<{ kind: string; playbackId?: string }>;
}

test('the player tells the daemon playback started — once per utterance, not per chunk', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });

  const before = (await commands()).filter((c) => c.kind === 'playbackStarted').length;
  expect(before, 'no playback has happened yet, so nothing should have been reported').toBe(0);

  // A fake MP3 payload: decode fails in the player, but `enqueue` → `onStart` is
  // exactly the path under test (the same trick `downlink.spec.ts` uses).
  const payload = [0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4];
  await post('/audio-down', { bytes: payload });
  await expect
    .poll(async () => (await commands()).filter((c) => c.kind === 'playbackStarted').length, { timeout: 10_000 })
    .toBe(before + 1);

  const first = (await commands()).filter((c) => c.kind === 'playbackStarted')[before];
  // The id is a renderer-local correlation token. Bounded and non-empty is the
  // whole contract; it is NOT a session id and must never look like one.
  expect(first?.playbackId, 'the renderer correlates the playback').toBeTruthy();
  expect(String(first?.playbackId).length).toBeLessThanOrEqual(64);
  expect(String(first?.playbackId)).not.toMatch(/^ses_/);

  // THE POINT: three more chunks of the SAME contiguous run must not add more
  // reports — the latch is per queue residency, not per chunk. (Peer review:
  // in production Fish sentence gaps empty the queue, so this is roughly per
  // sentence, not per utterance; back-to-back posts here are one run, which is
  // exactly the shape asserted.)
  await post('/audio-down', { bytes: payload });
  await post('/audio-down', { bytes: payload });
  await post('/audio-down', { bytes: payload });
  await page.waitForTimeout(2_000);
  const after = (await commands()).filter((c) => c.kind === 'playbackStarted').length;
  expect(after, 'onStart is latched per contiguous run, not per chunk').toBe(before + 1);

  // A barge ends the run, so the NEXT utterance reports again — that is the
  // latch clearing, not the signal being one-shot forever.
  await page.getByTestId('abort-button').click();
  await post('/audio-down', { bytes: payload });
  await expect
    .poll(async () => (await commands()).filter((c) => c.kind === 'playbackStarted').length, { timeout: 10_000 })
    .toBeGreaterThan(after);
});

test('the barge-in button still aborts the turn — playbackStarted is not a control path', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });

  const abortsBefore = (await commands()).filter((c) => c.kind === 'abort').length;
  await page.getByTestId('abort-button').click();
  await expect
    .poll(async () => (await commands()).filter((c) => c.kind === 'abort').length, { timeout: 10_000 })
    .toBe(abortsBefore + 1);
});
