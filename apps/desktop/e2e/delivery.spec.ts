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
// `bargein.spec.ts` asserts `stopSpeech`).
//
// bd103b2: this file's second test clicked `abort-button` twice — once for the
// latch-clearing precondition and once for its subject. That button is gone, and
// with it the turn-cancel capability it measured (see `abort.spec.ts`). The
// latch is cleared by anything that calls `stop()` on the player, and the mute
// is one of them (`AudioPlayer.setMuted(true)` → `stop()`), so the re-point is a
// real control rather than a stubbed one.

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

const FAKE_MP3 = [0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4];

test('the player tells the daemon playback started, with a bounded correlation id', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  // NOTE: the stub's /commands log is GLOBAL across the whole Playwright run
  // (one stub process), so earlier specs may already have left playbackStarted
  // rows. Assert the DELTA this spec produces, never an absolute zero.
  const before = (await commands()).filter((c) => c.kind === 'playbackStarted').length;

  // A fake MP3 payload: decode fails in the player, but `enqueue` → `onStart` is
  // exactly the path under test (the same trick `downlink.spec.ts` uses).
  const payload = FAKE_MP3;
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

  // LATCH HONESTY: whether three back-to-back posts are one run or three depends
  // on decode timing — the fake payload fails decode fast, so the queue may drain
  // between posts and each legitimately reports. The per-run latch itself is
  // unit-pinned in playback.test.ts; here we pin the deterministic part: every
  // emitted row carries a bounded, non-session correlation id, however many.
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

  // A stop ends the run, so the NEXT utterance reports again — that is the latch
  // clearing, not the signal being one-shot forever.
  //
  // Re-pointed from `abort-button` to `bot-toggle`. A mute calls
  // `AudioPlayer.setMuted(true)`, which calls `stop()`, which clears `started` —
  // the same latch-clearing edge the abort button used to exercise. The mute is
  // a control that still exists AND it sends no command to the daemon, so this
  // also re-proves the W6 property from the delivery side.
  const bot = page.getByTestId('bot-toggle');
  await expect(bot).toHaveAttribute('aria-pressed', 'false');
  const cmdsBefore = (await commands()).length;
  await bot.click();
  await expect(bot).toHaveAttribute('aria-pressed', 'true');
  expect((await commands()).length, 'the mute reports nothing to the daemon').toBe(cmdsBefore);

  await bot.click();
  await expect(bot).toHaveAttribute('aria-pressed', 'false');

  await post('/audio-down', { bytes: payload });
  await expect
    .poll(async () => (await commands()).filter((c) => c.kind === 'playbackStarted').length, { timeout: 10_000 })
    .toBeGreaterThan(after);
});

test('a muted assistant reports playback as INACTIVE — delivery honesty under a mute', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  // W6 in the delivery domain. `enqueue` returns immediately when muted, so a
  // muted assistant must NOT claim to have started playing: the daemon's
  // "delivery" signal has to mean audio, and a mute is silence.
  const bot = page.getByTestId('bot-toggle');
  await bot.click();
  await expect(bot).toHaveAttribute('aria-pressed', 'true');

  const before = (await commands()).filter((c) => c.kind === 'playbackStarted').length;
  for (let i = 0; i < 3; i += 1) await post('/audio-down', { bytes: FAKE_MP3 });
  await page.waitForTimeout(2_000);
  const after = (await commands()).filter((c) => c.kind === 'playbackStarted').length;
  expect(after, 'a muted assistant reports no playback').toBe(before);

  // The orb agrees: muted, the shell holds `thinking` rather than `speaking`, so
  // the widget never claims to be audible while it is not.
  await post('/voice', { phase: 'speaking' });
  await expect(page.getByTestId('orb')).toHaveAttribute('data-phase', 'thinking', { timeout: 5_000 });

  // Unmute and the claim comes back with the audio.
  await bot.click();
  await expect(bot).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('orb')).toHaveAttribute('data-phase', 'speaking', { timeout: 5_000 });
  await post('/audio-down', { bytes: FAKE_MP3 });
  await expect
    .poll(async () => (await commands()).filter((c) => c.kind === 'playbackStarted').length, { timeout: 10_000 })
    .toBeGreaterThan(after);

  // Leave the shared stub on `idle` for whoever runs next.
  await post('/voice', { phase: 'idle' });
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 5_000 });
});
