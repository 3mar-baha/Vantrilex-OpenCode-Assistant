import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ensureVault, resolveVaultRoot, VAULT_NOTES } from './vault.js';

// Self-bootstrapping Obsidian vault (portability invariant): missing
// structures are scaffolded with default templates, never throw on absent dirs.
describe('resolveVaultRoot', () => {
  test('VOXAURA_VAULT_DIR override wins; otherwise <cwd>/vault', () => {
    expect(resolveVaultRoot('/repo', { VOXAURA_VAULT_DIR: '/data/v' })).toBe('/data/v');
    expect(resolveVaultRoot('/repo', {})).toBe(join('/repo', 'vault'));
  });
});

describe('ensureVault', () => {
  test('scaffolds the six atomic notes plus the MOC with default templates', () => {
    const base = mkdtempSync(join(tmpdir(), 'vault-test-'));
    const result = ensureVault('voxaura', join(base, 'vault'));
    expect(result.created.length).toBeGreaterThanOrEqual(7);
    for (const note of VAULT_NOTES) {
      const p = join(base, 'vault', 'projects', 'voxaura', note);
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p, 'utf8')).toContain('# ');
    }
    const moc = join(base, 'vault', 'indexes', 'MOC-master.md');
    expect(existsSync(moc)).toBe(true);
    expect(readFileSync(moc, 'utf8')).toContain('voxaura');
  });

  test('idempotent: second run creates nothing and preserves edits', () => {
    const base = mkdtempSync(join(tmpdir(), 'vault-test-'));
    ensureVault('voxaura', join(base, 'vault'));
    const note = join(base, 'vault', 'projects', 'voxaura', '03-active-state.md');
    writeFileSync(note, '# edited\n', 'utf8');
    const second = ensureVault('voxaura', join(base, 'vault'));
    expect(second.created).toEqual([]);
    expect(readFileSync(note, 'utf8')).toBe('# edited\n');
  });

  test('rejects path-escaping project names', () => {
    const base = mkdtempSync(join(tmpdir(), 'vault-test-'));
    expect(() => ensureVault('../escape', join(base, 'vault'))).toThrow();
  });
});
