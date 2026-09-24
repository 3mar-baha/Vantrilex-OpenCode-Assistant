// Voxaura live interactive console harness.
// Real network + real APIs: OpenCode serve (Basic auth), WS-4097 bridge,
// Fish Audio TTS (keyring from the encrypted vault), Silero VAD, Groq Whisper.
// Secrets are never printed: only counts, lengths, and statuses.
// Run: node scripts/live_console_test.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UiServer, UI_SUBPROTOCOL } from '../dist/ipc/index.js';
import { VOICE_IDS } from '../dist/common/brands.js';
import { FileVault } from '../dist/voice/vault.js';
import { Keyring } from '../dist/voice/keyring.js';
import { FishHttpTransport, TTS_MODEL } from '../dist/voice/tts.js';
import { GroqWhisperClient } from '../dist/voice/stt.js';
import { SileroVad } from '../dist/runtime/vad.js';

const SERVE_PORT = 4096;
const BRIDGE_PORT = 4097;
const CONTRACT_VERSION = '3.1.0';
const PHRASE =
  'هلا عمر، منظومة فوكسورا شغالة بكفاءة، والوكيلين كريم ونور جاهزين لإدارة المشاريع.';
const OPENCODE_BIN =
  process.env['OPENCODE_BIN'] ??
  'C:\\Users\\omarb\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe';

const line = (s = ''): void => console.log(s);
const rule = (title: string): void => {
  line();
  line(`── ${title} ${'─'.repeat(Math.max(2, 60 - title.length))}`);
};
const ok = (s: string): void => line(`  ✔ ${s}`);
const warn = (s: string): void => line(`  ⚠ ${s}`);
const info = (s: string): void => line(`  · ${s}`);

function basic(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

async function serveFetch(path: string, password: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${SERVE_PORT}${path}`, {
    headers: { Authorization: basic(password) },
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

interface DiscoveredSession {
  id: string;
  agent?: string;
  model?: string;
  state?: string;
}

function extractSessions(payload: unknown): DiscoveredSession[] {
  // Live shape (verified): { data: [ { id, agent, model, ... } ] }
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((row) => row as Record<string, unknown>)
    .filter((row) => typeof row['id'] === 'string')
    .map((row) => ({
      id: String(row['id']),
      agent: typeof row['agent'] === 'string' ? row['agent'] : undefined,
      model:
        typeof row['model'] === 'object' && row['model'] !== null
          ? String((row['model'] as Record<string, unknown>)['id'] ?? '')
          : undefined,
      state: typeof row['state'] === 'string' ? row['state'] : undefined,
    }));
}

function spawnServe(password: string): ChildProcess {
  const child = spawn(
    OPENCODE_BIN,
    ['serve', '--port', String(SERVE_PORT), '--hostname', '127.0.0.1'],
    {
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

async function waitForServe(password: string, timeoutMs: number): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error('serve did not become ready in budget');
    try {
      const { status } = await serveFetch('/api/session', password);
      if (status === 200) return Date.now() - started;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  line('╔════════════════════════════════════════════════════════════╗');
  line('║  VOXAURA LIVE CONSOLE HARNESS — real network / real APIs   ║');
  line('╚════════════════════════════════════════════════════════════╝');

  // ---- 0. Credentials from the encrypted vault (never printed) ----
  rule('0 · CREDENTIALS (encrypted vault)');
  const vault = new FileVault('vault/keyring.dat');
  const keyring = Keyring.load(vault);
  const fishKey = keyring.acquire('fish');
  const groqKey = keyring.acquire('groq');
  ok(`fish pool: 1 key acquired (${fishKey.material.byteLength} bytes, redacted)`);
  ok(`groq pool: 1 key acquired (${groqKey.material.byteLength} bytes, redacted)`);
  const fishSecret = Buffer.from(fishKey.material).toString('utf8');
  const groqSecret = Buffer.from(groqKey.material).toString('utf8');
  keyring.release(fishKey, true);
  keyring.release(groqKey, true);

  // ---- 1. Live OpenCode serve (Basic auth) ----
  rule('1 · LIVE OPencode SERVE');
  const servePassword = `voxaura-live-${Date.now().toString(36)}`;
  const child = spawnServe(servePassword);
  let serveBootMs = -1;
  let sessions: DiscoveredSession[] = [];
  try {
    serveBootMs = await waitForServe(servePassword, 20_000);
    ok(`serve ready on 127.0.0.1:${SERVE_PORT} in ${serveBootMs} ms (password redacted)`);
    const list = await serveFetch('/api/session', servePassword);
    sessions = extractSessions(list.json);
    ok(`/api/session → HTTP ${list.status}, ${sessions.length} session(s) discovered`);
    const agentList = await serveFetch('/api/agent', servePassword);
    const agents = (agentList.json as { data?: unknown[] })?.data ?? [];
    info(`/api/agent → HTTP ${agentList.status}, ${agents.length} agent(s) available`);
  } catch (err) {
    warn(`serve boot/list failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // ---- 2. WS-4097 bridge (real UiServer + real WebSocket client) ----
  rule('2 · WS-4097 BRIDGE (hello / inventory / switchSession)');
  const bridgeToken = `bridge-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const server = new UiServer({ token: bridgeToken, contractVersion: CONTRACT_VERSION });
  const commands: Array<Record<string, unknown>> = [];
  server.onCommand = (cmd) => void commands.push(cmd as unknown as Record<string, unknown>);
  const boundPort = await server.start(BRIDGE_PORT);
  const t0 = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${boundPort}/v1/ui`, [UI_SUBPROTOCOL, bridgeToken]);
  const received: Record<string, unknown>[] = [];
  ws.addEventListener('message', (ev: MessageEvent) => {
    try {
      received.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    } catch {
      // ignore malformed
    }
  });
  const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hello timeout')), 5_000);
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (msg['type'] === 'hello') {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
  const handshakeMs = Date.now() - t0;
  ok(`connected + hello in ${handshakeMs} ms (contract ${String(hello['contractVersion'])}, pid ${String(hello['nodePid'])})`);

  server.publishInventory(
    sessions.length > 0
      ? sessions.map((s) => ({ sessionId: s.id, state: s.state ?? 'idle' }))
      : [{ sessionId: 'console-local', state: 'idle' }],
  );
  await new Promise((r) => setTimeout(r, 150));
  const inventory = received.find((m) => m['type'] === 'inventory');
  ok(`inventory frame received: ${Array.isArray(inventory?.['sessions']) ? (inventory!['sessions'] as unknown[]).length : 0} session(s)`);

  const target = sessions[0]?.id ?? 'console-local';
  ws.send(JSON.stringify({ id: 'cmd-switch-1', kind: 'switchSession', sessionId: target }));
  const ack = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ack timeout')), 5_000);
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (msg['type'] === 'ack' && msg['id'] === 'cmd-switch-1') {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
  ok(`switchSession("${target}") acked: ok=${String(ack['ok'])}; daemon recorded ${commands.length} command(s)`);
  ws.close();
  await server.close();

  // ---- 3. Fish Audio live synthesis ----
  rule('3 · FISH AUDIO TTS (live)');
  const tts = new FishHttpTransport(
    Keyring.fromKeys({ fish: [fishSecret], groq: [groqSecret] }),
  );
  const voice = VOICE_IDS['male-default'];
  info(`model ${TTS_MODEL} · voice ${voice.slice(0, 8)}… (reference redacted)`);

  // 3a. First-chunk TTFB — the real 800 ms budget metric (progressive path).
  const streamStart = Date.now();
  let firstChunkMs = -1;
  const parts: Uint8Array[] = [];
  try {
    for await (const chunk of tts.synthesizeStream(PHRASE, voice)) {
      if (firstChunkMs < 0) firstChunkMs = Date.now() - streamStart;
      parts.push(chunk);
    }
  } catch (err) {
    warn(`streaming synthesis failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  const totalMs = Date.now() - streamStart;
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const audio = new Uint8Array(total);
  {
    let offset = 0;
    for (const part of parts) {
      audio.set(part, offset);
      offset += part.byteLength;
    }
  }
  if (total > 0) {
    const dir = join(process.cwd(), 'artifacts');
    mkdirSync(dir, { recursive: true });
    const out = join(dir, 'live_voice_test.mp3');
    writeFileSync(out, audio);
    const size = statSync(out).size;
    const isMp3 =
      (audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) || // ID3
      (audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0); // MPEG frame sync
    ok(`saved ${out}`);
    ok(`bytes ${size} (>${10 * 1024} required: ${size > 10 * 1024 ? 'PASS' : 'FAIL'}) · mp3-header ${isMp3 ? 'PASS' : 'FAIL'}`);
    ok(`first-chunk TTFB ${firstChunkMs} ms (<800 budget: ${firstChunkMs >= 0 && firstChunkMs < 800 ? 'PASS' : 'over'})`);
    info(`full-buffer synthesis ${totalMs} ms (informational; budget applies to first chunk)`);
    try {
      const probe = spawn('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out,
      ], { windowsHide: true });
      let dur = '';
      probe.stdout?.on('data', (d: Buffer) => (dur += d.toString('utf8')));
      await new Promise<void>((r) => probe.on('exit', () => r()));
      ok(`duration ${Number.parseFloat(dur.trim()).toFixed(2)} s (ffprobe)`);
    } catch {
      info('ffprobe unavailable — duration not measured');
    }
    if (process.platform === 'win32') {
      spawn('powershell', ['-NoProfile', '-Command', `Start-Process '${out}'`], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      }).unref();
      ok('OS playback triggered (default player)');
    }
  }

  // ---- 4. Silero VAD + Groq Whisper round-trip ----
  rule('4 · VAD + STT (live)');
  try {
    const vad = await SileroVad.load('models/silero-vad.onnx');
    const silence = await vad.prob(new Float32Array(512));
    ok(`Silero VAD loaded; silent-window P(speech) = ${silence.toFixed(3)}`);
    await vad.dispose();
  } catch (err) {
    warn(`VAD failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  try {
    const whisper = new GroqWhisperClient(groqSecret);
    const pcm = new Uint8Array(16_000 * 2); // 1s of 16kHz silence
    const text = await whisper.transcribe({ index: 0, startsAtMs: 0, endsAtMs: 1000, bytes: pcm });
    ok(`Groq Whisper round-trip OK (real call); silent-input transcript length ${text.length}`);
  } catch (err) {
    warn(`Whisper failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  if (child.pid !== undefined) {
    killTree(child);
    info('live serve terminated (tree-kill)');
  }
  line();
  line('Harness complete.');
}

main().catch((err) => {
  console.error(`harness error: ${err instanceof Error ? err.message : 'unknown'}`);
  process.exitCode = 1;
});
