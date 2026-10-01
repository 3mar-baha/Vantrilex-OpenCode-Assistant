import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { startDaemon, type DaemonHandle } from './daemon.js';
import { decodeFrames, maskFrame, Opcode } from './ipc/protocol.js';
import { FileVault } from './voice/vault.js';
import { writeKeyPools } from './voice/key-store.js';
import { STT_TIMEOUT_MS, SttTimeoutError } from './voice/stt.js';

// ─────────────────────────────────────────────────────────────────────────────
// W27 — ONE stalled STT window produced THREE false reports about itself.
//
// The chain, all of it real and all of it reachable:
//
//   stt.ts races the transcription and rejects `SttTimeoutError`
//     → daemon's `transcribe` catch recorded STT_FAILED/ERROR and emitted
//       `stt-failed` at severity `error`
//     → audio-pipeline's `transcribeWindow` caught it, counted it, dropped the
//       window and called `onSttTimeout`
//       → which recorded STT_TIMEOUT/DEGRADED and emitted `stt-timeout` at
//         severity `warn`
//
// So one recoverable event produced two telemetry rows (one of them saying
// `Unknown`, because `classify` compared two literal names and
// `SttTimeoutError` is neither) and two notices at CONFLICTING severities,
// error first. The user was told speech-to-text had failed while the app was
// still listening.
//
// This file drives the REAL daemon over a REAL socket and reads the JSONL the
// daemon actually wrote. It does not call the classifier, spy on the notice, or
// assert on source text — every assertion below is about an observable the
// product emits.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How the stubbed Groq client behaves. Mutable so ONE test can make it stall.
 *
 * It rejects with the REAL `SttTimeoutError` rather than hanging for the real
 * 15 s. That is not a shortcut around the code under test: `stt.ts`'s race is
 * what manufactures the class, and the class is what both branches branch on —
 * `transcribeWindow` uses `err instanceof SttTimeoutError` and so does the
 * daemon's catch. The race itself is covered in `stt.test.ts`; what is under
 * test here is what the daemon DOES with the error, and that is identical for a
 * class the race threw and a class a test threw.
 */
let sttMode: 'reject' | 'timeout' = 'reject';

vi.mock('groq-sdk', () => ({
  default: class StubGroq {
    readonly audio = {
      transcriptions: {
        create: (): Promise<{ text: string; segments: unknown[] }> =>
          sttMode === 'timeout'
            ? Promise.reject(new SttTimeoutError(STT_TIMEOUT_MS))
            : Promise.reject(new Error('stubbed STT provider')),
      },
    };
  },
}));

interface NoticeFrame {
  readonly type?: string;
  readonly code?: string;
  readonly level?: string;
}

/**
 * Push one real 5 s window through WS-4097 and collect every notice until the
 * pipeline settles, then resolve with what the user was actually told.
 */
function driveWindow(port: number, token: string, settleMs = 900): Promise<readonly NoticeFrame[]> {
  return new Promise((resolve, reject) => {
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
    let acc = Buffer.alloc(0);
    let head = Buffer.alloc(0);
    let upgraded = false;
    const notices: NoticeFrame[] = [];
    const finish = (): void => {
      clearTimeout(settle);
      sock.end();
      resolve(notices);
    };
    // The settle window is what makes "exactly one notice" a real claim: the
    // stream stays open after the notice, so a second one arriving late is still
    // counted rather than raced away from.
    const settle = setTimeout(finish, settleMs);
    sock.on('error', (err: Error) => {
      clearTimeout(settle);
      reject(err);
    });
    sock.on('data', (chunk: Buffer) => {
      let rest = chunk;
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const idx = head.indexOf('\r\n\r\n');
        if (idx === -1) return;
        upgraded = true;
        // 50 × 100 ms of full-scale PCM clears the −30 dBFS energy gate, so the
        // window really reaches the transcribe call.
        const loud = Buffer.alloc(3200, 0x7f);
        for (let i = 0; i < 50; i += 1) sock.write(maskFrame(Opcode.Binary, loud, Buffer.from([1, 2, 3, 4])));
        rest = head.subarray(idx + 4);
      }
      acc = Buffer.concat([acc, rest]);
      const { frames, remaining } = decodeFrames(acc);
      acc = Buffer.from(remaining);
      for (const f of frames) {
        if (f.opcode !== Opcode.Text) continue;
        const frame = JSON.parse(Buffer.from(f.payload).toString('utf8')) as NoticeFrame;
        if (frame.type === 'notice') notices.push(frame);
      }
    });
  });
}

function fakeServe(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const send = (body: unknown): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/api/session' && req.method === 'GET') {
        send({ data: [{ id: 'ses_a', state: 'idle' }] });
        return;
      }
      if (req.url?.startsWith('/api/agent')) {
        send({ data: [{ id: 'build', name: 'Build' }] });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr !== null ? addr.port : 0 });
    });
  });
}

const servers: Server[] = [];
const handles: DaemonHandle[] = [];

afterEach(async () => {
  sttMode = 'reject';
  if (PREV_VAD === undefined) delete process.env['VAD_MODEL_PATH'];
  else process.env['VAD_MODEL_PATH'] = PREV_VAD;
  while (handles.length > 0) await handles.pop()!.stop();
  while (servers.length > 0) {
    const s = servers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/**
 * Force the ENERGY gate for every test in the file.
 *
 * `models/silero-vad.onnx` is gitignored and ships in no build, but a developer
 * checkout CAN have one — and Silero correctly judges a full-scale DC tone to be
 * non-speech, which would gate the window before it ever reached the transcribe
 * call. This suite would then pass vacuously on its notice assertions while
 * testing nothing.
 *
 * Set in `beforeEach`, NOT at module scope. An earlier revision of this file set
 * it once at the top and restored it in `afterEach`, which made the FIRST test
 * exercise the RMS path and every LATER test silently take the Silero path — the
 * same window, gated differently, and only the first assertion had anything
 * behind it. That is the "green because the setup no-opped" failure in its most
 * expensive form: four of six tests were measuring a gated window.
 */
const PREV_VAD = process.env['VAD_MODEL_PATH'];
beforeEach(() => {
  process.env['VAD_MODEL_PATH'] = 'models/w27-absent-vad.onnx';
});

async function bootStall(): Promise<{ handle: DaemonHandle; runtimeDir: string }> {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'w27-rt-'));
  const vaultPath = join(mkdtempSync(join(tmpdir(), 'w27-vault-')), 'keyring.dat');
  writeKeyPools(new FileVault(vaultPath), { groq: ['g1'], fish: ['f1'], openrouter: ['o1'] });
  const { server, port } = await fakeServe();
  servers.push(server);
  const handle = await startDaemon({
    servePort: port,
    servePassword: 'pw',
    ipcToken: 'test-ipc-token',
    ipcPort: 0,
    vaultPath,
    directory: process.cwd(),
    inventoryIntervalMs: 3_600_000,
    runtimeDir,
    narratorChat: async () => '{"line":"تم"}',
  });
  handles.push(handle);
  return { handle, runtimeDir };
}

interface Row {
  readonly subsystem?: string;
  readonly status?: string;
  readonly errorCode?: string;
  readonly sanitizedErrorClass?: string;
  readonly latencyMs?: number;
  readonly remediationAttempted?: string;
}

/**
 * Stop the daemon — which is what flushes the telemetry buffer — and read the
 * rows it wrote.
 *
 * The read is NOT best-effort. An earlier revision swallowed a missing file and
 * returned `[]`, and every assertion downstream then passed or failed for the
 * wrong reason (four of six failed on an empty read while the daemon was in fact
 * writing correctly). A guard that cannot tell "no rows" from "did not read the
 * rows" is not a guard, so a missing file throws here and names the path.
 */
async function stopAndRead(handle: DaemonHandle, runtimeDir: string): Promise<Row[]> {
  await handle.stop();
  handles.pop();
  const file = join(runtimeDir, 'voice-runtime.jsonl');
  if (!existsSync(file)) throw new Error(`no telemetry file at ${file} — the daemon wrote nothing`);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Row);
}

describe('W27: one stalled STT window produces ONE notice and ONE row', () => {
  test('BREAK: exactly one notice, and it is the recoverable one at `warn`', async () => {
    sttMode = 'timeout';
    const { handle } = await bootStall();
    const notices = await driveWindow(handle.ipcPort, 'test-ipc-token');

    const stalls = notices.filter((n) => n.code === 'stt-timeout' || n.code === 'stt-failed');
    // BEFORE: both, `stt-failed` at `error` first and `stt-timeout` at `warn`
    // after — one event, two contradictory severities.
    expect(stalls.map((n) => n.code)).toEqual(['stt-timeout']);
    expect(stalls[0]?.level, 'a recovered stall is a `warn`, not an `error`').toBe('warn');
    // And the harsh claim is not merely reordered — it is absent, because the
    // product never failed at all.
    expect(notices.some((n) => n.code === 'stt-failed')).toBe(false);
  });

  test('BREAK: exactly one telemetry row, DEGRADED, classed TimeoutError', async () => {
    sttMode = 'timeout';
    const { handle, runtimeDir } = await bootStall();
    await driveWindow(handle.ipcPort, 'test-ipc-token');
    const all = await stopAndRead(handle, runtimeDir);
    const stt = all.filter((r) => r.subsystem === 'STT' && (r.errorCode === 'STT_TIMEOUT' || r.errorCode === 'STT_FAILED'));
    // BEFORE: two rows — STT_FAILED/ERROR/`Unknown` and STT_TIMEOUT/DEGRADED.
    expect(stt.map((r) => r.errorCode)).toEqual(['STT_TIMEOUT']);
    expect(stt[0]?.status, 'the window was dropped and the loop continued').toBe('DEGRADED');
    // The recorded defect: this exact value was `Unknown` for the daemon's
    // whole life, because `classify` compared two literals.
    expect(stt[0]?.sanitizedErrorClass).toBe('TimeoutError');
    expect(stt[0]?.sanitizedErrorClass).not.toBe('Unknown');
  });

  test('BREAK: no `Unknown` class reaches the STT subsystem at all', async () => {
    // The narrower claim, and the one that generalises: a stall must never be
    // filed as an unidentified error, because `Unknown` is the class that tells
    // an operator nothing and is indistinguishable from a bug in this code.
    sttMode = 'timeout';
    const { handle, runtimeDir } = await bootStall();
    await driveWindow(handle.ipcPort, 'test-ipc-token');
    for (const r of await stopAndRead(handle, runtimeDir)) {
      expect(r.sanitizedErrorClass, `an STT row was filed ${r.sanitizedErrorClass}`).not.toBe('Unknown');
    }
  });

  test('BREAK: the recorded latency is a MEASUREMENT, not the timeout budget copied in', async () => {
    // `onSttTimeout` is handed the timeout CONSTANT. Writing that into
    // `latencyMs` reported every stall as exactly 15 000 ms — a fabricated
    // number in the one file whose entire job is measurement. The row now
    // carries the elapsed time the STT call actually took.
    sttMode = 'timeout';
    const { handle, runtimeDir } = await bootStall();
    await driveWindow(handle.ipcPort, 'test-ipc-token');
    const stt = (await stopAndRead(handle, runtimeDir)).find((r) => r.errorCode === 'STT_TIMEOUT');
    expect(stt, 'the stall must have been recorded').toBeDefined();
    // A real elapsed time for a call that failed almost immediately, so it is
    // orders of magnitude below the 15 s budget. BEFORE: exactly 15 000.
    expect(stt?.latencyMs ?? -1).toBeLessThan(STT_TIMEOUT_MS);
    expect(stt?.latencyMs ?? -1).toBeGreaterThanOrEqual(0);
  });
});

describe('W27: a GENUINE STT failure keeps its `error` notice', () => {
  test('BREAK: a non-timeout rejection still reports `stt-failed` at `error`', async () => {
    // The counterpart, and the reason the fix is a branch rather than a
    // deletion. A Groq 401 or 500 is a real failure the user must be told
    // about, and it must still land in the pool-rotation telemetry.
    sttMode = 'reject';
    const { handle, runtimeDir } = await bootStall();
    const notices = await driveWindow(handle.ipcPort, 'test-ipc-token');
    const failures = notices.filter((n) => n.code === 'stt-failed');
    const all = await stopAndRead(handle, runtimeDir);

    expect(failures.length, 'a genuine provider refusal must still be reported').toBe(1);
    expect(failures[0]?.level).toBe('error');
    const stt = all.filter((r) => r.subsystem === 'STT' && r.errorCode === 'STT_FAILED');
    expect(stt.length).toBe(1);
    expect(stt[0]?.status).toBe('ERROR');
    // And it must NOT be mistaken for a stall in the other direction.
    expect(stt[0]?.sanitizedErrorClass).not.toBe('TimeoutError');
  });
});

describe('W27: the pipeline still recovers — the fix does not wedge the loop', () => {
  test('BREAK: after a stall the daemon is still serving frames', async () => {
    // The reason the timeout arm RETHROWS instead of swallowing. Swallowing it
    // in the daemon's catch would stop `transcribeWindow` from recognising the
    // timeout, so the window would never be dropped and the serial await in
    // `pushChunk` would stall every later window — the D5 wedge, reintroduced by
    // the fix for D5's sibling defect.
    sttMode = 'timeout';
    const { handle } = await bootStall();
    const first = await driveWindow(handle.ipcPort, 'test-ipc-token');
    expect(first.filter((n) => n.code === 'stt-timeout').length, 'the first window stalled').toBe(1);

    // A second, INDEPENDENT socket must get its own stall notice. That is only
    // possible if the pipeline is still consuming windows: a wedged one would
    // leave this socket connected with a `hello` and nothing else.
    const second = await driveWindow(handle.ipcPort, 'test-ipc-token');
    expect(second.filter((n) => n.code === 'stt-timeout').length, 'the pipeline wedged after the first stall').toBe(1);
    // And the second window was counted, not silently absorbed.
    expect(second.filter((n) => n.code === 'stt-failed').length, 'the harsh notice came back').toBe(0);
  });
});

