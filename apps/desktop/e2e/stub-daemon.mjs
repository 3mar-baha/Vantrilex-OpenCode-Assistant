// E2E stub daemon — the REAL UiServer from root dist/, driven over HTTP.
// Lets Playwright assert the full loop: hello/version, events → matrix,
// commands ← action bar, socket death → degraded.
import http from 'node:http';
import { UiServer } from '../../../dist/ipc/ui-server.js';
import { createCommandHandler } from '../../../dist/orchestrator/command-router.js';

const token = process.env['VOICE_RUNTIME_IPC_TOKEN'] ?? 'e2e-token';
let server = new UiServer({ token, contractVersion: '3.1.0' });
const received = [];
const audioFrames = [];
const executedShells = [];
// Real FR-12 router with a recording fake ServeClient: destructive commands
// park until confirmed, exactly like production. Recording is preserved so
// existing specs keep passing.
const router = createCommandHandler({
  client: {
    setSessionAgent: async () => ({}),
    setSessionModel: async () => ({}),
    toggleSessionSkill: async () => ({}),
    execSessionShell: async (session, command) => {
      executedShells.push({ session, command });
      return {};
    },
  },
  switchSession: () => {},
  activeSessionId: () => 'ses_e2e',
  saveKeys: { saveKeys: async () => ({}) },
  // Phase 5 — ZERO CANNED REPLIES. In production the daemon asks the model to
  // write the confirmation line. The stub cannot call a model, so it stands in
  // with a representative MODEL-WRITTEN line. What the E2E spec proves is that
  // a supplied line reaches the HUD — and that it is not a canned template.
  onExecuted: (cmd, outcome) => {
    server.notice('assistant-said', narratorLineFor(cmd, outcome.ok), 'info');
  },
});

/** Stands in for the narrator's model output. */
function narratorLineFor(cmd, ok) {
  if (!ok) return 'ما قدرت أوصّل الطلب، خلّيني أعيد المحاولة';
  if (cmd.kind === 'deafen') return 'كتمت الميكروفون، وبقيت أسمعك عند اللزوم';
  if (cmd.kind === 'mute') return 'كتمت صوتي، خذ الإشعار بدل الكلام';
  if (cmd.kind === 'abort') return 'وقفت التوليد عند الحد';
  return 'عملت';
}
function wireServer(srv) {
  srv.onCommand = (cmd) => {
    received.push(cmd);
    return router(cmd);
  };
  srv.onAudio = (pcm) => {
    audioFrames.push(pcm.byteLength);
  };
}
wireServer(server);

const CONTROL_PORT = 4197;
let seq = 0;

const control = http.createServer((req, res) => {
  const send = (code, body) => {
    // In-page fetches from the vite origin need CORS; the stub is test-only.
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'POST' && req.url === '/fire') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const { state } = JSON.parse(raw);
      seq += 1;
      send(200, server.broadcast({ type: 'event', eventId: `e2e-${seq}`, state }));
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/commands') {
    send(200, received);
    return;
  }
  if (req.method === 'GET' && req.url === '/shells') {
    send(200, executedShells);
    return;
  }
  if (req.method === 'GET' && req.url === '/audio') {
    send(200, { frames: audioFrames.length, bytes: audioFrames.reduce((a, b) => a + b, 0) });
    return;
  }
  if (req.method === 'POST' && req.url === '/audio/reset') {
    audioFrames.length = 0;
    send(200, { reset: true });
    return;
  }
  if (req.method === 'POST' && req.url === '/audio-down') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const { bytes } = JSON.parse(raw);
      const chunks = server.broadcastAudio(Buffer.from(bytes));
      send(200, { chunks });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/notice') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const { code, detail, level } = JSON.parse(raw);
      send(200, { sent: server.notice(code, detail, level) });
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/voice') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const { phase, transcript } = JSON.parse(raw);
      send(200, { sent: server.voice(phase, transcript) });
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/inventory') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const { sessions } = JSON.parse(raw);
      send(200, server.publishInventory(sessions));
    });
    return;
  }  if (req.method === 'POST' && req.url === '/agents') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const { agents } = JSON.parse(raw);
      send(200, server.publishAgents(agents));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/kill') {
    void server.close().then(() => send(200, { killed: true }));
    return;
  }
  if (req.method === 'POST' && req.url === '/revive') {
    server = new UiServer({ token, contractVersion: '3.1.0' });
    wireServer(server);
    server.start(4097).then(
      () => send(200, { revived: true }),
      (err) => send(500, { error: String(err) }),
    );
    return;
  }
  send(404, { error: 'unknown' });
});

await server.start(4097);
await new Promise((resolve) => control.listen(CONTROL_PORT, '127.0.0.1', resolve));
console.log(`e2e stub daemon: ws=4097 control=${CONTROL_PORT}`);

