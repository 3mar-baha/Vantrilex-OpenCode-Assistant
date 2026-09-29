import { afterEach, describe, expect, test } from 'vitest';
import { decodeMsgpack, encodeMsgpack, FishWsError, FishWsTransport } from './fish-ws.js';
import { ttsTransportMode } from './fish-ws.js';
import { fishRequestBody, TTS_MODEL } from './tts.js';
import type { FishWsConnector, FishWsEvent, FishWsSocket } from './fish-ws.js';
import type { AcquiredKey, Keyring } from './keyring.js';
import type { KeyPool } from './vault.js';

/**
 * M2 Pattern 6b — Fish WebSocket transport.
 *
 * Hermetic by construction: the socket is INJECTED (`FishWsConnector`), so no
 * frame in this file ever reaches a network. The fake encodes its server-side
 * frames with the module's own encoder, so a codec that is wrong in a way that
 * round-trips would go unnoticed — which is why `pin` below asserts raw bytes
 * against a hand-computed MessagePack sequence, and why the frame-order
 * assertions read the decoded `event` names off the recorded send buffer.
 */

interface Recorded {
  ok: boolean;
  status?: number;
}

function fakeRing(): { ring: Keyring; released: Recorded[]; acquired: string[] } {
  const released: Recorded[] = [];
  const acquired: string[] = [];
  const ring = {
    acquire(pool: KeyPool): AcquiredKey {
      acquired.push(pool);
      // ASCII material so the Authorization header assertion is meaningful.
      return { pool, keyId: 'K1', material: Buffer.from('kk', 'utf8') };
    },
    release(_key: AcquiredKey, ok: boolean, status?: number): void {
      released.push(status === undefined ? { ok } : { ok, status });
    },
  } as unknown as Keyring;
  return { ring, released, acquired };
}

class FakeSocket implements FishWsSocket {
  readonly sent: Uint8Array[] = [];
  closeCalls = 0;
  readonly listeners = new Set<(event: FishWsEvent) => void>();
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalls += 1;
    this.emit({ type: 'close' });
  }
  on(listener: (event: FishWsEvent) => void): void {
    this.listeners.add(listener);
  }
  off(listener: (event: FishWsEvent) => void): void {
    this.listeners.delete(listener);
  }
  emit(event: FishWsEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  /** Event names in send order: the protocol assertion, not a comment. */
  events(): string[] {
    return this.sent.map((frame) => String((decodeMsgpack(frame) as { event: string }).event));
  }
  frame(n: number): Record<string, unknown> {
    const raw = this.sent[n];
    if (raw === undefined) throw new Error(`no frame ${n} (have ${this.sent.length})`);
    return decodeMsgpack(raw) as Record<string, unknown>;
  }
  audio(bytes: Uint8Array): void {
    this.emit({ type: 'message', data: encodeMsgpack({ event: 'audio', audio: bytes }) });
  }
  finish(reason: 'stop' | 'error' = 'stop'): void {
    this.emit({ type: 'message', data: encodeMsgpack({ event: 'finish', reason }) });
  }
}

/** Connect through a socket that opens on the microtask AFTER the transport subscribes. */
function fakeConnector(): { connect: FishWsConnector; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const connect: FishWsConnector = (url, headers) => {
    const socket = new FakeSocket(url, headers);
    sockets.push(socket);
    queueMicrotask(() => socket.emit({ type: 'open' }));
    return socket;
  };
  return { connect, sockets };
}

const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

async function drain(gen: AsyncGenerator<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done === true) return out;
    out.push(step.value);
  }
}

const VOICE = 'speech-test-ref';
const TEXT = 'أهلاً بك. كيف أساعدك؟';

describe('fish-ws msgpack framing', () => {
  // Pinned bytes, hand-computed from the MessagePack spec — a fixmap of one
  // entry, fixstr "event" (0xa5), fixstr "stop" (0xa4), then a fixmap-0.
  test('pin: {event:"stop"} is a hand-computed byte sequence', () => {
    expect([...encodeMsgpack({ event: 'stop' })]).toEqual([
      0x81, 0xa5, 0x65, 0x76, 0x65, 0x6e, 0x74, 0xa4, 0x73, 0x74, 0x6f, 0x70,
    ]);
  });

  test('pin: a start frame opens fixmap(2) + "event" + "request"', () => {
    // Peer review: the stop pin covers fixmap-1 only, while every real frame
    // is wider — a symmetrically-wrong codec (map widths swapped) would pass
    // round-trips and the narrow pin. This pins the real start prefix:
    // fixmap(2) 0x82, "event" 0xa5 + value, "request" 0xa7. (My first version
    // of this pin forgot the 'start' VALUE bytes and failed honestly.)
    const bytes = encodeMsgpack({ event: 'start', request: { text: '' } });
    const head = [...bytes.slice(0, 15)];
    expect(head).toEqual([
      0x82, 0xa5, 0x65, 0x76, 0x65, 0x6e, 0x74, 0xa5, 0x73, 0x74, 0x61, 0x72, 0x74, 0xa7, 0x72,
    ]);
  });

  test('round-trips the value shapes the protocol uses', () => {
    const value = {
      event: 'start',
      request: {
        text: '',
        reference_id: VOICE,
        format: 'mp3',
        latency: 'balanced',
        chunk_length: 300,
        min_chunk_length: 50,
        normalize: true,
        temperature: 0.5,
        top_p: 0.7,
        repetition_penalty: 1.3,
        condition_on_previous_chunks: true,
        prosody: { speed: 0.95, volume: -2, normalize_loudness: true },
        negative: -1.5,
        big: 70000,
        bytes: new Uint8Array([1, 2, 250]),
        list: [1, 'two'],
        nothing: null,
      },
    };
    expect(decodeMsgpack(encodeMsgpack(value))).toEqual(value);
  });

  test('a truncated frame throws instead of yielding a partial value', () => {
    const full = encodeMsgpack({ event: 'audio', audio: new Uint8Array(64) });
    expect(() => decodeMsgpack(full.subarray(0, full.length - 8))).toThrow(/msgpack/);
  });
});

describe('FishWsTransport frame sequence', () => {
  test('start -> text per sentence -> flush after each -> stop, and never close()', async () => {
    const { ring, released, acquired } = fakeRing();
    const { connect, sockets } = fakeConnector();
    const transport = new FishWsTransport(ring, 'wss://example.invalid/v1/tts/live', { connect });

    const gen = transport.synthesizeStream(TEXT, VOICE);
    const pending = drain(gen);
    await tick();
    const socket = sockets[0] as FakeSocket;

    socket.audio(new Uint8Array([1, 2, 3]));
    socket.audio(new Uint8Array([4, 5]));
    socket.finish();
    const chunks = await pending;

    expect(socket.events()).toEqual(['start', 'text', 'flush', 'text', 'flush', 'stop']);
    expect(socket.closeCalls).toBe(0);
    expect([...chunks[0]!]).toEqual([1, 2, 3]);
    expect([...chunks[1]!]).toEqual([4, 5]);
    expect(acquired).toEqual(['fish']);
    expect(released).toEqual([{ ok: true }]);
  });

  test('start.request reuses the HTTP TTS params and sends empty text', async () => {
    const { ring } = fakeRing();
    const { connect, sockets } = fakeConnector();
    const transport = new FishWsTransport(ring, 'wss://example.invalid/v1/tts/live', { connect });

    const pending = drain(transport.synthesizeStream(TEXT, VOICE));
    await tick();
    const socket = sockets[0] as FakeSocket;
    socket.finish();
    await pending;

    const start = socket.frame(0) as { event: string; request: Record<string, unknown> };
    expect(start.event).toBe('start');
    expect(start.request).toEqual({ ...fishRequestBody('', VOICE), text: '' });
    // The measured values, spelled out so a future "tidy-up" of the shared
    // body cannot silently change the WS transport alone.
    expect(start.request.latency).toBe('balanced');
    expect(start.request.chunk_length).toBe(300);
    expect(start.request.min_chunk_length).toBe(50);
    expect(start.request.temperature).toBe(0.5);
    expect(start.request.top_p).toBe(0.7);
    expect(start.request.repetition_penalty).toBe(1.3);
    expect(start.request.prosody).toEqual({ speed: 0.95, volume: -2, normalize_loudness: true });

    expect(socket.headers.model).toBe(TTS_MODEL);
    expect(socket.headers.Authorization).toBe('Bearer kk');
    expect(socket.url).toBe('wss://example.invalid/v1/tts/live');
  });

  test('text frames carry stripSpeechText output, sentence by sentence', async () => {
    const { ring } = fakeRing();
    const { connect, sockets } = fakeConnector();
    const transport = new FishWsTransport(ring, 'wss://example.invalid/v1/tts/live', { connect });

    const pending = drain(transport.synthesizeStream('مرحبا 👋 how are you?', VOICE));
    await tick();
    const socket = sockets[0] as FakeSocket;
    socket.finish();
    await pending;

    const texts = socket
      .sent.map((f) => decodeMsgpack(f) as { event: string; text?: string })
      .filter((m) => m.event === 'text')
      .map((m) => m.text);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});

describe('FishWsTransport failures', () => {
  test('finish{reason:"error"} throws a typed FishWsError, and the key is not rotated', async () => {
    const { ring, released } = fakeRing();
    const { connect, sockets } = fakeConnector();
    const transport = new FishWsTransport(ring, 'wss://example.invalid/v1/tts/live', { connect });

    const gen = transport.synthesizeStream(TEXT, VOICE);
    const pending = drain(gen);
    await tick();
    const socket = sockets[0] as FakeSocket;
    socket.audio(new Uint8Array([9]));
    socket.finish('error');

    await expect(pending).rejects.toBeInstanceOf(FishWsError);
    // A.3 as-is: a WS frame reports no HTTP status, so the release is NEUTRAL
    // (ok:false, no status) — which advances the pool on nothing.
    expect(released).toEqual([{ ok: false }]);
  });

  test('finish{reason:"length_exceeded"} fails too — only stop is success', async () => {
    // Peer review: truncated audio shipped as success marks a cut reply good
    // and the key with it. Only 'stop' is clean; every other reason fails.
    const { ring, released } = fakeRing();
    const { connect, sockets } = fakeConnector();
    const transport = new FishWsTransport(ring, 'wss://example.invalid/v1/tts/live', { connect });

    const gen = transport.synthesizeStream(TEXT, VOICE);
    const pending = drain(gen);
    await tick();
    const socket = sockets[0] as FakeSocket;
    socket.audio(new Uint8Array([9]));
    socket.emit({ type: 'message', data: encodeMsgpack({ event: 'finish', reason: 'length_exceeded' }) });

    await expect(pending).rejects.toThrow(/length_exceeded/);
    expect(released).toEqual([{ ok: false }]);
  });

  test('a socket close before finish fails the turn instead of hanging', async () => {
    const { ring } = fakeRing();
    const { connect, sockets } = fakeConnector();
    const transport = new FishWsTransport(ring, 'wss://example.invalid/v1/tts/live', { connect });

    const gen = transport.synthesizeStream(TEXT, VOICE);
    const pending = drain(gen);
    await tick();
    (sockets[0] as FakeSocket).emit({ type: 'close' });

    await expect(pending).rejects.toBeInstanceOf(FishWsError);
  });

  test('a barge abort sends stop, ends the stream, and never yields more audio', async () => {
    const { ring } = fakeRing();
    const { connect, sockets } = fakeConnector();
    const transport = new FishWsTransport(ring, 'wss://example.invalid/v1/tts/live', { connect });
    const controller = new AbortController();

    const gen = transport.synthesizeStream(TEXT, VOICE, { signal: controller.signal });
    const pending = drain(gen);
    await tick();
    const socket = sockets[0] as FakeSocket;
    socket.audio(new Uint8Array([1]));
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(socket.events()).toEqual(['start', 'text', 'flush', 'text', 'flush', 'stop']);
    // A barge must NOT recycle the socket: we stopped reading it.
    expect(socket.closeCalls).toBe(1);
  });

  test('synthesize() concatenates the streamed audio in order', async () => {
    const { ring } = fakeRing();
    const { connect, sockets } = fakeConnector();
    const transport = new FishWsTransport(ring, 'wss://example.invalid/v1/tts/live', { connect });

    const pending = transport.synthesize(TEXT, VOICE);
    await tick();
    const socket = sockets[0] as FakeSocket;
    socket.audio(new Uint8Array([1, 2]));
    socket.audio(new Uint8Array([3]));
    socket.finish();

    expect([...(await pending)]).toEqual([1, 2, 3]);
  });
});

describe('FishWsTransport socket reuse', () => {
  test('two synthesizeStream calls reuse the warm socket and re-issue start', async () => {
    const { ring } = fakeRing();
    const { connect, sockets } = fakeConnector();
    const transport = new FishWsTransport(ring, 'wss://example.invalid/v1/tts/live', { connect });

    for (let i = 0; i < 2; i += 1) {
      const pending = drain(transport.synthesizeStream(TEXT, VOICE));
      await tick();
      (sockets[0] as FakeSocket).finish();
      await pending;
    }
    expect(sockets.length).toBe(1);
    expect((sockets[0] as FakeSocket).events()).toEqual([
      'start', 'text', 'flush', 'text', 'flush', 'stop',
      'start', 'text', 'flush', 'text', 'flush', 'stop',
    ]);
  });

  test('a warm socket the server closed is replaced, and start is re-issued', async () => {
    const { ring } = fakeRing();
    const { connect, sockets } = fakeConnector();
    const transport = new FishWsTransport(ring, 'wss://example.invalid/v1/tts/live', { connect });

    const first = drain(transport.synthesizeStream(TEXT, VOICE));
    await tick();
    (sockets[0] as FakeSocket).finish();
    await first;
    // The documented server behaviour: exactly one finish, then it closes.
    (sockets[0] as FakeSocket).emit({ type: 'close' });

    const second = drain(transport.synthesizeStream(TEXT, VOICE));
    await tick();
    (sockets[1] as FakeSocket).finish();
    await second;

    expect(sockets.length).toBe(2);
    expect((sockets[1] as FakeSocket).events()[0]).toBe('start');
  });
});

describe('ttsTransportMode rollback flag', () => {
  const prior = process.env.TTS_TRANSPORT;
  // Peer review: restore in afterEach, not in a vacuous test — a throw in the
  // first test used to leak the env into the rest of the file.
  afterEach(() => {
    if (prior === undefined) delete process.env.TTS_TRANSPORT;
    else process.env.TTS_TRANSPORT = prior;
  });
  test('default is http; only the exact string "ws" selects the WS transport', () => {
    delete process.env.TTS_TRANSPORT;
    expect(ttsTransportMode(() => undefined)).toBe('http');
    expect(ttsTransportMode(() => 'ws')).toBe('ws');
    expect(ttsTransportMode(() => 'http')).toBe('http');
    expect(ttsTransportMode(() => 'WS')).toBe('http');
    expect(ttsTransportMode(() => '')).toBe('http');
  });
});
