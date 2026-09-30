import { z } from 'zod';
import { OrchestratorError } from '../common/errors.js';

// Cognitive brain — docs/18 §18.3, docs/06 §6.5. Inkling via OpenRouter,
// 2.0 s golden mark / 5.0 s hard abort, validated JSON output, high-stakes gate.
// Phrasing is synthesized by the model under the RAG-grounded system prompt;
// anchors in docs are illustrative, never templates.
//
// SCOPE, because the gate now runs on a different budget and the two numbers
// read as a contradiction if this is not stated. `BRAIN_CEILING_MS` is the
// DEFAULT for `openRouterChat` and the hard abort for the `BrainClient` path
// (`respond`, used by `cli live`). It is NOT the ceiling for the coordinator
// chain, whose stages pass their own budgets — intake 10 s, plan 25 s, and the
// permission gate `GATE_TIMEOUT_MS` (12 s), each measured separately. The gate
// outgrew the default because a 6 s budget aborted ~1 turn in 10 against a
// 4.3 s p50; see `GATE_TIMEOUT_MS` in coordinator.ts for the distribution.
//
// `BRAIN_GOLDEN_MS` is a REPORTING threshold, not a budget: it sets
// `goldenBreached` on the result and aborts nothing. Nothing in the tree
// enforces it, so it can be exceeded without consequence — do not "fix" a
// golden breach by raising a timeout, which is a different problem.
export const BRAIN_GOLDEN_MS = 2000;
export const BRAIN_CEILING_MS = 5000;

/**
 * OpenRouter client identity.
 *
 * Measured 2026-09-27: `thinkingmachines/inkling:free` answers HTTP 403
 * ("only available on agentic harnesses") unless the request carries a
 * `User-Agent` identifying a known coding agent. `opencode/<version>` passes
 * (any version; suffixes after the version are accepted, so the product names
 * itself honestly), as do `claude-cli/`, `codex-cli/` and `cursor/`. Bare
 * `voxaura/`, `aider/`, `continue/` and browser UAs are rejected. Node's
 * default fetch sends no such UA, so without this header the coordinator
 * could never use inkling at all — every plan call would fail as a 403.
 */
export const OPENROUTER_USER_AGENT = 'opencode/1.0 (Voxaura)';

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
 *
 * The `intent` field is deliberately tolerant because the free OpenRouter models
 * are non-deterministic: measured live on 2026-09-27, the same model and prompt
 * returned `"intent": "followUp"` on one call and
 * `"intent": {"name": "answer", "confidence": 1.0, "slots": {...}}` on the next.
 * A zod `.default()` does not help here — it only rescues `undefined`, not a
 * wrong-typed value — so the object form failed the whole parse and the voice
 * loop fell through to `BRAIN_REJECTED`, i.e. silence. Since one malformed field
 * must not cost the user their reply, a recognisable intent is recovered and an
 * unrecognised one degrades to `followUp` rather than failing.
 */
const INTENT_VALUES = ['newSession', 'followUp', 'control'] as const;

function coerceIntent(raw: unknown): (typeof INTENT_VALUES)[number] {
  const candidate =
    typeof raw === 'string'
      ? raw
      : typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>)['name'] === 'string'
        ? ((raw as Record<string, unknown>)['name'] as string)
        : '';
  // Case-insensitive match, but always return the CANONICAL camelCase value:
  // lowercasing the candidate and comparing it against camelCase members would
  // never match anything.
  const wanted = candidate.trim().toLowerCase();
  const hit = INTENT_VALUES.find((v) => v.toLowerCase() === wanted);
  return hit ?? 'followUp';
}

export function normalizeBrainJson(raw: unknown): BrainOutput | null {
  const exact = BrainOutputSchema.safeParse(raw);
  if (exact.success) return exact.data;
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  // `intent` is intentionally `unknown`: it must not be able to fail this parse.
  const loose = z
    .object({
      intent: z.unknown().optional(),
      control: z.unknown().optional(),
      reply: z.string().optional(),
      outcome: z.string().optional(),
      identity: z.string().optional(),
      nextAction: z.string().optional(),
    })
    .safeParse(obj);
  if (!loose.success) return null;
  const parts = [loose.data.identity, loose.data.outcome, loose.data.reply, loose.data.nextAction]
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (parts.length === 0) return null;
  const control =
    typeof loose.data.control === 'string' &&
    ['approve', 'cancel', 'repeat', 'switchVoice', 'none'].includes(loose.data.control)
      ? (loose.data.control as 'none')
      : 'none';
  return BrainOutputSchema.parse({
    intent: coerceIntent(loose.data.intent),
    control,
    reply: parts.join('. ').slice(0, 1200),
  });
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
  if (start < 0) return null;
  // Prefer the FIRST complete object: models under a repetition habit emit
  // `{"reply_ar": "…"}{"reply_ar": "…truncated`, and first-brace-to-last-brace
  // spans that into unparseable garbage. Measured live on inkling 2026-09-27.
  const first = firstBalancedObject(candidate, start);
  if (first !== null) {
    try {
      return JSON.parse(first) as unknown;
    } catch {
      // Fall through to the legacy whole-span attempt below.
    }
  }
  const end = candidate.lastIndexOf('}');
  if (end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/**
 * String-aware scan for the first balanced `{…}` starting at `from`.
 * Quotes, escapes and braces-inside-strings are honored, so Arabic text
 * containing `{` cannot corrupt the boundary. Returns null when no balanced
 * object closes.
 */
function firstBalancedObject(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

export interface BrainClient {
  respond(transcript: string, sessionContext: string): Promise<{ output: BrainOutput; elapsedMs: number; goldenBreached: boolean; attempts: number }>;
}

/** Project-default OpenRouter slug for the brain (coordinator default, verified live). */
export const BRAIN_OPENROUTER_MODEL = 'thinkingmachines/inkling:free';

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Raw OpenRouter chat call returning the assistant content string. Shared by
 * the brain client and the P5 coordinator chain so both stages speak the same
 * transport: Bearer auth, `response_format: json_object`. The ceiling DEFAULTS
 * to `BRAIN_CEILING_MS` but is overridable per call, and stages that override it
 * (the permission gate passes `GATE_TIMEOUT_MS`) get their own budget rather
 * than being clamped to the default. Key is caller-supplied (vault) — never
 * hardcoded, never logged.
 */
export async function openRouterChat(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  fetchImpl: typeof fetch = fetch,
  options: { reasoning?: unknown; maxTokens?: number; temperature?: number; timeoutMs?: number; responseFormat?: unknown } = {},
): Promise<string> {
  const controller = new AbortController();
  // Hoisted so the abort timer and the error message are driven by ONE value.
  // They were not: the message below hardcoded "5.0s" while the timer used
  // this expression, so a caller passing its own budget (the gate passes
  // `GATE_TIMEOUT_MS`) produced a timeout that misreported its own ceiling —
  // a measured 6.0 s abort announced itself as "exceeded 5.0s ceiling". That
  // sent the first investigation looking for a 5 s budget on a 6 s timeout,
  // which is exactly the wrong place to look. A diagnostic that lies about its
  // own limit is worse than no diagnostic: it is confidently wrong.
  const budgetMs = options.timeoutMs ?? BRAIN_CEILING_MS;
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const res = await fetchImpl(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Title': 'opencode-voice-runtime',
        // Required by harness-gated models (measured: inkling:free 403s
        // without an agentic UA). Harmless for every other model.
        'User-Agent': OPENROUTER_USER_AGENT,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: options.temperature ?? 0.4,
        max_tokens: options.maxTokens ?? 300,
        stream: false,
        response_format: options.responseFormat ?? { type: 'json_object' },
        ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
      }),
      signal: controller.signal,
    });
    // Same honest codes as respondOnce (L24): the coordinator and narrator both
    // run through this function, and every failure here used to wear
    // BRAIN_TIMEOUT. Retryable flags are preserved exactly — except 429, which
    // used to be retryable-true and is now false: retrying an exhausted quota
    // just burns the same exhausted budget. The coordinator's intake failover
    // catches all chat errors regardless of `retryable`, so that path is
    // unaffected.
    if (res.status === 401 || res.status === 403) {
      throw new OrchestratorError('BRAIN_AUTH', false, 'brain rejected credentials (rotate OPENROUTER_API_KEY)');
    }
    if (res.status === 429) {
      throw new OrchestratorError('RATE_LIMITED', false, 'brain rate limited or out of quota (HTTP 429)');
    }
    // A.4: an empty balance, checked before the generic !res.ok arm, which would
    // otherwise call it a retryable BRAIN_REJECTED and spend three requests per
    // turn. Non-retryable, and its own code rather than RATE_LIMITED so the pool
    // is not advanced for a credential that is still good.
    if (res.status === 402) {
      throw new OrchestratorError('BRAIN_CREDIT', false, 'brain out of credit (HTTP 402)');
    }
    if (!res.ok) {
      throw new OrchestratorError('BRAIN_REJECTED', true, `brain endpoint HTTP ${res.status}`);
    }
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      error?: { message?: unknown };
    };
    if (typeof payload?.error?.message === 'string') {
      throw new OrchestratorError('BRAIN_REJECTED', false, `brain provider error: ${payload.error.message.slice(0, 200)}`);
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new OrchestratorError('BRAIN_REJECTED', true, 'brain returned empty completion');
    }
    return content;
  } catch (err) {
    if (err instanceof OrchestratorError) throw err;
    const aborted = err instanceof Error && err.name === 'AbortError';
    // The budget in force, not a constant. `(budgetMs / 1000).toFixed(1)` is
    // what "5.0s ceiling" always meant to say; it is now derived from the same
    // value the abort timer used, so the two cannot disagree.
    throw new OrchestratorError(
      'BRAIN_TIMEOUT',
      true,
      aborted ? `brain exceeded ${(budgetMs / 1000).toFixed(1)}s ceiling` : `brain call failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OpenRouter brain — the BrainClient contract, routed via
 * Bearer auth to the OpenRouter chat endpoint. `response_format: json_object`
 * is required (OpenRouter-spec) so completions arrive parseable; the shared
 * normalize/extract pipeline still guards the shape. Key is caller-supplied
 * (env or vault) — never hardcoded, never logged.
 */
export class OpenRouterBrainClient implements BrainClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = BRAIN_OPENROUTER_MODEL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async respond(transcript: string, sessionContext: string): Promise<{ output: BrainOutput; elapsedMs: number; goldenBreached: boolean; attempts: number }> {
    const started = Date.now();
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await this.respondOnce(transcript, sessionContext, started);
        return { ...result, attempts: attempt };
      } catch (err) {
        lastError = err;
        // Retry only a genuinely transient refusal. Previously this keyed off
        // `code === 'BRAIN_TIMEOUT' && retryable`, which only worked because
        // every failure wore that one code; now that the codes are honest it
        // must key off `retryable` alone. Auth and quota are non-retryable and
        // are therefore never re-attempted, which is the whole point of
        // distinguishing them.
        const retryable = err instanceof OrchestratorError && err.retryable;
        if (!retryable || attempt === 3) throw err;
      }
    }
    throw lastError;
  }

  private async respondOnce(transcript: string, sessionContext: string, started: number): Promise<{ output: BrainOutput; elapsedMs: number; goldenBreached: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BRAIN_CEILING_MS);
    try {
      const res = await this.fetchImpl(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'X-Title': 'opencode-voice-runtime',
          // Same harness-gate reason as openRouterChat above.
          'User-Agent': OPENROUTER_USER_AGENT,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: AMMANI_SYSTEM_PROMPT },
            { role: 'user', content: `Context: ${sessionContext}\nDeveloper said: ${transcript}` },
          ],
          temperature: 0.4,
          max_tokens: 300,
          stream: false,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      const elapsedMs = Date.now() - started;
      // L24 — each of these was reported as BRAIN_TIMEOUT, so an expired key,
      // an exhausted quota and a slow network were indistinguishable. The
      // `retryable` flag is what drives the retry loop, so it is preserved
      // exactly; only the code becomes honest.
      if (res.status === 401 || res.status === 403) {
        throw new OrchestratorError('BRAIN_AUTH', false, 'brain rejected credentials (rotate OPENROUTER_API_KEY)');
      }
      if (res.status === 429) {
        // Quota or upstream load. Retrying immediately just burns the same
        // exhausted budget, so this is the one non-2xx that is NOT retryable.
        throw new OrchestratorError('RATE_LIMITED', false, 'brain rate limited or out of quota (HTTP 429)');
      }
      if (res.status === 402) {
        // A.4: same rule as the shared transport above — one attempt, and the
        // pool is left alone because the credential is not what ran out.
        throw new OrchestratorError('BRAIN_CREDIT', false, 'brain out of credit (HTTP 402)');
      }
      if (!res.ok) {
        throw new OrchestratorError('BRAIN_REJECTED', true, `brain endpoint HTTP ${res.status}`);
      }
      const payload = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        error?: { message?: unknown };
      };
      if (typeof payload?.error?.message === 'string') {
        throw new OrchestratorError('BRAIN_REJECTED', false, `brain provider error: ${payload.error.message.slice(0, 200)}`);
      }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new OrchestratorError('BRAIN_REJECTED', true, 'brain returned an empty completion');
      }
      const output = normalizeBrainJson(extractJson(content));
      if (output === null) {
        throw new OrchestratorError('BRAIN_REJECTED', false, 'brain returned non-JSON output');
      }
      return { output, elapsedMs, goldenBreached: elapsedMs > BRAIN_GOLDEN_MS };
    } catch (err) {
      if (err instanceof OrchestratorError) throw err;
      const aborted = err instanceof Error && err.name === 'AbortError';
      // Same rule as `openRouterChat`, for the same reason. This path has no
      // per-call override so its budget IS `BRAIN_CEILING_MS`, which means the
      // literal "5.0s" is correct today and will be silently wrong the day the
      // constant moves. Derived, so it cannot rot.
      throw new OrchestratorError(
        'BRAIN_TIMEOUT',
        true,
        aborted
          ? `brain exceeded ${(BRAIN_CEILING_MS / 1000).toFixed(1)}s ceiling — fallback briefing`
          : `brain call failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
