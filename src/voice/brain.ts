import Groq from 'groq-sdk';
import { z } from 'zod';
import { OrchestratorError } from '../common/errors.js';

// Cognitive brain — docs/18 §18.3, docs/06 §6.5. `openai/gpt-oss-120b` on Groq LPU,
// 2.0 s golden mark / 5.0 s hard abort, validated JSON output, high-stakes gate.
// Phrasing is synthesized by the model under the RAG-grounded system prompt;
// anchors in docs are illustrative, never templates.
export const BRAIN_GOLDEN_MS = 2000;
export const BRAIN_CEILING_MS = 5000;

export const BrainOutputSchema = z.object({
  intent: z.enum(['newSession', 'followUp', 'control']),
  control: z.enum(['approve', 'cancel', 'repeat', 'switchVoice', 'none']).default('none'),
  reply: z.string().min(1).max(1200),
  sessionDirective: z.string().optional(),
});
export type BrainOutput = z.infer<typeof BrainOutputSchema>;

const HIGH_STAKES_VERBS = ['destroy', 'delete', 'drop', 'force-push', 'force push', 'deploy', 'rm -rf', 'rm -rf '];

/** FR-12: ambiguous or explicit destructive language always requires confirmation. */
export function requiresConfirmation(text: string): boolean {
  const lowered = text.toLowerCase();
  return HIGH_STAKES_VERBS.some((verb) => lowered.includes(verb));
}

export const AMMANI_SYSTEM_PROMPT = [
  "You are the voice of the developer's ambient coding orchestrator — a peer, not a script.",
  'SYNTHESIZE every reply dynamically in your own authentic voice. Illustrative anchors define',
  'register and flavor ONLY; NEVER repeat them verbatim. Adapt phrasing, tone, and pacing to',
  'live context, outcome severity, and session specifics.',
  'Spoken output: everyday Ammani Jordanian Arabic software-engineering parlance.',
  'NEVER MSA newsreader prose, exaggerated Beiruti slang, or foreign regional dialects.',
  'Technical spans (code, paths, logs, error codes, sessions, commands) stay in technical English.',
  'Briefings: BLUF first — outcome + identity in ≤15 words, ≤3 change-clauses, one next action.',
  'Failures ≤15 seconds: state → modules + count → logs saved → next step.',
  'Destructive verbs: ALWAYS require explicit two-way confirmation. Ambiguous: ask, never act.',
  'Retry loops: silent intermediates; heartbeat every 5 min or 3 fails; halt at 5, ask for guidance.',
  'Classify intent: newSession | followUp | control. Reply ONLY with the JSON shape. No prose outside JSON.',
].join('\n');

/** Extract the first top-level JSON object (fences/prose tolerated, never trusted). */
export function extractJson(content: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const candidate = (fenced?.[1] ?? content).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export interface BrainClient {
  respond(transcript: string, sessionContext: string): Promise<{ output: BrainOutput; elapsedMs: number; goldenBreached: boolean }>;
}

export class GroqBrainClient implements BrainClient {
  private readonly client: Groq;

  constructor(apiKey: string) {
    this.client = new Groq({ apiKey });
  }

  async respond(transcript: string, sessionContext: string): Promise<{ output: BrainOutput; elapsedMs: number; goldenBreached: boolean }> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BRAIN_CEILING_MS);
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: 'openai/gpt-oss-120b',
          messages: [
            { role: 'system', content: AMMANI_SYSTEM_PROMPT },
            { role: 'user', content: `Context: ${sessionContext}\nDeveloper said: ${transcript}` },
          ],
          temperature: 0.4,
          max_tokens: 300,
          stream: false,
        },
        { signal: controller.signal },
      );
      const elapsedMs = Date.now() - started;
      const content = completion.choices[0]?.message?.content ?? '';
      const parsedJson = extractJson(content);
      if (parsedJson === null) {
        throw new OrchestratorError('BRAIN_TIMEOUT', false, 'brain returned non-JSON output — fallback briefing');
      }
      const output = BrainOutputSchema.parse(parsedJson);
      return { output, elapsedMs, goldenBreached: elapsedMs > BRAIN_GOLDEN_MS };
    } catch (err) {
      if (err instanceof OrchestratorError) throw err;
      const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'APIConnectionTimeoutError');
      throw new OrchestratorError('BRAIN_TIMEOUT', true, aborted ? 'brain exceeded 5.0s ceiling — fallback briefing' : `brain call failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
