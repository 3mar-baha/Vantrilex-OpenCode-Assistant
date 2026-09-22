// Project disambiguation — docs/02 §2.3.1. Single active project: the name is
// omitted. Multiple concurrent projects: the name is embedded in the agent's own
// phrasing via the provided slot (the brain synthesizes the sentence, not a template).
export interface DisambiguationContext {
  readonly activeProjects: readonly string[];
  readonly currentProject: string;
}

export function projectSlot(ctx: DisambiguationContext): string {
  if (ctx.activeProjects.length <= 1) return '';
  return ctx.currentProject;
}

/** Prefix identity only when ambiguous; the TTS text carries the slot downstream. */
export function qualifyBriefing(text: string, ctx: DisambiguationContext): string {
  const slot = projectSlot(ctx);
  if (slot === '') return text;
  return `[${slot}] ${text}`;
}
