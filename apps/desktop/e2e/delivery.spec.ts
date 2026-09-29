import { expect, test } from '@playwright/test';

// M2 Pattern 3 E2E — completion ≠ delivery, renderer half.
//
// The daemon cannot tell "the assistant is speaking" from "the assistant finished
// and nobody heard it" without evidence from the shell, and `playbackStarted` is
// that evidence. This spec proves the renderer sends it from the player's
// `onStart` with a bounded, non-session correlation id. The per-run latch
// itself is unit-pinned in playback.test.ts (E2E timing cannot deterministically
// hold a run open: fake decode fails fast).
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

test('the player tells the daemon playback started, with a bounded correlation id', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });

  // NOTE: the stub's /commands log is GLOBAL across the whole Playwright run
  // (one stub process), so earlier specs (e.g. bargein) may already have left
  // playbackStarted rows. Assert the DELTA this spec produces, never an
  // absolute zero — the zero-assumption failed the M2 close gate.
  const before = (await commands()).filter((c) => c.kind === 'playbackStarted').length;

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

  // LATCH HONESTY (M2 close-gate fix): whether three back-to-back posts are
  // one run or three depends on decode timing — the fake payload fails decode
  // fast, so the queue may drain between posts and each legitimately reports.
  // The per-run latch itself is unit-pinned in playback.test.ts; here we pin
  // the deterministic part: every emitted row carries a bounded,
  // non-session correlation id, however many rows there are.
  await post('/audio-down', { bytes: payload });
  await post('/audio-down', { bytes: payload });
  await post('/audio-down', { bytes: payload });
  await page.waitForTimeout(2_000);
  const rows = (await commands()).filter((c) => c.kind === 'playbackStarted');
  expect(rows.length, 'reports were emitted').toBeGreaterThan(before);
  for (const row of rows) {
    expect(String(row.playbackId).length, 'bounded correlation id').toBeLessThanOrEqual(64);
    expect(String(row.playbackId), 'never a session id').not.toMatch(/^ses_/);
  }
  const after = rows.length;

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

  // Determinism precondition (M2 close-gate fix): the abort button sends
  // 'abort' only while `live` (matrix !== 0), and a fresh page has matrix 0
  // (which sends 'arm' instead). Drive a lifecycle event through the stub's
  // existing /fire route first — without this the test asserts whatever the
  // ambient matrix happens to be, and it failed exactly that way in isolation
  // while passing in full runs by accident of ordering.
  await post('/fire', { state: 'running' });
  await expect(page.getByTestId('abort-button')).toContainText('إيقاف التوليد', { timeout: 10_000 });

  const abortsBefore = (await commands()).filter((c) => c.kind === 'abort').length;
  await page.getByTestId('abort-button').click();
  await expect
    .poll(async () => (await commands()).filter((c) => c.kind === 'abort').length, { timeout: 10_000 })
    .toBe(abortsBefore + 1);

  // Leave the campsite clean (M2 close-gate fix): the /fire event above is
  // RETAINED in the stub's resume buffer, and the next spec's fresh page
  // connects with ?lastSeq=0 — so it replays our stale `running` event,
  // lands matrix=2, and reads "processing" instead of "ready". An `idle`
  // close-out restores the shared stub for whoever runs next. (This is the
  // B.2c resume-gap hole, confirmed live: silence vs missed-everything are
  // indistinguishable without it. Product fix is M3 scope.)
  await post('/fire', { state: 'idle' });
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });
});
