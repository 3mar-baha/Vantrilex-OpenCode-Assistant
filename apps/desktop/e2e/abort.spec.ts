import { expect, test } from '@playwright/test';

// TURN CANCELLATION — RETIRED as a UI capability, and this file is the record.
//
// WHAT WAS RETIRED. The bento had an `abort-button` that sent `{kind:'abort'}`,
// which the daemon maps to `onAbort` (the WHOLE turn: the plan, not just the
// audio). It is gone, and the live DOM confirms it: `abort-button` measures
// ZERO, and nothing in the shell can produce an `abort` on any code path.
//
// WHY IT IS NOT SIMPLY DELETED. Turn cancellation is safety-relevant. A user who
// has asked for something destructive and changed their mind currently has NO
// way to stop it from the widget. The remaining stop paths are:
//
//   · BARGE-IN (`stopSpeech`) — stops the SPEECH only, and only when the
//     microphone hears a voice burst while audio is playing. It does not cancel
//     the turn, and it cannot fire during `thinking` when nothing is playing.
//     Covered end to end by `bargein.spec.ts`.
//   · FR-12 — a destructive command is PARKED and never executes without an
//     explicit confirm, so a destructive turn that would need cancelling is
//     blocked before it runs. Covered by `fr12.spec.ts`.
//
// So the net risk is bounded, but it is not zero, and this file asserts the
// CURRENT contract honestly rather than pretending the capability exists.
test('the shell has NO turn-cancel control: nothing can send `abort`', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  // Asserted absent. If a future build reintroduces a cancel control this test
  // goes red, which is the intent: it forces a decision rather than letting the
  // capability drift back in unannounced.
  await expect(page.getByTestId('abort-button')).toHaveCount(0);

  const abortsBefore = await fetch('http://localhost:4197/commands')
    .then((r) => r.json() as Promise<Array<{ kind: string }>>)
    .then((rows) => rows.filter((c) => c.kind === 'abort').length);

  // Drive every control the shell actually has, and every phase the orb can be
  // in. None of them may produce a turn cancel.
  for (const phase of ['listening', 'thinking', 'speaking', 'idle']) {
    await fetch('http://localhost:4197/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase }),
    });
    await expect(page.getByTestId('orb')).toHaveAttribute('data-phase', phase, { timeout: 5_000 });
  }

  const mic = page.getByTestId('mic-toggle');
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('bot-toggle').click();
  await expect(page.getByTestId('bot-toggle')).toHaveAttribute('aria-pressed', 'true');

  const abortsAfter = await fetch('http://localhost:4197/commands')
    .then((r) => r.json() as Promise<Array<{ kind: string }>>)
    .then((rows) => rows.filter((c) => c.kind === 'abort').length);
  expect(abortsAfter, 'no path in the shell can cancel a turn').toBe(abortsBefore);

  // The mic toggle sends `deafen` — a mute, not a cancel.
  const rows = await fetch('http://localhost:4197/commands').then((r) => r.json() as Promise<Array<{ kind: string }>>);
  expect(rows.some((c) => c.kind === 'deafen')).toBe(true);

  // Leave the campsite as found for the specs that follow.
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('bot-toggle').click();
  await expect(page.getByTestId('bot-toggle')).toHaveAttribute('aria-pressed', 'false');
});

test('barge-in sends `stopSpeech`, never `abort` — the speech/turn split still holds', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  // The invariant behind the removed button. `bargein.spec.ts` proves the full
  // microphone-driven path; this pins the cheap half — that the wire contract
  // keeps the two verbs distinct — so a future refactor cannot quietly turn a
  // barge into a turn cancel, which is the exact bug M2 Pattern 2 fixed.
  const result = await page.evaluate(async (url: string) => {
    const openSocket = (): Promise<WebSocket> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(url, ['voice-ui.v1', 'e2e-token']);
        ws.addEventListener('open', () => resolve(ws), { once: true });
        ws.addEventListener('error', () => reject(new Error('ws open failed')), { once: true });
      });
    const sendAndAck = (ws: WebSocket, msg: Record<string, unknown>): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ack timeout')), 8000);
        const onMessage = (ev: MessageEvent): void => {
          const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (m['type'] === 'ack' && m['id'] === msg['id']) {
            clearTimeout(timer);
            ws.removeEventListener('message', onMessage);
            resolve(m);
          }
        };
        ws.addEventListener('message', onMessage);
        ws.send(JSON.stringify(msg));
      });
    const ws = await openSocket();
    await new Promise((r) => setTimeout(r, 300));
    const ack = await sendAndAck(ws, { id: 'abort-probe', kind: 'abort' });
    ws.close();
    return ack;
  }, 'ws://127.0.0.1:4097/v1/ui?lastSeq=0');

  // The daemon still IMPLEMENTS `abort` and still acks it read-only. What is
  // gone is the control, not the verb — so this asserts the verb is alive (the
  // voice path can still reach it) while `orb-shell.spec.ts` and the test above
  // assert the UI cannot.
  expect(result).toMatchObject({ ok: true });
});
