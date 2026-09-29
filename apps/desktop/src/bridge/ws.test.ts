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

// `uplinkPaused` is REQUIRED on the wire (M3 B.3) and defaults to `false` here,
// so a fixture without it models a daemon that checked and found no pause. The
// shell's own type keeps the field optional, so the "daemon predates B.3" case
// is a separate fixture — `helloLegacy` below — not this one's default.
const hello = (seq = 0, version = '3.1.0', uplinkPaused = false): HelloMsg => ({
  type: 'hello',
  contractVersion: version,
  nodePid: 4242,
  servePort: 4096,
  layaReady: true,
  seq,
  uplinkPaused,
});

/** A daemon from before B.3: no `uplinkPaused` field at all. */
const helloLegacy = (seq = 0, version = '3.1.0'): HelloMsg => {
  const { uplinkPaused: _drop, ...rest } = hello(seq, version);
  void _drop;
  return rest as HelloMsg;
};

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
    // A FIRST connect must already carry the resume cursor. This assertion used
    // to be `toBe(UI_WS_URL)` — in a test named "resumes seq" — which pinned the
    // bug: with no `?lastSeq=`, the server's `lastSeqOf` returns NaN and
    // `ui-server.ts` skips the whole replay block, so a cold launch received
    // `hello` and nothing else. Measured live: 25 s, hello only, no inventory and
    // no agents, because the inventory interval only pushes on change.
    expect(created[0]!.url).toBe(`${UI_WS_URL}?lastSeq=0`);
    expect(created[0]!.protocols).toEqual([UI_SUBPROTOCOL, 'tok']);

    // A hello carrying seq advances the resume cursor.
    created[0]!.peerText(JSON.stringify(hello(7)));
    bridge.dispose();
    expect(created[0]!.closed).toBe(true);
  });

  test('the resume cursor is sent on the very first connect, not only on reconnect', () => {
    // Dedicated guard for the first-paint defect. `lastSeq` is initialised to -1
    // as a "never connected" sentinel, so any code that keys the query param off
    // `>= 0` silently omits it on connect #1 and the shell starts empty. The
    // sentinel must stay -1 for the backwards-seq check; only the wire value is
    // floored. Verified by breaking it: reverting to the `>= 0` form leaves every
    // other test in this file green, so this test is the only thing holding it.
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
    expect(created[0]!.url).toContain('lastSeq=0');
    // The cursor-advance-on-reconnect half is already covered by
    // "close schedules one reconnect with resume query" below.
    bridge.dispose();
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

// M3 B.3 — the shell half of the pause/resume watermarks.
//
// The dangerous half of this feature is the renderer, because "paused" has an
// attractive wrong implementation: `capture.stop()`. That silences the mic, so
// the user is not just un-transcribed but unheard, and the resume frame then
// has to re-acquire a device the user may have to grant again. Dropping chunks
// at the uplink costs a hole in one utterance; stopping the mic costs the
// session. So the contract asserted here is: the uplink drops, the capture
// keeps running, and every OTHER channel keeps working.
describe('M3 B.3 flow watermarks (pause/resume the uplink, never the mic)', () => {
  /** A bridge whose flow state is observable through the callback only. */
  function flowBridge(): {
    bridge: VoxauraBridge;
    states: string[];
    getSocket: () => FakeSocket;
  } {
    const states: string[] = [];
    let socket: FakeSocket | null = null;
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      onFlow: (f) => void states.push(f.state),
      createSocket: (url, protocols) => {
        socket = new FakeSocket(url, protocols);
        return socket;
      },
    });
    bridge.connect();
    return {
      bridge,
      states,
      getSocket: () => {
        if (socket === null) throw new Error('socket not created');
        return socket;
      },
    };
  }

  const flow = (state: 'pause' | 'resume', seq = 5): string =>
    JSON.stringify({ type: 'flow', seq, state });

  test('a pause frame advances lastSeq and drops the uplink chunk, and the mic keeps running', () => {
    vi.useFakeTimers();
    const created: FakeSocket[] = [];
    const states: string[] = [];
    const heard: number[] = [];
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      onFlow: (f) => void states.push(f.state),
      onAudio: (a) => void heard.push(a[0] ?? -1),
      createSocket: (url, protocols) => {
        const s = new FakeSocket(url, protocols);
        created.push(s);
        return s;
      },
    });
    bridge.connect();
    const sock = created[0]!;
    sock.peerText(JSON.stringify(hello(3)));
    expect(bridge.sendPcm(new Uint8Array([1]))).toBe(true);

    sock.peerText(flow('pause', 9));
    expect(states).toEqual(['pause']);

    // `lastSeq` is private, so it is observed the only way that matters: the URL a
    // reconnect actually emits. A flow frame that skipped the cursor would leave
    // the shell resuming from 3 and the daemon replaying from 9.
    sock.close();
    vi.advanceTimersByTime(5000);
    expect(created).toHaveLength(2);
    expect(created[1]!.url).toBe(`${UI_WS_URL}?lastSeq=9`);

    // The chunk is dropped: `sendPcm` reports false and nothing hits the wire.
    expect(bridge.sendPcm(new Uint8Array([2]))).toBe(false);
    expect(bridge.sendPcm(new Uint8Array([3]))).toBe(false);
    expect(created[1]!.sentBinary).toHaveLength(0);

    // A malformed `state` is rejected rather than coerced. Coercing an unknown
    // value to 'pause' would stop the uplink on the strength of a frame the
    // daemon did not write; coercing it to 'resume' would defeat the pause that
    // is in force. Either way it must leave the state exactly as it was.
    created[1]!.peerText(JSON.stringify({ type: 'flow', seq: 10, state: 'halfway' }));
    expect(states).toEqual(['pause']);
    expect(bridge.sendPcm(new Uint8Array([4]))).toBe(false);

    // The mic is NOT stopped. Nothing here closes, disposes, or re-acquires
    // anything: the socket is still ours, and `capture.ts` is not this class's to
    // touch. Dropping PCM costs a hole in one utterance; silencing the mic costs
    // the session.
    expect(created[1]!.closed).toBe(false);
    expect(bridge.live).toBe(true);

    // Only the UPLINK is gated. Control still goes out…
    void bridge.sendCommand({ id: 'c1', kind: 'abort' });
    expect(created[1]!.sent.filter((t) => t.includes('"abort"'))).toHaveLength(1);
    // …and the speech downlink still plays, so a reply in flight is never cut
    // off by backpressure aimed at the microphone.
    created[1]!.peerBinary(new Uint8Array([0x01, 0, 9, 42]).buffer);
    expect(heard).toEqual([42]);
    bridge.dispose();
  });

  test('a resume frame restores the uplink', () => {
    const { bridge, states, getSocket } = flowBridge();
    const sock = getSocket();
    sock.peerText(JSON.stringify(hello(0)));
    expect(bridge.sendPcm(new Uint8Array([1]))).toBe(true);

    sock.peerText(flow('pause', 4));
    expect(bridge.sendPcm(new Uint8Array([2]))).toBe(false);
    expect(states).toEqual(['pause']);

    sock.peerText(flow('resume', 5));
    expect(states).toEqual(['pause', 'resume']);
    expect(bridge.sendPcm(new Uint8Array([3]))).toBe(true);
    // Two frames got through (before the pause, after the resume), not three.
    expect(sock.sentBinary.map((b) => b[0])).toEqual([1, 3]);
    bridge.dispose();
  });

  test('a daemon restart clears the pause — the resume can never come from a dead daemon', () => {
    // The other half of the deadlock, and the one a user experiences as "my
    // microphone broke". A pause belongs to the accumulator that raised it. A
    // restarted daemon starts with an empty buffer, so it will never cross
    // PAUSE_BYTES again and will never send the 'resume' this shell is waiting
    // for. A shell that kept the latch across the restart would discard every
    // frame until the next restart — over a socket that is up, with a live
    // green status pill, and no error anywhere.
    const gaps: number[] = [];
    const created: FakeSocket[] = [];
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      onGap: () => void gaps.push(1),
      createSocket: (url, protocols) => {
        const s = new FakeSocket(url, protocols);
        created.push(s);
        return s;
      },
    });
    bridge.connect();
    created[0]!.peerText(JSON.stringify(hello(50)));
    created[0]!.peerText(flow('pause', 51));
    expect(bridge.sendPcm(new Uint8Array([1]))).toBe(false);

    // Epoch reset: the backwards hello is the restart signal for the CURSOR.
    created[0]!.peerText(JSON.stringify(hello(0)));
    expect(gaps).toHaveLength(1);
    expect(bridge.sendPcm(new Uint8Array([2]))).toBe(true);

    // A pause the new daemon raises is honoured normally — the reset is not a
    // permanent exemption from backpressure.
    created[0]!.peerText(flow('pause', 3));
    expect(bridge.sendPcm(new Uint8Array([3]))).toBe(false);
    created[0]!.peerText(flow('resume', 4));
    expect(bridge.sendPcm(new Uint8Array([4]))).toBe(true);
    bridge.dispose();
  });

  test('the hello resyncs the pause — a mid-session reconnect is not a restart', async () => {
    // Peer review, and the one that matters: the backwards-seq branch is NOT
    // taken for an ordinary reconnect, because the daemon's seq only moves
    // forward. So a shell that reconnects while paused, having missed the resume
    // (the `flow` frame is not retained for resume), would keep its latch —
    // while the accumulator sits at zero bytes and never crosses PAUSE_BYTES
    // again. Both halves stall, silently, behind a green pill.
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
    vi.useFakeTimers();
    bridge.connect();
    created[0]!.peerText(JSON.stringify(hello(10, '3.1.0', true)));
    expect(bridge.sendPcm(new Uint8Array([1])), 'adopted from hello, no flow frame seen').toBe(false);


    // (b) the socket drops and comes back with a FORWARD seq — not a restart,
    // so no onGap, and the old branch would have cleared nothing.
    created[0]!.close();
    vi.advanceTimersByTime(5000);
    expect(created).toHaveLength(2);
    created[1]!.peerText(JSON.stringify(hello(11, '3.1.0', false)));
    expect(bridge.sendPcm(new Uint8Array([2])), 'the release arrived in hello').toBe(true);

    // (c) a pause that arrives only as a frame, after a legacy hello with no
    // field at all, still latches — the field is a resync, not a replacement.
    const legacy: FakeSocket[] = [];
    const b2 = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      createSocket: (url, protocols) => {
        const s = new FakeSocket(url, protocols);
        legacy.push(s);
        return s;
      },
    });
    b2.connect();
    legacy[0]!.peerText(JSON.stringify(helloLegacy(5)));
    expect(b2.sendPcm(new Uint8Array([3])), 'a pre-B.3 daemon means no backpressure').toBe(true);
    legacy[0]!.peerText(flow('pause', 6));
    expect(b2.sendPcm(new Uint8Array([4])), 'frames still work against a legacy hello').toBe(false);
    b2.dispose();
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
