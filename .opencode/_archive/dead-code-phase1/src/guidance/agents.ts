import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// AGENTS.md project injection — docs/17, docs/01 FR-9. Project-local only;
// pre-authorization classes separate safe tasks from destructive ones (C11).
export type PreAuthClass = 'pre-approved' | 'hold-for-approval';

export interface AgentsInjection {
  readonly repoCase: 'greenfield' | 'legacy' | 'refresh';
  readonly preApproved: readonly string[];
  readonly heldForApproval: readonly string[];
  readonly overseerNote: string;
}

export function renderAgentsMd(injection: AgentsInjection): string {
  return [
    '# AGENTS.md — opencode-voice-runtime project guidance',
    '',
    `Project case: ${injection.repoCase}. Reasons, not rules: follow the intent below;`,
    'use peer-grade judgment everywhere except the hard boundaries marked [!].',
    '',
    '## Pre-authorized (safe, non-destructive)',
    ...injection.preApproved.map((t) => `- ${t}`),
    '',
    '## Hold for explicit approval [!]',
    ...injection.heldForApproval.map((t) => `- ${t} (two-way voice/text confirm, FR-12)`),
    '',
    '## Session overseer',
    injection.overseerNote,
    '',
    '## Hard boundaries [!]',
    '- Never write secrets to logs, ledger, or repo files (I-1..I-5).',
    '- Never execute destructive filesystem/VCS changes on ambiguous speech.',
    '- Ledger append precedes every side effect.',
    '',
  ].join('\n');
}

export function injectAgentsMd(repoDir: string, injection: AgentsInjection): string {
  const path = join(repoDir, 'AGENTS.md');
  writeFileSync(path, renderAgentsMd(injection));
  return path;
}
