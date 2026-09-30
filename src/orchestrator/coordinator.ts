import { z } from 'zod';
import type { SessionId } from '../common/brands.js';
import { redactString } from '../common/logger.js';
import { extractJson, requiresConfirmation } from '../voice/brain.js';
import {
  ADDRESSEE_CHAT_OPTIONS,
  ADDRESSEE_RESPONSE_FORMAT,
  PermissionSlot,
  addresseeSystem,
  parseAddressee,
  type PendingPermission,
} from './permission.js';

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

/**
 * The gate's own transport budget, in ms.
 *
 * WHY THIS OVERRIDES `ADDRESSEE_CHAT_OPTIONS.timeoutMs` RATHER THAN EDITING IT.
 * `ADDRESSEE_CHAT_OPTIONS` (permission.ts) is a shared decoding bundle: the
 * offline intent table in `cli/intents.ts` reproduces it verbatim so the table
 * measures the gate. A budget is a decision about the LIVE gate's blocking
 * behaviour, and the live gate is here, immediately in front of the only
 * `deps.dispatch` call in the tree. So the override sits at the call site and
 * the shared bundle is left alone. The cost of that split is that
 * `cli/intents.ts`'s "exactly the triple the gate builds" comment is now one
 * component out of date — it measures the gate at the OLD 6 s budget. Reported,
 * not silently absorbed; fixing that file was outside this change's write set.
 *
 * WHY 12,000 AND NOT THE 6,000 THAT WAS THERE. Measured 2026-09-30 against
 * `thinkingmachines/inkling:free` on this exact path — `addresseeSystem()` +
 * `ADDRESSEE_RESPONSE_FORMAT` strict schema, 31 completed calls across three
 * sessions: min 3264, p50 4349, p90 5537, max 6607 ms. Under the shipped 6 s
 * ceiling 3 of those calls aborted at ~6.01 s (6011 / 6013 / 6019), which is
 * the same cliff the live turn hit: `BRAIN_TIMEOUT` → `gate-unavailable` →
 * nothing dispatched, on a model whose p50 is 4.3 s. The product's only egress
 * was being closed by a budget that fired on roughly one turn in ten.
 *
 * Those 3 samples are TRUNCATED, so the tail is bounded below and not above —
 * 12 s is a budget, not a claim that nothing is slower. 12 s is ~1.8x the
 * slowest completion ever observed (6607 ms) and follows the narrator precedent
 * (8 s → 12 s after three ~5 s measurements). It is deliberately generous
 * because the error is ASYMMETRIC: a ceiling that is too low does not make the
 * gate slower, it fails the gate CLOSED and the user gets no dispatch at all
 * (FR-12 is preserved — `gate()` catches, asks, and never reaches dispatch),
 * while a ceiling that is too high costs latency on a rare path and nothing on
 * a common one. Free-tier latency is documented in this repo as slow and
 * lossy — re-measure, do not assume — so the budget carries headroom.
 */
export const GATE_TIMEOUT_MS = 12_000;

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

/**
 * M2 Pattern 6a — the outcome-claim detector.
 *
 * `تم` + a completion verb is a claim about work that has NOT happened: the
 * acknowledgement is spoken ~1.4 s after the user stops talking and before the
 * planner has been called, so a result reported here is a lie with a timestamp.
 *
 * Two deliberate narrownesses. (1) The verb list is spelled out instead of a
 * character range — a range across Arabic letters is the same defect as the
 * dash range that ate the port number in `normalizeArabic`. (2) `تم` must be
 * followed by whitespace, which is the entire difference between a result claim
 * ("تم تنفيذ") and 'تمام' ("okay"). Under-matching is the right failure here:
 * it silences one line, where a broad detector silences every healthy turn.
 *
 * The text is folded to a throwaway copy (tashkeel and tatweel removed, alef
 * variants collapsed) purely so ONE spelling matches several. The returned
 * line is never touched — the guard drops, it never edits: a filter over
 * Arabic produces a mangled half-sentence, which is worse than silence.
 */
const OUTCOME_VERBS = [
  'تنفيذ', 'تبديل', 'تشغيل', 'تغيير', 'تحديث', 'حذف', 'اضافة', 'انشاء', 'اصلاح', 'فتح',
  'اغلاق', 'تعديل', 'تطبيق', 'تفعيل', 'تعطيل', 'ايقاف', 'تثبيت', 'اكمال', 'الغاء', 'ادخال',
  'اعادة', 'ترتيب', 'ترقية', 'رفع', 'انزال', 'نسخ', 'ازالة', 'متابعة', 'انتهى', 'انتهت', 'بنجاح',
].join('|');
const OUTCOME_CLAIM_AR = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])تم[\\u0640\\u064B-\\u0652\\u0670]?\\s+(?:${OUTCOME_VERBS})(?![\\p{L}])`,
  'u',
);
/** The same defect spoken in English, for the mixed technical acknowledgements. */
const OUTCOME_CLAIM_EN = /\b(?:done|completed|finished|executed|deployed)\b/i;

function foldArabic(text: string): string {
  return text
    .replace(/[\u0640\u064B-\u0652\u0670]/g, '')
    .replace(/[آأإٱ]/g, 'ا');
}

/** True when the line reports an outcome, i.e. something that has not run yet. */
function claimsOutcome(replyAr: string): boolean {
  const folded = foldArabic(replyAr);
  return OUTCOME_CLAIM_AR.test(folded) || OUTCOME_CLAIM_EN.test(folded);
}

/** Appended on the single re-ask: the same rule, restated as the reason. */
const REASK_CONSTRAINT = [
  '',
  'The previous reply_ar REPORTED A RESULT. Nothing has run yet — no step has',
  'been planned, nothing has been dispatched, nothing has changed on disk. Say',
  'only that you are about to look into it, in the same voice, no outcome.',
].join('\n');

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
  '- You are the FIRST step of the turn, so nothing has run yet: acknowledge only,',
  '  never state an outcome — no "تم تنفيذ", no "تم تغيير", no "done"/"completed",',
  '  whatever the tone. The result is narrated later, by whatever actually ran.',
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
  /**
   * Phase B — the ask was raised and NOTHING was dispatched. The daemon uses
   * this to put the assistant's own line in front of the user immediately;
   * the coordinator never speaks it itself (see the D4 note on `speak`).
   */
  readonly onPermissionRequired?: (pending: PendingPermission) => void;
  /** Clock, for the permission TTL. Injected so expiry is testable. */
  readonly now?: () => number;
  /** Permission TTL override. */
  readonly permissionTtlMs?: number;
  /** Permission id source. */
  readonly newPermissionId?: () => string;
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
  /**
   * Phase B — the turn needed permission to touch OpenCode and did not get it.
   * `ok` is FALSE: nothing ran, and a result that reads `ok: true` here would
   * be the `layaReady: false` defect in a new place.
   */
  readonly needsPermission?: boolean;
  /** The assistant's own Arabic ask, so a caller can render it verbatim. */
  readonly permissionAskAr?: string;
  /** Correlation id of the open ask. Approving requires naming exactly this. */
  readonly permissionId?: string;
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
  /**
   * Phase B — the user's own words for this turn. The gate needs the UTTERANCE
   * to judge address, not just the planner's English restatement of it: "أعملها
   * هاي" and "do it" are the same task and read nothing alike, and a gate that
   * only ever saw `task_en` would be judging the planner's paraphrase of the
   * user rather than the user.
   *
   * Optional, and additive: `TaskQueue`'s `TaskRecord` has always carried the
   * verbatim transcript, so a caller that does not pass it simply makes the gate
   * fall back to the task specification.
   */
  readonly transcript?: string;
  /**
   * Peer review (D2): true when the 6a re-ask ran, so a ~2 s intake row is
   * distinguishable from a single call. The daemon logs it; without this a
   * re-ask silently doubles a recorded latency with nothing saying which.
   */
  readonly reasked?: boolean;
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
  /**
   * Phase B — the one live permission, owned per Coordinator.
   *
   * Per-INSTANCE rather than per-daemon on purpose. `rebuildVoice()` constructs
   * a new `Coordinator` on every key save, so a rebuild drops the slot: an ask
   * outstanding across a key save is answered with another ask. That is the
   * fail-closed direction and it is also the honest one — the user was holding
   * the keys screen when it happened, and re-asking costs one sentence while a
   * module-level singleton would let a permission outlive the pipeline that
   * earned it.
   */
  private readonly permission: PermissionSlot;

  constructor(private readonly deps: CoordinatorDeps) {
    this.permission = new PermissionSlot({
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.permissionTtlMs !== undefined ? { ttlMs: deps.permissionTtlMs } : {}),
      ...(deps.newPermissionId !== undefined ? { newId: deps.newPermissionId } : {}),
    });
  }

  /** The outstanding ask, if any. Diagnostics and tests. */
  get pendingPermission(): PendingPermission | null {
    return this.permission.current();
  }

  /**
   * Phase B — the contextual addressee + permission gate.
   *
   * IT LIVES HERE, immediately in front of `deps.dispatch`, for four reasons
   * that are structural rather than stylistic:
   *
   *  1. `deps.dispatch` is called from EXACTLY ONE place in the tree — this
   *     method's last two lines. `client.promptSession` (the 4096 egress) is
   *     reached from exactly one place too: the daemon's `dispatch` dep. A
   *     gate anywhere else is a gate with a gap behind it.
   *  2. It runs BEFORE the planning call, not after. Placing it after `plan()`
   *     would still be safe for dispatch, but it would spend a 25 s free-tier
   *     budget ×2 retries deciding something the user never asked for.
   *  3. It covers every caller. The queue planner calls `plan()` directly and
   *     the `VOXAURA_TASK_QUEUE=off` kill-switch calls `run()`, which calls
   *     `plan()`. One interception point, both entry paths.
   *  4. The daemon already keeps the state that must outlive a rebuild
   *     (`speechGate`, `ttsCredit`, the task queue); the permission is
   *     deliberately NOT there, because losing it is the safe failure.
   *
   * FAIL CLOSED: every exit below except `proceed` returns without dispatching,
   * and `proceed` is reachable only through `permission.consume()`, which
   * deletes the slot before it hands the action back.
   */
  private async gate(opts: {
    readonly taskEn: string;
    readonly transcript: string;
    readonly aborted: () => boolean;
    readonly base: { readonly replyAr: string; readonly intakeModel?: string };
  }): Promise<{ readonly kind: 'proceed'; readonly taskEn: string } | { readonly kind: 'stop'; readonly result: MissionResult }> {
    const base = opts.base;
    const session = this.deps.activeSessionId();

    // NOTE ON THE NO-SESSION CASE. An earlier revision of this gate returned
    // early when there was no active session, which skipped the planning call
    // and cost a 25 s free-tier budget that produced nothing. It was removed:
    // `plan()` already has a no-session guard further down, that guard returns
    // the PLAN to its caller, and a test pins the shape of that result. Trading
    // a documented contract for an optimisation nobody measured is the wrong
    // direction, and the wasted call is the same one the old code already spent.
    void session;

    const pending = this.permission.current();
    let raw: string;
    try {
      raw = await this.deps.chat(
        this.deps.coordinatorModel ?? COORDINATOR_MODEL,
        addresseeSystem(pending !== null ? { pending } : {}),
        `${opts.transcript}\n\nTASK SPECIFICATION:\n${opts.taskEn}`,
        // `timeoutMs` LAST so it overrides the shared bundle's 6 s. See
        // `GATE_TIMEOUT_MS` for the measurement; the short version is that a
        // 6 s ceiling aborted ~1 turn in 10 against a 4.3 s p50, and the gate
        // fails closed, so every one of those was a turn that dispatched
        // nothing. The spread order matters and is load-bearing: move
        // `timeoutMs` above the spread and this silently reverts to 6 s.
        { ...ADDRESSEE_CHAT_OPTIONS, responseFormat: ADDRESSEE_RESPONSE_FORMAT, timeoutMs: GATE_TIMEOUT_MS },
      );
    } catch {
      // Undecidable. Asking is the safe direction for BOTH misreads: a task we
      // swallowed silently is work the user asked for and never got, and a
      // question we dispatched is a prompt sent to a coding agent on a guess.
      //
      // STILL FAIL-CLOSED AT 12 s, and that is the property this budget must
      // not buy its way out of. Raising the ceiling raises WHEN a genuine
      // timeout is detected, never WHETHER it is: this catch is unchanged, it
      // still returns without touching `deps.dispatch`, and `proceed` remains
      // reachable only through `permission.consume()`. A slow gate that failed
      // OPEN would be the far worse defect — it would send a prompt to a
      // coding agent with nobody's approval.
      return this.ask(opts, session, 'تحتاج إذنك قبل ما أبعت أي شي لـ OpenCode؟', 'gate-unavailable');
    }
    if (opts.aborted()) {
      return {
        kind: 'stop',
        result: { ok: false, replyAr: base.replyAr, taskEn: opts.taskEn, receipt: null, cancelled: true, detail: 'cancelled' },
      };
    }

    const verdict = parseAddressee(raw);

    if (verdict.decision === 'deny') {
      this.permission.clear();
      return {
        kind: 'stop',
        result: {
          ok: false,
          replyAr: base.replyAr,
          taskEn: opts.taskEn,
          receipt: null,
          ...(base.intakeModel !== undefined ? { intakeModel: base.intakeModel } : {}),
          detail: 'permission-denied',
        },
      };
    }

    if (verdict.decision === 'approve') {
      // The ONLY exit that can dispatch. `consume` requires an exact id match
      // and deletes the slot before returning, so this is single-use.
      const consumed = this.permission.consume(verdict.approvesId);
      if (consumed === null) {
        // Said yes to nothing. Re-ask rather than guess what "yes" meant.
        return this.ask(opts, session, verdict.askAr, 'approval-unbound');
      }
      if (opts.aborted()) {
        return {
          kind: 'stop',
          result: { ok: false, replyAr: base.replyAr, taskEn: consumed.taskEn, receipt: null, cancelled: true, detail: 'cancelled' },
        };
      }
      return { kind: 'proceed', taskEn: consumed.taskEn };
    }

    if (verdict.decision === 'answer') {
      return {
        kind: 'stop',
        result: {
          ok: true,
          replyAr: base.replyAr,
          taskEn: opts.taskEn,
          receipt: null,
          ...(base.intakeModel !== undefined ? { intakeModel: base.intakeModel } : {}),
          detail: `answered-verbally (${verdict.reasonEn})`,
        },
      };
    }

    if (verdict.decision === 'not_addressed') {
      return {
        kind: 'stop',
        result: {
          ok: false,
          replyAr: base.replyAr,
          taskEn: opts.taskEn,
          receipt: null,
          ...(base.intakeModel !== undefined ? { intakeModel: base.intakeModel } : {}),
          detail: `not-addressed (${verdict.reasonEn})`,
        },
      };
    }

    // `ask_permission`, `undecided`, and anything `parseAddressee` could not
    // classify all land here. There is deliberately no fourth branch.
    return this.ask(opts, session, verdict.askAr, verdict.decision === 'undecided' ? 'gate-undecided' : 'permission-required');
  }

  /** Open (or re-open) the ask. Never dispatches. The single raise point. */
  private ask(
    opts: { readonly taskEn: string; readonly base: { readonly replyAr: string; readonly intakeModel?: string } },
    session: SessionId | undefined,
    askAr: string,
    detail: string,
  ): { readonly kind: 'stop'; readonly result: MissionResult } {
    const line = askAr.trim().length > 0 ? askAr.trim() : 'أرسل للـ OpenCode؟';
    // `session` is diagnostic here, not a precondition: the live-session guard
    // lives further down in `plan()` and owns that decision. `''` rather than
    // a throw, so a session that vanished between the two checks degrades into
    // a slot with no session on it instead of taking the turn down.
    const pending = this.permission.open(opts.taskEn, session ?? '', line);
    this.deps.onPermissionRequired?.(pending);
    return {
      kind: 'stop',
      result: {
        ok: false,
        replyAr: opts.base.replyAr,
        taskEn: opts.taskEn,
        receipt: null,
        ...(opts.base.intakeModel !== undefined ? { intakeModel: opts.base.intakeModel } : {}),
        needsPermission: true,
        permissionAskAr: line,
        permissionId: pending.id,
        detail,
      },
    };
  }

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

    // M2 Pattern 6a — the acknowledgement is written before anything has run,
    // so a line reporting an outcome is unearned. One bounded re-ask with the
    // constraint restated; if that still claims a result the line is DROPPED.
    //
    // `''` rather than `undefined` is the drop marker, and it is deliberate on
    // two counts. `undefined` would read as a failed intake to the daemon
    // (`daemon.ts` checks `ack.replyAr === undefined` before enqueuing) and
    // throw away work the user asked for; `''` keeps `ok: true` and `task_en`,
    // so the task still plans and dispatches — only the lie is withheld.
    // Downstream it is silent by existing contract: `isSpeakable('')` is false,
    // so `onUtterance` returns before synthesising, the `narrate() → null`
    // precedent. The FIRST ack's `task_en` is kept even when the re-ask is
    // clean: the re-ask is about one sentence, not a re-specification.
    let replyAr = intake.reply_ar;
    let reasked = false;
    if (claimsOutcome(replyAr)) {
      reasked = true;
      const reask = await this.reaskIntake(transcript, opts.context, servedBy);
      replyAr = reask !== null && !claimsOutcome(reask.reply_ar) ? reask.reply_ar : '';
    }
    return {
      ok: true,
      replyAr,
      taskEn: intake.task_en,
      receipt: null,
      intakeModel: servedBy,
      transcript,
      ...(reasked ? { reasked: true as const } : {}),
    };
  }

  /**
   * M2 Pattern 6a — the single re-ask. Same model that produced the claiming
   * ack (the failover model is not a second opinion on one sentence), same
   * decoding controls, so the retry cannot change how the leg is measured.
   *
   * Peer review (D1): 3 s, not the 10 s intake budget — only a cosmetic
   * sentence is at stake, and a 10 s re-ask would regress the §2.3 "ack
   * ≈1.4 s" budget to ~2.3 s of silence on exactly the turn this guard
   * exists for.
   *
   * A throw or an unparseable body resolves to `null`, which the caller reads
   * as "drop the ack": spending a third call to rescue a sentence the user is
   * about to hear over the plan would trade the latency budget for cosmetics.
   */
  private async reaskIntake(
    transcript: string,
    ctx: IntakeContext | undefined,
    model: string,
  ): Promise<Intake | null> {
    try {
      const raw = await this.deps.chat(
        model,
        `${intakeSystem(ctx)}\n${REASK_CONSTRAINT}`,
        transcript,
        { reasoning: { effort: 'none' }, maxTokens: 200, temperature: 0.2, timeoutMs: 3_000 },
      );
      return parseSchema(IntakeSchema, raw);
    } catch {
      return null;
    }
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

    // ── PHASE B GATE ────────────────────────────────────────────────────────
    // Before ANY planning call, and therefore before anything that could touch
    // OpenCode. See `gate()` for why this is the one place it belongs.
    //
    // `taskEn` is what gets planned and dispatched. On an approval it is
    // REPLACED by the pending action's own `taskEn`, so the dispatch below can
    // only ever run something the user was shown and agreed to.
    const transcript = ack.transcript ?? '';
    const gateVerdict = await this.gate({
      taskEn,
      transcript: transcript.length > 0 ? transcript : taskEn,
      aborted,
      base: servedBy !== undefined ? { replyAr, intakeModel: servedBy } : { replyAr },
    });
    if (gateVerdict.kind === 'stop') {
      return gateVerdict.result;
    }
    const approvedTaskEn = gateVerdict.taskEn;

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
    // `approvedTaskEn`, NOT `taskEn`. On an approving turn the planner is
    // building a plan for the action the user was SHOWN and agreed to, not for
    // whatever the approval utterance happened to be paraphrased into. This is
    // the last line before OpenCode and it is the only `deps.dispatch` call in
    // the tree.
    const { receipt } = await this.deps.dispatch(buildHandoff(taskId, approvedTaskEn, session, plan.steps));
    return { ok: true, replyAr, taskEn: approvedTaskEn, plan, receipt, ...(servedBy !== undefined ? { intakeModel: servedBy } : {}) };
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
    // M2 Pattern 6a: a dropped ack is `''`. `run()` is the pre-split path the
    // daemon only takes with the kill-switch off, and it speaks through its own
    // `speak` dep rather than `onUtterance`, so the `isSpeakable` skip that
    // makes the drop silent in the shipped path is not inherited here.
    if (ack.replyAr.length === 0) {
      // Peer review: narrow like the normal path below — passing the whole
      // opts today is inert (`plan` excludes `context`) but would diverge
      // silently the moment the option shapes change.
      return this.plan(ack, {
        ...(opts.approve !== undefined ? { approve: opts.approve } : {}),
        ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
      });
    }

    // Fast verbal response, kicked off but NOT awaited.
    //
    // D4: awaiting here serialized the whole turn behind a Fish round-trip —
    // every utterance paid the full synthesis latency in dead air before
    // planning even started. It is also fire-and-forget by design: the audible
    // reply is the daemon's `onUtterance` path, so nothing here blocks on it.
    // The catch is mandatory: an unhandled rejection in a detached promise
    // takes down the daemon process, not one turn. Nothing else about the
    // rejection is logged, and the message is scrubbed at the interpolation
    // below rather than trusted to arrive pre-scrubbed.
    void this.deps.speak?.(ack.replyAr)?.catch((err: unknown) => {
      console.error(
        JSON.stringify({
          evt: 'coordinator-speak-failed',
          // Redact at the interpolation, not at the caller: a Fish/whatever
          // rejection can carry any provider's message, and this is stderr a
          // human pastes into an issue. Idempotent, so a pre-scrubbed message
          // is not mangled twice.
          error: redactString(err instanceof Error ? err.message : 'unknown'),
        }),
      );
    });

    return await this.plan(ack, {
      ...(opts.approve !== undefined ? { approve: opts.approve } : {}),
      ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    });
  }
}
