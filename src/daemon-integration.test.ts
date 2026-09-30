import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { startDaemon, type DaemonHandle, type DaemonOptions } from './daemon.js';
import { decodeFrames, maskFrame, Opcode } from './ipc/protocol.js';
import { SERVE_BLOCKED_DETAIL_DEGRADED, SERVE_NOTICE_RECONNECTING } from './runtime/serve-health.js';
import { MAX_PENDING } from './tasks/index.js';
import { qualifyTaskNotice } from './daemon/shell-tasks.js';

// WHY THIS FILE EXISTS SEPARATELY from daemon.test.ts and serve-health.test.ts.
//
// Both of those are GREEN without a single line of this integration, and that is
// the defect class this repo has now hit five times: `mentions.ts`, `slash.ts` and
// `prompt-optimizer.ts` all had passing tests and zero importers at the same time,
// and `serve-health.ts` shipped as "built, tested, not wired". A module's own
// tests prove the module; only a test that drives the COMPOSITION ROOT proves the
// wiring. Everything below therefore goes through the real daemon over a real
// loopback socket, or reads `src/daemon.ts` and asserts a structural fact a
// behavioural test cannot see.
//
// The two guards that are structural say so in their own names, and each one
// names the runtime behaviour it cannot reach.

const servers: Server[] = [];
const handles: DaemonHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.stop();
  while (servers.length > 0) {
    const s = servers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/**
 * A fake `opencode serve` carrying the one route that matters here.
 *
 * `/session/{id}/shell` answers with the MEASURED v1 shape — a completed tool part
 * with `output` and NO exit code anywhere. That is the common case against a real
 * serve, and it is why the assertions below expect `outcome: 'unknown'`.
 */
function fakeServe(opts: { shell?: () => unknown; shellStatus?: number; beforeShell?: () => Promise<void> } = {}): Promise<{
  server: Server;
  port: number;
}> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const send = (body: unknown, code = 200): void => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/api/session' && req.method === 'GET') {
        send({ data: [{ id: 'ses_a', state: 'idle' }] });
        return;
      }
      if (req.url?.startsWith('/api/session/ses_a/context')) {
        // `sessionContext` is the control command the serve-health gate is measured
        // against, so the fake has to answer it. Without this route the "healthy"
        // control would fail for a reason that has nothing to do with the gate.
        send({ id: 'ses_a', tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, messages: 2 });
        return;
      }
      if (req.url?.startsWith('/api/agent')) {
        send({ data: [{ id: 'build', name: 'Build' }] });
        return;
      }
      if (req.url?.startsWith('/session/ses_a/shell')) {
        const finish = (): void => {
          send(
            opts.shell?.() ?? {
              info: { id: 'msg_1', sessionID: 'ses_a', role: 'assistant', time: { created: 1, completed: 2 } },
              parts: [
                {
                  id: 'prt_1',
                  type: 'tool',
                  callID: 'call_1',
                  tool: 'bash',
                  state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi\r\n', title: 'echo hi' },
                },
              ],
            },
            opts.shellStatus ?? 200,
          );
        };
        // A serve that BLOCKS until the command completes is the measured behaviour,
        // and it is what makes "silent while running" observable rather than assumed.
        if (opts.beforeShell === undefined) {
          finish();
          return;
        }
        void opts.beforeShell().then(finish);
        return;
      }
      send({ error: 'not found' }, 404);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

async function boot(
  over: Partial<DaemonOptions> = {},
  serveOpts: { shell?: () => unknown; shellStatus?: number; beforeShell?: () => Promise<void> } = {},
): Promise<DaemonHandle> {
  const { server, port } = await fakeServe(serveOpts);
  servers.push(server);
  const dir = mkdtempSync(join(tmpdir(), 'voxaura-it-'));
  const handle = await startDaemon({
    servePort: port,
    servePassword: 'pw',
    ipcToken: 'test-ipc-token',
    ipcPort: 0,
    vaultPath: join(dir, 'keyring.dat'),
    directory: process.cwd(),
    inventoryIntervalMs: 3_600_000,
    // Never the real provider: a command that narrates would otherwise spend a
    // network call (and quota) inside a hermetic test. The key is `reply_ar` —
    // `narrate` reads that and returns null for anything else, which is why the
    // busy-room test below needs this exact shape.
    narratorChat: async () => '{"reply_ar":"تم"}',
    // A courtesy TTS line must never reach Fish from a test either. Recording the
    // calls instead is what lets the SILENCE-WINDOW rule be asserted rather than
    // assumed — see `does not speak a notice while the room is busy`.
    shellSpeak: () => undefined,
    // Always-healthy unless a test says otherwise, so an unrelated 5 s poll cannot
    // make a serve-health assertion flaky.
    serveHealthProbe: async () => true,
    ...over,
  });
  handles.push(handle);
  return handle;
}

interface Frame {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * One connection, many commands, every frame observed.
 *
 * `sendCommand` in `daemon.test.ts` resolves on the ack and closes, which cannot
 * see the `output` and `notice` frames that arrive around it — and those are the
 * frames under test. This keeps the socket open, so ordering between an ack, an
 * output frame and a notice is observable.
 *
 * TWO RACES ARE HANDLED HERE, and both cost a whole debugging session before they
 * were named:
 *   1. a frame written BEFORE the 101 is swallowed by Node's HTTP parser and
 *      discarded when the server hijacks the socket, so `send` queues until the
 *      upgrade completes;
 *   2. a `ui.notice` emitted before the server has registered the connection
 *      reaches nobody, so this promise resolves on the `hello` frame — the
 *      server's own proof that the socket is in `ui.conns` — rather than on TCP
 *      connect.
 */
interface Shell {
  send: (cmd: Record<string, unknown>) => void;
  seen: Frame[];
  close: () => void;
  waitFor: (pred: (f: Frame) => boolean, ms?: number) => Promise<Frame>;
}

function session(port: number, token: string): Promise<Shell> {
  return new Promise((resolve, reject) => {
    const seen: Frame[] = [];
    const waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
    const outbox: Buffer[] = [];
    let acc = Buffer.alloc(0);
    let head = Buffer.alloc(0);
    let upgraded = false;
    let settled = false;

    const finish = (shell: Shell): void => {
      if (settled) return;
      settled = true;
      resolve(shell);
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

    // Belt and braces: a server that never says `hello` must fail the test rather
    // than hang it, and the timer is cleared by `finish`.
    setTimeout(() => finish(shell), 2_000).unref();
  });
}


/* ══════════════════════════ POINT 1 · construct after the boot probe ═════════ */

describe('POINT 1 — the monitor is constructed only after the boot probe passed', () => {
  // STRUCTURAL, and the reason is that the behaviour is unrepresentable in a test:
  // `startDaemon` THROWS on a dead serve, so no test can observe a monitor that was
  // armed against one — the daemon would not exist to observe. What this pins is the
  // source ORDER, which is the whole safety property. Moving the construction above
  // the `throw` is invisible to every other test in the repository.
  test('the ServeHealthMonitor is constructed below the SERVE_UNREACHABLE throw', () => {
    const src = readFileSync('src/daemon.ts', 'utf8');
    const bootProbe = src.indexOf('if (!(await probeHealth(options.servePort, options.servePassword)))');
    const thrown = src.indexOf("'SERVE_UNREACHABLE',", bootProbe);
    const constructed = src.indexOf('new ServeHealthMonitor(');
    expect(bootProbe, 'the boot probe must still exist').toBeGreaterThan(-1);
    expect(thrown, 'the boot probe must still throw SERVE_UNREACHABLE').toBeGreaterThan(-1);
    expect(constructed, 'the monitor must be constructed somewhere').toBeGreaterThan(-1);
    expect(constructed).toBeGreaterThan(thrown);
  });

  test('the boot check itself is untouched — still one probe, still a throw', () => {
    // The other half of the same property, and the one that would matter more: a
    // refactor that "helpfully" made the monitor's healthy start the boot condition
    // would pass every behavioural test below.
    const src = readFileSync('src/daemon.ts', 'utf8');
    expect(src.match(/probeHealth\(options\.servePort, options\.servePassword\)/g) ?? []).toHaveLength(1);
    expect(src).toContain('`no healthy opencode serve on 127.0.0.1:${options.servePort}`');
  });

  test('the monitor is STARTED beside inventory.start(), after ui.start() resolved', () => {
    const src = readFileSync('src/daemon.ts', 'utf8');
    const uiStart = src.indexOf('await ui.start(options.ipcPort)');
    const invStart = src.indexOf('inventory.start();');
    const healthStart = src.indexOf('serveHealth.start();');
    expect(uiStart).toBeGreaterThan(-1);
    expect(invStart).toBeGreaterThan(uiStart);
    expect(healthStart).toBeGreaterThan(invStart);
    // And it is stopped on the way out, or the poller outlives the process.
    expect(src).toContain('serveHealth.stop();');
  });

  test('a live daemon exposes the monitor on the handle', async () => {
    const handle = await boot();
    expect(handle.serveHealth.status().state).toBe('healthy');
    expect(handle.serveHealth.status().servePort).toBeGreaterThan(0);
  });

  test('the exposed status carries no credential', async () => {
    // `ServeHealthMonitor` holds the password privately and `status()` is the shape
    // that would cross the WS boundary. Serialising it is the honest test.
    const handle = await boot();
    expect(JSON.stringify(handle.serveHealth.status())).not.toContain('pw');
  });
});

/* ══════════════════════════ POINT 2 + 3 · amber bar and the gate ════════════ */

describe('POINT 2 — a lost serve raises the amber bar over a real socket', () => {
  test('two failed probes put the bar up with the serve-reconnecting code', async () => {
    // `probeHealth` returns a bare boolean, so a 2 s timeout, a 500 and a closed
    // port are the same `false`. The threshold is 2 (`serve-health.ts:92`), so the
    // bar is driven by two real `checkNow()` calls rather than by faking the
    // state — the transition, the event and the notice are all the module's own.
    let healthy = true;
    const handle = await boot({ serveHealthProbe: async () => healthy });
    const s = await session(handle.ipcPort, handle.token);

    expect(await handle.serveHealth.checkNow()).toBe('reachable');
    healthy = false;
    expect(await handle.serveHealth.checkNow()).toBe('unreachable');
    // Still healthy: one failure cannot be told from one slow probe.
    expect(handle.serveHealth.status().state).toBe('healthy');

    expect(await handle.serveHealth.checkNow()).toBe('unreachable');
    expect(handle.serveHealth.status().state).toBe('degraded');

    const notice = await s.waitFor((f) => f.type === 'notice');
    expect(notice['code']).toBe(SERVE_NOTICE_RECONNECTING);
    expect(notice['level']).toBe('warn'); // the amber
    s.close();
  });

  test('a healthy serve emits NO notice at all', async () => {
    const handle = await boot();
    const s = await session(handle.ipcPort, handle.token);
    await handle.serveHealth.checkNow();
    expect(s.seen.filter((f) => f.type === 'notice')).toHaveLength(0);
    s.close();
  });
});

describe('POINT 3 — the gate refuses serve-reaching commands and nothing else', () => {
  test('a degraded serve refuses sessionContext with the degraded detail', async () => {
    let healthy = true;
    const handle = await boot({ serveHealthProbe: async () => healthy });
    const s = await session(handle.ipcPort, handle.token);
    healthy = false;
    await handle.serveHealth.checkNow();
    await handle.serveHealth.checkNow();

    s.send({ id: 'c1', kind: 'sessionContext', sessionId: 'ses_a' });
    const ack = await s.waitFor((f) => f.type === 'ack' && f['id'] === 'c1');
    expect(ack['ok']).toBe(false);
    expect(ack['detail']).toBe(SERVE_BLOCKED_DETAIL_DEGRADED);
    s.close();
  });

  test('the SAME command succeeds while serve is healthy', async () => {
    // The control half. Without it, "the gate refuses everything" would pass this
    // test file just as well as the real behaviour.
    const handle = await boot();
    const s = await session(handle.ipcPort, handle.token);
    s.send({ id: 'c1', kind: 'sessionContext', sessionId: 'ses_a' });
    const ack = await s.waitFor((f) => f.type === 'ack' && f['id'] === 'c1');
    expect(ack['ok']).toBe(true);
    s.close();
  });

  test('abort and stopSpeech still flow while serve is down', async () => {
    // The asymmetry the allowlist exists for. Blocking these would make the gate
    // CAUSE the outage it reports: a user who cannot stop the audio cannot use the
    // app at all until serve comes back, and serve is the thing that is broken.
    let healthy = true;
    const handle = await boot({ serveHealthProbe: async () => healthy });
    const s = await session(handle.ipcPort, handle.token);
    healthy = false;
    await handle.serveHealth.checkNow();
    await handle.serveHealth.checkNow();
    expect(handle.serveHealth.status().state).toBe('degraded');

    s.send({ id: 'a1', kind: 'abort' });
    s.send({ id: 'a2', kind: 'stopSpeech' });
    const a1 = await s.waitFor((f) => f.type === 'ack' && f['id'] === 'a1');
    const a2 = await s.waitFor((f) => f.type === 'ack' && f['id'] === 'a2');
    expect(a1['ok']).toBe(true);
    expect(a2['ok']).toBe(true);
    s.close();
  });

  test('execSessionShell is BLOCKED while degraded — it is state-mutating', async () => {
    let healthy = true;
    const handle = await boot({ serveHealthProbe: async () => healthy });
    const s = await session(handle.ipcPort, handle.token);
    healthy = false;
    await handle.serveHealth.checkNow();
    await handle.serveHealth.checkNow();

    s.send({ id: 'sh1', kind: 'execSessionShell', sessionId: 'ses_a', command: 'echo hi' });
    const ack = await s.waitFor((f) => f.type === 'ack' && f['id'] === 'sh1');
    expect(ack['ok']).toBe(false);
    // No task and no output frame: the command was refused, so there is nothing to
    // report on. A frame here would be a result for work that never happened.
    expect(handle.shellTasks.tasks.list()).toHaveLength(0);
    expect(s.seen.filter((f) => f.type === 'output')).toHaveLength(0);
    s.close();
  });

  test('the gate is the WRAPPER at ui.onCommand, not a branch inside the router', async () => {
    // STRUCTURAL. `command-router.ts` is owned by another wave and could grow its own
    // serve check tomorrow; this asserts there is exactly ONE gate and that it is
    // `withServeGate` at the assignment the charter named. Exactly one CALL SITE —
    // an import specifier is not a call, so the count is on the open paren.
    const src = readFileSync('src/daemon.ts', 'utf8');
    expect(src.match(/\bwithServeGate\(/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/ui\.onCommand = withServeGate\(/);
    expect(src).toContain('(status) => ({ ok: false, detail: serveBlockedDetail(status) })');
  });
});

/* ══════════════════════════ POINT 4 · shell → task, frame, notice ═══════════ */

describe('POINT 4 — an approved shell command becomes a task, a frame and a notice', () => {
  /** Park, then approve — the real FR-12 two-step the gate above must not bypass. */
  async function approveShell(handle: DaemonHandle, s: Awaited<ReturnType<typeof session>>): Promise<void> {
    s.send({ id: 'p1', kind: 'execSessionShell', sessionId: 'ses_a', command: 'echo hi' });
    const park = await s.waitFor((f) => f.type === 'ack' && f['id'] === 'p1');
    expect(park['detail']).toBe('confirmation-required');
    s.send({ id: 'c1', kind: 'confirm', confirmId: 'p1', approve: true });
  }

  test('a PARKED command enqueues nothing — the confirm gate is above the decorator', async () => {
    // THE ORDERING GUARD, and the reason the decorator sits on the client the
    // daemon builds rather than inside the router. If the two were the other way
    // round, an unapproved command would announce itself before it was allowed to
    // exist: a task, an output frame and a notice for work nobody authorised.
    const handle = await boot();
    const s = await session(handle.ipcPort, handle.token);
    s.send({ id: 'p1', kind: 'execSessionShell', sessionId: 'ses_a', command: 'echo hi' });
    const park = await s.waitFor((f) => f.type === 'ack' && f['id'] === 'p1');
    expect(park['detail']).toBe('confirmation-required');
    expect(handle.shellTasks.tasks.list()).toHaveLength(0);
    expect(s.seen.filter((f) => f.type === 'output')).toHaveLength(0);
    s.close();
  });

  test('the output frame carries outcome "unknown", NOT "ok" — the measured common case', async () => {
    // THE HONESTY GUARD, and the most important assertion in this file. Serve
    // reports no exit code in any field, so a `completed` tool proves only that the
    // tool ran. A frame that said `ok` here would be the fabricated success this
    // whole chain was written to remove — and it would be wrong in production on
    // essentially every command.
    const handle = await boot();
    const s = await session(handle.ipcPort, handle.token);
    await approveShell(handle, s);
    const out = await s.waitFor((f) => f.type === 'output');
    expect(out['status']).toBe('completed');
    expect(out['outcome']).toBe('unknown');
    expect(out['exitCode']).toBeNull();
    expect(out['sessionId']).toBe('ses_a');
    expect(out['command']).toBe('echo hi');
    expect(out['output']).toContain('hi');
    expect(out['truncated']).toBe(false);
    expect(typeof out['commandId']).toBe('string');
    s.close();
  });

  test('the task record and the notice both say the result is unknown', async () => {
    const handle = await boot();
    const s = await session(handle.ipcPort, handle.token);
    await approveShell(handle, s);
    await s.waitFor((f) => f.type === 'output');
    const notice = await s.waitFor(
      (f) => f.type === 'notice' && typeof f['code'] === 'string' && f['code'].startsWith('task-'),
    );
    // `buildTaskNotice` says `خلص <command>`; the qualifier is what stops that
    // reading as a success report.
    expect(notice['code']).toBe('task-done');
    expect(notice['level']).toBe('warn'); // never green on an unknown
    expect(String(notice['detail'])).toContain('مو مؤكدة');

    const records = handle.shellTasks.tasks.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe('done');
    expect(records[0]?.kind).toBe('shell');
    s.close();
  });

  test('a serve-flagged tool error is reported as failed, and says so', async () => {
    const handle = await boot(
      {},
      {
        shell: () => ({
          info: { id: 'msg_1', sessionID: 'ses_a', role: 'assistant' },
          parts: [
            {
              id: 'prt_1',
              type: 'tool',
              callID: 'call_1',
              tool: 'bash',
              state: { status: 'error', input: { command: 'nope' }, error: 'command not found', output: '' },
            },
          ],
        }),
      },
    );
    const s = await session(handle.ipcPort, handle.token);
    await approveShell(handle, s);
    const out = await s.waitFor((f) => f.type === 'output');
    expect(out['outcome']).toBe('failed');
    const notice = await s.waitFor(
      (f) => f.type === 'notice' && typeof f['code'] === 'string' && f['code'].startsWith('task-'),
    );
    expect(notice['level']).toBe('error');
    expect(String(notice['detail'])).toContain('فشل');
    s.close();
  });

  test('a transport failure still terminates the command, with status "error"', async () => {
    // The other half of the "a failed command is not a silent success" property: a
    // call that never reached serve has no `SessionShellResult`, and the frame must
    // still say so rather than leaving a spinner with no result.
    //
    // The failure is a real 404, not a 200 with an error body — a 200 JSON body
    // carrying no tool part is `outcome: 'unknown'`, which is a DIFFERENT case and is
    // asserted above. This branch is the one where the call itself failed.
    const handle = await boot({}, { shellStatus: 404, shell: () => ({ name: 'NotFoundError', data: { message: 'nope' } }) });
    const s = await session(handle.ipcPort, handle.token);
    s.send({ id: 'p1', kind: 'execSessionShell', sessionId: 'ses_a', command: 'echo hi' });
    await s.waitFor((f) => f.type === 'ack' && f['id'] === 'p1');
    s.send({ id: 'c1', kind: 'confirm', confirmId: 'p1', approve: true });

    const ack = await s.waitFor((f) => f.type === 'ack' && f['id'] === 'c1');
    expect(ack['ok']).toBe(false);
    // The router's own catch turned the thrown `OrchestratorError` into a code, so
    // the ack still works for a shell that only reads acks.
    expect(ack['detail']).toBe('SESSION_NOT_FOUND');
    const out = await s.waitFor((f) => f.type === 'output');
    expect(out['status']).toBe('error');
    expect(out['outcome']).toBe('failed');
    expect(handle.shellTasks.tasks.list()[0]?.state).toBe('failed');
    s.close();
  });

  test('a 200 with no tool part is "unknown", not a transport failure', async () => {
    // The distinction the whole chain turns on. Serve answers 200; it is not our
    // place to declare a contract we did not receive a failure. Asserting it here
    // keeps the previous test from being satisfied by the wrong branch.
    const handle = await boot({}, { shell: () => ({ info: { id: 'msg_1' }, parts: [] }) });
    const s = await session(handle.ipcPort, handle.token);
    await approveShell(handle, s);
    const out = await s.waitFor((f) => f.type === 'output');
    expect(out['status']).toBe('unknown');
    expect(out['outcome']).toBe('unknown');
    expect(out['output']).toBe('');
    s.close();
  });

  test('the transport-failure frame never carries err.message', async () => {
    // `ui.notice` redacts; the OUTPUT frame does not. So only a closed-union literal
    // is allowed to cross into it, and a provider string would be the leak.
    const handle = await boot(
      {},
      { shellStatus: 404, shell: () => ({ name: 'NotFoundError', data: { message: 'sk-live-SECRET' } }) },
    );
    const s = await session(handle.ipcPort, handle.token);
    s.send({ id: 'p1', kind: 'execSessionShell', sessionId: 'ses_a', command: 'echo hi' });
    await s.waitFor((f) => f.type === 'ack' && f['id'] === 'p1');
    s.send({ id: 'c1', kind: 'confirm', confirmId: 'p1', approve: true });
    const out = await s.waitFor((f) => f.type === 'output');
    expect(String(out['output'])).not.toContain('sk-live-SECRET');
    expect(String(out['output'])).toBe('SESSION_NOT_FOUND');
    s.close();
  });

  test('no notice is emitted while the command is still running', async () => {
    // "Silent while running" is a rule, not an aspiration: a task that announces
    // itself before it has produced anything is two frames the user reads as noise.
    // The fake serve BLOCKS until `release()` — the measured behaviour, and the only
    // way to observe a task that is genuinely mid-flight.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const handle = await boot(
      {},
      {
        beforeShell: () => gate,
        shell: () => ({
          info: { id: 'msg_1', sessionID: 'ses_a', role: 'assistant' },
          parts: [{ id: 'prt_1', type: 'tool', tool: 'bash', state: { status: 'completed', output: 'x' } }],
        }),
      },
    );
    const s = await session(handle.ipcPort, handle.token);
    await approveShell(handle, s);
    // The task exists and is running; nothing has been said about it.
    await new Promise((r) => setTimeout(r, 200));
    expect(handle.shellTasks.tasks.list()[0]?.state).toBe('running');
    expect(s.seen.filter((f) => f.type === 'notice' || f.type === 'output')).toHaveLength(0);
    release();
    await s.waitFor((f) => f.type === 'output');
    expect(s.seen.some((f) => f.type === 'notice')).toBe(true);
    s.close();
  });

  test('a courtesy line IS spoken when the room is quiet', async () => {
    // The positive half of the audio rule. `speak` is injected so the decision is
    // observable without Fish.
    const spoken: string[] = [];
    const handle = await boot({ shellSpeak: (text) => spoken.push(text) });
    const s = await session(handle.ipcPort, handle.token);
    await approveShell(handle, s);
    await s.waitFor((f) => f.type === 'output');
    await new Promise((r) => setTimeout(r, 200));
    // No keys in the vault, so `voicePhase` is 'idle' and `ttsInFlight` is 0: the
    // window IS open, and one line is spoken for the one completion.
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain('مو مؤكدة');
    s.close();
  });

  test('a courtesy line is NOT spoken while the assistant is speaking', async () => {
    // THE HALF THAT MAKES THE RULE REAL, and the half the first version of this
    // file was missing — see the note below. Forcing `speechAvailable: true` in
    // `buildTaskNotice` left all 29 tests GREEN, because every other test ran in a
    // quiet room where the flag was already true. A guard that only ever observes
    // the case where the behaviour is identical to the break is not a guard.
    //
    // The busy room is produced by the REAL path: `narrateOutcome` sets the voice
    // phase to 'speaking' and emits `assistant-said`, and nothing clears it except
    // `onUtterance`'s `finally` — which needs a voice pipeline this daemon does not
    // have. So a single narrated command leaves the daemon mid-answer, which is
    // exactly the state a task notice must not talk over.
    const spoken: string[] = [];
    const handle = await boot({ shellSpeak: (text) => spoken.push(text) });
    const s = await session(handle.ipcPort, handle.token);

    // Narrate a command through the injected chat. `sessionContext` is read-only,
    // so it passes the gate and reaches `onExecuted` → `narrateOutcome`.
    s.send({ id: 'n1', kind: 'sessionContext', sessionId: 'ses_a' });
    await s.waitFor((f) => f.type === 'notice' && f['code'] === 'assistant-said');
    expect(spoken, 'precondition: nothing has been spoken yet').toHaveLength(0);

    await approveShell(handle, s);
    // The VISUAL notice is unconditional — that is half the rule and it is what
    // keeps the user informed even when the room is busy.
    const notice = await s.waitFor(
      (f) => f.type === 'notice' && typeof f['code'] === 'string' && f['code'].startsWith('task-'),
    );
    expect(notice['code']).toBe('task-done');
    await new Promise((r) => setTimeout(r, 200));
    // And the SPOKEN one is suppressed. The task itself still completed: the queue
    // must never be blocked by the audio decision.
    expect(spoken).toHaveLength(0);
    expect(handle.shellTasks.tasks.list()[0]?.state).toBe('done');
    s.close();
  });

  test('the queue is bounded, and a full queue refuses rather than dropping silently', async () => {
    // The bound is C's, but the BEHAVIOUR at the bound is this integration's: the
    // command must be visibly refused, not silently queued behind nine others.
    const handle = await boot();
    const s = await session(handle.ipcPort, handle.token);
    for (let i = 0; i < MAX_PENDING + 4; i += 1) {
      s.send({ id: `p${i}`, kind: 'execSessionShell', sessionId: 'ses_a', command: 'echo hi' });
    }
    await s.waitFor((f) => f.type === 'ack' && f['id'] === 'p0');
    expect(handle.shellTasks.tasks.list().length).toBeLessThanOrEqual(MAX_PENDING + 2);
    s.close();
  });
});

/* ══════════════════════════ qualifyTaskNotice · pure, and its own tests ══════ */

describe('qualifyTaskNotice — the honesty rule, tested without a daemon', () => {
  const base = { code: 'task-done', detailAr: 'خلص npm test', severity: 'ok', speak: true } as const;

  test('an unknown outcome downgrades green to warn and says the result is unconfirmed', () => {
    const out = qualifyTaskNotice(base, 'unknown');
    expect(out.severity).toBe('warn');
    expect(out.detailAr).toContain('خلص npm test');
    expect(out.detailAr).toContain('مو مؤكدة');
  });

  test('a failed outcome is an error and says which side failed', () => {
    const out = qualifyTaskNotice(base, 'failed');
    expect(out.severity).toBe('error');
    expect(out.detailAr).toContain('فشل');
  });

  test('a confirmed ok is left EXACTLY as buildTaskNotice made it', () => {
    // If `ok` is untouched, then `warn` above is caused by the qualifier and not by
    // something else in the pipeline — which is the only way this test can mean
    // anything.
    expect(qualifyTaskNotice(base, 'ok')).toEqual(base);
  });

  test('no result at all (a timeout or a cancellation) adds nothing', () => {
    // `buildTaskNotice` already classifies those as warn/error. Appending an
    // outcome qualifier with no outcome would be inventing a result.
    expect(qualifyTaskNotice(base, null)).toEqual(base);
  });

  test('the spoken flag is never widened by the qualifier', () => {
    // Speaking an "unknown" line is the honest case; speaking a FAILURE is not
    // something the qualifier decides, and it must not accidentally enable it.
    expect(qualifyTaskNotice(base, 'unknown').speak).toBe(true);
    expect(qualifyTaskNotice({ ...base, speak: false }, 'unknown').speak).toBe(false);
  });
});

/* ══════════════════════════ POINT 5 · the handle ═══════════════════════════ */

describe('POINT 5 — the handle exposes live views, not snapshots', () => {
  test('serveHealth and shellTasks are the objects the daemon itself uses', async () => {
    const handle = await boot();
    // Same object every read: a snapshot getter would still type-check and would
    // report a monitor nothing is driving.
    expect(handle.serveHealth).toBe(handle.serveHealth);
    expect(handle.shellTasks).toBe(handle.shellTasks);
    expect(handle.shellTasks.tasks).toBe(handle.shellTasks.tasks);
  });

  test('stop() closes the shell queue, so an in-flight confirm cannot hang', async () => {
    const handle = await boot();
    handles.pop(); // this test closes it itself
    await handle.stop();
    expect(handle.shellTasks.tasks.stats().closed).toBe(true);
  });
});
