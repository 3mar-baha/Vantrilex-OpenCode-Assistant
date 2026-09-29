import { z } from 'zod';
import type { SessionId } from '../common/brands.js';
import { extractJson, requiresConfirmation } from '../voice/brain.js';

// P5 runtime orchestration — the 3-agent chain as executable code:
// Dots3 intake ({reply_ar, task_en}) → Inkling plan (task DAG) → Inkling
// handoff dispatched to the active OpenCode session. The fast verbal reply is
// spoken before planning completes; every malformed model output becomes a
// structured failure, never an escape; destructive plans honor FR-12.
//
// The coordinator role was previously served by Nemotron
// (nvidia/nemotron-3-ultra-550b-a55b:free). It is now served by Inkling
// (thinkingmachines/inkling:free), verified live 2026-09-27: 5/5 valid task
// DAGs against the production strict json_schema (p50 1950 ms, max 3987 ms,
// within the 25 s planning ceiling). Two measured constraints travel with it:
// inkling answers HTTP 403 without an agentic User-Agent (see
// OPENROUTER_USER_AGENT in voice/brain.ts), and without strict schema
// enforcement it emits raw tool-call syntax instead of a plan (0/5
// prompt-only) — so PLAN_RESPONSE_FORMAT is load-bearing, not decorative.
// "Nemotron" survives in the handoff envelope only as the coordinator role
// name defined by the mission-handoff skill contract, not as a model slug.
export const INTAKE_MODEL = 'dots-studio/dots-3-note-preview:free';
export const COORDINATOR_MODEL = 'thinkingmachines/inkling:free';

export const IntakeSchema = z.object({
  reply_ar: z.string().min(1),
  task_en: z.string().min(1),
});
export type Intake = z.infer<typeof IntakeSchema>;

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  detail: z.string().min(1),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.object({
  steps: z.array(PlanStepSchema).min(1),
  tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

/**
 * Situational context handed to intake so `reply_ar` is written FROM the
 * situation rather than from a stock acknowledgement. Phase 5.
 */
export interface IntakeContext {
  readonly sessionTitle?: string;
  readonly currentModel?: string;
  readonly currentAgent?: string;
  /** Context-window fill, 0..100. */
  readonly contextPercent?: number;
  readonly lastOutcome?: string;
}

function intakeContextBlock(ctx?: IntakeContext): string {
  if (ctx === undefined) return '';
  const rows: string[] = [];
  if (ctx.sessionTitle !== undefined) rows.push(`session title: ${ctx.sessionTitle}`);
  if (ctx.currentModel !== undefined) rows.push(`current model: ${ctx.currentModel}`);
  if (ctx.currentAgent !== undefined) rows.push(`current agent: ${ctx.currentAgent}`);
  if (ctx.contextPercent !== undefined) rows.push(`context window used: ${ctx.contextPercent}%`);
  if (ctx.lastOutcome !== undefined) rows.push(`last outcome: ${ctx.lastOutcome}`);
  if (rows.length === 0) return '';
  return `SITUATION:\n${rows.join('\n')}\n\n`;
}

function intakeSystem(ctx?: IntakeContext): string {
  return [
  'You take Arabic voice transcripts and split them into two fields.',
  'Reply ONLY with this exact JSON, no prose outside it, no preamble:',
  '{"reply_ar": "<short natural Ammani Arabic acknowledgement, max 20 words>", "task_en": "<precise English task specification>"}',
  '',
  'How to write reply_ar — this is the line the user will HEAR, so it matters:',
  '- Write it from the SITUATION you are given, not from a stock phrase.',
  '- You are a calm, sharp senior engineer talking to a peer, not a call centre.',
  '- React to what actually happened: if a heavier model was just swapped in for a hard task,',
  '  say something about that capability; if the context window is nearly full, raise it',
  '  naturally and offer to compact, without sounding like an automated alert.',
  '- Vary your phrasing. Do NOT reuse a fixed opener. No "تم تنفيذ الأمر بنجاح",',
  '  no "تم تغيير", no robotic confirmation templates — those are forbidden.',
  '- If the user said something that needs no action, acknowledge it briefly and set',
  '  task_en to a no-op marker rather than inventing work.',
  '',
  intakeContextBlock(ctx),
  ].join('\n');
}


const COORDINATOR_SYSTEM = [
  'You are the planner for Voxaura, an agent runtime that executes your steps:',
  'it can prompt sessions, toggle skills, switch models/agents, and run shell commands.',
  'Decompose the task into concrete executable steps using kinds: prompt, control, shell, skill.',
].join('\n');

/** Strict schema enforcement: json_object mode lets the model drift into prose. */
const PLAN_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'task_plan',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              kind: { type: 'string' },
              detail: { type: 'string' },
            },
            required: ['id', 'kind', 'detail'],
            additionalProperties: false,
          },
        },
        tools: { type: 'array', items: { type: 'string' } },
        skills: { type: 'array', items: { type: 'string' } },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
};

export type ChatFn = (model: string, system: string, user: string, options?: ChatOptions) => Promise<string>;

/** Per-call decoding controls. The Dots3 intake uses reasoning suppression. */
export interface ChatOptions {
  readonly reasoning?: unknown;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly responseFormat?: unknown;
}

export interface CoordinatorDeps {
  readonly chat: ChatFn;
  readonly intakeModel?: string;
  readonly coordinatorModel?: string;
  /**
   * Failover intake model. Dots3 is the configured primary, but a model that
   * times out or returns unparseable output must not kill the mission — one
   * retry on the fallback preserves continuity (fail-closed, never silent).
   */
  readonly fallbackModel?: string;
  dispatch(text: string): Promise<{ receipt: string }>;
  activeSessionId(): SessionId | undefined;
  speak?(text: string): Promise<unknown>;
}

export interface MissionResult {
  readonly ok: boolean;
  readonly replyAr?: string;
  readonly taskEn?: string;
  readonly plan?: Plan;
  readonly receipt: string | null;
  readonly intakeModel?: string;
  readonly needsConfirmation?: boolean;
  readonly flagged?: string[];
  readonly detail?: string;
  /**
   * M2 Pattern 1: the intake half returns before a plan exists. `intakeModel`
   * travels with it because a task queue has to record which model answered —
   * a failover to Inkling on the intake leg is exactly the kind of thing an
   * operator asks about after the fact.
   */
  readonly cancelled?: boolean;
}

/**
 * M2 Pattern 1 — the acknowledgement intake produced, handed to `plan()`.
 *
 * The split exists because the two halves have opposite latency profiles and
 * the same caller: intake p50 901 ms (the user is waiting), plan p50 1950 ms /
 * max 3987 (the user is not). Before the split `run()` did both, so the ack
 * could not be spoken until a plan had already been built — the wait the
 * roadmap measures as ~1.4 s.
 */
export interface IntakeAck {
  readonly ok: boolean;
  readonly replyAr?: string;
  readonly taskEn?: string;
  readonly receipt: string | null;
  readonly intakeModel?: string;
  readonly detail?: string;
}

/** mission-handoff envelope — the exact payload Inkling executes in-session. */
export function buildHandoff(taskId: string, taskEn: string, sessionId: string, steps: PlanStep[]): string {
  const lines = steps.map((s) => `- [${s.id}] ${s.kind} :: ${s.detail}`);
  return [
    `[HANDOFF from=Nemotron to=Inkling task=${taskId}]`,
    `objective: ${taskEn}`,
    `session: ${sessionId}`,
    'steps:',
    ...lines,
    'acceptance: dispatch receipt',
    'constraints: FR-12 confirmed where flagged; English only; in-session execution only',
  ].join('\n');
}

function parseSchema<T>(schema: z.ZodType<T>, raw: string): T | null {
  const candidate = extractJson(raw);
  if (candidate === null) return null;
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export class Coordinator {
  constructor(private readonly deps: CoordinatorDeps) {}

  /**
   * M2 Pattern 1 — the FIRST half of `run()`, moved verbatim.
   *
   * Everything between here and the old `:232` is byte-identical to what
   * `run()` did, including the A.8 failover flags (`intakeTransportFailed` set
   * on a throw, reset on an unparseable body). Those flags are load-bearing:
   * primary 500 + fallback 200-garbage must report `intake-failed`, not
   * `intake-invalid`. Moving the loop is not the moment to "tidy" them.
   *
   * What is deliberately NOT here: the detached `speak()` and the plan. The
   * ack is spoken by the daemon the moment this returns — that is the whole
   * point — so firing it from inside intake would double-speak it.
   */
  async intake(transcript: string, opts: { context?: IntakeContext } = {}): Promise<IntakeAck> {
    const intakeModel = this.deps.intakeModel ?? INTAKE_MODEL;
    const fallbackModel = this.deps.fallbackModel ?? COORDINATOR_MODEL;

    // Intake with failover: a dead or garbled primary falls back once.
    // Dots3 runs with reasoning suppressed (effort:none) so it answers
    // immediately instead of burning tokens on hidden chain-of-thought.
    // Measured 1.2–1.9 s over 3 runs; the 10 s budget covers worst case
    // with margin while a hard failure still fails over fast.
    let intake: Intake | null = null;
    let servedBy = intakeModel;
    let intakeTransportFailed = false;
    for (const model of [intakeModel, fallbackModel]) {
      let raw: string;
      try {
        raw = await this.deps.chat(
          model,
          intakeSystem(opts.context),
          transcript,
          model === intakeModel
            ? { reasoning: { effort: 'none' }, maxTokens: 200, temperature: 0.2, timeoutMs: 10_000 }
            : undefined,
        );
      } catch {
        intakeTransportFailed = true;
        continue;
      }
      const parsed = parseSchema(IntakeSchema, raw);
      if (parsed !== null) {
        intake = parsed;
        servedBy = model;
        break;
      }
      intakeTransportFailed = false;
    }
    if (intake === null) {
      return { ok: false, receipt: null, detail: intakeTransportFailed ? 'intake-failed' : 'intake-invalid' };
    }
    return { ok: true, replyAr: intake.reply_ar, taskEn: intake.task_en, receipt: null, intakeModel: servedBy };
  }

  /**
   * M2 Pattern 1 — the SECOND half, entered with an ack this class produced.
   *
   * `signal` is checked after every await rather than once at the top. A single
   * check at entry would let a cancel that lands DURING a 25 s plan call be
   * answered by a dispatch: the call is already in flight, so what has to be
   * refused is its effect. Checking per-await means the check immediately
   * before the dispatch is the one that decides.
   */
  async plan(
    ack: IntakeAck,
    opts: { signal?: AbortSignal; approve?: boolean; taskId?: string } = {},
  ): Promise<MissionResult> {
    if (!ack.ok || ack.replyAr === undefined || ack.taskEn === undefined) {
      // An intake that never produced an acknowledgement has no task to plan.
      // Asking the coordinator model to plan nothing spends a 25 s budget on
      // a turn that is already over.
      return { ok: false, receipt: null, detail: ack.detail ?? 'intake-failed' };
    }
    const { replyAr, taskEn } = ack;
    // Read once, into a widened local: the `exactOptionalPropertyTypes`
    // returns below assign `servedBy` into optional fields, and re-reading
    // `ack.intakeModel` at each site kept losing the narrowing.
    const servedBy: string | undefined = ack.intakeModel;
    const coordinatorModel = this.deps.coordinatorModel ?? COORDINATOR_MODEL;
    const cancelled = (): MissionResult =>
      ({ ok: false, replyAr, taskEn, receipt: null, cancelled: true, detail: 'cancelled' });
    // A FUNCTION, not a repeated property read. TypeScript narrows an optional
    // chain across statements — after `if (signal?.aborted === true) return`,
    // every later `signal?.aborted === true` reads as unreachable and is
    // flagged TS2367. The abort can arrive BETWEEN awaits, which is precisely
    // the case this exists for, so the read must not be cacheable.
    const aborted = (): boolean => opts.signal?.aborted === true;
    if (aborted()) return cancelled();

    let planRaw: string | null = null;
    try {
      // Planning is background work: generous ceiling so a slow model still
      // delivers (intake keeps the tight budget for fast failover instead).
      // Strict schema mode — plain json_object lets the model drift into prose.
      planRaw = await this.deps.chat(coordinatorModel, COORDINATOR_SYSTEM, taskEn, {
        timeoutMs: 25_000,
        temperature: 0.2,
        maxTokens: 300,
        responseFormat: PLAN_RESPONSE_FORMAT,
      });
    } catch {
      planRaw = null;
    }
    if (aborted()) return cancelled();
    let plan = planRaw === null ? null : parseSchema(PlanSchema, planRaw);
    if (plan === null) {
      // One bounded retry with a sterner format reminder. No unbounded loops.
      if (aborted()) return cancelled();
      try {
        const retry = await this.deps.chat(
          coordinatorModel,
          `${COORDINATOR_SYSTEM}\nCRITICAL: output ONLY the JSON object. Any prose invalidates the entire response.`,
          taskEn,
          { timeoutMs: 25_000, temperature: 0.2, maxTokens: 300, responseFormat: PLAN_RESPONSE_FORMAT },
        );
        plan = parseSchema(PlanSchema, retry);
      } catch {
        plan = null;
      }
    }
    if (aborted()) return cancelled();
    if (plan === null) {
      return { ok: false, replyAr, taskEn, receipt: null, detail: 'plan-invalid' };
    }

    const flagged = plan.steps.filter((s) => requiresConfirmation(`${s.kind} ${s.detail}`)).map((s) => s.id);
    if (flagged.length > 0 && opts.approve !== true) {
      return {
        ok: false,
        replyAr,
        taskEn,
        plan,
        receipt: null,
        ...(servedBy !== undefined ? { intakeModel: servedBy } : {}),
        needsConfirmation: true,
        flagged,
        detail: `destructive steps held: ${flagged.join(', ')}`,
      };
    }

    const session = this.deps.activeSessionId();
    if (session === undefined) {
      return { ok: true, replyAr, taskEn, plan, receipt: null, ...(servedBy !== undefined ? { intakeModel: servedBy } : {}) };
    }
    const taskId = opts.taskId ?? `mission-${Date.now().toString(36)}`;
    // The last await before a live session is touched, so this check is the one
    // that decides whether the turn was still wanted.
    if (aborted()) return { ...cancelled(), plan };
    const { receipt } = await this.deps.dispatch(buildHandoff(taskId, taskEn, session, plan.steps));
    return { ok: true, replyAr, taskEn, plan, receipt, ...(servedBy !== undefined ? { intakeModel: servedBy } : {}) };
  }

  /**
   * Retained with unchanged behaviour: intake, then plan. Twenty-plus tests
   * call this directly and they describe the CHAIN, not the split — the split
   * is something the DAEMON opts into by calling the halves itself.
   */
  async run(
    transcript: string,
    opts: { approve?: boolean; taskId?: string; context?: IntakeContext } = {},
  ): Promise<MissionResult> {
    const ack = await this.intake(transcript, { ...(opts.context !== undefined ? { context: opts.context } : {}) });
    if (!ack.ok || ack.replyAr === undefined) return ack;

    // Fast verbal response, kicked off but NOT awaited.
    //
    // D4: awaiting here serialized the whole turn behind a Fish round-trip —
    // every utterance paid the full synthesis latency in dead air before
    // planning even started. It is also fire-and-forget by design: the audible
    // reply is the daemon's `onUtterance` path, so nothing here blocks on it.
    // The catch is mandatory: an unhandled rejection in a detached promise
    // takes down the daemon process, not one turn. No transcript or key
    // material is logged — only the failure class and message.
    void this.deps.speak?.(ack.replyAr)?.catch((err: unknown) => {
      console.error(
        JSON.stringify({
          evt: 'coordinator-speak-failed',
          error: err instanceof Error ? err.message : 'unknown',
        }),
      );
    });

    return await this.plan(ack, {
      ...(opts.approve !== undefined ? { approve: opts.approve } : {}),
      ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    });
  }
}
