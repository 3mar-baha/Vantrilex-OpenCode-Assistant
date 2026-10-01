import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';
import {
  Coordinator,
  PlanSchema,
  type ChatFn,
  type IntakeAck,
  type IntakeContext,
  type MissionResult,
  type Plan,
} from '../orchestrator/coordinator.js';
import {
  ADDRESSEE_CHAT_OPTIONS,
  ADDRESSEE_RESPONSE_FORMAT,
  PERMISSION_TTL_MS,
  parseAddressee,
  type AddresseeVerdict,
  type PendingPermission,
} from '../orchestrator/permission.js';

// HEADLESS BRAIN — the product's own coordinator, driven without a daemon.
//
// WHY THIS FILE EXISTS. Every number this runner prints has to be traceable to a
// module in `src/`. A scratch script that calls `fetch('http://127.0.0.1:4096')`
// measures OPENCODE, and stays green when the coordinator is gutted, the gate is
// inverted, or dispatch is dead. So the chain here is assembled from the shipped
// modules and nothing else:
//
//   Coordinator (src/orchestrator/coordinator.ts) — intake → gate → plan → dispatch
//   parseAddressee / addresseeSystem / ADDRESSEE_* (src/orchestrator/permission.ts)
//   ServeClient (src/runtime/client.ts) — the only HTTP egress, via the `dispatch` dep
//
// WHAT THE INSTRUMENTATION IS. `deps.chat` and `deps.dispatch` are the two seams
// `Coordinator` takes as constructor arguments, so wrapping them observes the real
// chain without editing a line of it. A stage is identified by the PRODUCT'S OWN
// objects, never by a guess at the prompt text:
//
//   gate  ⇔ `options.responseFormat === ADDRESSEE_RESPONSE_FORMAT`
//     A reference comparison against the same imported const, so it is identity,
//     not a heuristic. `coordinator.ts` imports it from `permission.ts`; so does
//     this file; one ESM instance, one object.
//   plan ⇔ a strict schema that is not the addressee one — only `plan()` sends
//     one (`PLAN_RESPONSE_FORMAT`, `coordinator.ts:817`).
//   intake-reask ⇔ no schema and the re-ask's own 3 s budget (`coordinator.ts:746`).
//   intake-failover ⇔ no schema and NO options object at all (the failover leg
//     passes `options: undefined`, `coordinator.ts:673`).
//   intake ⇔ no schema, with a budget — the primary intake (`coordinator.ts:672`).
//
// WHY THE MODEL IS NOT IN THAT LIST. Two of those slots once held different
// slugs, so the classifier used to compare `model` against `INTAKE_MODEL` /
// `COORDINATOR_MODEL`. A quota outage put both on one slug, the first branch
// swallowed every call, and `plan` became unassignable. Shape is a property of
// the CALL SITE and survives a slug swap; a slug is a config value that gets
// swapped for outage reasons. Do not "simplify" this back to a model comparison.
//
// WHAT IT WILL NOT DO. It does not decide anything. Every `decision` printed is
// `parseAddressee`'s, verbatim, from the reply the product itself received; every
// dispatch printed is one `deps.dispatch` call that actually ran. If the gate
// refuses, the trace says refused — there is no path here that can report a
// dispatch that did not happen.

/** Which model call a row is. Derived from the call's own arguments, as above. */
export type ChatStage = 'intake' | 'intake-reask' | 'intake-failover' | 'gate' | 'plan' | 'unclassified';

export interface ChatCall {
  readonly stage: ChatStage;
  readonly model: string;
  readonly ms: number;
  /** `'addressee'` when the call carried the gate's strict schema. */
  readonly schema: 'addressee' | 'none' | 'other';
  /** The raw completion, bounded. Never a key, never a header. */
  readonly raw: string;
  /** The thrown class/code when the call failed, else `null`. */
  readonly failure: string | null;
}

/**
 * One `deps.dispatch` call. `delivered` is the load-bearing half: a record exists
 * for every ATTEMPT, and `receipt === null` means serve never acknowledged it. A
 * record is not a success and must never be printed as one.
 */
export interface DispatchRecord {
  readonly text: string;
  readonly receipt: string | null;
  readonly state: string;
  readonly ms: number;
  readonly delivered: boolean;
  readonly failure: string | null;
}

export interface TurnTrace {
  readonly text: string;
  readonly ack: IntakeAck;
  readonly result: MissionResult;
  /** The product's own classification of the gate reply, or `null` if no gate call ran. */
  readonly gateVerdict: AddresseeVerdict | null;
  /** The slot the product opened, captured from `onPermissionRequired`. */
  readonly openedAsk: PendingPermission | null;
  /** The plan re-parsed through the product's `PlanSchema`; null when none was built. */
  readonly plan: Plan | null;
  /** Dispatches attributable to THIS turn (the shared ledger is sliced by index). */
  readonly dispatches: readonly DispatchRecord[];
  readonly chatCalls: readonly ChatCall[];
  /**
   * Why `plan()` threw, when it did.
   *
   * `plan()` propagates whatever `deps.dispatch` threw, so without this the only
   * record of a failed dispatch would be a stack trace out of the CLI — a crash
   * after the report, with a non-zero code and no explanation on screen. Catching
   * it here is what lets the trace say `delivered: false` and name the code, which
   * is the difference between a finding and a crash.
   */
  readonly dispatchError: string | null;
  /** Wall clock for the whole turn, intake through dispatch. */
  readonly ms: number;
}

export interface HeadlessBrainOptions {
  readonly chat: ChatFn;
  /** Read at dispatch time, so a session that appears later is honoured. */
  readonly activeSessionId: () => SessionId | undefined;
  /** The only egress. Throwing here is recorded, never swallowed. */
  readonly dispatch: (text: string) => Promise<{ receipt: string; state: string }>;
  readonly onPermissionRequired?: (pending: PendingPermission) => void;
  /**
   * Slot overrides, forwarded to `Coordinator`.
   *
   * Unset in production — the shipped constants are the point. They exist so a
   * test can drive the chain through BOTH configurations at once: distinct slots,
   * and the collided pair a quota outage produces. A classification guard that can
   * only ever see one configuration cannot claim to be independent of it.
   */
  readonly intakeModel?: string;
  readonly coordinatorModel?: string;
  readonly fallbackModel?: string;
}

/** Raw completions are logged, not archived; 4 KB is enough to read a verdict. */
const RAW_BOUND = 4_000;

function bound(text: string): string {
  return text.length <= RAW_BOUND ? text : `${text.slice(0, RAW_BOUND)}…`;
}

/**
 * One line naming the failure, with the product's own code where there is one.
 *
 * `OrchestratorError` is the case that matters: its `name` is always
 * `'OrchestratorError'`, so printing the name alone would report eight different
 * faults as one — and `BRAIN_TIMEOUT` (a 6 s budget exceeded) against
 * `BRAIN_AUTH` (a rejected key) is exactly the distinction an operator needs.
 */
function failureLabel(err: unknown): string {
  if (err instanceof OrchestratorError) return `${err.code}: ${err.secretSafeMessage.slice(0, 120)}`;
  if (err instanceof Error) return err.name === 'Error' ? err.message.slice(0, 120) : err.name;
  return 'non-error throw';
}

/**
 * The real coordinator plus a ledger of what it did.
 *
 * ONE INSTANCE SPANS THE WHOLE CONVERSATION on purpose. `Coordinator` owns the
 * `PermissionSlot` per instance (`coordinator.ts:328`), so a fresh instance per
 * turn would delete the pending ask and the approval turn could never consume it
 * — the runner would report a gate that cannot be satisfied when the product's can.
 */
export class HeadlessBrain {
  private readonly coordinator: Coordinator;
  private readonly chatCalls: ChatCall[] = [];
  private readonly dispatches: DispatchRecord[] = [];
  private openedAsk: PendingPermission | null = null;
  /** Bumped once per turn, so a slot opened by an EARLIER turn is not re-reported. */
  private askSeq = 0;
  /** The value `askSeq` held when the current slot was opened. */
  private askAtOpen: number | null = null;
  private dispatchCursor = 0;

  constructor(private readonly options: HeadlessBrainOptions) {
    this.coordinator = new Coordinator({
      chat: this.instrumentedChat,
      dispatch: this.instrumentedDispatch,
      activeSessionId: options.activeSessionId,
      ...(options.intakeModel !== undefined ? { intakeModel: options.intakeModel } : {}),
      ...(options.coordinatorModel !== undefined ? { coordinatorModel: options.coordinatorModel } : {}),
      ...(options.fallbackModel !== undefined ? { fallbackModel: options.fallbackModel } : {}),
      // ALWAYS wired, not only when the caller supplied a hook. The ask is the
      // load-bearing output of this whole file: a trace that reported a turn as
      // "nothing dispatched" without also reporting WHETHER THE GATE ASKED would
      // be indistinguishable from a turn where the gate was never reached. Wiring
      // it conditionally made `openedAsk` null in exactly the cases a reader most
      // needs it — a test or a caller with no UI to notify.
      onPermissionRequired: (pending) => {
        this.openedAsk = pending;
        this.askAtOpen = this.askSeq;
        options.onPermissionRequired?.(pending);
      },
    });
  }

  /** The product's own view of the outstanding ask. The slot is a public getter. */
  get pendingPermission(): PendingPermission | null {
    return this.coordinator.pendingPermission;
  }

  /** Whether an ask was ever raised in this conversation. */
  get slotEverOpened(): boolean {
    return this.openedAsk !== null;
  }

  /** The live call ledger, and the dispatch ledger, for reporting. */
  get ledger(): { readonly calls: readonly ChatCall[]; readonly dispatches: readonly DispatchRecord[] } {
    return { calls: this.chatCalls, dispatches: this.dispatches };
  }

  private readonly instrumentedChat: ChatFn = async (model, system, user, options) => {
    const at = Date.now();
    const schemaKind: ChatCall['schema'] =
      options?.responseFormat === ADDRESSEE_RESPONSE_FORMAT ? 'addressee' : options?.responseFormat === undefined ? 'none' : 'other';
    let stage: ChatStage = 'unclassified';
    // WHY SHAPE, NOT SLUG. The obvious classifier is `model === INTAKE_MODEL` /
    // `model === COORDINATOR_MODEL`, and it was exactly that. A quota outage put
    // both slots on the same slug, so the first `if` swallowed every call and the
    // coordinator branch became unreachable dead code — `stage` could never be
    // `'plan'`, which silently broke `lastPlanOf` and printed `approve.plan ===
    // null` for a plan the chain had actually built. A model slug is a CONFIG
    // VALUE that gets swapped for outage reasons; the request's SHAPE is what each
    // call site is for. So shape decides, and the model is not consulted at all —
    // every branch below is true regardless of which slug answered.
    if (schemaKind === 'addressee') {
      // The gate is the only caller passing the addressee schema — identity
      // against the shared const, not a heuristic.
      stage = 'gate';
    } else if (schemaKind === 'other') {
      // A strict schema that is NOT the gate's. Only `plan()` sends one
      // (`PLAN_RESPONSE_FORMAT`, coordinator.ts:283/817). Intentionally does not
      // compare the schema object to that const: this file does not import it, and
      // `'other'` already means "some schema the gate did not ask for".
      stage = 'plan';
    } else if (options?.timeoutMs === 3_000) {
      // The re-ask is the primary intake's shape with a 3 s budget instead of 10 s
      // (coordinator.ts:746 vs :672), and it goes to the same model that produced
      // the claiming ack. Only the budget separates the two legs.
      stage = 'intake-reask';
    } else if (options === undefined) {
      // The failover leg passes NO options object at all (`coordinator.ts:673`),
      // while the primary intake always passes a budget. That is the shape
      // difference, and it holds even when both slots name the same model — a
      // slug comparison cannot distinguish these two legs at all under a
      // collision, because there is only one slug to compare.
      stage = 'intake-failover';
    } else {
      // The primary intake: no schema, and a budget — the only remaining shape.
      stage = 'intake';
    }
    try {
      const raw = await this.options.chat(model, system, user, options);
      this.chatCalls.push({ stage, model, ms: Date.now() - at, schema: schemaKind, raw: bound(raw), failure: null });
      return raw;
    } catch (err) {
      this.chatCalls.push({
        stage,
        model,
        ms: Date.now() - at,
        schema: schemaKind,
        raw: '',
        failure: failureLabel(err),
      });
      throw err;
    }
  };

  private readonly instrumentedDispatch = async (text: string): Promise<{ receipt: string }> => {
    const at = Date.now();
    try {
      const result = await this.options.dispatch(text);
      this.dispatches.push({
        text,
        receipt: result.receipt,
        state: result.state,
        ms: Date.now() - at,
        delivered: true,
        failure: null,
      });
      return { receipt: result.receipt };
    } catch (err) {
      this.dispatches.push({
        text,
        receipt: null,
        state: 'failed',
        ms: Date.now() - at,
        delivered: false,
        failure: failureLabel(err),
      });
      throw err;
    }
  };

  /** One turn: intake, then the gate, then the plan, then dispatch. */
  async turn(
    text: string,
    opts: { readonly approve?: boolean; readonly taskId?: string; readonly context?: CoordinatorContext } = {},
  ): Promise<TurnTrace> {
    const at = Date.now();
    const from = this.dispatchCursor;
    const fromCall = this.chatCalls.length;
    // Bumped BEFORE intake, so an ask raised by this turn is attributed to this
    // turn. `onPermissionRequired` records the value it saw, and the return value
    // below compares the two.
    this.askSeq += 1;
    const ack = await this.coordinator.intake(
      text,
      opts.context !== undefined ? { context: opts.context } : {},
    );
    let result: MissionResult;
    let dispatchError: string | null = null;
    try {
      result = await this.coordinator.plan(ack, {
        ...(opts.approve !== undefined ? { approve: opts.approve } : {}),
        ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
      });
    } catch (err) {
      // The ONLY exit `plan()` has for a dispatch failure is to propagate. The
      // result is rebuilt here from facts the chain already established — the
      // intake ack, the plan if one was built, and `ok: false` — and the thrown
      // value is carried in `dispatchError` and in the ledger row. Nothing is
      // invented: `ok: false` is the honest verdict for a turn whose dispatch
      // never landed, and `detail` names the stage.
      dispatchError = failureLabel(err);
      const failedPlan = lastPlanOf(this.chatCalls);
      result = {
        ok: false,
        // `exactOptionalPropertyTypes` forbids assigning `undefined` into an
        // optional field, so the two optional members are added only when the
        // intake actually produced them. A turn that failed at the dispatch has
        // already been through intake, but "already" is not a type.
        ...(ack.replyAr !== undefined ? { replyAr: ack.replyAr } : {}),
        ...(ack.taskEn !== undefined ? { taskEn: ack.taskEn } : {}),
        receipt: null,
        ...(ack.intakeModel !== undefined ? { intakeModel: ack.intakeModel } : {}),
        ...(failedPlan !== null ? { plan: failedPlan } : {}),
        detail: 'dispatch-failed',
      };
    }
    this.dispatchCursor = this.dispatches.length;

    const turnCalls = this.chatCalls.slice(fromCall);
    const gateCall = turnCalls.find((c) => c.stage === 'gate');
    const gateVerdict = gateCall === undefined ? null : parseAddressee(gateCall.raw);
    // Re-parsed through the product's own schema rather than trusted from the
    // result object: `plan()` returns the parsed plan, and re-validating it here
    // means the printed steps came from `PlanSchema` in this process.
    const plan = result.plan !== undefined && PlanSchema.safeParse(result.plan).success ? result.plan : null;
    return {
      text,
      ack,
      result,
      gateVerdict,
      // `null` when THIS turn raised no ask, so a second turn cannot be handed the
      // first turn's slot as if it were its own.
      openedAsk: this.askAtOpen === this.askSeq ? this.openedAsk : null,
      plan,
      dispatches: this.dispatches.slice(from),
      chatCalls: turnCalls,
      dispatchError,
      ms: Date.now() - at,
    };
  }
}

/** The situational block `Coordinator.intake` accepts — the product's own type. */
export type CoordinatorContext = IntakeContext;

/**
 * The last plan the chain built, read back off the ledger.
 *
 * Only used on the `dispatch-failed` path, where `plan()` threw before it could
 * return its own result and the plan it had already validated is the only record
 * that a plan existed. Re-validated through the same `PlanSchema`, so a garbage
 * completion cannot put a fabricated step list into a report.
 */
function lastPlanOf(calls: readonly ChatCall[]): Plan | null {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const raw = calls[i]?.raw;
    if (calls[i]?.stage !== 'plan' || raw === undefined) continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    const validated = PlanSchema.safeParse(parsed);
    if (validated.success) return validated.data;
  }
  return null;
}

// ── THE STRUCTURAL INVARIANT, COUNTED FROM SOURCE ────────────────────────────

export interface SourceCount {
  readonly label: string;
  readonly pattern: string;
  readonly count: number;
  readonly expected: number;
}

interface CountSpec {
  readonly label: string;
  readonly pattern: RegExp;
  readonly expected: number;
}

export interface GateInvariant {
  readonly file: string;
  readonly counts: readonly SourceCount[];
  /**
   * Every textual mention of `kind: 'proceed'`, anchored on nothing.
   *
   * PUBLISHED DELIBERATELY because it is NOT the number to guard. A plain
   * substring count returns 2: one is the type member in `gate()`'s return
   * annotation (`coordinator.ts:372`) and one is the value (`coordinator.ts:438`).
   * A reader who greps the file will see 2, and a guard written on that number
   * would either fail forever or be "fixed" by loosening the pattern until it
   * went green — which is a guard that passes for the wrong reason. The guarded
   * count is the one below it.
   */
  readonly naiveProceedMentions: number;
  readonly ok: boolean;
  readonly failures: readonly string[];
}

/**
 * Count the dispatch-authorising path in `coordinator.ts` source.
 *
 * THE THREE PATTERNS, and why these three:
 *  - `return { kind: 'proceed'` — the single exit of `gate()` that leads to a
 *    dispatch. Anchored on `return {` for the reason in `naiveProceedMentions`.
 *  - `this.deps.dispatch(` — the single CALL SITE. `deps.dispatch` also appears in
 *    the `CoordinatorDeps` interface, so the `this.` anchor is what makes this a
 *    count of calls rather than of mentions.
 *  - `this.permission.consume(` — the single read of the slot that authorises one.
 *
 * The patterns and their expected counts are not new here: they are the ones
 * `src/orchestrator/command-tiers.test.ts:630-631` already pins, and this runner
 * reuses them verbatim so the CLI and the suite can never disagree about the
 * number. Each is one line of the file's own claim about itself.
 */
export function measureGateInvariant(source: string, file: string): GateInvariant {
  const specs: readonly CountSpec[] = [
    { label: "return { kind: 'proceed'", pattern: /return \{ kind: 'proceed'/g, expected: 1 },
    { label: 'this.deps.dispatch(', pattern: /this\.deps\.dispatch\(/g, expected: 1 },
    { label: 'this.permission.consume(', pattern: /this\.permission\.consume\(/g, expected: 1 },
  ];
  const counts: SourceCount[] = specs.map((s) => ({
    label: s.label,
    pattern: s.pattern.source,
    count: source.match(s.pattern)?.length ?? 0,
    expected: s.expected,
  }));
  const failures = counts.filter((c) => c.count !== c.expected).map((c) => `${c.label}: ${c.count} (expected ${c.expected})`);
  return {
    file,
    counts,
    naiveProceedMentions: source.match(/kind: 'proceed'/g)?.length ?? 0,
    ok: failures.length === 0,
    failures,
  };
}

/**
 * Locate `src/orchestrator/coordinator.ts` by walking up from this module.
 *
 * Two deployments, two depths: `src/cli/turn.ts` under Vitest and
 * `dist/cli/turn.js` after `npm run build`. A hard-coded `../..` is correct for
 * exactly one of them, and a reader who runs the tests gets a file-not-found
 * instead of a number. Walking up until the marker exists handles both and needs
 * no configuration.
 *
 * NOT FOUND IS A THROW, never a default. A source-measured invariant that falls
 * back to a hard-coded `1` when it cannot read the file is the same defect as
 * `res.ok` being read as proof a route exists: the number would be right by
 * construction and therefore useless.
 */
export function readCoordinatorSource(fromUrl: string = import.meta.url): { path: string; source: string } {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'src', 'orchestrator', 'coordinator.ts');
    if (existsSync(candidate)) return { path: candidate, source: readFileSync(candidate, 'utf8') };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'coordinator.ts not found walking up from ' + fromUrl + ' — the structural invariant cannot be measured, and a hard-coded count would be a fiction',
  );
}

/** Read the real file and count it. Throws rather than guessing (see above). */
export function assertGateInvariant(fromUrl?: string): GateInvariant {
  const { path, source } = readCoordinatorSource(fromUrl);
  return measureGateInvariant(source, path);
}

/**
 * The RUNTIME half of the same invariant, and the half that catches what a
 * source count cannot.
 *
 * A source count proves there is one line that can authorise a dispatch. It does
 * not prove the line is reachable, nor that reaching it requires a gate verdict.
 * These three facts are measured from the run:
 *
 *  1. `attempts <= 1` — one turn can dispatch at most once.
 *  2. `attempts > 0` implies the gate said `approve` — the only verdict
 *     `gate()` maps to `kind: 'proceed'` (`coordinator.ts:424-439`).
 *  3. after a dispatch the slot is EMPTY — `consume()` deletes before it returns
 *     (`permission.ts:361-367`), so a live slot beside a delivered dispatch would
 *     mean a permission survived its own use.
 */
export interface RuntimeInvariant {
  readonly attempts: number;
  readonly delivered: number;
  readonly gateDecisions: readonly string[];
  readonly gateAuthorised: boolean;
  readonly slotAfter: 'empty' | 'open' | 'none-observed';
  readonly violations: readonly string[];
  readonly ok: boolean;
}

export function checkRuntimeInvariant(input: {
  readonly dispatches: readonly DispatchRecord[];
  readonly gateVerdicts: ReadonlyArray<AddresseeVerdict | null>;
  readonly slotAfter: PendingPermission | null;
  readonly slotEverOpened: boolean;
}): RuntimeInvariant {
  const attempts = input.dispatches.length;
  const delivered = input.dispatches.filter((d) => d.delivered).length;
  const gateDecisions = input.gateVerdicts.map((v) => v?.decision ?? 'no-gate-call');
  const gateAuthorised = input.gateVerdicts.some((v) => v?.decision === 'approve');
  const slotAfter: RuntimeInvariant['slotAfter'] = input.slotEverOpened
    ? input.slotAfter === null
      ? 'empty'
      : 'open'
    : 'none-observed';
  const violations: string[] = [];
  if (attempts > 1) violations.push(`${attempts} dispatch attempts in one run — the single-dispatch invariant is broken`);
  if (attempts > 0 && !gateAuthorised) {
    violations.push('a dispatch happened without an `approve` verdict from the gate');
  }
  if (delivered > 0 && slotAfter === 'open') {
    violations.push('a permission slot is still open after a delivered dispatch — consume() did not delete it');
  }
  return { attempts, delivered, gateDecisions, gateAuthorised, slotAfter, violations, ok: violations.length === 0 };
}

/** Re-exported so the CLI never hardcodes a model slug or a TTL. */
export const GATE_TTL_MS = PERMISSION_TTL_MS;
export { ADDRESSEE_CHAT_OPTIONS };
