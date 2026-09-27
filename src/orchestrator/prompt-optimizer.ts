// Phase 5 — the prompt optimization seam.
//
// A spoken instruction is messy: it carries filler, pronouns and half-formed
// references to context on screen. An OpenCode session does better with a
// structured brief. This module sits between the transcript and dispatch and
// rewrites one into the other.
//
// The rule that keeps it honest: it IMPROVES an instruction, it never INVENTS
// work. `تمام` must not become a task, or the assistant starts acting on
// acknowledgements. `isActionableInstruction` is the gate.
//
// No worked example appears in the system prompt: a few-shot sample is how a
// fixed phrasing creeps back in, and a test asserts none exists.

export type OptimizerChat = (model: string, system: string, user: string) => Promise<string>;

export interface PromptContext {
  readonly sessionTitle?: string;
  readonly currentModel?: string;
  readonly contextPercent?: number;
}

/** Upper bound on a rewritten prompt; a session prompt is not an essay. */
const MAX_PROMPT_CHARS = 2000;

/**
 * Acknowledgements and greetings. Turning any of these into a task would make
 * the assistant act on the user's politeness.
 */
const NON_ACTIONABLE = new Set([
  'تمام',
  'طيب',
  'اوك',
  'اوكي',
  'اكيد',
  'نعم',
  'لا',
  'مرحبا',
  'اهلا',
  'السلام عليكم',
  'شكرا',
  'شكرا جزيلا',
  'حسنا',
  'جيد',
  'ماشي',
  'تماما',
  'يسلمو',
  'يلا',
]);

export function isActionableInstruction(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  const norm = t.replace(/[.،,!؟?…\s]+$/g, '').toLowerCase();
  // Punctuation-only input ("؟؟") is not an instruction.
  if (norm.length === 0) return false;
  if (NON_ACTIONABLE.has(norm)) return false;
  // Only a list of known short acknowledgements is caught here. Free-form
  // conversational Arabic ("تمام شكرا جزيلا، أنا بخير") is deliberately NOT
  // classified by a word list: the coordinator's own judgement is the gate for
  // anything ambiguous, and a heuristic that guesses is worse than one that
  // admits its scope.
  return true;
}

export const PROMPT_SYSTEM = [
  'أنت محرّر أوامر. حوّل الطلب المنطوق إلى نص تنفيذي موجز ومنظّم للوكيل.',
  'اكتب النتيجة بأربعة عناوين فقط: ROLE (الدور المطلوب)، CONTEXT (السياق المتاح)، GOAL (الهدف)، CONSTRAINTS (القيود).',
  'لا تختلق عملاً لم يطلبه المستخدم، ولا توسّع النطاق، ولا تضف اقتراحات غير مرتبطة.',
  'اكتب بنفس لغة المستخدم في طلبه.',
  'اجعل الهدف جملة واحدة واضحة قابلة للتنفيذ فوراً.',
  'أخرج النص النهائي فقط، بلا مقدمات ولا شرح ولا علامات اقتباس.',
].join('\n');

/**
 * Rewrite `utterance` into a dispatchable brief.
 *
 * Returns the ORIGINAL text on any failure. That fallback is the user's own
 * words rather than a template, so a degraded prompt is still honest — the
 * session simply does less structured work.
 */
export async function optimizePrompt(
  utterance: string,
  chat: OptimizerChat,
  model: string,
  context: PromptContext = {},
): Promise<string> {
  const parts: string[] = [`الطلب المنطوق: ${utterance}`];
  if (context.sessionTitle !== undefined) parts.push(`عنوان الجلسة: ${context.sessionTitle}`);
  if (context.currentModel !== undefined) parts.push(`النموذج الحالي: ${context.currentModel}`);
  if (context.contextPercent !== undefined) parts.push(`نسبة نافذة السياق: ${context.contextPercent}%`);
  const user = parts.join('\n');

  let raw: string;
  try {
    raw = await chat(model, PROMPT_SYSTEM, user);
  } catch {
    return utterance;
  }
  const text = raw.trim();
  if (text.length === 0) return utterance;
  return text.length <= MAX_PROMPT_CHARS ? text : text.slice(0, MAX_PROMPT_CHARS);
}
