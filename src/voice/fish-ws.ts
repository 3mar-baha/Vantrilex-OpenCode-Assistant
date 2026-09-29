/**
 * M2 Pattern 6b — the Fish Audio WebSocket transport.
 *
 * Endpoint and event grammar are the documented ones (docs.fish.audio, verified
 * via context7 and the raw-API rules): `wss://api.fish.audio/v1/tts/live`,
 * MessagePack frames, client sequence `start{request}` → `text{text}`* →
 * `flush`? → `stop` (**the literal is `stop`, not `close`**), server
 * `audio{audio}`* → one `finish{reason}` and then the server closes.
 *
 * The measured tuning stays in `fishRequestBody` and is NOT restated here: this
 * module sends `start.request` as that very object with `text` emptied, so
 * `latency: 'balanced'`, `chunk_length: 300`, `min_chunk_length: 50`,
 * `temperature: 0.5`, `top_p: 0.7`, `repetition_penalty: 1.3` and the prosody
 * block have exactly one definition. A second copy of these numbers is how the
 * stale-`normal` defect of v0.7.2 happened.
 *
 * WHAT IS NOT VERIFIED (roadmap §2 Pattern 6b keeps these open):
 * - The MessagePack codec below is hand-rolled and exercised only by
 *   round-trip tests plus one hand-computed byte pin. It has never spoken to
 *   the live endpoint, because that needs a key and burns Fish credit.
 * - Whether the free tier honours `flush` with a measurable TTFB win.
 * Consequently `TTS_TRANSPORT` defaults to `http`: this transport is opt-in
 * and `FishHttpTransport` remains the shipped path.
 *
 * DEPENDENCY VERDICT: no new dependency. Node's global `WebSocket` (undici)
 * accepts a second `init` argument with `headers` — measured on node v25.0.0:
 * `model` and `authorization` both arrived on the upgrade request — so `ws` is
 * NOT needed. No msgpack package is declared in the root manifest, and
 * `msgpackr` in `node_modules` is EXTRANEOUS (a leftover of `effect`), so
 * importing it would be the `pino` lesson: it would work in the repo and be
 * absent from the pruned sidecar manifest in `scripts/provision-sidecar.mjs`.
 * Hence the local codec, zero deps, and no manifest change to make.
 */
import { FishHttpTransport } from './tts.js';
import { FISH_TIMEOUT_MS, fishRequestBody, splitSentences, stripSpeechText, TTS_MODEL, TtsTimeoutError } from './tts.js';
import type { FishTransport } from './tts.js';
import type { Keyring } from './keyring.js';

// ---------------------------------------------------------------------------
// MessagePack, the subset the Fish event grammar uses.
// ---------------------------------------------------------------------------

export type MsgValue = null | boolean | number | string | Uint8Array | MsgValue[] | { [key: string]: MsgValue };

const TE = new TextEncoder();
const TD = new TextDecoder();

export function encodeMsgpack(value: MsgValue): Uint8Array {
  const out: number[] = [];
  write(value, out);
  return Uint8Array.from(out);
}

function writeFloat64(n: number, out: number[]): void {
  out.push(0xcb);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, n);
  for (let i = 0; i < 8; i += 1) out.push(view.getUint8(i));
}

function writeNumber(n: number, out: number[]): void {
  if (!Number.isInteger(n)) {
    writeFloat64(n, out);
    return;
  }
  if (n >= 0) {
    if (n <= 0x7f) out.push(n);
    else if (n <= 0xff) out.push(0xcc, n);
    else if (n <= 0xffff) out.push(0xcd, (n >> 8) & 0xff, n & 0xff);
    else if (n <= 0xffff_ffff) out.push(0xce, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    else writeFloat64(n, out);
    return;
  }
  if (n >= -32) out.push(n + 0x100);
  else if (n >= -128) out.push(0xd0, n & 0xff);
  else if (n >= -32_768) out.push(0xd1, (n >> 8) & 0xff, n & 0xff);
  else if (n >= -2_147_483_648) out.push(0xd2, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  else writeFloat64(n, out);
}

function writeStr(s: string, out: number[]): void {
  const bytes = TE.encode(s);
  if (bytes.length < 32) out.push(0xa0 | bytes.length);
  else if (bytes.length < 0x100) out.push(0xd9, bytes.length);
  else if (bytes.length < 0x1_0000) out.push(0xda, (bytes.length >> 8) & 0xff, bytes.length & 0xff);
  else out.push(0xdb, (bytes.length >>> 24) & 0xff, (bytes.length >>> 16) & 0xff, (bytes.length >>> 8) & 0xff, bytes.length & 0xff);
  for (const b of bytes) out.push(b);
}

function write(value: MsgValue, out: number[]): void {
  if (value === null) {
    out.push(0xc0);
    return;
  }
  if (typeof value === 'boolean') {
    out.push(value ? 0xc3 : 0xc2);
    return;
  }
  if (typeof value === 'number') {
    writeNumber(value, out);
    return;
  }
  if (typeof value === 'string') {
    writeStr(value, out);
    return;
  }
  if (value instanceof Uint8Array) {
    if (value.length < 0x100) out.push(0xc4, value.length);
    else if (value.length < 0x1_0000) out.push(0xc5, (value.length >> 8) & 0xff, value.length & 0xff);
    else out.push(0xc6, (value.length >>> 24) & 0xff, (value.length >>> 16) & 0xff, (value.length >>> 8) & 0xff, value.length & 0xff);
    for (const b of value) out.push(b);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length < 16) out.push(0x90 | value.length);
    else if (value.length < 0x1_0000) out.push(0xdc, (value.length >> 8) & 0xff, value.length & 0xff);
    else out.push(0xdd, (value.length >>> 24) & 0xff, (value.length >>> 16) & 0xff, (value.length >>> 8) & 0xff, value.length & 0xff);
    for (const item of value) write(item, out);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length < 16) out.push(0x80 | keys.length);
  else if (keys.length < 0x1_0000) out.push(0xde, (keys.length >> 8) & 0xff, keys.length & 0xff);
  else out.push(0xdf, (keys.length >>> 24) & 0xff, (keys.length >>> 16) & 0xff, (keys.length >>> 8) & 0xff, keys.length & 0xff);
  for (const key of keys) {
    writeStr(key, out);
    write(value[key] as MsgValue, out);
  }
}

/** Anything this codec cannot represent raises rather than truncating a frame. */
export function decodeMsgpack(bytes: Uint8Array): MsgValue {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const need = (n: number): void => {
    if (pos + n > bytes.length) throw new Error(`msgpack: truncated frame (wanted ${n} at byte ${pos}/${bytes.length})`);
  };
  const u = (n: number): number => {
    need(n);
    let v = 0;
    for (let i = 0; i < n; i += 1) v = v * 0x100 + (view.getUint8(pos + i) as number);
    pos += n;
    return v;
  };
  const i = (n: number): number => {
    need(n);
    let v = view.getInt8(pos);
    for (let k = 1; k < n; k += 1) v = v * 0x100 + (view.getUint8(pos + k) as number);
    pos += n;
    return v;
  };
  const str = (len: number): string => {
    need(len);
    const s = TD.decode(bytes.subarray(pos, pos + len));
    pos += len;
    return s;
  };
  const read = (): MsgValue => {
    need(1);
    const b = view.getUint8(pos) as number;
    pos += 1;
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if (b >= 0xa0 && b <= 0xbf) return str(b & 0x1f);
    if (b >= 0x90 && b <= 0x9f) return array(b & 0x0f);
    if (b >= 0x80 && b <= 0x8f) return map(b & 0x0f);
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return bin(u(1));
      case 0xc5: return bin(u(2));
      case 0xc6: return bin(u(4));
      case 0xca: { need(4); const v = view.getFloat32(pos); pos += 4; return v; }
      case 0xcb: { need(8); const v = view.getFloat64(pos); pos += 8; return v; }
      case 0xcc: return u(1);
      case 0xcd: return u(2);
      case 0xce: return u(4);
      case 0xcf: { need(8); const lo = u(4); const hi = view.getUint32(pos - 4); return hi * 0x1_0000_0000 + lo; }
      case 0xd0: return i(1);
      case 0xd1: return i(2);
      case 0xd2: return i(4);
      case 0xd3: { need(8); const v = view.getBigInt64(pos); pos += 8; return Number(v); }
      case 0xd9: return str(u(1));
      case 0xda: return str(u(2));
      case 0xdb: return str(u(4));
      case 0xdc: return array(u(2));
      case 0xdd: return array(u(4));
      case 0xde: return map(u(2));
      case 0xdf: return map(u(4));
      default:
        // 0xc1 (never used) and the ext families are not part of the Fish
        // grammar. Refusing is the honest answer; guessing would corrupt audio.
        throw new Error(`msgpack: unsupported byte 0x${b.toString(16)} at ${pos - 1}`);
    }
  };
  const bin = (len: number): Uint8Array => {
    need(len);
    const out = bytes.slice(pos, pos + len);
    pos += len;
    return out;
  };
  const array = (len: number): MsgValue[] => {
    const out: MsgValue[] = [];
    for (let k = 0; k < len; k += 1) out.push(read());
    return out;
  };
  const map = (len: number): { [key: string]: MsgValue } => {
    const out: { [key: string]: MsgValue } = {};
    for (let k = 0; k < len; k += 1) {
      const key = read();
      // A non-string key cannot be looked up by event name; keep it addressable
      // rather than dropping a field we were asked to decode.
      const name = typeof key === 'string' ? key : String(key);
      out[name] = read();
    }
    return out;
  };
  return read();
}

// ---------------------------------------------------------------------------
// The socket seam. Injected everywhere, including in tests: no test here opens
// a network connection, and the real connector is one small adapter.
// ---------------------------------------------------------------------------

export type FishWsEvent =
  | { type: 'open' }
  | { type: 'message'; data: Uint8Array }
  | { type: 'error'; message: string }
  | { type: 'close' };

export interface FishWsSocket {
  send(data: Uint8Array): void;
  close(): void;
  on(listener: (event: FishWsEvent) => void): void;
  off(listener: (event: FishWsEvent) => void): void;
}

export type FishWsConnector = (url: string, headers: Record<string, string>) => FishWsSocket;

interface WebSocketLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  send(data: Uint8Array): void;
  close(): void;
}

/**
 * Node's global `WebSocket` is undici's, and its real signature is
 * `(url, init)` where `init.headers` is honoured — a capability the WHATWG
 * signature has no room for, which is why `@types/node` models only
 * `(url, protocols)` and this cast is needed. MEASURED, not assumed: a probe
 * against a local upgrade server on node v25.0.0 received both `model` and
 * `authorization`. The `model` header is load-bearing in exactly the way
 * `fishHeaders` documents for HTTP: omit it and the endpoint bills the paid
 * `s2.1-pro` tier and answers 402 on a free account.
 */
const nodeConnector: FishWsConnector = (url, headers) => {
  const Ctor = WebSocket as unknown as new (target: string, init: { headers: Record<string, string> }) => WebSocketLike;
  const ws = new Ctor(url, { headers });
  const listeners = new Set<(event: FishWsEvent) => void>();
  const emit = (event: FishWsEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  ws.addEventListener('open', () => emit({ type: 'open' }));
  ws.addEventListener('message', (event) => {
    const data = (event as { data?: unknown }).data;
    if (data instanceof ArrayBuffer) emit({ type: 'message', data: new Uint8Array(data) });
    else if (typeof data === 'string') emit({ type: 'message', data: TE.encode(data) });
    else if (data instanceof Uint8Array) emit({ type: 'message', data });
  });
  ws.addEventListener('error', (event) => {
    const message = (event as { message?: unknown }).message;
    emit({ type: 'error', message: typeof message === 'string' && message !== '' ? message : 'fish socket error' });
  });
  ws.addEventListener('close', () => emit({ type: 'close' }));
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    on: (listener) => listeners.add(listener),
    off: (listener) => listeners.delete(listener),
  };
};

/** A WS frame reports no HTTP status, so it cannot be a FishCreditError. */
export class FishWsError extends Error {
  constructor(readonly reason: string) {
    super(`Fish WS synthesis failed: ${reason}`);
    this.name = 'FishWsError';
  }
}

interface Live {
  socket: FishWsSocket;
  opened: boolean;
  dead: boolean;
}

function isRecord(value: MsgValue): value is { [key: string]: MsgValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

/** `audio` is msgpack bin; a base64 string is accepted because some edges send that. */
function audioBytes(value: MsgValue | undefined): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new Uint8Array(Buffer.from(value, 'base64'));
  return null;
}

export class FishWsTransport implements FishTransport {
  /** The one socket kept between calls. `null` while a stream has it checked out. */
  private warm: Live | null = null;
  private readonly connect: FishWsConnector;
  private readonly timeoutMs: number;

  constructor(
    private readonly keyring: Keyring,
    private readonly endpoint = 'wss://api.fish.audio/v1/tts/live',
    options: { connect?: FishWsConnector; timeoutMs?: number } = {},
  ) {
    this.connect = options.connect ?? nodeConnector;
    this.timeoutMs = options.timeoutMs ?? FISH_TIMEOUT_MS;
  }

  async synthesize(text: string, fishVoiceId: string): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const chunk of this.synthesizeStream(text, fishVoiceId)) parts.push(chunk);
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  async *synthesizeStream(
    text: string,
    fishVoiceId: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<Uint8Array> {
    const key = this.keyring.acquire('fish');
    // Same expression as the HTTP path, so the header is the same credential.
    const bearer = Buffer.from(key.material).toString('utf8');
    const queue: Uint8Array[] = [];
    let ended = false;
    /** True only after a `finish` with reason 'stop' — i.e. socket reusable. */
    let clean = false;
    let failure: Error | null = null;
    let notify: (() => void) | null = null;
    const wake = (): void => {
      const n = notify;
      notify = null;
      if (n !== null) n();
    };
    const fail = (err: Error): void => {
      if (failure === null) failure = err;
      ended = true;
      wake();
    };

    const live = this.take(bearer);
    /** The protocol's end-of-stream is exactly ONE `stop`; a barge must not add a second. */
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      try {
        live.socket.send(encodeMsgpack({ event: 'stop' }));
      } catch {
        // A socket that died first needs no stop; the close in `finally` is enough.
      }
    };
    // Socket-liveness is tracked by the permanent listener registered in
    // `dial()` — it belongs to the socket, not the stream.

    const onEvent = (event: FishWsEvent): void => {
      if (event.type === 'message') {
        let msg: MsgValue;
        try {
          msg = decodeMsgpack(event.data);
        } catch {
          // Forward compatibility: the documented rule is to ignore unknown
          // events, and an undecodable frame is the same class of surprise.
          return;
        }
        if (!isRecord(msg)) return;
        if (msg.event === 'audio') {
          const bytes = audioBytes(msg.audio);
          if (bytes !== null) {
            queue.push(bytes);
            wake();
          }
        } else if (msg.event === 'finish') {
          // Peer review: ONLY 'stop' is success. Any other reason (notably a
          // truncation like 'length_exceeded') ships cut audio as success and
          // marks the key good — so it fails here, with the reason named.
          clean = msg.reason === 'stop';
          if (!clean) fail(new FishWsError(`finish reason=${typeof msg.reason === 'string' ? msg.reason : 'unknown'}`));
          else {
            ended = true;
            wake();
          }
        }
        return;
      }
      // `open` is the open-wait's wake-up. Without this the wait sits until the
      // 20 s timeout, and the test that exercises the barge abort observes the
      // resume happening after the abort rather than before it.
      if (event.type === 'open') {
        wake();
        return;
      }
      if (event.type === 'error') {
        fail(new FishWsError(event.message));
        return;
      }
      // `close`: the server sends exactly one `finish` and then closes, so a
      // close we did not see a finish for means the turn died mid-stream.
      if (!ended) fail(new FishWsError('socket closed before finish'));
    };
    live.socket.on(onEvent);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const signal = options.signal;
    const onAbort = (): void => {
      // A barge tells the server to stop synthesising (a free-tier credit) and
      // then gives up the socket: we stop reading it, so it cannot be reused.
      stop();
      const reason: unknown = signal?.reason;
      fail(reason instanceof Error ? reason : new FishWsError('aborted'));
    };

    try {
      timer = setTimeout(() => fail(new TtsTimeoutError(this.timeoutMs)), this.timeoutMs);
      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      if (!live.opened) {
        await new Promise<void>((resolve) => {
          notify = resolve;
          if (live.opened || live.dead) wake();
        });
        if (!live.opened) throw failure ?? new FishWsError('socket did not open');
      }
      // A barge that landed while the socket was still connecting must not push
      // the paragraph anyway: that is provider time and Fish credit spent on a
      // reply nobody will hear.
      if (failure !== null) throw failure;

      // `start.request` IS the HTTP body with empty text: the real text streams
      // in as `text` events, so every measured parameter is defined once, in
      // tts.ts, and cannot drift between the two transports.
      const request = { ...fishRequestBody('', fishVoiceId), text: '' } as Record<string, MsgValue>;
      live.socket.send(encodeMsgpack({ event: 'start', request }));
      // stripSpeechText again on purpose: the daemon's `onUtterance` calls the
      // transport directly, bypassing TtsEngine, so this is the last gate.
      for (const sentence of splitSentences(stripSpeechText(text))) {
        if (sentence === '') continue;
        live.socket.send(encodeMsgpack({ event: 'text', text: sentence }));
        // `flush` after EVERY sentence, not once at the end: it is the only
        // thing that makes the server synthesise the clause just sent, which is
        // the entire latency argument for this transport.
        live.socket.send(encodeMsgpack({ event: 'flush' }));
      }
      // `stop`, never `close`: closing mid-stream is not how the protocol ends.
      stop();

      for (;;) {
        // Drain first: audio often arrived while the last chunk was being
        // yielded, and yielding it without a round trip is the point.
        while (queue.length > 0) yield queue.shift() as Uint8Array;
        if (failure !== null) throw failure;
        if (ended) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } catch (err) {
      // A write to a socket Fish closed between take() and send throws here.
      if (failure === null) fail(err instanceof Error ? err : new Error(String(err)));
      throw failure ?? err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      live.socket.off(onEvent);
      // Peer review: the `!live.dead` conjunct was vacuous (no test could fail
      // on it — `take()` already excludes dead sockets). Dropped, so the
      // recycle decision reads as exactly what it is: clean finish or not.
      if (clean) this.warm = live;
      else live.socket.close();
      // A.3 UNCHANGED, and deliberately: `release` advances the pool on
      // 429/401/403 only, and a WS frame names no status at all, so the only
      // honest call is the neutral one. This is not an attempt at the A.3 fix.
      this.keyring.release(key, clean);
    }
  }

  private take(bearer: string): Live {
    const warm = this.warm;
    this.warm = null;
    if (warm !== null && !warm.dead) return warm;
    return this.dial(bearer);
  }

  private dial(bearer: string): Live {
    const live: Live = {
      socket: this.connect(this.endpoint, { Authorization: `Bearer ${bearer}`, model: TTS_MODEL }),
      opened: false,
      dead: false,
    };
    // Peer review (measured 25 listeners on 25 turns): this registration lived
    // per synthesizeStream call and was never removed — every frame's emit
    // walked all of them. It belongs to the SOCKET, so it is registered once
    // here, at dial time. The per-stream `onEvent` below is still removed in
    // `finally` via `live.socket.off(onEvent)`.
    live.socket.on((event) => {
      if (event.type === 'open') live.opened = true;
      if (event.type === 'close' || event.type === 'error') live.dead = true;
    });
    return live;
  }
}

/**
 * The rollback switch. `http` is the default and the shipped path, so setting
 * `TTS_TRANSPORT=ws` is a one-variable experiment and unsetting it restores
 * `FishHttpTransport` with no other change.
 */
export function ttsTransportMode(
  read: () => string | undefined = () => process.env.TTS_TRANSPORT,
): 'http' | 'ws' {
  return read() === 'ws' ? 'ws' : 'http';
}

/**
 * Returns the CONCRETE class, not `FishTransport`, and that is load-bearing:
 * `FishTransport.synthesizeStream` is optional, so widening the return type
 * here would make every `fish.synthesizeStream(...)` call site a TS2722
 * ("possibly undefined"). Both classes implement it as required, so the union
 * keeps the daemon compiling with no `!` and no casts.
 */
export function createFishTransport(
  keyring: Keyring,
  mode: 'http' | 'ws' = ttsTransportMode(),
): FishHttpTransport | FishWsTransport {
  return mode === 'ws' ? new FishWsTransport(keyring) : new FishHttpTransport(keyring);
}
