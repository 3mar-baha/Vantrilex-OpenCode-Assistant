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

/** The only chat surface the narrator needs — keeps it testable and provider-free. */
export type NarratorChat = (model: string, system: string, user: string) => Promise<string>;

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
  'أخرج الجملة فقط، بلا علامات اقتباس ولا شرح.',
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
 * Returns `null` when the model is unavailable, fails, or says nothing usable.
 * Callers MUST NOT substitute a canned string for `null`.
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
    raw = await chat(model, system, narrationContextLine(ctx));
  } catch {
    // No fallback sentence. A visible gap beats a robotic lie.
    return null;
  }
  const line = raw
    .trim()
    .replace(/^["'«]|["'»]$/g, '')
    .replace(/^(تم\s*[:：-]\s*)/, '')
    .trim();
  if (line.length === 0) return null;
  return line.length <= MAX_CHARS ? line : `${line.slice(0, MAX_CHARS - 1).trimEnd()}…`;
}
