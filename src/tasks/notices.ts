import type { TaskOutcomeCode, TaskRecord } from './types.js';

/**
 * The notice plan. PURE, and not wired to anything — the engine never speaks.
 *
 * The charter's rule is asymmetric on purpose: a finished task ALWAYS gets a
 * visual notice, and gets a SPOKEN one only inside a silence window. The queue
 * knows nothing about audio, so it does not decide; this module produces the
 * decision as data and the integration wave supplies the window (the daemon's
 * speech gate) as an argument. Keeping it pure is what lets both halves be
 * tested: the classification here, the window there.
 *
 * Copy is Ammani / White Jordanian, matching `brain.ts` and the two personas.
 * It is authored copy, not a measured claim about how a user reacts.
 */
export type NoticeSeverity = 'ok' | 'warn' | 'error';

export interface TaskNotice {
  /** Stable machine code. A frame/telemetry key, not prose. */
  readonly code: string;
  readonly detailAr: string;
  readonly severity: NoticeSeverity;
  /** Always true: the visual notice is unconditional. */
  readonly visual: true;
  /** True only when the caller says the room is silent enough to talk. */
  readonly speak: boolean;
}

export interface NoticeContext {
  /**
   * Whether a spoken notice is permitted right now — the integration wave's
   * speech gate, injected as data so this function stays pure.
   */
  readonly speechAvailable: boolean;
}

export function buildTaskNotice(task: TaskRecord, ctx: NoticeContext): TaskNotice {
  const outcome = classify(task);
  // A cancellation was the user's own action seconds ago; repeating it aloud is
  // noise. It still gets the visual notice.
  //
  // Compared on the OUTCOME, not on `outcome.code`. Comparing the notice code
  // here (`'task-cancelled' !== 'cancelled'`) reads as if it works and never
  // does — a guard test caught exactly that, which is why the assertion in
  // `notices.test.ts` pins the outcome rather than trusting this comment.
  //
  // This is a judgement call and the one place the charter's "spoken on
  // completion" is deliberately not followed, so it is called out here rather
  // than buried.
  const speak = outcomeOf(task) !== 'cancelled' && ctx.speechAvailable;
  return {
    code: outcome.code,
    detailAr: outcome.detailAr,
    severity: outcome.severity,
    visual: true,
    speak,
  };
}

function classify(task: TaskRecord): { code: string; detailAr: string; severity: NoticeSeverity } {
  switch (outcomeOf(task)) {
    case 'ok':
      return { code: 'task-done', detailAr: `خلص ${task.label}`, severity: 'ok' };
    case 'timeout':
      return {
        code: 'task-timeout',
        detailAr: `انتهى وقت ${task.label} بدون ما يخلص`,
        severity: 'error',
      };
    case 'interrupted':
      return {
        code: 'task-interrupted',
        detailAr: `انقطع ${task.label} لأن التطبيق طفا — ما بنقدر نأكد إذا خلص`,
        severity: 'warn',
      };
    case 'cancelled':
      return { code: 'task-cancelled', detailAr: `ألغيت ${task.label}`, severity: 'warn' };
    case 'threw':
    default:
      return {
        code: 'task-failed',
        detailAr: `فشل ${task.label}: ${task.failure?.message ?? 'سبب غير معروف'}`,
        severity: 'error',
      };
  }
}

function outcomeOf(task: TaskRecord): TaskOutcomeCode {
  if (task.state === 'done') return 'ok';
  if (task.state === 'cancelled') return 'cancelled';
  return task.failure?.code ?? 'threw';
}
