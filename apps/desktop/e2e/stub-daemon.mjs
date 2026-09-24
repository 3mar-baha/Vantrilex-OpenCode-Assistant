// E2E stub daemon — the REAL UiServer from root dist/, driven over HTTP.
// Lets Playwright assert the full loop: hello/version, events → matrix,
// commands ← action bar, socket death → degraded.
import http from 'node:http';
import { UiServer } from '../../../dist/ipc/ui-server.js';

const token = process.env['VOICE_RUNTIME_IPC_TOKEN'] ?? 'e2e-token';
let server = new UiServer({ token, contractVersion: '3.1.0' });
const received = [];
server.onCommand = (cmd) => {
  received.push(cmd);
};

const CONTROL_PORT = 4197;
let seq = 0;

const control = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
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
  if (req.method === 'POST' && req.url === '/kill') {
    void server.close().then(() => send(200, { killed: true }));
    return;
  }
  if (req.method === 'POST' && req.url === '/revive') {
    server = new UiServer({ token, contractVersion: '3.1.0' });
    server.onCommand = (cmd) => {
      received.push(cmd);
    };
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
