// Whiteboard asset generator (human-dev-branding skill).
// Deterministic seeded-jitter sketch math (roughness-1.2 equivalent):
// double-stroke boxes, hachure fills, hand arrows. Pure SVG output —
// no gradients, no filters, no scripts. Usage: node scripts/generate-whiteboard-assets.mjs
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = {
  canvas: '#ffffff',
  slate: '#0f172a',
  gray: '#475569',
  blue: '#2563eb',
  amber: '#d97706',
  green: '#16a766',
};
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const f1 = (n) => (Math.round(n * 10) / 10).toString();

// Sketchy rectangle: two jittered passes (roughness ~1.2).
function sketchRect(x, y, w, h, stroke, seed, width = 2.5) {
  let d = '';
  for (let pass = 0; pass < 2; pass += 1) {
    const rnd = mulberry32(seed + pass * 101);
    const j = () => (rnd() - 0.5) * 4;
    const p = [
      [x + j(), y + j()], [x + w + j(), y + j()],
      [x + w + j(), y + h + j()], [x + j(), y + h + j()],
    ];
    d += `M${f1(p[0][0])},${f1(p[0][1])}L${f1(p[1][0])},${f1(p[1][1])}L${f1(p[2][0])},${f1(p[2][1])}L${f1(p[3][0])},${f1(p[3][1])}Z`;
  }
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>`;
}

// Hachure fill inside an axis-aligned rect (45° marker strokes).
function hachure(x, y, w, h, stroke, seed, step = 9) {
  const rnd = mulberry32(seed);
  let d = '';
  for (let k = -h; k < w; k += step) {
    const x0 = x + Math.max(k, 0);
    const y0 = y + h + Math.min(k, 0);
    const x1 = x + Math.min(k + h, w);
    const y1 = y + h - (x1 - x0);
    if (x1 - x0 < 2) continue;
    const wob = () => (rnd() - 0.5) * 1.6;
    d += `M${f1(x0)},${f1(y0 + wob())}L${f1(x1)},${f1(y1 + wob())}`;
  }
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round"/>`;
}

// Hand arrow between two points (shaft + head).
function sketchArrow(x1, y1, x2, y2, stroke, seed) {
  const rnd = mulberry32(seed);
  const mx = (x1 + x2) / 2 + (rnd() - 0.5) * 6;
  const my = (y1 + y2) / 2 + (rnd() - 0.5) * 6;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const hl = 14;
  const a1 = ang + Math.PI * 0.82;
  const a2 = ang - Math.PI * 0.82;
  return `<path d="M${f1(x1)},${f1(y1)}L${f1(mx)},${f1(my)}L${f1(x2)},${f1(y2)}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round"/>`
    + `<path d="M${f1(x2)},${f1(y2)}L${f1(x2 + hl * Math.cos(a1))},${f1(y2 + hl * Math.sin(a1))}M${f1(x2)},${f1(y2)}L${f1(x2 + hl * Math.cos(a2))},${f1(y2 + hl * Math.sin(a2))}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round"/>`;
}

const text = (x, y, s, { size = 16, fill = C.slate, anchor = 'start', weight = 400, family = MONO } = {}) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="central" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}">${s}</text>`;

const CSS = `<style>.draw{stroke-dasharray:3200;stroke-dashoffset:3200;animation:draw 2.8s ease-out forwards}@keyframes draw{to{stroke-dashoffset:0}}.flow{stroke-dasharray:9 11;animation:flow 1.2s linear infinite}@keyframes flow{to{stroke-dashoffset:-40}}.blinkdot{animation:blinkdot 1.6s ease-in-out infinite}@keyframes blinkdot{0%,100%{opacity:1}50%{opacity:0.3}}</style>`;

function sketchCircle(x, y, r, stroke, seed, width = 2.5) {
  let d = '';
  for (let pass = 0; pass < 2; pass += 1) {
    const rnd = mulberry32(seed + pass * 57);
    const j = () => (rnd() - 0.5) * 3;
    d += `M${f1(x - r + j())},${f1(y + j())}a${r},${r} 0 1,0 ${f1(2 * r)},0a${r},${r} 0 1,0 ${f1(-2 * r)},0`;
  }
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>`;
}

function heroBanner() {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 320"><rect width="1200" height="320" fill="${C.canvas}"/>${CSS}`;
  s += `<path class="draw" d="M30,22 L1170,18 L1174,298 L26,302 Z" fill="none" stroke="${C.slate}" stroke-width="3" stroke-linecap="round"/>`;
  for (let i = 0; i < 5; i += 1) {
    const h = [70, 130, 190, 120, 60][i];
    const x = 110 + i * 34;
    s += sketchRect(x, 160 - h / 2, 20, h, C.blue, 900 + i * 11, 3);
  }
  s += text(340, 130, 'Voxaura', { size: 72, weight: 700, family: 'system-ui, -apple-system, sans-serif' });
  s += `<path class="draw" d="M344,168 C500,162 640,172 800,166" fill="none" stroke="${C.amber}" stroke-width="5" stroke-linecap="round"/>`;
  s += text(342, 208, 'ambient desktop companion over OpenCode v2', { size: 26, fill: C.gray, family: 'system-ui, -apple-system, sans-serif' });
  s += text(342, 248, 'Arabic intake · English coordination · FR-12 armed', { size: 20, fill: C.gray, family: 'system-ui, -apple-system, sans-serif' });
  s += text(1050, 290, 'v0.2.0', { size: 16, fill: C.gray, anchor: 'middle' });
  return `${s}</svg>`;
}

function ipcHandshake() {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 300"><rect width="900" height="300" fill="${C.canvas}"/>${CSS}`;
  s += text(450, 26, 'WS-4097 handshake · /v1/ui · voice-ui.v1', { size: 20, weight: 700, anchor: 'middle' });
  s += sketchRect(90, 56, 180, 44, C.blue, 1101);
  s += text(180, 79, 'Shell', { size: 17, weight: 700, anchor: 'middle' });
  s += sketchRect(630, 56, 180, 44, C.blue, 1102);
  s += text(720, 79, 'Daemon', { size: 17, weight: 700, anchor: 'middle' });
  const lx = [180, 720];
  lx.forEach((x, i) => {
    s += `<path d="M${x},110 L${x},268" fill="none" stroke="${C.gray}" stroke-width="2" stroke-dasharray="7 7"/>`;
    void i;
  });
  const msgs = [
    { y: 132, dir: 1, t: 'bearer subprotocol token' },
    { y: 160, dir: -1, t: 'hello {contract, pid, seq}' },
    { y: 188, dir: 1, t: 'command {id, kind}' },
    { y: 216, dir: -1, t: 'ack {id, ok, detail?}' },
    { y: 244, dir: -1, t: 'event {seq, id, state} …' },
  ];
  msgs.forEach((m, i) => {
    const x1 = m.dir === 1 ? 180 : 720;
    const x2 = m.dir === 1 ? 720 : 180;
    s += sketchArrow(x1, m.y, x2, m.y, C.slate, 1200 + i * 17);
    s += text(450, m.y - 13, m.t, { size: 13, fill: C.slate, anchor: 'middle' });
  });
  s += sketchRect(636, 258, 240, 30, C.amber, 1300, 2);
  s += text(756, 274, '?lastSeq= resume · shared seq', { size: 12, fill: C.amber, anchor: 'middle' });
  return `${s}</svg>`;
}

function queueLifecycle() {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 320"><rect width="900" height="320" fill="${C.canvas}"/>${CSS}`;
  s += text(450, 26, 'orchestrator queue lifecycle · FIFO + dedupe', { size: 20, weight: 700, anchor: 'middle' });
  s += sketchRect(40, 70, 150, 180, C.blue, 1401);
  s += text(115, 92, 'INBOX', { size: 16, weight: 700, anchor: 'middle' });
  s += text(115, 130, 'SSE /api/event', { size: 12, fill: C.gray, anchor: 'middle' });
  s += text(115, 155, 'event ids', { size: 12, fill: C.gray, anchor: 'middle' });
  s += sketchRect(250, 70, 220, 180, C.blue, 1402);
  s += text(360, 92, 'QUEUE (FIFO)', { size: 16, weight: 700, anchor: 'middle' });
  ['E-4 prompt', 'E-10 dispatch', 'E-11 control'].forEach((t, i) => {
    const y = 118 + i * 42;
    s += sketchRect(266, y, 188, 32, C.slate, 1450 + i * 7, 2);
    s += text(360, y + 17, t, { size: 13, anchor: 'middle' });
  });
  s += sketchArrow(190, 160, 250, 160, C.slate, 1500);
  s += sketchRect(530, 70, 150, 180, C.green, 1403);
  s += text(605, 92, 'WORKERS', { size: 16, weight: 700, anchor: 'middle', fill: C.green });
  ['w1 sessions', 'w2 prompts', 'w3 controls'].forEach((t, i) => {
    s += sketchCircle(605, 130 + i * 38, 15, C.green, 1520 + i * 13, 2.5);
    s += text(648, 130 + i * 38, t, { size: 12, fill: C.gray });
  });
  s += sketchArrow(470, 160, 530, 160, C.slate, 1501);
  s += sketchRect(720, 70, 140, 180, C.amber, 1404);
  s += text(790, 92, 'LEDGER', { size: 16, weight: 700, anchor: 'middle', fill: C.amber });
  s += text(790, 130, 'receipts', { size: 12, fill: C.gray, anchor: 'middle' });
  s += text(790, 155, 'msg_… / ack', { size: 12, fill: C.gray, anchor: 'middle' });
  s += text(790, 180, 'commit SHA', { size: 12, fill: C.gray, anchor: 'middle' });
  s += sketchArrow(680, 160, 720, 160, C.slate, 1502);
  s += text(450, 292, '409 SESSION_BUSY → backoff requeue · dup ids dropped · n ≤ workers', { size: 13, fill: C.amber, anchor: 'middle' });
  return `${s}</svg>`;
}

function tauriBridge() {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 300"><rect width="900" height="300" fill="${C.canvas}"/>${CSS}`;
  s += text(450, 26, 'tauri shell bridge · rust backend ↔ react webview', { size: 20, weight: 700, anchor: 'middle' });
  s += sketchRect(50, 60, 300, 160, C.blue, 1601, 3);
  s += text(200, 88, 'Rust backend', { size: 17, weight: 700, anchor: 'middle' });
  s += text(200, 120, 'window · tray · hotkeys', { size: 13, fill: C.gray, anchor: 'middle' });
  s += text(200, 145, 'window_subsystem windows', { size: 13, fill: C.gray, anchor: 'middle' });
  s += text(200, 170, 'no serve ownership', { size: 13, fill: C.amber, anchor: 'middle' });
  s += sketchRect(550, 60, 300, 160, C.blue, 1602, 3);
  s += text(700, 88, 'React webview', { size: 17, weight: 700, anchor: 'middle' });
  s += text(700, 120, 'matrix · portals · chips', { size: 13, fill: C.gray, anchor: 'middle' });
  s += text(700, 145, 'no Node · UI only', { size: 13, fill: C.gray, anchor: 'middle' });
  s += text(700, 170, 'sandboxed renderer', { size: 13, fill: C.amber, anchor: 'middle' });
  s += sketchArrow(350, 120, 550, 120, C.slate, 1610);
  s += sketchArrow(550, 165, 350, 165, C.slate, 1611);
  s += text(450, 105, 'invoke', { size: 13, fill: C.green, anchor: 'middle', weight: 700 });
  s += text(450, 188, 'events', { size: 13, fill: C.green, anchor: 'middle', weight: 700 });
  s += text(450, 262, 'single supervisor: node owns opencode serve', { size: 13, fill: C.gray, anchor: 'middle' });
  return `${s}</svg>`;
}

function vaultCrypto() {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 300"><rect width="900" height="300" fill="${C.canvas}"/>${CSS}`;
  s += text(450, 26, 'zero-secret vault · AES-256-GCM · scrypt KDF', { size: 20, weight: 700, anchor: 'middle' });
  const steps = [
    { x: 30, t: 'ENV POOLS', s: 'comma keys once' },
    { x: 245, t: 'scrypt KDF', s: 'machine.key 0600' },
    { x: 460, t: 'AES-256-GCM', s: 'nonce · ct · sum' },
    { x: 675, t: 'KEYRING', s: 'ephemeral · zeroed' },
  ];
  steps.forEach((b, i) => {
    s += sketchRect(b.x, 70, 195, 130, i === 3 ? C.green : C.blue, 1700 + i * 41, 2.5);
    s += text(b.x + 97, 108, b.t, { size: 16, weight: 700, anchor: 'middle' });
    s += text(b.x + 97, 138, b.s, { size: 12, fill: C.gray, anchor: 'middle' });
    s += text(b.x + 97, 162, b.x === 30 ? 'then unset env' : b.x === 245 ? '~/.opencode-voice' : b.x === 460 ? 'checksum-then-decrypt' : 'release → wipe', { size: 12, fill: C.gray, anchor: 'middle' });
    if (i < 3) s += sketchArrow(b.x + 195, 135, b.x + 220, 135, C.slate, 1750 + i * 19);
  });
  s += sketchRect(255, 232, 390, 34, C.amber, 1790, 2);
  s += text(450, 250, 'safeStorage preferred when present · values never printed', { size: 13, fill: C.amber, anchor: 'middle' });
  return `${s}</svg>`;
}

function e2eHarness() {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 260"><rect width="900" height="260" fill="${C.canvas}"/>${CSS}`;
  s += text(450, 26, 'e2e verification pipeline', { size: 20, weight: 700, anchor: 'middle' });
  const steps = [
    { x: 40, t: 'doctor', s: 'env + health' },
    { x: 260, t: 'test:vantrilex', s: '211 green' },
    { x: 480, t: 'test:e2e', s: '8/8 green' },
    { x: 700, t: 'ledger', s: 'checkpoint' },
  ];
  steps.forEach((b, i) => {
    s += sketchRect(b.x, 70, 160, 110, C.blue, 1800 + i * 23, 2.5);
    s += text(b.x + 80, 108, b.t, { size: 16, weight: 700, anchor: 'middle' });
    s += text(b.x + 80, 134, b.s, { size: 13, fill: C.green, anchor: 'middle' });
    s += text(b.x + 80, 158, '✓', { size: 20, fill: C.green, anchor: 'middle' });
    if (i < 3) s += sketchArrow(b.x + 160, 125, b.x + 200, 125, C.slate, 1850 + i * 11);
  });
  s += text(450, 224, 'exit 0 required · red refuses the commit', { size: 13, fill: C.amber, anchor: 'middle' });
  return `${s}</svg>`;
}

function memoryManager() {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 300"><rect width="900" height="300" fill="${C.canvas}"/>${CSS}`;
  s += text(450, 26, 'context memory manager · vault notes + server compact', { size: 20, weight: 700, anchor: 'middle' });
  s += sketchRect(40, 70, 230, 160, C.blue, 1901, 2.5);
  s += text(155, 92, 'SESSION EVENTS', { size: 15, weight: 700, anchor: 'middle' });
  for (let i = 0; i < 4; i += 1) {
    s += sketchRect(60, 112 + i * 28, 120, 20, C.gray, 1920 + i * 5, 1.5);
  }
  s += `<path d="M192,106 L206,106 L206,202 L192,202" fill="none" stroke="${C.amber}" stroke-width="2.5"/>`;
  s += text(246, 160, 'working', { size: 12, fill: C.amber, anchor: 'middle' });
  s += text(246, 178, 'window', { size: 12, fill: C.amber, anchor: 'middle' });
  s += sketchArrow(270, 150, 330, 150, C.slate, 1950);
  s += sketchRect(330, 70, 260, 160, C.green, 1902, 2.5);
  s += text(460, 92, 'VAULT NOTES', { size: 15, weight: 700, anchor: 'middle', fill: C.green });
  ['03-active-state', '04-decisions-log', '05-sessions', '06-skills-used'].forEach((t, i) => {
    s += text(460, 122 + i * 26, t, { size: 13, anchor: 'middle' });
  });
  s += sketchArrow(590, 150, 650, 150, C.slate, 1951);
  s += sketchRect(650, 70, 210, 160, C.blue, 1903, 2.5);
  s += text(755, 92, 'MOC INDEX', { size: 15, weight: 700, anchor: 'middle' });
  s += text(755, 125, 'scoped retrieval', { size: 12, fill: C.gray, anchor: 'middle' });
  s += text(755, 150, 'server /compact', { size: 12, fill: C.gray, anchor: 'middle' });
  s += text(755, 175, 'for long runs', { size: 12, fill: C.gray, anchor: 'middle' });
  s += text(450, 272, 'one fact per section · link, do not duplicate · never store secrets', { size: 13, fill: C.gray, anchor: 'middle' });
  return `${s}</svg>`;
}

function cliTree() {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 340"><rect width="900" height="340" fill="${C.canvas}"/>${CSS}`;
  s += text(450, 26, 'cli command tree · opencode-voice', { size: 20, weight: 700, anchor: 'middle' });
  s += sketchRect(370, 52, 160, 48, C.slate, 2001, 3);
  s += text(450, 77, 'opencode-voice', { size: 17, weight: 700, anchor: 'middle' });
  const cmds = [
    { x: 30, t: 'doctor', s: 'env presence + serve health', e: 'exit 0/1' },
    { x: 255, t: 'vault bootstrap', s: 'env pools → keyring.dat', e: 'then unset env' },
    { x: 480, t: 'live', s: 'TTS→STT→brain→TTS', e: 'latency JSON' },
    { x: 705, t: '(serve: opencode)', s: 'port 4096 · Basic', e: 'not our CLI' },
  ];
  cmds.forEach((b, i) => {
    const cx = [180, 405, 630, 810][i];
    s += `<path d="M450,100 L${cx},130" fill="none" stroke="${C.gray}" stroke-width="2"/>`;
    s += sketchRect(b.x, 130, 165, 110, C.blue, 2020 + i * 31, 2.5);
    s += text(b.x + 82, 158, b.t, { size: 15, weight: 700, anchor: 'middle' });
    s += text(b.x + 82, 186, b.s, { size: 12, fill: C.gray, anchor: 'middle' });
    s += text(b.x + 82, 210, b.e, { size: 12, fill: C.green, anchor: 'middle' });
  });
  s += sketchRect(180, 268, 540, 40, C.amber, 2090, 2);
  s += text(450, 289, 'OPENCODE_SERVER_PASSWORD · *_API_KEYS · VOXAURA_VAULT_DIR', { size: 13, fill: C.amber, anchor: 'middle' });
  return `${s}</svg>`;
}

function stateMachine() {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 300"><rect width="900" height="300" fill="${C.canvas}"/>${CSS}`;
  s += text(450, 26, 'session lifecycle · finite-state machine', { size: 20, weight: 700, anchor: 'middle' });
  const main = [
    { x: 40, t: 'creating' }, { x: 250, t: 'running' }, { x: 460, t: 'idle' }, { x: 670, t: 'complete' },
  ];
  main.forEach((b, i) => {
    s += sketchRect(b.x, 70, 170, 60, i === 3 ? C.green : C.blue, 2100 + i * 43, 2.5);
    s += text(b.x + 85, 101, b.t, { size: 16, weight: 700, anchor: 'middle' });
    if (i < 3) s += sketchArrow(b.x + 170, 100, b.x + 210, 100, C.slate, 2150 + i * 9);
  });
  s += text(175, 88, 'prompt', { size: 12, fill: C.gray, anchor: 'middle' });
  s += text(385, 88, 'drain', { size: 12, fill: C.gray, anchor: 'middle' });
  s += text(595, 88, 'done', { size: 12, fill: C.gray, anchor: 'middle' });
  s += sketchRect(250, 180, 170, 60, C.amber, 2200, 2.5);
  s += text(335, 211, 'awaiting-approval', { size: 15, weight: 700, anchor: 'middle', fill: C.amber });
  s += sketchArrow(300, 130, 300, 180, C.slate, 2210);
  s += sketchArrow(370, 180, 370, 130, C.slate, 2211);
  s += text(252, 158, 'FR-12', { size: 12, fill: C.amber, anchor: 'middle' });
  s += sketchRect(460, 180, 170, 60, C.gray, 2220, 2);
  s += text(545, 211, 'error', { size: 15, weight: 700, anchor: 'middle' });
  s += sketchRect(660, 180, 170, 60, C.gray, 2221, 2);
  s += text(745, 211, 'aborted', { size: 15, weight: 700, anchor: 'middle' });
  s += sketchArrow(505, 130, 480, 180, C.slate, 2230);
  s += sketchArrow(640, 130, 700, 180, C.slate, 2231);
  s += text(450, 278, 'fail-closed: 404 halt · 409 requeue · 401 halt-all', { size: 13, fill: C.gray, anchor: 'middle' });
  return `${s}</svg>`;
}

function footerSketch() {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 160"><rect width="1200" height="160" fill="${C.canvas}"/>${CSS}`;
  s += `<path class="draw" d="M60,50 C300,42 500,58 700,50 S1000,44 1140,52" fill="none" stroke="${C.slate}" stroke-width="3" stroke-linecap="round"/>`;
  s += text(600, 92, 'Voxaura · MIT © 2026 Omar Baha', { size: 20, weight: 700, anchor: 'middle' });
  s += text(600, 122, 'CONTRIBUTING.md · gates green · conventional commits · FR-12 always', { size: 15, fill: C.gray, anchor: 'middle' });
  return `${s}</svg>`;
}

function architectureFlow() {
  const boxes = [
    { x: 40, label: 'CLI Engine', sub: 'doctor · vault · live' },
    { x: 255, label: 'WS-4097 Gateway', sub: 'hello · inv · ack' },
    { x: 470, label: 'Orchestrator', sub: 'queue · 409 retry' },
    { x: 685, label: 'Client Shell', sub: 'serve 2.0.12 · 204' },
  ];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 220"><rect width="900" height="220" fill="${C.canvas}"/>`;
  s += text(450, 26, 'control-plane pipeline', { size: 20, weight: 700, anchor: 'middle' });
  boxes.forEach((b, i) => {
    s += sketchRect(b.x, 60, 175, 110, C.blue, 1000 + i * 77);
    s += text(b.x + 87, 104, b.label, { size: 17, weight: 700, anchor: 'middle' });
    s += text(b.x + 87, 132, b.sub, { size: 13, fill: C.gray, anchor: 'middle' });
    if (i < 3) {
      s += sketchArrow(b.x + 175, 115, b.x + 215, 115, C.slate, 2000 + i * 33);
      s += text(b.x + 195, 88, ['IPC', 'JSON-RPC', 'SSE'][i], { size: 13, fill: C.amber, anchor: 'middle', weight: 700 });
    }
  });
  s += text(450, 198, 'Basic auth · {data} envelopes · ?lastSeq= resume', { size: 13, fill: C.gray, anchor: 'middle' });
  return `${s}</svg>`;
}

function benchmarkMatrix() {
  const rows = [
    { label: 'Code Generation', sub: 'Pass@1', v: 94.8, b: 81.2, d: '+13.6%' },
    { label: 'Tool Calling', sub: 'Precision', v: 99.1, b: 88.4, d: '+10.7%' },
    { label: 'Zero-Hallucination', sub: 'Rate', v: 98.6, b: 84.0, d: '+14.6%' },
    { label: 'Latency', sub: 'TTFT · lower wins', v: 180, vb: 450, ms: true, d: '2.5x faster' },
    { label: 'E2E Resolution', sub: 'Multi-step', v: 91.4, b: 76.5, d: '+14.9%' },
  ];
  const X = 270, MAXW = 300, RH = 46, Y0 = 84;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 380"><rect width="900" height="380" fill="${C.canvas}"/>`;
  s += text(450, 28, 'model accuracy &amp; response benchmarks', { size: 21, weight: 700, anchor: 'middle' });
  s += text(24, 60, 'CAPABILITY', { size: 13, fill: C.gray, weight: 700 });
  s += text(X, 60, 'ENGINE vs BASELINE', { size: 13, fill: C.gray, weight: 700 });
  s += text(812, 60, 'DELTA', { size: 13, fill: C.gray, weight: 700, anchor: 'middle' });
  rows.forEach((r, i) => {
    const y = Y0 + i * (RH + 8);
    s += sketchRect(14, y, 872, RH + 2, C.gray, 3000 + i * 55, 1.5);
    s += text(26, y + 17, r.label, { size: 16, weight: 700 });
    s += text(26, y + 36, r.sub, { size: 12, fill: C.gray });
    const vw = r.ms ? (r.v / r.vb) * MAXW : (r.v / 100) * MAXW;
    const bw = r.ms ? MAXW : (r.b / 100) * MAXW;
    s += sketchRect(X, y + 8, vw, 13, C.blue, 4000 + i * 91, 2);
    s += hachure(X + 3, y + 11, vw - 6, 7, C.blue, 5000 + i * 47);
    s += sketchRect(X, y + 27, bw, 8, C.gray, 6000 + i * 29, 1.5);
    const vs = r.ms ? `${r.v} ms` : `${r.v.toFixed(1)}%`;
    const bs = r.ms ? `${r.vb} ms` : `${r.b.toFixed(1)}%`;
    s += text(X + vw + 10, y + 15, vs, { size: 15, weight: 700, fill: C.blue });
    s += text(X + bw + 10, y + 32, bs, { size: 12, fill: C.gray });
    s += sketchRect(742, y + 7, 134, 34, C.amber, 7000 + i * 13, 2);
    s += text(809, y + 25, r.d, { size: 14, weight: 700, fill: C.green, anchor: 'middle' });
  });
  return `${s}</svg>`;
}

writeFileSync(join(root, 'assets', 'hero-banner.svg'), `${heroBanner()}\n`);
writeFileSync(join(root, 'assets', 'architecture-flow.svg'), `${architectureFlow()}\n`);
writeFileSync(join(root, 'assets', 'benchmark-matrix.svg'), `${benchmarkMatrix()}\n`);
writeFileSync(join(root, 'assets', 'ipc-protocol-handshake.svg'), `${ipcHandshake()}\n`);
writeFileSync(join(root, 'assets', 'orchestrator-queue-lifecycle.svg'), `${queueLifecycle()}\n`);
writeFileSync(join(root, 'assets', 'desktop-tauri-bridge.svg'), `${tauriBridge()}\n`);
writeFileSync(join(root, 'assets', 'vault-crypto-flow.svg'), `${vaultCrypto()}\n`);
writeFileSync(join(root, 'assets', 'e2e-test-harness.svg'), `${e2eHarness()}\n`);
writeFileSync(join(root, 'assets', 'context-memory-manager.svg'), `${memoryManager()}\n`);
writeFileSync(join(root, 'assets', 'cli-command-tree.svg'), `${cliTree()}\n`);
writeFileSync(join(root, 'assets', 'system-state-machine.svg'), `${stateMachine()}\n`);
writeFileSync(join(root, 'assets', 'footer-sketch.svg'), `${footerSketch()}\n`);
console.log('whiteboard assets generated: 12 SVGs');
