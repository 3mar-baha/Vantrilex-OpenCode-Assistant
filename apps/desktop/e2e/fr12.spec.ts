import { expect, test } from '@playwright/test';

// FR-12 end-to-end: a destructive shell command parks until an explicit
// confirm arrives, then executes exactly once. Driven over the real WS-4097
// socket against the stub's production command router.
const WS_URL = 'ws://127.0.0.1:4097/v1/ui?lastSeq=0';

async function shells(): Promise<Array<{ session: string; command: string }>> {
  const res = await fetch('http://localhost:4197/shells');
  return (await res.json()) as Array<{ session: string; command: string }>;
}

test('destructive shell parks until confirmed, then executes once', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('bridge-status')).toContainText('متصل وبانتظار الأوامر', { timeout: 10_000 });

  const outcome = await page.evaluate(async (url: string) => {
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
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(String(ev.data));
          } catch {
            return;
          }
          const m = parsed as Record<string, unknown>;
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
    // Drain the hello frame so only acks are observed below.
    await new Promise((r) => setTimeout(r, 300));
    const parked = await sendAndAck(ws, { id: 'fr12-1', kind: 'execSessionShell', command: 'rm -rf build' });
    const before = await fetch('http://localhost:4197/shells').then((r) => r.json());
    const confirmed = await sendAndAck(ws, { id: 'fr12-2', kind: 'confirm', confirmId: 'fr12-1' });
    const replay = await sendAndAck(ws, { id: 'fr12-3', kind: 'confirm', confirmId: 'fr12-1' });
    ws.close();
    return { parked, before, confirmed, replay };
  }, WS_URL);

  expect(outcome.parked).toMatchObject({ ok: true, detail: 'confirmation-required' });
  expect(outcome.before).toEqual([]);
  expect(outcome.confirmed).toMatchObject({ ok: true });
  expect(outcome.replay).toMatchObject({ ok: false, detail: 'no pending action' });
  await expect
    .poll(async () => shells(), { timeout: 5_000 })
    .toEqual([{ session: 'ses_e2e', command: 'rm -rf build' }]);
});
