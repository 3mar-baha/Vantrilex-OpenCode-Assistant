import { expect, test } from '@playwright/test';

// SESSION SWITCHING — RETIRED as a UI capability, and this file is the record.
//
// WHAT WAS RETIRED. The bento rendered a `session-chip` with a
// `session-chip-trigger`, a `session-list` dropdown and one `session-<id>` row
// per session; picking a row sent `{kind:'switchSession', sessionId}`. All four
// measure ZERO in the live DOM, and no renderer surface sends `switchSession`
// any more — not the widget, not the settings window, not the keys window.
//
// WHAT SURVIVES. The `inventory` frame is still on the wire, the daemon still
// publishes it (`server.publishInventory`) and the router still implements
// `switchSession`. Only the control is gone. So a session is chosen by whatever
// the voice turn does, never by hand.
//
// The consequence, stated plainly: in a multi-session workspace the companion is
// pinned to whichever session the daemon considers active, and the user has no
// way to move it. This is a product decision, not test hygiene.
async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://localhost:4197${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

test('an inventory snapshot is delivered but renders NO session control', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  const before = await fetch('http://localhost:4197/commands')
    .then((r) => r.json() as Promise<Array<{ kind: string }>>)
    .then((rows) => rows.filter((c) => c.kind === 'switchSession').length);

  await post('/inventory', {
    sessions: [
      { sessionId: 'ses_a', state: 'running' },
      { sessionId: 'ses_b', state: 'idle' },
    ],
  });

  // The frame is published by the REAL UiServer to every connected client, so
  // the bridge really received it. What it no longer produces is a control.
  await expect(page.getByTestId('voxaura-shell')).toBeVisible();
  await expect(page.getByTestId('session-chip')).toHaveCount(0);
  await expect(page.getByTestId('session-chip-trigger')).toHaveCount(0);
  await expect(page.getByTestId('session-list')).toHaveCount(0);
  await expect(page.getByTestId('session-ses_a')).toHaveCount(0);
  await expect(page.getByTestId('session-ses_b')).toHaveCount(0);

  // Even a large history renders nothing, and the shell does not react to it.
  await post('/inventory', {
    sessions: Array.from({ length: 30 }, (_, i) => ({
      sessionId: `ses_hist_${String(i).padStart(2, '0')}`,
      state: 'idle',
    })),
  });
  await expect(page.getByTestId('session-list')).toHaveCount(0);
  await expect(page.getByTestId('mic-toggle')).toBeVisible();
  await expect(page.getByTestId('orb')).toBeVisible();

  // And nothing switched.
  const after = await fetch('http://localhost:4197/commands')
    .then((r) => r.json() as Promise<Array<{ kind: string }>>)
    .then((rows) => rows.filter((c) => c.kind === 'switchSession').length);
  expect(after, 'no session switch is reachable from the shell').toBe(before);
});

test('the daemon still implements switchSession on the wire', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 10_000 });

  // The verb is alive; only the button is gone. Asserted so that "we removed
  // the control" and "we removed the capability" are never confused: a future
  // build that wants the control back has a working verb to wire to.
  const ack = await page.evaluate(async (url: string) => {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(url, ['voice-ui.v1', 'e2e-token']);
      s.addEventListener('open', () => resolve(s), { once: true });
      s.addEventListener('error', () => reject(new Error('ws open failed')), { once: true });
    });
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ack timeout')), 8000);
      const onMessage = (ev: MessageEvent): void => {
        const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (m['type'] === 'ack' && m['id'] === 'sw-probe') {
          clearTimeout(timer);
          ws.removeEventListener('message', onMessage);
          resolve(m);
        }
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ id: 'sw-probe', kind: 'switchSession', sessionId: 'ses_probe' }));
    });
    ws.close();
    return result;
  }, 'ws://127.0.0.1:4097/v1/ui?lastSeq=0');

  expect(ack).toMatchObject({ ok: true });
});
