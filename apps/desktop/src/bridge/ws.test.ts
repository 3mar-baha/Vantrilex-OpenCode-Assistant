import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  computeBackoff,
  UI_SUBPROTOCOL,
  UI_WS_URL,
  VoxauraBridge,
  type EventMsg,
  type HelloMsg,
  type SocketLike,
} from './ws.js';

// G2 TDD — bridge reconnect math + hello/version/refusal behavior.
// A fake socket keeps every test hermetic (no network, no DOM).
class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  readonly sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.(null);
  }
  peerText(text: string): void {
    this.onmessage?.({ data: text });
  }
}

const hello = (seq = 0, version = '3.1.0'): HelloMsg => ({
  type: 'hello',
  contractVersion: version,
  nodePid: 4242,
  servePort: 4096,
  layaReady: true,
  seq,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('computeBackoff (staggered reconnect)', () => {
  test('base delay on first attempt, doubling after', () => {
    expect(computeBackoff(0, 50, 30, 2500, () => 0)).toBe(50);
    expect(computeBackoff(1, 50, 30, 2500, () => 0)).toBe(100);
    expect(computeBackoff(2, 50, 30, 2500, () => 0)).toBe(200);
  });

  test('jitter bounded by [0, jitterMs)', () => {
    expect(computeBackoff(0, 50, 30, 2500, () => 0.5)).toBeCloseTo(65, 5);
    expect(computeBackoff(0, 50, 30, 2500, () => 0.999)).toBeLessThan(80);
  });

  test('hard cap at 2.5s', () => {
    expect(computeBackoff(20, 50, 30, 2500, () => 1)).toBe(2500);
  });
});

describe('VoxauraBridge handshake', () => {
  test('opens the loopback URL with subprotocol + bearer token, resumes seq', () => {
    const created: FakeSocket[] = [];
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      createSocket: (url, protocols) => {
        const s = new FakeSocket(url, protocols);
        created.push(s);
        return s;
      },
    });
    bridge.connect();
    expect(created).toHaveLength(1);
    expect(created[0]!.url).toBe(UI_WS_URL);
    expect(created[0]!.protocols).toEqual([UI_SUBPROTOCOL, 'tok']);

    // A hello carrying seq advances the resume cursor.
    created[0]!.peerText(JSON.stringify(hello(7)));
    bridge.dispose();
    expect(created[0]!.closed).toBe(true);
  });

  test('version mismatch triggers refusal: close, no reconnect', () => {
    vi.useFakeTimers();
    const refusals: Array<{ expected: string; got: string }> = [];
    const created: FakeSocket[] = [];
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      onRefusal: (info) => void refusals.push(info),
      createSocket: (url, protocols) => {
        const s = new FakeSocket(url, protocols);
        created.push(s);
        return s;
      },
    });
    bridge.connect();
    created[0]!.peerText(JSON.stringify(hello(0, '9.9.9')));
    expect(refusals).toEqual([{ expected: '3.1.0', got: '9.9.9' }]);
    expect(created[0]!.closed).toBe(true);
    void vi.advanceTimersByTime(10_000);
    expect(created).toHaveLength(1); // refused: never redials
    bridge.dispose();
  });

  test('close schedules one reconnect with resume query', () => {
    vi.useFakeTimers();
    const created: FakeSocket[] = [];
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      createSocket: (url, protocols) => {
        const s = new FakeSocket(url, protocols);
        created.push(s);
        return s;
      },
    });
    bridge.connect();
    created[0]!.peerText(JSON.stringify(hello(4)));
    created[0]!.close(); // server drop
    expect(created).toHaveLength(1);
    void vi.advanceTimersByTime(5000);
    expect(created).toHaveLength(2);
    expect(created[1]!.url).toBe(`${UI_WS_URL}?lastSeq=4`);
    bridge.dispose();
  });

  test('inventory frames update sessions; malformed frames are ignored safely', () => {
    const seen: Array<Array<{ sessionId: string; state: string }>> = [];
    const errors: string[] = [];
    let socket!: FakeSocket;
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      onInventory: (sessions) => void seen.push(sessions),
      onErrorFrame: (detail) => void errors.push(detail),
      createSocket: (url, protocols) => {
        socket = new FakeSocket(url, protocols);
        return socket;
      },
    });
    bridge.connect();
    socket.peerText(JSON.stringify(hello(0)));
    socket.peerText(
      JSON.stringify({
        type: 'inventory',
        seq: 1,
        sessions: [
          { sessionId: 'ses_a', state: 'running' },
          { sessionId: 'ses_b', state: 'idle' },
        ],
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      { sessionId: 'ses_a', state: 'running' },
      { sessionId: 'ses_b', state: 'idle' },
    ]);
    socket.peerText(JSON.stringify({ type: 'inventory', seq: 2, sessions: [{ sessionId: '' }] }));
    socket.peerText(JSON.stringify({ type: 'inventory', seq: 3 }));
    expect(seen).toHaveLength(1); // malformed frames never reach state
    expect(errors.length).toBeGreaterThanOrEqual(1);
    bridge.dispose();
  });
  test('daemon restart resets the cursor and fires onGap', () => {
    const gaps: number[] = [];
    const events: EventMsg[] = [];
    let socket!: FakeSocket;
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      onEvent: (e) => void events.push(e),
      onGap: () => void gaps.push(1),
      createSocket: (url, protocols) => {
        socket = new FakeSocket(url, protocols);
        return socket;
      },
    });
    bridge.connect();
    socket.peerText(JSON.stringify(hello(50)));
    socket.peerText(JSON.stringify({ type: 'event', seq: 51, eventId: 'e-51', state: 'running' }));
    socket.peerText(JSON.stringify(hello(0))); // daemon restarted: epoch reset
    socket.peerText(JSON.stringify({ type: 'event', seq: 1, eventId: 'e-1', state: 'running' }));
    expect(gaps).toHaveLength(1);
    expect(events.map((e) => e.eventId)).toEqual(['e-51', 'e-1']);
    bridge.dispose();
  });

  test('malformed hello is refused, never live', () => {
    const refusals: Array<{ expected: string; got: string }> = [];
    let socket!: FakeSocket;
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      onRefusal: (info) => void refusals.push(info),
      createSocket: (url, protocols) => {
        socket = new FakeSocket(url, protocols);
        return socket;
      },
    });
    bridge.connect();
    socket.peerText(JSON.stringify({ type: 'hello', contractVersion: '3.1.0', seq: 0 }));
    expect(refusals).toEqual([{ expected: '3.1.0', got: 'malformed-hello' }]);
    expect(socket.closed).toBe(true);
    bridge.dispose();
  });

  test('ack ok:false resolves false; error frames surface via onErrorFrame', async () => {
    const errors: string[] = [];
    let socket!: FakeSocket;
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      onErrorFrame: (detail) => void errors.push(detail),
      createSocket: (url, protocols) => {
        socket = new FakeSocket(url, protocols);
        return socket;
      },
    });
    bridge.connect();
    socket.peerText(JSON.stringify(hello(0)));
    const failed = bridge.sendCommand({ id: 'cmd-f', kind: 'mute' });
    socket.peerText(JSON.stringify({ type: 'ack', id: 'cmd-f', ok: false }));
    await expect(failed).resolves.toBe(false);
    socket.peerText(JSON.stringify({ type: 'error', detail: 'unknown command' }));
    expect(errors).toEqual(['unknown command']);
    bridge.dispose();
  });

  test('switchSession command carries the session id and resolves on ack', async () => {
    let socket!: FakeSocket;
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      createSocket: (url, protocols) => {
        socket = new FakeSocket(url, protocols);
        return socket;
      },
    });
    bridge.connect();
    socket.peerText(JSON.stringify(hello(0)));
    const sent = bridge.sendCommand({ id: 'cmd-sw', kind: 'switchSession', sessionId: 'ses_b' });
    expect(JSON.parse(socket.sent[0] as string)).toMatchObject({ kind: 'switchSession', sessionId: 'ses_b' });
    socket.peerText(JSON.stringify({ type: 'ack', id: 'cmd-sw', ok: true }));
    await expect(sent).resolves.toBe(true);
    bridge.dispose();
  });

  test('events advance the cursor; commands resolve on ack', async () => {
    const events: EventMsg[] = [];
    let socket!: FakeSocket;
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      onEvent: (e) => void events.push(e),
      createSocket: (url, protocols) => {
        socket = new FakeSocket(url, protocols);
        return socket;
      },
    });
    bridge.connect();
    socket.peerText(JSON.stringify(hello(0)));
    socket.peerText(JSON.stringify({ type: 'event', seq: 1, eventId: 'e-1', state: 'running' }));
    expect(events.map((e) => e.eventId)).toEqual(['e-1']);

    const acked = bridge.sendCommand({ id: 'cmd-1', kind: 'abort' });
    expect(JSON.parse(socket.sent[0] as string)).toMatchObject({ id: 'cmd-1', kind: 'abort' });
    socket.peerText(JSON.stringify({ type: 'ack', id: 'cmd-1', ok: true }));
    await expect(acked).resolves.toBe(true);
    bridge.dispose();
  });

  test('dispose() stops reconnects and settles pending commands as false', async () => {
    vi.useFakeTimers();
    const created: FakeSocket[] = [];
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      createSocket: (url, protocols) => {
        const s = new FakeSocket(url, protocols);
        created.push(s);
        return s;
      },
    });
    bridge.connect();
    const pending = bridge.sendCommand({ id: 'cmd-x', kind: 'mute' });
    bridge.dispose();
    await expect(pending).resolves.toBe(false);
    void vi.advanceTimersByTime(30_000);
    expect(created).toHaveLength(1);
  });
});

