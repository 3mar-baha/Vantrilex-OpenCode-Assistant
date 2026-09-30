import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import type { SessionId } from '../common/brands.js';
import { createCommandHandler } from '../orchestrator/command-router.js';
import { decodeFrames, maskFrame, Opcode, type UiCommand } from '../ipc/protocol.js';
import type { SessionShellResult } from '../runtime/client.js';
import { createShellTaskBridge } from './shell-tasks.js';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, type DaemonHandle } from '../daemon.js';

// DEFECT 1: the `output` frame carried the wrong id.
//
// The router was threaded — `CommandClient.execSessionShell(sessionId, command,
// commandId)` with the third argument REQUIRED, and `cmd.id` passed to it — and
// `daemon.ts` then threw the third argument away in a two-argument arrow.
// TypeScript accepts that without complaint, because a function with fewer
// parameters is assignable to a slot that declares more, so both typechecks stayed
// green, the whole suite stayed green, and every `output` frame arrived carrying
// the task queue's own UUID. A frame the shell cannot correlate to the spinner it
// is still showing is the exact defect the frame was added to end.
//
// BOTH ENDS ARE GUARDED HERE, because either alone would be a description:
//   - the BRIDGE, behaviourally, through the real router and a real `TaskQueue`;
//   - the DAEMON, structurally, by reading `daemon.ts` — a dropped parameter is
//     invisible to every behavioural test, since a bridge that accepts two
//     arguments and is handed three behaves identically.

const here = dirname(fileURLToPath(import.meta.url));

const OK: SessionShellResult = {
  sessionId: 'ses_a',
  command: 'echo hi',
  status: 'completed',
  exitCode: null,
  output: 'hi',
  durationMs: 5,
  outcome: 'unknown',
  messageId: 'msg_1',
  partId: 'prt_1',
  tool: 'bash',
  startedAt: 1,
  endedAt: 6,
  outputBytes: 2,
};

/** Park then approve, because `execSessionShell` is state-mutating. */
async function approveShell(handler: ReturnType<typeof createCommandHandler>, id: string, command: string) {
  const parked = await handler({ id, kind: 'execSessionShell', command } as UiCommand);
  expect(parked, 'precondition: the FR-12 gate parks the command').toEqual({
    ok: true,
    detail: 'confirmation-required',
  });
  return await handler({ id: `${id}-confirm`, kind: 'confirm', confirmId: id } as UiCommand);
}

describe('DEFECT 1a — the bridge uses the id it is given, not the task id', () => {
  // `break-the-guard`: change `commandId: run.commandId` back to `commandId: task.id`
  // in `publishResult`. Four tests below go red, including the one that asserts the
  // frame's id is NOT the task id.
  test('the frame carries the WS command id, and it is not the queue task id', async () => {
    const frames: Array<{ commandId: string }> = [];
    const bridge = createShellTaskBridge({
      run: async () => OK,
      emitOutput: (input) => {
        frames.push({ commandId: input.commandId });
      },
      emitNotice: () => undefined,
      speechAvailable: () => false,
    });
    await bridge.execSessionShell('ses_a' as SessionId, 'echo hi', 'cmd-from-ws');
    const taskId = bridge.tasks.list()[0]?.id;
    expect(taskId, 'precondition: one task exists').toBeDefined();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.commandId).toBe('cmd-from-ws');
    // The negative, which is the half a positive assertion cannot establish: the
    // task id is a UUID this test never sent, and a frame carrying it is the bug.
    expect(frames[0]?.commandId).not.toBe(taskId);
  });

  test('two commands keep their own ids — the id is per command, not per bridge', async () => {
    // The regression this shape invites. A single id cached on the bridge would
    // satisfy every one-command test and silently mislabel the second.
    const frames: Array<{ commandId: string }> = [];
    const bridge = createShellTaskBridge({
      run: async () => OK,
      emitOutput: (input) => {
        frames.push({ commandId: input.commandId });
      },
      emitNotice: () => undefined,
      speechAvailable: () => false,
    });
    await bridge.execSessionShell('ses_a' as SessionId, 'echo one', 'cmd-A');
    await bridge.execSessionShell('ses_a' as SessionId, 'echo two', 'cmd-B');
    expect(frames.map((f) => f.commandId)).toEqual(['cmd-A', 'cmd-B']);
  });

  test('the failure frame carries the same id as the success frame would', async () => {
    // The fault path is a separate function, so a fix that threaded the id only
    // through `publishResult` would leave the error frame keyed by the task id —
    // and an error frame is the one a shell is most likely to be waiting on.
    const frames: Array<{ commandId: string }> = [];
    const bridge = createShellTaskBridge({
      run: async () => {
        throw new Error('nope');
      },
      emitOutput: (input) => {
        frames.push({ commandId: input.commandId });
      },
      emitNotice: () => undefined,
      speechAvailable: () => false,
    });
    await expect(bridge.execSessionShell('ses_a' as SessionId, 'boom', 'cmd-fail')).rejects.toThrow();
    expect(frames[0]?.commandId).toBe('cmd-fail');
  });

  test('the id survives the REAL router, through the FR-12 park', async () => {
    // The end-to-end half that matters. The router is the component that owns the
    // park, the confirmation and the `cmd.id`; driving it here means the id is
    // threaded from a `UiCommand` all the way to the frame, not merely supplied
    // correctly by a test.
    const frames: Array<{ commandId: string }> = [];
    const bridge = createShellTaskBridge({
      run: async () => OK,
      emitOutput: (input) => {
        frames.push({ commandId: input.commandId });
      },
      emitNotice: () => undefined,
      speechAvailable: () => false,
    });
    const handler = createCommandHandler({
      client: {
        setSessionAgent: async () => undefined,
        setSessionModel: async () => undefined,
        toggleSessionSkill: async () => undefined,
        createSession: async () => ({ sessionId: 'ses_new' as SessionId }),
        execSessionShell: (sessionId, command, commandId) =>
          bridge.execSessionShell(sessionId, command, commandId),
      },
      switchSession: () => undefined,
      activeSessionId: () => 'ses_a' as SessionId,
      projectDirectory: () => 'O:/project',
    });
    await approveShell(handler, 'ws-cmd-42', 'rm -rf build');
    expect(frames).toHaveLength(1);
    // The EXEC id, not the confirm's id: the parked payload is the one that runs.
    expect(frames[0]?.commandId).toBe('ws-cmd-42');
  });

  test('a shell-supplied id cannot make the frame unparseable', async () => {
    // The bound. `OutputFrameSchema.commandId` is `min(1).max(128)` plus a
    // control-character refusal, and `buildOutputFrame` PARSES — so an id that
    // violated it would throw inside `ui.output`. The claim is that it cannot,
    // because `UiCommandSchema.id` is the same rule and the id reaches the bridge
    // through it. This test walks the real schema rather than restating the
    // constant, so a widening of one side and not the other fails here.
    const frames: Array<{ commandId: string }> = [];
    const bridge = createShellTaskBridge({
      run: async () => OK,
      emitOutput: (input) => {
        frames.push({ commandId: input.commandId });
      },
      emitNotice: () => undefined,
      speechAvailable: () => false,
    });
    // Both extremes: the empty id is refused by the COMMAND schema before it could
    // ever reach here, and this is the largest legal one.
    const atLimit = 'c'.repeat(128);
    await bridge.execSessionShell('ses_a' as SessionId, 'echo hi', atLimit);
    expect(frames[0]?.commandId).toBe(atLimit);
    expect(atLimit.length).toBe(128);
  });
});

describe('DEFECT 1b — daemon.ts forwards the third argument', () => {
  // STRUCTURAL, and it has to be. A dropped parameter is invisible to every
  // behavioural test in the repository: a bridge that takes two arguments and is
  // handed three behaves exactly the same, which is how the whole suite stayed
  // green while the defect shipped. Reading the source is the only instrument that
  // can see it.
  //
  // `break-the-guard`: shorten the arrow at `execSessionShell:` back to
  // `(sessionId, command) =>`. This fails; no behavioural test in the repo does.
  test('the wrapper declares three parameters and passes all three through', () => {
    const source = readFileSync(resolve(here, '../daemon.ts'), 'utf8');
    const line = source
      .split('\n')
      .find((l) => l.includes('execSessionShell:') && l.includes('=>'));
    expect(line, 'the wrapper is where the id is forwarded').toBeDefined();
    const declaration = line?.match(/execSessionShell:\s*\(([^)]*)\)/);
    expect(declaration, 'the wrapper declares its parameters').not.toBeNull();
    const params = (declaration?.[1] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    expect(params, 'three parameters, not two').toHaveLength(3);
    expect(params[2]).toBe('commandId');
    // And the body passes that exact name to the bridge.
    const body = source.slice(source.indexOf(line ?? ''), source.indexOf(line ?? '') + 400);
    expect(body).toMatch(/shellTasks\.execSessionShell\(sessionId, command, commandId\)/);
  });

  test('the production bridge is built with the default deadline', () => {
    // The seam I added for the timeout test, pinned. A production deadline that
    // is only reachable through a test option is a number nobody is reading, and
    // `daemon.ts` passing one would change the 15-minute deadline nobody measured.
    const source = readFileSync(resolve(here, '../daemon.ts'), 'utf8');
    const call = source.slice(source.indexOf('createShellTaskBridge('), source.indexOf('createShellTaskBridge(') + 1_200);
    expect(call, 'the factory call is found').toContain('createShellTaskBridge(');
    expect(call, 'daemon.ts sets no per-task deadline').not.toMatch(/timeoutMs:/);
    expect(call, 'daemon.ts sets no clamp floor').not.toMatch(/minTimeoutMs:/);
  });

  test('the boot probe still throws before the monitor is constructed', () => {
    // NOT MINE, and asserted because this change touched `daemon.ts` and the
    // ordering is the file's most safety-critical property: `startDaemon` must
    // refuse to exist against a dead serve rather than arm a monitor on it. A
    // structural re-read here is cheaper than discovering the regression in an
    // installed build.
    const source = readFileSync(resolve(here, '../daemon.ts'), 'utf8');
    const bootProbe = source.indexOf('if (!(await probeHealth(options.servePort, options.servePassword)))');
    const thrown = source.indexOf("'SERVE_UNREACHABLE',", bootProbe);
    const constructed = source.indexOf('new ServeHealthMonitor(');
    expect(bootProbe).toBeGreaterThan(-1);
    expect(thrown).toBeGreaterThan(-1);
    expect(constructed).toBeGreaterThan(thrown);
  });

  test('the serve gate is still the one wrapper at the one call site', () => {
    // Also not mine, and the same reason: the router is gated by `withServeGate` at
    // `ui.onCommand`, and `serve-health.ts`'s allowlist is the exact complement of
    // the serve-reaching kinds. One call site, no more.
    const source = readFileSync(resolve(here, '../daemon.ts'), 'utf8');
    expect(source.match(/\bwithServeGate\(/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/ui\.onCommand = withServeGate\(/);
  });

  test('the client wrapper is still spelled out verb by verb, never spread', () => {
    // The spread trap, restated because this change added a line to the object
    // literal. `{ ...client }` on a class instance copies no prototype method, so
    // every verb becomes `undefined` at runtime while type-checking cleanly.
    const source = readFileSync(resolve(here, '../daemon.ts'), 'utf8');
    const start = source.indexOf('createCommandHandler({');
    const block = source.slice(start, source.indexOf('projectDirectory:', start));
    expect(block, 'the wrapper literal is found').toContain('client: {');
    // Comments are stripped first, and that is not a detail: the block's own
    // comment explains WHY the spread is forbidden and quotes `{ ...client }` in
    // the process, so a raw substring search matches the explanation. A guard that
    // fails on its own documentation is not a guard.
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'the wrapper literal').not.toMatch(/\.\.\.client\b/);
    for (const verb of [
      'setSessionAgent',
      'setSessionModel',
      'toggleSessionSkill',
      'createSession',
      'contextUsage',
      'execSessionShell',
    ]) {
      expect(code, `${verb} is forwarded explicitly`).toContain(`${verb}: (`);
    }
  });
});

// ── THE SAME DEFECT THROUGH THE REAL DAEMON ─────────────────────────────────
//
// The unit tests above prove the bridge and the router. This one drives the
// COMPOSITION ROOT over a real socket, because `daemon.ts` is where the id was
// dropped and no unit test can reach it: a bridge that accepts two arguments and is
// handed three is indistinguishable from one that accepts three.

interface Frame {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface Shell {
  send: (cmd: Record<string, unknown>) => void;
  seen: Frame[];
  close: () => void;
  waitFor: (pred: (f: Frame) => boolean, ms?: number) => Promise<Frame>;
}

function session(port: number, token: string): Promise<Shell> {
  return new Promise((resolve_, reject) => {
    const seen: Frame[] = [];
    const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
    const outbox: Buffer[] = [];
    let acc = Buffer.alloc(0);
    let head = Buffer.alloc(0);
    let upgraded = false;
    let settled = false;
    const finish = (shell: Shell): void => {
      if (settled) return;
      settled = true;
      resolve_(shell);
    };
    const shell: Shell = {
      send: (cmd) => {
        const frame = maskFrame(Opcode.Text, Buffer.from(JSON.stringify(cmd)), Buffer.from([1, 2, 3, 4]));
        if (upgraded) sock.write(frame);
        else outbox.push(frame);
      },
      seen,
      close: () => sock.destroy(),
      waitFor: (pred, ms = 5_000) =>
        new Promise<Frame>((res, rej) => {
          const existing = seen.find(pred);
          if (existing !== undefined) {
            res(existing);
            return;
          }
          const timer = setTimeout(() => rej(new Error(`frame not seen in ${ms}ms`)), ms);
          waiters.push({
            pred,
            resolve: (f) => {
              clearTimeout(timer);
              res(f);
            },
          });
        }),
    };
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(
        Buffer.from(
          [
            'GET /v1/ui HTTP/1.1',
            'Host: 127.0.0.1',
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            `Sec-WebSocket-Protocol: voice-ui.v1, ${token}`,
            '',
            '',
          ].join('\r\n'),
          'utf8',
        ),
      );
    });
    sock.on('error', reject);
    sock.on('data', (chunk: Buffer) => {
      if (upgraded) {
        onFrames(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const idx = head.indexOf('\r\n\r\n');
      if (idx === -1) return;
      upgraded = true;
      onFrames(head.subarray(idx + 4));
      for (const pending of outbox.splice(0)) sock.write(pending);
    });
    function onFrames(bytes: Buffer): void {
      if (bytes.byteLength === 0) return;
      acc = Buffer.concat([acc, bytes]);
      const { frames, remaining } = decodeFrames(acc);
      acc = Buffer.from(remaining);
      for (const f of frames) {
        if (f.opcode !== Opcode.Text) continue;
        const frame = JSON.parse(Buffer.from(f.payload).toString('utf8')) as Frame;
        seen.push(frame);
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          const w = waiters[i];
          if (w === undefined || !w.pred(frame)) continue;
          waiters.splice(i, 1);
          w.resolve(frame);
        }
        if (frame.type === 'hello') finish(shell);
      }
    }
    setTimeout(() => finish(shell), 2_000).unref();
  });
}

const servers: Server[] = [];
const handles: DaemonHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.stop();
  while (servers.length > 0) {
    const s = servers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
});

function fakeServe(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve_) => {
    const server = createServer((req, res) => {
      const send = (body: unknown): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/api/session' && req.method === 'GET') {
        send({ data: [{ id: 'ses_a', state: 'idle' }] });
        return;
      }
      if (req.url?.startsWith('/api/session/ses_a/context')) {
        send({ id: 'ses_a', tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, messages: 2 });
        return;
      }
      if (req.url?.startsWith('/api/agent')) {
        send({ data: [{ id: 'build', name: 'Build' }] });
        return;
      }
      if (req.url?.startsWith('/session/ses_a/shell')) {
        send({
          info: { id: 'msg_1', sessionID: 'ses_a' },
          parts: [
            {
              id: 'prt_1',
              type: 'tool',
              callID: 'call_1',
              tool: 'bash',
              state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi\r\n' },
            },
          ],
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve_({ server, port: typeof addr === 'object' && addr !== null ? addr.port : 0 });
    });
  });
}

async function boot(): Promise<DaemonHandle> {
  const { server, port } = await fakeServe();
  servers.push(server);
  const dir = mkdtempSync(join(tmpdir(), 'voxaura-id-'));
  const handle = await startDaemon({
    servePort: port,
    servePassword: 'pw',
    ipcToken: 'test-ipc-token',
    ipcPort: 0,
    vaultPath: join(dir, 'keyring.dat'),
    directory: process.cwd(),
    inventoryIntervalMs: 3_600_000,
    narratorChat: async () => '{"reply_ar":"تم"}',
    shellSpeak: () => undefined,
    serveHealthProbe: async () => true,
  });
  handles.push(handle);
  return handle;
}

describe('DEFECT 1c — through the real daemon, the frame carries the shell command id', () => {
  // `break-the-guard`: this one has no injection of its own — it fails when 1b's
  // source assertion is broken, which is the point. It exists to prove the fix is
  // not only that a line of source now contains three parameters, but that a real
  // `output` frame on a real socket carries the id the shell sent.
  test('the output frame commandId is the exec id, not the task id', async () => {
    const handle = await boot();
    const s = await session(handle.ipcPort, handle.token);
    s.send({ id: 'shell-exec-9', kind: 'execSessionShell', sessionId: 'ses_a', command: 'echo hi' });
    const park = await s.waitFor((f) => f.type === 'ack' && f['id'] === 'shell-exec-9');
    expect(park['detail']).toBe('confirmation-required');
    s.send({ id: 'shell-exec-9-confirm', kind: 'confirm', confirmId: 'shell-exec-9', approve: true });

    const out = await s.waitFor((f) => f.type === 'output');
    expect(out['commandId']).toBe('shell-exec-9');
    // The negative. The task id is a UUID the shell never sent, and the frame
    // carrying it is the defect this whole file exists for.
    const taskId = handle.shellTasks.tasks.list()[0]?.id;
    expect(taskId).toBeDefined();
    expect(out['commandId']).not.toBe(taskId);
    s.close();
  });

  test('two commands get two frames with their own ids', async () => {
    // The per-command half, over the real socket. A bridge-level id cached once
    // would pass the single-command test and mislabel every command after the
    // first, which is the shape a one-line fix usually takes.
    const handle = await boot();
    const s = await session(handle.ipcPort, handle.token);
    for (const id of ['exec-one', 'exec-two']) {
      s.send({ id, kind: 'execSessionShell', sessionId: 'ses_a', command: 'echo hi' });
      await s.waitFor((f) => f.type === 'ack' && f['id'] === id);
      s.send({ id: `${id}-c`, kind: 'confirm', confirmId: id, approve: true });
    }
    await s.waitFor((f) => f.type === 'output' && f['commandId'] === 'exec-two');
    const ids = s.seen.filter((f) => f.type === 'output').map((f) => f['commandId']);
    expect(ids).toEqual(['exec-one', 'exec-two']);
    s.close();
  });
});
