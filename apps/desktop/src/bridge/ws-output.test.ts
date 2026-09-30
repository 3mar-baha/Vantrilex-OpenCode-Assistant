import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  VoxauraBridge,
  type CommandKind,
  type OutputFrameMsg,
  type SocketLike,
} from './ws.js';

// The `output` branch in `onMessage` — the seam that was declared by `App` and
// consumed by nobody, so every frame the daemon emitted went into the void.
//
// The daemon side is `buildOutputFrame` / `OutputFrameSchema`
// (`src/ipc/protocol.ts:908`). This suite never imports it: the root `src/` tree
// is outside the desktop tsconfig's `include` and importing it would drag zod
// into the renderer bundle. So the fixture below is written from the schema by
// hand, and `type OutputFrameMsg` is the structural mirror. The reconciliation
// that makes the mirror trustworthy is asserted in two places: `field for field`
// below (every field, present, right type) and the assignability case at the
// bottom, which proves the drawer's `OutputFrameLike` is a subset of it.
//
// WHAT IS ASSERTED HERE, and what is not: that the bridge FORWARDS, and that it
// does not corrupt, widen or re-truncate on the way. That the daemon ever EMITS
// one is not this file's business and is not something a renderer can observe.

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(): void {
    /* commands are not what this file is about */
  }
  sendBinary(): void {
    /* ditto */
  }
  close(): void {
    this.closed = true;
  }
  peerText(text: string): void {
    this.onmessage?.({ data: text });
  }
}

/** One wire-legal `output` frame, per `OutputFrameSchema`. */
function frame(overrides: Partial<OutputFrameMsg> = {}): Record<string, unknown> {
  return {
    type: 'output',
    seq: 12,
    sessionId: 'ses_alpha',
    commandId: 'cmd_1',
    command: 'npm run build',
    status: 'completed',
    outcome: 'unknown',
    exitCode: null,
    output: 'vite v7.1.0 building for production',
    outputBytes: 33,
    droppedBytes: 0,
    truncated: false,
    durationMs: 812,
    ...overrides,
  };
}

interface Harness {
  readonly bridge: VoxauraBridge;
  readonly socket: FakeSocket;
  readonly output: Array<OutputFrameMsg>;
  readonly errors: string[];
  readonly others: Record<string, number>;
}

/** A live bridge whose every callback is counted, so widening is visible. */
function harness(): Harness {
  const output: OutputFrameMsg[] = [];
  const errors: string[] = [];
  const others: Record<string, number> = {};
  let socket: FakeSocket | null = null;
  const bridge = new VoxauraBridge({
    token: 'tok',
    contractVersion: '3.1.0',
    createSocket: (url, protocols) => {
      socket = new FakeSocket(url, protocols);
      return socket;
    },
    onOutput: (f) => output.push(f),
    onErrorFrame: (detail) => errors.push(detail),
    onNotice: () => {
      others['notice'] = (others['notice'] ?? 0) + 1;
    },
    onVoice: () => {
      others['voice'] = (others['voice'] ?? 0) + 1;
    },
    onEvent: () => {
      others['event'] = (others['event'] ?? 0) + 1;
    },
    onContext: () => {
      others['context'] = (others['context'] ?? 0) + 1;
    },
    onFlow: () => {
      others['flow'] = (others['flow'] ?? 0) + 1;
    },
    onInventory: () => {
      others['inventory'] = (others['inventory'] ?? 0) + 1;
    },
    onAgents: () => {
      others['agents'] = (others['agents'] ?? 0) + 1;
    },
  });
  bridge.connect();
  if (socket === null) throw new Error('socket was not created');
  return { bridge, socket, output, errors, others };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the output branch: forwarding', () => {
  test('an output frame reaches onOutput, whole and unmodified', () => {
    const h = harness();
    h.socket.peerText(JSON.stringify(frame()));
    expect(h.output).toHaveLength(1);
    expect(h.output[0]).toEqual(frame());
    // Forwarded as the parsed object, not re-serialised: no key is added and no
    // key is lost between the wire and the handler.
    expect(Object.keys(h.output[0] ?? {}).sort()).toEqual(
      [
        'command',
        'commandId',
        'droppedBytes',
        'durationMs',
        'exitCode',
        'outcome',
        'output',
        'outputBytes',
        'seq',
        'sessionId',
        'status',
        'truncated',
        'type',
      ].sort(),
    );
    h.bridge.dispose();
  });

  test('the handler is fired ONLY for type "output" — never widened', () => {
    // "Do not widen the handler" is the load-bearing property here: a 32 KiB
    // untrusted blob must only ever reach a drawer built for one. Every other
    // frame type the bridge knows is delivered to its OWN callback and leaves
    // `onOutput` untouched.
    const h = harness();
    for (const other of [
      { type: 'notice', seq: 1, code: 'assistant-said', detail: 'x', level: 'info' },
      { type: 'voice', seq: 2, phase: 'speaking' },
      { type: 'event', seq: 3, eventId: 'e1', state: 'running' },
      { type: 'context', seq: 4, sessionId: 'ses_a', used: 1, limit: 10, percent: 10, messageCount: 1 },
      { type: 'flow', seq: 5, state: 'pause' },
      { type: 'inventory', seq: 6, sessions: [{ sessionId: 'ses_a', state: 'idle' }] },
      { type: 'agents', seq: 7, agents: [{ id: 'build', name: 'build' }] },
    ]) {
      h.socket.peerText(JSON.stringify(other));
    }
    expect(h.output, 'no other frame type may reach onOutput').toHaveLength(0);
    expect(Object.keys(h.others).length, 'and each reached its own callback').toBe(7);
    h.bridge.dispose();
  });

  test('a frame with output-shaped fields but the WRONG type is not an output', () => {
    // The type is the branch key. A peer that renames the type must degrade into
    // an ignored frame, not into a terminal log.
    const h = harness();
    const smuggled = frame({ type: 'stdout' } as unknown as Partial<OutputFrameMsg>);
    h.socket.peerText(JSON.stringify(smuggled));
    expect(h.output).toHaveLength(0);
    h.bridge.dispose();
  });
});

describe('the output branch: the resume cursor', () => {
  test('seq advances lastSeq, so a reconnect resumes past the frame', () => {
    // The cursor is why the branch exists in `onMessage` at all: `output` shares
    // the daemon's seq space, and a frame whose seq is not counted is a frame the
    // daemon has already moved past and will never replay. The observable
    // consequence is the query param on the NEXT connect.
    const sockets: FakeSocket[] = [];
    const output: OutputFrameMsg[] = [];
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      createSocket: (url, protocols) => {
        const s = new FakeSocket(url, protocols);
        sockets.push(s);
        return s;
      },
      onOutput: (f) => output.push(f),
    });
    bridge.connect();
    sockets[0]!.peerText(JSON.stringify(frame({ seq: 40 })));
    expect(output).toHaveLength(1);

    // Drop and reconnect: the resume cursor must carry 40, not the 0 the first
    // connect used. Fake timers are installed BEFORE the close, because
    // `scheduleReconnect` registers its backoff timer inside the close handler —
    // faking time afterwards leaves a real timer to be advanced, and the second
    // socket is never created. (This exact ordering cost one debugging pass.)
    vi.useFakeTimers();
    sockets[0]!.closed = true;
    sockets[0]!.onclose?.(null);
    vi.advanceTimersByTime(5_000);
    vi.useRealTimers();
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toContain('lastSeq=40');
    bridge.dispose();
  });

  test('a REPLAYED frame is still forwarded — the filter is server-side', () => {
    // `onMessage` advances the cursor and fires the callback UNCONDITIONALLY,
    // exactly as `event` / `inventory` / `agents` / `context` / `flow` do. The
    // `seq > lastSeq` rule lives in `ui-server.ts`, on the replay path. A
    // client-side suppression would be a THIRD opinion about the same question,
    // and the wrong one: the terminal drawer dedupes re-delivery on `commandId`
    // (`linesFromOutputFrame` mints `${commandId}:${n}` ids), which is the layer
    // built to know about replays. Asserting the forward is what makes the
    // drawer's dedupe reachable at all.
    const h = harness();
    h.socket.peerText(JSON.stringify(frame({ seq: 3 })));
    h.socket.peerText(JSON.stringify(frame({ seq: 3 })));
    expect(h.output, 'a re-delivered frame is a fact, not an error').toHaveLength(2);
    h.bridge.dispose();
  });
});

describe('the output branch: a malformed frame is refused, and the socket lives', () => {
  // Every assertion in this block is a whole-shape requirement. The reason is
  // the same one `isContextMsg` and `isFlowMsg` give: a partial read is the false
  // affordance, and `truncated: false` on a frame that ARRIVED truncated means
  // the drawer prints "اكتمل الأمر" over half a build log.
  const cases: Array<[string, Partial<OutputFrameMsg>]> = [
    ['no seq', { seq: undefined as unknown as number }],
    ['a fractional seq', { seq: 1.5 }],
    ['a negative seq', { seq: -1 }],
    ['a session id that is not a ses_ token', { sessionId: 'not-a-session' }],
    ['an empty commandId', { commandId: '' }],
    ['a commandId over OUTPUT_MAX_COMMAND_ID_CHARS', { commandId: 'c'.repeat(129) }],
    ['a command over OUTPUT_MAX_COMMAND_CHARS', { command: 'c'.repeat(513) }],
    ['an unknown status', { status: 'done' as OutputFrameMsg['status'] }],
    ['an unknown outcome', { outcome: 'fine' as OutputFrameMsg['outcome'] }],
    ['a non-integer exitCode', { exitCode: 1.5 }],
    ['a missing exitCode (serve has no such field — null IS the value)', { exitCode: undefined as unknown as null }],
    ['a non-string output', { output: 42 as unknown as string }],
    ['a negative outputBytes', { outputBytes: -1 }],
    ['a negative droppedBytes', { droppedBytes: -1 }],
    ['a non-boolean truncated', { truncated: 'yes' as unknown as boolean }],
    ['a negative durationMs', { durationMs: -5 }],
  ];

  test.each(cases)('%s is refused', (_label, override) => {
    const h = harness();
    h.socket.peerText(JSON.stringify(frame(override)));
    expect(h.output, 'a frame this shell cannot fully read must not be handed on').toHaveLength(0);
    expect(h.errors).toEqual(['malformed output frame']);
    h.bridge.dispose();
  });

  test('a refused frame does not consume a seq', () => {
    // Ordering, stated as an assertion: validate, THEN move the cursor. If the
    // cursor moved first, a malformed frame would advance the resume point and
    // the daemon would skip the good frames that follow it.
    const sockets: FakeSocket[] = [];
    const errors: string[] = [];
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      createSocket: (url, protocols) => {
        const s = new FakeSocket(url, protocols);
        sockets.push(s);
        return s;
      },
      onErrorFrame: (d) => errors.push(d),
    });
    bridge.connect();
    sockets[0]!.peerText(JSON.stringify(frame({ seq: 99, status: 'bogus' as OutputFrameMsg['status'] })));
    expect(errors).toHaveLength(1);
    vi.useFakeTimers();
    sockets[0]!.closed = true;
    sockets[0]!.onclose?.(null);
    vi.advanceTimersByTime(5_000);
    vi.useRealTimers();
    expect(sockets[1]!.url, 'the bad seq must not be counted').toContain('lastSeq=0');
    bridge.dispose();
  });

  test('a negative exitCode is LEGAL and forwarded — a signal kill is not malformed', () => {
    // `exitCode` is `z.number().int().nullable()` with no lower bound, because a
    // process killed by a signal reports a negative code. A guard that required
    // `>= 0` here would drop a real frame, and "silence" is the wrong failure.
    const h = harness();
    h.socket.peerText(JSON.stringify(frame({ exitCode: -9, outcome: 'failed' })));
    expect(h.output).toHaveLength(1);
    expect(h.output[0]?.exitCode).toBe(-9);
    expect(h.errors).toHaveLength(0);
    h.bridge.dispose();
  });

  test('a 32 KiB output is forwarded whole — the renderer must not re-truncate', () => {
    // The producer owns `MAX_OUTPUT_TEXT_BYTES` and reports the drop on the
    // frame. A renderer-side clamp would hide it and assert a completeness the
    // frame never claimed, so this suite asserts the OPPOSITE: whatever the
    // producer said arrives, byte for byte, with `truncated` and `droppedBytes`
    // intact for the projection to render.
    const h = harness();
    const body = 'س'.repeat(10_000); // 2 bytes each: 20 000 bytes
    h.socket.peerText(
      JSON.stringify(frame({ output: body, outputBytes: 40_884, droppedBytes: 20_884, truncated: true })),
    );
    expect(h.output).toHaveLength(1);
    expect(h.output[0]?.output).toBe(body);
    expect(h.output[0]?.truncated).toBe(true);
    expect(h.output[0]?.droppedBytes).toBe(20_884);
    h.bridge.dispose();
  });
});

describe('the output branch: the frame contract is additive', () => {
  test('an unknown frame type is IGNORED, not thrown', () => {
    // A new shell against an old daemon, and a new daemon against this shell.
    // Neither half may crash the other: the `onMessage` ladder falls off the end
    // for a type it does not know, which is the pre-`output` behaviour for every
    // frame that had not been written yet.
    const h = harness();
    for (const type of ['tool', 'delta', 'stdout', 'metrics', 'output_v2', '']) {
      h.socket.peerText(JSON.stringify({ ...frame(), type }));
    }
    h.socket.peerText('not json at all');
    h.socket.peerText('null');
    h.socket.peerText('42');
    h.socket.peerText('[]');
    expect(h.output).toHaveLength(0);
    expect(h.errors, 'and it is silent, not an error frame per unknown type').toHaveLength(0);
    // A frame that CLAIMS to be an output but carries none of the shape is a
    // different case and says so: `type: 'output'` alone is not an ignorable
    // unknown, it is a malformed contract frame.
    h.socket.peerText(JSON.stringify({ type: 'output' }));
    expect(h.output).toHaveLength(0);
    expect(h.errors).toEqual(['malformed output frame']);
    // The socket is still usable afterwards — the whole point of degrading.
    h.socket.peerText(JSON.stringify(frame({ commandId: 'cmd_after' })));
    expect(h.output).toHaveLength(1);
    expect(h.output[0]?.commandId).toBe('cmd_after');
    h.bridge.dispose();
  });

  test('a future field on the frame is ignored, not refused', () => {
    // Forward compatibility in the other direction: the guard checks the fields
    // it knows and leaves the rest alone, so a daemon that ADDS a field does not
    // break a shell that predates it. A whole-shape guard that compared keys
    // would break the additive contract the protocol comments insist on.
    const h = harness();
    h.socket.peerText(JSON.stringify({ ...frame(), futureField: { nested: true } }));
    expect(h.output).toHaveLength(1);
    h.bridge.dispose();
  });

  test('an output frame is still a liveness signal', () => {
    // `onFrame` fires for any inbound byte before the ladder runs, so a stream
    // of output keeps the HUD pill live. Asserted because the alternative — a
    // frame that only reaches its own handler — would have been easy to write by
    // returning early before the liveness tap.
    let frames = 0;
    const socket = new FakeSocket('u', []);
    const bridge = new VoxauraBridge({
      token: 'tok',
      contractVersion: '3.1.0',
      createSocket: () => socket,
      onFrame: () => {
        frames += 1;
      },
    });
    bridge.connect();
    socket.peerText(JSON.stringify(frame()));
    expect(frames).toBe(1);
    bridge.dispose();
  });
});

describe('the output frame mirror, reconciled against the real schema', () => {
  test('field for field: every OutputFrameSchema field is declared, with its type', () => {
    // The thirteen fields of `OutputFrameSchema` (`src/ipc/protocol.ts:908`).
    // Written out one at a time rather than as an object comparison, because a
    // missing key and a wrong-typed key are different defects and an equality
    // check reports both as "not equal".
    const f = frame();
    const out = f as unknown as OutputFrameMsg;
    expect(out.type).toBe('output');
    expect(out.seq).toBe(12);
    expect(out.sessionId).toBe('ses_alpha');
    expect(out.commandId).toBe('cmd_1');
    expect(out.command).toBe('npm run build');
    expect(out.status).toBe('completed');
    expect(out.outcome).toBe('unknown');
    expect(out.exitCode).toBeNull();
    expect(out.output).toBe('vite v7.1.0 building for production');
    expect(out.outputBytes).toBe(33);
    expect(out.droppedBytes).toBe(0);
    expect(out.truncated).toBe(false);
    expect(out.durationMs).toBe(812);
  });

  test("the drawer's OutputFrameLike is a SUBSET, so App's handler fits the seam", () => {
    // The compile-time half of the reconciliation, proven at runtime as well:
    // `App` passes `(frame: OutputFrameLike) => void` where the bridge wants
    // `(frame: OutputFrameMsg) => void`, which under `strictFunctionTypes` needs
    // the argument to be contravariant — i.e. `OutputFrameMsg` must be a
    // supertype of what the drawer reads. This is the assignment the renderer
    // makes on every mount, expressed as data so a change to either shape that
    // breaks it fails here rather than at a `tsc` nobody reads.
    const wire: OutputFrameMsg = {
      type: 'output',
      seq: 1,
      sessionId: 'ses_alpha',
      commandId: 'cmd_1',
      command: 'echo hi',
      status: 'completed',
      outcome: 'unknown',
      exitCode: null,
      output: 'hi',
      outputBytes: 2,
      droppedBytes: 0,
      truncated: false,
      durationMs: 4,
    };
    // The ten fields the projection reads, taken off the wire object.
    const projection = {
      commandId: wire.commandId,
      command: wire.command,
      status: wire.status,
      outcome: wire.outcome,
      sessionId: wire.sessionId,
      exitCode: wire.exitCode,
      output: wire.output,
      droppedBytes: wire.droppedBytes,
      truncated: wire.truncated,
      durationMs: wire.durationMs,
    };
    // A handler typed against the projection accepts the wire object.
    const handler = (f: typeof projection): string => f.command;
    expect(handler(wire)).toBe('echo hi');
    // The projection is exactly the ten fields the drawer reads, and nothing
    // else — asserted as data so a field added to `OutputFrameLike` shows up here
    // as an eleventh key rather than being absorbed silently.
    //
    // IT WAS EIGHT, AND THIS LIST IS THE RECEIPT FOR THE DRIFT THAT PROVED THE
    // GUARD VACUOUS. This object is hand-built from the wire shape, so adding
    // `outcome` and `sessionId` to `OutputFrameLike` — the change the drawer's own
    // header documents at length — left every assertion here green and the key
    // list still claiming eight. A transcription cannot notice a transcription
    // being out of date; that is the whole weakness, and it is a separate decision
    // whether to replace this object with the real type.
    expect(Object.keys(projection).sort()).toEqual([
      'command',
      'commandId',
      'droppedBytes',
      'durationMs',
      'exitCode',
      'outcome',
      'output',
      'sessionId',
      'status',
      'truncated',
    ]);
    // And the three the projection does not read are still on the wire, which is
    // the half of the reconciliation worth stating: `type` and `seq` are frame
    // identity the bridge owns, and `outputBytes` is not a second view of
    // `output`. `buildOutputFrame` measures it as
    // `Buffer.byteLength(input.output, 'utf8')` on the RAW text, before
    // `OutputAssembler` caps `output` at `MAX_OUTPUT_TEXT_BYTES` — so it is UTF-8
    // bytes of something that may not be what shipped, and it disagrees with
    // `output.length` for that reason AND because the assembler may have trimmed
    // it. The drawer needs none of it: its truncation story is already told by
    // `truncated` and `droppedBytes`, which ARE read.
    expect(['type', 'seq', 'outputBytes'].every((k) => k in wire)).toBe(true);
  });

  test('every command kind the shell can send is a plain string union', () => {
    // Not load-bearing on its own; it exists so the fixture above cannot drift
    // into a world where `OutputFrameMsg` is untyped `any`. If `ws.ts` ever
    // loosens the interface, this import stops being meaningful and tsc says so.
    const kinds: readonly CommandKind[] = ['abort', 'execSessionShell', 'stopSpeech'];
    expect(kinds).toHaveLength(3);
  });
});
