import { z } from 'zod';
import { extractJson } from '../voice/brain.js';

// PHASE B — the contextual addressee gate and the contextual permission slot.
//
// WHY A MODEL AND NOT A LIST. The requirement is that the assistant judges from
// the conversational context whether it is being addressed. The only honest
// implementation of that on this stack is a model call: `slash.ts` matches a
// literal `/` prefix, `mentions.ts` matches a literal `@`, and
// `isActionableInstruction` matches a 19-word acknowledgement set. All three
// are correct about what they DO and useless for this — "شو رأيك" and
// "ممكن تساعدني" and "طيب يا هلا" are all addressed and none of them is a
// template anyone can enumerate.
//
// WHAT COMPOSES AND WHAT IS REPLACED. Nothing is replaced. `slash.ts` runs in
// `daemon.ts` BEFORE `think()` reaches intake, so a slash never reaches this
// module; `mentions.ts` resolves `@file`/`@agent`/`@skill` before any model
// sees the text, and their presence is passed here as evidence the user IS
// addressing the assistant; `isActionableInstruction` runs before intake, so
// "تمام" never arrives. FR-12's destructive hold lives in `plan()` AFTER this
// gate and is strictly additional — a destructive plan still needs its own
// confirmation even after the user approves this one.
//
// FAIL CLOSED, STRUCTURALLY. `decision` has no value that leads to a dispatch.
// The only route to `deps.dispatch` is a permission slot that was opened on an
// earlier turn and CONSUMED by this one. A classifier that throws, times out,
// returns prose, or returns an unknown value lands on `undecided`, which asks.
// There is no "default to proceed" anywhere in this file, and there is no
// standing grant: the slot holds one action and is deleted before the dispatch
// it authorises, so a crash mid-dispatch leaves nothing to retry with.

export type AddresseeDecision =
  /** A question. Answer verbally; nothing is sent anywhere. */
  | 'answer'
  /** A task. Ask permission first; nothing is sent this turn. */
  | 'ask_permission'
  /** Not addressed to the assistant (self-talk, a note to a colleague). */
  | 'not_addressed'
  /** The gate could not decide. Treated exactly like `ask_permission`. */
  | 'undecided'
  /** The user approved the pending ask. Authorises ONE dispatch, once. */
  | 'approve'
  /** The user declined. Closes the ask; authorises nothing. */
  | 'deny';

/**
 * Strict schema, like every other model contract in this tree.
 *
 * `approves_id` is the load-bearing field and the reason this cannot degrade
 * into a standing "yes": the model must name WHICH ask it is approving, and the
 * id is checked against the live slot. A model that says `approve` with an
 * empty or stale id has approved nothing, which is the fail-closed direction.
 */
export const ADDRESSEE_SCHEMA = z.object({
  addressed: z.boolean(),
  needs_opencode: z.boolean(),
  decision: z.enum(['answer', 'ask_permission', 'not_addressed', 'undecided', 'approve', 'deny']),
  /** One short Ammani Arabic line, written from the situation. Never a template. */
  ask_ar: z.string(),
  /** Empty unless `decision` is `approve`. */
  approves_id: z.string(),
  reason_en: z.string(),
});

export const ADDRESSEE_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'addressee_verdict',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        addressed: { type: 'boolean' },
        needs_opencode: { type: 'boolean' },
        decision: {
          type: 'string',
          enum: ['answer', 'ask_permission', 'not_addressed', 'undecided', 'approve', 'deny'],
        },
        ask_ar: { type: 'string' },
        approves_id: { type: 'string' },
        reason_en: { type: 'string' },
      },
      required: ['addressed', 'needs_opencode', 'decision', 'ask_ar', 'approves_id', 'reason_en'],
      additionalProperties: false,
    },
  },
};

/** Decoding controls. `effort:none` is mandatory for Inkling (see `brain.ts`). */
export const ADDRESSEE_CHAT_OPTIONS = {
  reasoning: { effort: 'none' },
  maxTokens: 250,
  temperature: 0,
  timeoutMs: 6_000,
} as const;

/**
 * How long an unanswered ask stays approvable.
 *
 * Short on purpose. It is a spoken exchange: the user hears a question and
 * answers it in the next breath. A slot that outlives the conversation is a
 * standing permission with a delay on it, which is the exact thing this gate
 * exists to prevent.
 */
export const PERMISSION_TTL_MS = 30_000;

export interface PendingPermission {
  readonly id: string;
  /** The action, in the planner's English. Bound at ask time, not at approve. */
  readonly taskEn: string;
  readonly sessionId: string;
  readonly askAr: string;
  readonly openedAt: number;
}

export interface AddresseeVerdict {
  readonly decision: AddresseeDecision;
  readonly addressed: boolean;
  readonly askAr: string;
  readonly approvesId: string;
  readonly reasonEn: string;
}

/**
 * The system prompt. It carries the situation, the conversation so far and the
 * pending ask, and it states the two things a model gets wrong here: that
 * answering a question does NOT mean doing it, and that approving is a claim
 * about a SPECIFIC pending action rather than a mood.
 */
export function addresseeSystem(input: {
  readonly sessionTitle?: string;
  readonly currentAgent?: string;
  readonly pending?: PendingPermission;
}): string {
  const rows: string[] = [];
  if (input.sessionTitle !== undefined) rows.push(`session title: ${input.sessionTitle}`);
  if (input.currentAgent !== undefined) rows.push(`current agent: ${input.currentAgent}`);
  const situation = rows.length > 0 ? `SITUATION:\n${rows.join('\n')}\n\n` : '';

  const pending =
    input.pending === undefined
      ? ''
      : [
          'THERE IS A PENDING ASK the assistant already made. Decide whether the new',
          'utterance is the user answering THAT ask:',
          `  pending id: ${input.pending.id}`,
          `  pending action: ${input.pending.taskEn}`,
          'If the user is approving, set decision="approve" and set approves_id to that',
          'exact id. If they are declining, set decision="deny". If they are saying',
          'something else entirely, treat the new utterance on its own merits and do',
          'NOT approve anything.',
          '',
        ].join('\n');

  return [
    'You decide how an Arabic voice utterance addressed to an AI assistant should be',
    'handled. You are the addressee gate: your only job is to decide, never to act.',
    '',
    'Read the CONVERSATION, not just the latest line. The user may address the',
    'assistant directly, ask it something, refer to it in the third person, or be',
    'talking to a colleague who is not there.',
    '',
    'decide:',
    '- "answer": the user is asking the assistant a question or making conversation.',
    '  Answer it in your own words. This NEVER implies running anything.',
    '- "ask_permission": the user wants work done that needs OpenCode, a session',
    '  prompt, a tool call, or anything on the machine. Set ask_ar to ONE short',
    '  natural Ammani Arabic line asking whether to go ahead — in the user\'s own',
    '  situation, never a fixed phrase, never "تم تنفيذ".',
    '- "not_addressed": the utterance is not for the assistant at all.',
    '- "undecided": you genuinely cannot tell. Use it rather than guessing.',
    '',
    'THE TWO MISTAKES THAT MATTER MOST:',
    '1. A question is not a task. "شو رأيك" and "كيف أعمل هذا" are ANSWERS even',
    '   though answering well might take work. Only ask permission for something',
    '   that would touch OpenCode or the machine.',
    '2. Asking permission is not having it. Never set decide="ask_permission" and',
    '   assume the work proceeds.',
    '',
    situation,
    pending,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * Parse a gate reply. Anything unrecognised is `undecided` — never a proceed.
 *
 * The one deliberate coercion is a `deny` that arrives while nothing is
 * pending: it stays `deny` and consumes nothing, because a user saying "لا" to
 * silence is not an error and must not open an ask.
 */
export function parseAddressee(raw: string): AddresseeVerdict {
  const UNDECIDED: AddresseeVerdict = {
    decision: 'undecided',
    addressed: true,
    askAr: '',
    approvesId: '',
    reasonEn: 'unparseable',
  };
  const candidate = extractJson(raw);
  if (candidate === null) return UNDECIDED;
  const parsed = ADDRESSEE_SCHEMA.safeParse(candidate);
  if (!parsed.success) return UNDECIDED;
  const d = parsed.data;
  return {
    decision: d.decision,
    addressed: d.addressed,
    askAr: d.ask_ar,
    // Only an approval may carry an id. A stale id on any other decision is
    // dropped here rather than trusted downstream.
    approvesId: d.decision === 'approve' ? d.approves_id : '',
    reasonEn: d.reason_en,
  };
}

export interface PermissionSlotOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly newId?: () => string;
}

/**
 * ONE pending permission at a time, bound to ONE action.
 *
 * Single-slot is a design choice, not a limitation of the data structure. A
 * voice turn is a queue of one: while an ask is outstanding the only sensible
 * next thing the user can say is the answer to it. Two live asks would mean
 * the user had to disambiguate out loud which of two actions they were
 * approving, and "approve the first one" is exactly the standing permission
 * this is built to refuse.
 */
export class PermissionSlot {
  private pending: PendingPermission | null = null;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly newId: () => string;

  constructor(options: PermissionSlotOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? PERMISSION_TTL_MS;
    this.newId = options.newId ?? defaultId;
  }

  /** The live ask, or null when there is none or it has expired. */
  current(): PendingPermission | null {
    const p = this.pending;
    if (p === null) return null;
    if (this.now() - p.openedAt > this.ttlMs) {
      this.pending = null;
      return null;
    }
    return p;
  }

  /** Open an ask for `taskEn`. Replaces any existing one. */
  open(taskEn: string, sessionId: string, askAr: string): PendingPermission {
    const opened: PendingPermission = {
      id: this.newId(),
      taskEn,
      sessionId,
      askAr,
      openedAt: this.now(),
    };
    this.pending = opened;
    return opened;
  }

  /**
   * Take the ask, but ONLY if the approval names it and has not expired.
   *
   * DELETES BEFORE IT RETURNS. The caller then holds an action it is
   * authorised to run exactly once. A `dispatch` that throws afterwards leaves
   * an empty slot, not a half-applied permission — the difference between "the
   * user said yes and the machine was down" and "the user's yes survived and
   * fires later against something else".
   */
  consume(approvesId: string): PendingPermission | null {
    const p = this.current();
    if (p === null) return null;
    if (p.id !== approvesId) return null;
    this.pending = null;
    return p;
  }

  /** Close the ask without acting (a denial, an abort, a superseding turn). */
  clear(): void {
    this.pending = null;
  }
}

function defaultId(): string {
  const c = globalThis.crypto;
  if (c !== undefined && typeof c.randomUUID === 'function') return c.randomUUID();
  // Non-secure fallback: the id is a correlation token inside one process, not
  // a capability. Nothing is authorised by guessing it — `consume` also checks
  // the slot still holds it.
  return `perm-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
