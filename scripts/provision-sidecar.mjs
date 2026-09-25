#!/usr/bin/env node
// Provision the bundled sidecar so a fresh Windows install needs ZERO
// prerequisites (no Node, no npm, no repo checkout) beyond entering API keys.
//
//   node scripts/provision-sidecar.mjs
//
// Output: apps/desktop/src-tauri/sidecar/
//   node.exe            system Node binary, copied
//   dist/               compiled daemon (served by `node dist/cli.js serve`)
//   package.json        ONLY the runtime deps the serve path imports
//   node_modules/       installed from that minimal manifest
//
// The sidecar is gitignored (large binaries) and declared as a Tauri bundle
// resource, so it rides inside the NSIS installer.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sidecar = join(root, 'apps', 'desktop', 'src-tauri', 'sidecar');
const distSrc = join(root, 'dist');

if (!existsSync(join(distSrc, 'cli.js'))) {
  console.error('missing dist/cli.js — run `npm run build` first');
  process.exit(1);
}

console.log('[sidecar] assembling ' + sidecar);
rmSync(sidecar, { recursive: true, force: true });
mkdirSync(sidecar, { recursive: true });

// 1. Node runtime (the exact binary running this script).
const nodeExe = process.execPath;
cpSync(nodeExe, join(sidecar, 'node.exe'));
console.log('[sidecar] node.exe <- ' + nodeExe);

// 2. Compiled daemon.
cpSync(distSrc, join(sidecar, 'dist'), { recursive: true });
console.log('[sidecar] dist/ copied');

// 3. Minimal dependency manifest — only what the `serve` path imports at
//    runtime (not the ML/voice-heavy optional paths).
const manifest = {
  name: 'voxaura-sidecar',
  private: true,
  version: '0.2.0',
  type: 'module',
  dependencies: {
    'groq-sdk': '^0.9.0',
    'eventsource': '^3.0.0',
    'lru-cache': '^11.0.0',
    'pino': '^9.0.0',
    'zod': '^3.23.0',
  },
};
writeFileSync(join(sidecar, 'package.json'), JSON.stringify(manifest, null, 2));
console.log('[sidecar] installing runtime deps (pruned manifest)');
execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: sidecar,
  stdio: 'inherit',
  shell: true,
});

console.log('[sidecar] done. Contents:');
console.log(execFileSync('powershell', ['-NoProfile', '-Command',
  `Get-ChildItem -Force '${sidecar}' | Select-Object Name, Length | Format-Table -AutoSize | Out-String`],
  { encoding: 'utf8' }));
console.log('[sidecar] total size:');
console.log(execFileSync('powershell', ['-NoProfile', '-Command',
  `'{0:N1} MB' -f ((Get-ChildItem -Recurse -File -Force '${sidecar}' | Measure-Object -Property Length -Sum).Sum / 1MB)`],
  { encoding: 'utf8' }));