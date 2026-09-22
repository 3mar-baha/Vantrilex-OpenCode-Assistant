import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// GuildSkills resolver — docs/17 §17.5. Fetches the open catalog, scores entries
// with the §17.2.2 weights, and writes one tool--SKILL.md contract per ingested tool.
export interface GuildSkillEntry {
  readonly id: string;
  readonly name: string;
  readonly repoCase: readonly string[];
  readonly milestone: readonly string[];
  readonly defaultSelected?: boolean;
}

export interface ResolvedSkill extends GuildSkillEntry {
  readonly score: number;
  readonly reasons: string[];
}

export function scoreGuildSkill(
  entry: GuildSkillEntry,
  context: { repoCase: string; milestone: string; denied: readonly string[] },
): ResolvedSkill {
  if (context.denied.includes(entry.id)) {
    return { ...entry, score: Number.NEGATIVE_INFINITY, reasons: ['operator deny-list veto'] };
  }
  let score = 0;
  const reasons: string[] = [];
  if (entry.repoCase.includes(context.repoCase)) {
    score += 3;
    reasons.push(`repo Case match (+3): ${context.repoCase}`);
  }
  if (entry.milestone.includes(context.milestone)) {
    score += 2;
    reasons.push(`milestone need (+2): ${context.milestone}`);
  }
  if (entry.defaultSelected === true) {
    score += 1;
    reasons.push('catalog default-selected (+1)');
  }
  return { ...entry, score, reasons };
}

export function renderToolSkillContract(entry: GuildSkillEntry): string {
  return [
    `# tool--${entry.id} — invocation contract`,
    '',
    `Tool: ${entry.name} (${entry.id}).`,
    '',
    '## Invocation',
    '- Inputs, outputs, and idempotency guarantees are defined by the provider docs;',
    '  this contract records the project-local usage binding.',
    '',
    '## Best practices',
    '- Validate outputs against zod schemas before acting on them.',
    '- Never pass secrets except through the keyring acquire/release path.',
    '',
    '## Edge cases',
    '- Provider 429/5xx → forced keyring advance + jittered retry (max 3).',
    '- Schema-invalid output → fallback path, never raw passthrough.',
    '',
  ].join('\n');
}

export async function resolveGuildSkills(
  catalogUrl: string,
  context: { repoCase: string; milestone: string; denied: readonly string[] },
  skillsDir: string,
): Promise<ResolvedSkill[]> {
  const res = await fetch(catalogUrl);
  if (!res.ok) throw new Error(`guildskills catalog fetch failed: HTTP ${res.status}`);
  const catalog = (await res.json()) as { skills?: GuildSkillEntry[] };
  const entries = Array.isArray(catalog.skills) ? catalog.skills : [];
  const resolved = entries.map((e) => scoreGuildSkill(e, context)).filter((r) => r.score >= 2);
  mkdirSync(skillsDir, { recursive: true });
  for (const skill of resolved) {
    writeFileSync(join(skillsDir, `tool--${skill.id}.md`), renderToolSkillContract(skill));
  }
  return resolved;
}
