import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Self-bootstrapping Obsidian memory vault (installer-ready portability).
// No hardcoded absolute paths: the vault root resolves from an explicit base,
// VOXAURA_VAULT_DIR, or <cwd>/vault. Missing structures are scaffolded with
// default templates on first use; existing files are never overwritten.
export const VAULT_NOTES = [
  '01-overview.md',
  '02-architecture.md',
  '03-active-state.md',
  '04-decisions-log.md',
  '05-sessions-history.md',
  '06-skills-used.md',
] as const;

export type VaultNote = (typeof VAULT_NOTES)[number];

export function resolveVaultRoot(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env['VOXAURA_VAULT_DIR'];
  if (typeof override === 'string' && override.length > 0) return override;
  return join(cwd, 'vault');
}

function template(note: VaultNote, project: string): string {
  const titles: Record<VaultNote, string> = {
    '01-overview.md': `# ${project} — overview`,
    '02-architecture.md': `# ${project} — architecture`,
    '03-active-state.md': `# ${project} — active state`,
    '04-decisions-log.md': `# ${project} — decisions log`,
    '05-sessions-history.md': `# ${project} — sessions history`,
    '06-skills-used.md': `# ${project} — skills used`,
  };
  return `${titles[note]}\n\n> Scaffolded by ensureVault. One fact per section; link, do not duplicate.\n`;
}

function mocTemplate(project: string): string {
  const links = VAULT_NOTES.map((n) => `- [[projects/${project}/${n.replace(/\.md$/, '')}]]`).join('\n');
  return `# MOC — master map of content\n\n## ${project}\n\n${links}\n`;
}

export interface VaultScaffold {
  readonly root: string;
  readonly created: readonly string[];
}

export function ensureVault(project: string, base?: string): VaultScaffold {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(project)) {
    throw new Error(`invalid vault project name: ${project}`);
  }
  const root = base ?? resolveVaultRoot();
  const created: string[] = [];
  const write = (path: string, content: string): void => {
    if (existsSync(path)) return;
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
    created.push(path);
  };
  for (const note of VAULT_NOTES) {
    write(join(root, 'projects', project, note), template(note, project));
  }
  write(join(root, 'indexes', 'MOC-master.md'), mocTemplate(project));
  return { root, created };
}
