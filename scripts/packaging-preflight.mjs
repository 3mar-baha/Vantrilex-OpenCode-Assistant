// Packaging preflight — verifies apps/desktop is build-ready for Tauri bundles.
// Read-only: reports a readiness matrix; does not build.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const desktop = join(root, 'apps', 'desktop');

function which(cmd) {
  try {
    const out = execFileSync('where.exe', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? null;
  } catch {
    return null;
  }
}
function pathExists(p) {
  try {
    const st = statSync(p);
    return st.isDirectory() ? existsSync(p) : st.size > 0;
  } catch {
    return false;
  }
}

const rows = [];
const add = (name, ok, detail) => rows.push({ name, ok, detail });

// Runtimes
add('node ≥22', which('node') !== null, which('node') ?? 'missing');
add('npm', which('npm') !== null, which('npm') ?? 'missing');
add('rustc', which('rustc') !== null, which('rustc') ?? 'missing');
add('cargo', which('cargo') !== null, which('cargo') ?? 'missing');
const msvc = which('cl') ?? which('link');
add('MSVC linker (cl/link)', msvc !== null, msvc ?? 'missing — install VS Build Tools');
add('NSIS makensis', which('makensis') !== null || pathExists('C:\\Program Files (x86)\\NSIS\\makensis.exe'),
  which('makensis') ?? 'C:\\Program Files (x86)\\NSIS\\makensis.exe');

// Desktop project readiness
add('apps/desktop/package.json', pathExists(join(desktop, 'package.json')), '');
add('renderer deps installed', pathExists(join(desktop, 'node_modules', 'vite')), '');
add('tauri CLI dep', pathExists(join(desktop, 'node_modules', '@tauri-apps', 'cli')), '');
add('tauri.conf.json parses', (() => {
  try {
    JSON.parse(readFileSync(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    return true;
  } catch {
    return false;
  }
})(), '');
add('capabilities/default.json', pathExists(join(desktop, 'src-tauri', 'capabilities', 'default.json')), '');
add('Cargo.toml + Cargo.lock', pathExists(join(desktop, 'src-tauri', 'Cargo.toml')) && pathExists(join(desktop, 'src-tauri', 'Cargo.lock')), '');
add('icons (icon.ico)', pathExists(join(desktop, 'src-tauri', 'icons', 'icon.ico')), '');
add('icons (icon.icns)', pathExists(join(desktop, 'src-tauri', 'icons', 'icon.icns')), '');
add('frontend dist built', pathExists(join(desktop, 'dist', 'index.html')), '');

console.log('Voxaura packaging preflight');
console.log('='.repeat(52));
let ready = 0;
for (const r of rows) {
  if (r.ok) ready += 1;
  const mark = r.ok ? 'PASS' : 'MISS';
  console.log(`${mark}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log('='.repeat(52));
console.log(`${ready}/${rows.length} checks pass`);
const canBuildWindows = rows.find((r) => r.name.startsWith('MSVC'))?.ok === true;
console.log(`Windows bundle (NSIS): ${canBuildWindows ? 'READY' : 'BLOCKED — needs MSVC linker (cl/link)'}`);
console.log(`Linux bundle (AppImage/deb): ${process.platform === 'linux' ? 'READY' : 'requires Linux/Docker runner'}`);
