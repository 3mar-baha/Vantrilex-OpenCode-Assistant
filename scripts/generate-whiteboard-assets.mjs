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

writeFileSync(join(root, 'assets', 'architecture-flow.svg'), `${architectureFlow()}\n`);
writeFileSync(join(root, 'assets', 'benchmark-matrix.svg'), `${benchmarkMatrix()}\n`);
console.log('whiteboard assets generated: architecture-flow.svg, benchmark-matrix.svg');
