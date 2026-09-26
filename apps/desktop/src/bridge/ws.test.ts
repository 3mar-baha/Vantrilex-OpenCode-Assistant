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
  readonly sentBinary: Uint8Array[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string): void {
    this.sent.push(data);
  }
  sendBinary(data: Uint8Array): void {
    this.sentBinary.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.(null);
  }
  peerText(text: string): void {
    this.onmessage?.({ data: text });
  }
  peerBinary(buf: ArrayBuffer): void {
    this.onmessage?.({ data: buf });
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
  test('agents frames update the live selector; malformed frames ignored', () => {
    const seen: Array<Array<{ id: string; name: string }>> = [];
    const errors: string[] = [];
    let socket!: FakeSocket;
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      onAgents: (a) => void seen.push(a),
      onErrorFrame: (d) => void errors.push(d),
      createSocket: (url, protocols) => {
        socket = new FakeSocket(url, protocols);
        return socket;
      },
    });
    bridge.connect();
    socket.peerText(JSON.stringify(hello(0)));
    socket.peerText(JSON.stringify({ type: 'agents', seq: 1, agents: [{ id: 'build', name: 'Build' }] }));
    expect(seen).toEqual([[{ id: 'build', name: 'Build' }]]);
    socket.peerText(JSON.stringify({ type: 'agents', seq: 2, agents: [{ id: 'x' }] }));
    expect(seen).toHaveLength(1);
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


describe('sendPcm (P4 binary voice uplink)', () => {
  function liveBridge(): { bridge: VoxauraBridge; getSocket: () => FakeSocket } {
    let socket: FakeSocket | null = null;
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      createSocket: (url, protocols) => {
        socket = new FakeSocket(url, protocols);
        return socket;
      },
    });
    bridge.connect();
    return {
      bridge,
      getSocket: () => {
        if (socket === null) throw new Error('socket not created');
        return socket;
      },
    };
  }

  test('returns false with no socket, true after connect, bytes recorded', () => {
    const idle = new VoxauraBridge({ token: 'tok', contractVersion: '3.1.0' });
    expect(idle.sendPcm(new Uint8Array([1, 2, 3]))).toBe(false);
    idle.dispose();
    const { bridge, getSocket } = liveBridge();
    const sock = getSocket();
    sock.onopen?.(null);
    const frame = new Uint8Array([4, 5, 6, 7]);
    expect(bridge.sendPcm(frame)).toBe(true);
    expect(sock.sentBinary).toHaveLength(1);
    expect(sock.sentBinary[0]).toBe(frame);
    bridge.dispose();
  });

  test('a throwing socket resolves false instead of crashing', () => {
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      createSocket: (url, protocols) => {
        const sock = new FakeSocket(url, protocols);
        sock.sendBinary = () => {
          throw new Error('dead');
        };
        return sock;
      },
    });
    bridge.connect();
    expect(bridge.sendPcm(new Uint8Array([1]))).toBe(false);
    bridge.dispose();
  });
});

describe('onAudio (P4b speech downlink)', () => {
  function audioBridge(onAudio: (audio: Uint8Array) => void): { bridge: VoxauraBridge; getSocket: () => FakeSocket } {
    let socket: FakeSocket | null = null;
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      onAudio,
      createSocket: (url, protocols) => {
        socket = new FakeSocket(url, protocols);
        return socket;
      },
    });
    bridge.connect();
    const getSocket = () => {
      if (socket === null) throw new Error('socket not created');
      return socket;
    };
    return { bridge, getSocket };
  }

  function speechFrame(payload: Uint8Array): ArrayBuffer {
    const out = new Uint8Array(3 + payload.length);
    out[0] = 0x01;
    out[1] = 0;
    out[2] = 9;
    out.set(payload, 3);
    return out.buffer;
  }

  test('binary speech frames reach onAudio with the MP3 payload', () => {
    const received: Uint8Array[] = [];
    const { bridge, getSocket } = audioBridge((audio) => void received.push(audio));
    getSocket().peerBinary(speechFrame(new Uint8Array([0xff, 0xfb, 0x90])));
    expect(received).toHaveLength(1);
    expect(Array.from(received[0] as Uint8Array)).toEqual([0xff, 0xfb, 0x90]);
    bridge.dispose();
  });

  test('wrong type byte and short buffers are ignored', () => {
    const received: Uint8Array[] = [];
    const { bridge, getSocket } = audioBridge((audio) => void received.push(audio));
    const sock = getSocket();
    const wrong = new Uint8Array([0x02, 0, 9, 1, 2, 3]);
    sock.peerBinary(wrong.buffer);
    sock.peerBinary(new Uint8Array([0x01, 0]).buffer);
    sock.peerText('{"type":"nonsense"}');
    expect(received).toHaveLength(0);
    bridge.dispose();
  });
});
