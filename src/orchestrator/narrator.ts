// Phase 5 — ZERO CANNED REPLIES.
//
// Every verbal confirmation the user hears is written by the conversational
// model, from the situation, in the moment. There is no template table anywhere
// in this module, and no fallback sentence: if the model is unavailable the
// result is `null` and the shell shows a neutral error instead of speaking a
// canned line the user would recognise as fake.
//
// The previous implementation passed literals like "تم تبديل النموذج" from the
// call site, which is why confirmations sounded robotic regardless of context.
//
// Not a few-shot example is included below, deliberately: an example sentence
// in the system prompt is precisely how a canned phrase sneaks back in, and a
// pinned test asserts none exists.

import { extractJson } from '../voice/brain.js';

/** The only chat surface the narrator needs — keeps it testable and provider-free. */
export type NarratorChat = (
  model: string,
  system: string,
  user: string,
  options?: { responseFormat?: unknown; reasoning?: unknown },
) => Promise<string>;

/**
 * The narrator runs on Inkling (100% free constraint).
 *
 * Measured 2026-09-27: without strict schema enforcement inkling answers
 * narration prompts with raw tool-call syntax
 * (`<|message_model|>shell<|content_invoke_tool_json|>…`) or prose in 5/5
 * trials — either of which would be SPOKEN if it reached TTS. With strict
 * `json_schema` it returns clean `{"reply_ar": "…"}` in 5/5. So the schema is
 * not a nicety, it is the thing standing between the model and the speaker.
 */
export const NARRATOR_MODEL = 'thinkingmachines/inkling:free';

/** Strict output contract for the narrator. See NARRATOR_MODEL above. */
export const NARRATOR_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'narration',
    strict: true,
    schema: {
      type: 'object',
      properties: { reply_ar: { type: 'string' } },
      required: ['reply_ar'],
      additionalProperties: false,
    },
  },
};

export interface NarrationContext {
  /** Machine action id, e.g. 'setSessionModel'. Never a human sentence. */
  readonly action: string;
  readonly outcome: 'ok' | 'error';
  /** What was targeted, e.g. a model or agent id. */
  readonly target?: string;
  /** What it replaced, when the action changes something. */
  readonly previousModel?: string;
  readonly sessionTitle?: string;
  /** Current context-window fill, 0..100. */
  readonly contextPercent?: number;
  /** Failure reason, on the error path. */
  readonly errorDetail?: string;
}

export const NARRATOR_SYSTEM = [
  'أنت زميل مهندس برمجي عربي هادئ، تتحدث إلى زميلك عن العمل الجاري.',
  'اكتب جملة عربية واحدة قصيرة ({max} كلمة كحد أقصى) تصف ما حدث الآن، اعتماداً على السياق المعطى.',
  'كن طبيعياً ومباشراً كنظير، لا موظف خدمة.',
  'لا تستخدم قوالب جاهزة ولا عبارات آلية مثل "تم تنفيذ الأمر بنجاح" أو "تم تغيير" — هذه ممنوعة تماماً.',
  'اختر أسلوبك حسب الموقف: لو=swapنا نموذجاً على مهمة صعبة، علّق على قدرته؛ لو نافذة السياق قاربت الامتلاء، اقترح اختصاراً بلطف دون أن يبدو إنذاراً آلياً.',
  'لا تكرر صيغة بعينها في مواقف مختلفة، ولا تكرر جملتك السابقة.',
  'أخرج الجملة داخل JSON فقط، بهذا الشكل تماماً ودون أي نص خارجه:',
  '{"reply_ar": "<الجملة>"}',
  'إذا كان الخلل بسبب تقني، اذكر السبب بلطف واقترح خطوة تالية.',
].join('\n');

/** One-line machine context handed to the model. Not a sentence for a human. */
export function narrationContextLine(ctx: NarrationContext): string {
  const parts: string[] = [`الإجراء: ${ctx.action}`, `النتيجة: ${ctx.outcome === 'ok' ? 'نجح' : 'فشل'}`];
  if (ctx.target !== undefined) parts.push(`الهدف: ${ctx.target}`);
  if (ctx.previousModel !== undefined) parts.push(`السابق: ${ctx.previousModel}`);
  if (ctx.sessionTitle !== undefined) parts.push(`الجلسة: ${ctx.sessionTitle}`);
  if (ctx.contextPercent !== undefined) parts.push(`نسبة نافذة السياق: ${ctx.contextPercent}%`);
  if (ctx.errorDetail !== undefined) parts.push(`سبب الفشل: ${ctx.errorDetail}`);
  return parts.join(' | ');
}

/** Hard cap: a confirmation is one line, never a monologue. */
const MAX_CHARS = 240;

/**
 * Produce the spoken line for a just-completed action.
 *
 * The model MUST return `{"reply_ar": "<one short Arabic line>"}` — enforced
 * at the provider by NARRATOR_RESPONSE_FORMAT, and parsed here. Only the
 * extracted `reply_ar` ever reaches TTS: raw model output (JSON wrapper,
 * let alone control tokens) is never spoken and never displayed.
 *
 * Returns `null` when the model is unavailable, fails, or says nothing usable.
 * Callers MUST NOT substitute a canned string for `null`. In particular, a
 * non-JSON reply is a `null`, not a "best effort" spoken line — speaking a
 * best-effort parse is exactly how `<|message_model|>` ends up audible.
 */
export async function narrate(
  ctx: NarrationContext,
  chat: NarratorChat,
  model: string,
  maxWords = 20,
): Promise<string | null> {
  const system = NARRATOR_SYSTEM.replace('{max}', String(maxWords));
  let raw: string;
  try {
    raw = await chat(model, system, narrationContextLine(ctx), {
      responseFormat: NARRATOR_RESPONSE_FORMAT,
    });
  } catch {
    // No fallback sentence. A visible gap beats a robotic lie.
    return null;
  }
  const parsed = extractJson(raw);
  const reply =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['reply_ar']
      : undefined;
  if (typeof reply !== 'string') return null;
  const line = reply
    .trim()
    .replace(/^["'«]|["'»]$/g, '')
    .replace(/^(تم\s*[:：-]\s*)/, '')
    .trim();
  if (line.length === 0) return null;
  return line.length <= MAX_CHARS ? line : `${line.slice(0, MAX_CHARS - 1).trimEnd()}…`;
}
