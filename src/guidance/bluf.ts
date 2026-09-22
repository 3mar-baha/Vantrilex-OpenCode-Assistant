// BLUF briefing builder — docs/02 §2.3.1, docs/18 prompt rules. Shapes meaning;
// the brain supplies the words. Failure shape: state → modules+count → logs saved
// → next step, ≤15 spoken seconds. Log excerpts capped at 40 spoken words (T4).
export const MAX_EXCERPT_WORDS = 40;
export const MAX_BLUF_LEAD_WORDS = 15;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

export function capExcerpt(text: string, maxWords: number = MAX_EXCERPT_WORDS): string {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.slice(0, maxWords).join(' ');
}

export interface BlufInput {
  readonly sessionLabel: string;
  readonly outcome: 'green' | 'red' | 'amber' | 'unknown';
  readonly changeClauses: readonly string[];
  readonly nextAction: string;
  readonly failure?: { readonly modules: readonly string[]; readonly failureCount: number; readonly logsSaved: boolean };
}

export function buildBluf(input: BlufInput): { lead: string; body: string } {
  const leadWords = `${input.sessionLabel} ${input.outcome}`.split(/\s+/);
  const lead = leadWords.slice(0, MAX_BLUF_LEAD_WORDS).join(' ');
  if (input.outcome === 'red' && input.failure !== undefined) {
    const f = input.failure;
    const body = [
      `failed in ${f.modules.join(', ')}: ${f.failureCount} failures.`,
      f.logsSaved ? 'Details saved to the log.' : 'Log capture incomplete — see console.',
      input.nextAction,
    ].join(' ');
    return { lead, body };
  }
  const body = [...input.changeClauses.slice(0, 3), input.nextAction].join(' ');
  return { lead, body };
}
