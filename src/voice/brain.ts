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

/**
 * Normalize near-miss shapes (e.g. {intent, outcome, identity, nextAction})
 * into the canonical contract. Returns null when nothing salvageable exists —
 * the caller then takes the fallback briefing path (never raw speech).
 */
export function normalizeBrainJson(raw: unknown): BrainOutput | null {
  const exact = BrainOutputSchema.safeParse(raw);
  if (exact.success) return exact.data;
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const loose = z.object({
    intent: z.enum(['newSession', 'followUp', 'control']).default('followUp'),
    reply: z.string().optional(),
    outcome: z.string().optional(),
    identity: z.string().optional(),
    nextAction: z.string().optional(),
  }).safeParse(obj);
  if (!loose.success) return null;
  const parts = [loose.data.identity, loose.data.outcome, loose.data.reply, loose.data.nextAction]
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (parts.length === 0) return null;
  return BrainOutputSchema.parse({ intent: loose.data.intent, reply: parts.join('. ').slice(0, 1200) });
}

const HIGH_STAKES_VERBS = ['destroy', 'delete', 'drop', 'force-push', 'force push', 'deploy', 'rm -rf', 'rm -rf '];

/** FR-12: ambiguous or explicit destructive language always requires confirmation. */
export function requiresConfirmation(text: string): boolean {
  const lowered = text.toLowerCase();
  return HIGH_STAKES_VERBS.some((verb) => lowered.includes(verb));
}

export const AMMANI_SYSTEM_PROMPT = [
  'You are an Ammani Jordanian Arabic voice peer for a developer; synthesize every reply',
  'dynamically in everyday Ammani software parlance with fluid English tech terms.',
  'Never MSA newsreader prose, Beiruti slang, or foreign dialects; never repeat examples verbatim.',
  'Keep code, paths, logs, error codes, sessions, commands in technical English.',
  'Briefings BLUF-first: outcome + identity ≤15 words, ≤3 change clauses, one next action, ≤45s;',
  'failures ≤15s: state, modules + count, logs saved, next step.',
  'Destructive verbs (destroy/delete/drop/force-push/deploy/rm-rf): ALWAYS ask first; ambiguous: ask, never act.',
  'Retry loops: silent intermediates, heartbeat every 5 min or 3 fails, halt at 5 and ask.',
  'Reply ONLY with this exact JSON, no prose outside it:',
  '{"intent": "followUp", "control": "none", "reply": "<Ammani briefing>", "sessionDirective": "<prompt or omit>"}',
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
  respond(transcript: string, sessionContext: string): Promise<{ output: BrainOutput; elapsedMs: number; goldenBreached: boolean; attempts: number }>;
}

export class GroqBrainClient implements BrainClient {
  private readonly client: Groq;

  constructor(apiKey: string) {
    this.client = new Groq({ apiKey });
  }

  async respond(transcript: string, sessionContext: string): Promise<{ output: BrainOutput; elapsedMs: number; goldenBreached: boolean; attempts: number }> {
    const started = Date.now();
    // Transient empty completions get up to two immediate retries (3 attempts
    // total, each under the 5s ceiling); persistent failure takes the fallback
    // path (never raw speech, never an unbounded loop).
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await this.respondOnce(transcript, sessionContext, started);
        return { ...result, attempts: attempt };
      } catch (err) {
        lastError = err;
        const retryableEmpty = err instanceof OrchestratorError && err.code === 'BRAIN_TIMEOUT' && err.retryable;
        if (!retryableEmpty || attempt === 3) throw err;
      }
    }
    throw lastError;
  }

  private async respondOnce(transcript: string, sessionContext: string, started: number): Promise<{ output: BrainOutput; elapsedMs: number; goldenBreached: boolean }> {
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
      if (content.trim().length === 0) {
        throw new OrchestratorError('BRAIN_TIMEOUT', true, 'brain returned empty completion — retrying once');
      }
      const output = normalizeBrainJson(extractJson(content));
      if (output === null) {
        throw new OrchestratorError('BRAIN_TIMEOUT', false, 'brain returned non-JSON output — fallback briefing');
      }
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
