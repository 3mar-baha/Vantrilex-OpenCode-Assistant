// GuildSkills ingestion stub — docs/17 §17.5. Full fetcher lands with guidance (P5);
// this stub defines the contract so P0 typechecks without network access.
export interface GuildSkillEntry {
  readonly id: string;
  readonly contractPath: string; // tool--SKILL.md accompanying the tool
}

export async function fetchGuildSkillsCatalog(_url: string): Promise<GuildSkillEntry[]> {
  void _url;
  throw new Error('GuildSkills ingestion not yet implemented (P5 milestone)');
}
