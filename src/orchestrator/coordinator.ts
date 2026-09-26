import { z } from 'zod';
import type { SessionId } from '../common/brands.js';
import { extractJson, requiresConfirmation } from '../voice/brain.js';

// P5 runtime orchestration — the 3-agent chain as executable code:
// Dots3 intake ({reply_ar, task_en}) → Nemotron plan (task DAG) → Inkling
// handoff dispatched to the active OpenCode session. The fast verbal reply is
// spoken before planning completes; every malformed model output becomes a
// structured failure, never an escape; destructive plans honor FR-12.
export const INTAKE_MODEL = 'dots-studio/dots-3-note-preview:free';
export const COORDINATOR_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';

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

const INTAKE_SYSTEM = [
  'You take Arabic voice transcripts and split them into two fields.',
  'Reply ONLY with this exact JSON, no prose outside it, no preamble:',
  '{"reply_ar": "<short natural Ammani Arabic acknowledgement, max 20 words>", "task_en": "<precise English task specification>"}',
].join('\n');

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

  async run(transcript: string, opts: { approve?: boolean; taskId?: string } = {}): Promise<MissionResult> {
    const intakeModel = this.deps.intakeModel ?? INTAKE_MODEL;
    const fallbackModel = this.deps.fallbackModel ?? COORDINATOR_MODEL;
    const coordinatorModel = this.deps.coordinatorModel ?? COORDINATOR_MODEL;

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
          INTAKE_SYSTEM,
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

    // Fast verbal response first — the user hears back before planning lands.
    await this.deps.speak?.(intake.reply_ar);

    let planRaw: string | null = null;
    try {
      // Planning is background work: generous ceiling so a slow model still
      // delivers (intake keeps the tight budget for fast failover instead).
      // Strict schema mode — plain json_object lets the model drift into prose.
      planRaw = await this.deps.chat(coordinatorModel, COORDINATOR_SYSTEM, intake.task_en, {
        timeoutMs: 25_000,
        temperature: 0.2,
        maxTokens: 300,
        responseFormat: PLAN_RESPONSE_FORMAT,
      });
    } catch {
      planRaw = null;
    }
    let plan = planRaw === null ? null : parseSchema(PlanSchema, planRaw);
    if (plan === null) {
      // One bounded retry with a sterner format reminder. No unbounded loops.
      try {
        const retry = await this.deps.chat(
          coordinatorModel,
          `${COORDINATOR_SYSTEM}\nCRITICAL: output ONLY the JSON object. Any prose invalidates the entire response.`,
          intake.task_en,
          { timeoutMs: 25_000, temperature: 0.2, maxTokens: 300, responseFormat: PLAN_RESPONSE_FORMAT },
        );
        plan = parseSchema(PlanSchema, retry);
      } catch {
        plan = null;
      }
    }
    if (plan === null) {
      return { ok: false, replyAr: intake.reply_ar, taskEn: intake.task_en, receipt: null, detail: 'plan-invalid' };
    }

    const flagged = plan.steps.filter((s) => requiresConfirmation(`${s.kind} ${s.detail}`)).map((s) => s.id);
    if (flagged.length > 0 && opts.approve !== true) {
      return {
        ok: false,
        replyAr: intake.reply_ar,
        taskEn: intake.task_en,
        plan,
        receipt: null,
        intakeModel: servedBy,
        needsConfirmation: true,
        flagged,
        detail: `destructive steps held: ${flagged.join(', ')}`,
      };
    }

    const session = this.deps.activeSessionId();
    if (session === undefined) {
      return { ok: true, replyAr: intake.reply_ar, taskEn: intake.task_en, plan, receipt: null, intakeModel: servedBy };
    }
    const taskId = opts.taskId ?? `mission-${Date.now().toString(36)}`;
    const { receipt } = await this.deps.dispatch(buildHandoff(taskId, intake.task_en, session, plan.steps));
    return { ok: true, replyAr: intake.reply_ar, taskEn: intake.task_en, plan, receipt, intakeModel: servedBy };
  }
}