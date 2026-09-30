import {
  ADDRESSEE_CHAT_OPTIONS,
  ADDRESSEE_RESPONSE_FORMAT,
  addresseeSystem,
  parseAddressee,
  PermissionSlot,
  type AddresseeDecision,
  type AddresseeVerdict,
} from '../orchestrator/permission.js';
import { openRouterChat } from '../voice/brain.js';
import { COORDINATOR_MODEL, type ChatFn } from '../orchestrator/coordinator.js';

// HEADLESS INTENT TABLE — the contextual gate, measured.
//
// WHAT "THE REAL GATE" MEANS HERE, PRECISELY. The classification is
// `parseAddressee` (`permission.ts:276`) applied to a reply produced under
// `addresseeSystem()` with `ADDRESSEE_RESPONSE_FORMAT` and
// `ADDRESSEE_CHAT_OPTIONS`. That is the identical triple `Coordinator.gate()`
// passes to `deps.chat` (`coordinator.ts:388-393`). The table below never
// re-decides anything and never inspects the reply text: it records what
// `parseAddressee` returned and compares it to a written expectation.
//
// TWO SOURCES OF THE REPLY, AND THE DIFFERENCE MATTERS.
//   `model`  — a live `openRouterChat` call. Measures the model.
//   `replay` — a captured completion, byte-for-byte in the product's schema.
//              Measures `parseAddressee` and the round-trip, with no network.
// The report ALWAYS names which one produced a row, because an accuracy figure
// over replayed replies is a measurement of the parser and calling it a
// measurement of the classifier's judgement on Arabic would be the fabrication
// this whole exercise exists to remove.

export interface IntentCase {
  readonly id: string;
  /** The user's words, Ammani, as the gate would receive them. */
  readonly utterance: string;
  /** The planner's restatement, which travels with the utterance into the gate. */
  readonly taskEn: string;
  readonly expected: AddresseeDecision;
  /** A completion in the gate's strict schema. Replayed unless `--live`. */
  readonly reply: string;
  /** Why this is the expected decision, in the gate's own vocabulary. */
  readonly why: string;
}

function verdict(fields: {
  decision: AddresseeDecision;
  addressed: boolean;
  ask_ar: string;
  approves_id?: string;
  reason_en: string;
}): string {
  return JSON.stringify({
    addressed: fields.addressed,
    needs_opencode: fields.decision === 'ask_permission' || fields.decision === 'approve',
    decision: fields.decision,
    ask_ar: fields.ask_ar,
    approves_id: fields.approves_id ?? '',
    reason_en: fields.reason_en,
  });
}

/**
 * The table.
 *
 * The four decisions with a natural Arabic example, plus the two that exist only
 * to be fail-closed: `undecided` and the malformed replies that must land there.
 * `deny` and `approve` are exercised structurally below rather than as table
 * rows, because both are only meaningful against a live `PermissionSlot` — a
 * `deny` with nothing pending is documented as a deliberate no-op
 * (`permission.ts:272-274`), and a table row cannot express a slot.
 */
export const INTENT_CASES: readonly IntentCase[] = [
  {
    id: 'question',
    utterance: 'شو رأيك هون؟',
    taskEn: 'Ask the user for an opinion about this file',
    expected: 'answer',
    reply: verdict({
      decision: 'answer',
      addressed: true,
      ask_ar: '',
      reason_en: 'A question. Answer it verbally; nothing needs to run.',
    }),
    why: 'The gate prompt states the rule directly: "a question is not a task".',
  },
  {
    id: 'task-needs-opencode',
    utterance: 'شوف لي الجلسات اللي فشلت امبارح',
    taskEn: 'List the sessions that failed yesterday and report why',
    expected: 'ask_permission',
    reply: verdict({
      decision: 'ask_permission',
      addressed: true,
      ask_ar: 'بدي راجع الجلسات اللي فشلت، نمشي؟',
      reason_en: 'Needs OpenCode to read session state, so permission is required first.',
    }),
    why: 'The only decision that opens a slot without acting on it.',
  },
  {
    id: 'third-person',
    utterance: 'خبر سامي إنه رح يجي اليوم',
    taskEn: 'Tell Sami the message arrived',
    expected: 'not_addressed',
    reply: verdict({
      decision: 'not_addressed',
      addressed: false,
      ask_ar: '',
      reason_en: 'The user is speaking to a colleague who is not the assistant.',
    }),
    why: 'Dispatching this would send a message the assistant was not asked to send.',
  },
  {
    id: 'undecided-garbage',
    utterance: 'ممكن نشوف الموضوع؟',
    taskEn: 'Review the topic with the user',
    expected: 'undecided',
    reply: 'سأفكر في الأمر وسأعود إليك قريبا',
    why: 'Prose instead of the strict schema. Must fail CLOSED to undecided, which asks.',
  },
  {
    id: 'undecided-truncated',
    utterance: 'تمام',
    taskEn: 'Acknowledge',
    expected: 'undecided',
    reply: '{"addressed":true,"needs_opencode":false,"decision":"answ',
    why: 'A half-written JSON body is a transport failure wearing a decision.',
  },
  {
    id: 'approve-id-without-slot',
    utterance: 'ايه هلا سويت',
    taskEn: 'Proceed with the pending action',
    // NOT `undecided`. The parser's contract is that it reports the model's
    // decision verbatim, including an approval whose id matches nothing. The
    // SAFETY is not in this row: it is in `PermissionSlot.consume()`, which
    // returns null for an unknown id and makes the coordinator re-ask
    // (`coordinator.ts:427-431`). `probePermissionSlot()` below exercises that
    // with the slot's own method. Expecting `undecided` here would be writing the
    // answer into the expectation and measuring nothing.
    expected: 'approve',
    reply: verdict({
      decision: 'approve',
      addressed: true,
      ask_ar: '',
      approves_id: 'a0000000-0000-4000-8000-000000000000',
      reason_en: 'Approving an action that was never shown.',
    }),
    why: 'The parser is a parser. A correct `approve` with an unmatchable id authorises nothing, and the slot probe proves it.',
  },
];

export type VerdictSource = 'model' | 'replay';

export interface IntentRow {
  readonly id: string;
  readonly expected: AddresseeDecision;
  readonly actual: AddresseeDecision;
  readonly match: boolean;
  readonly addressed: boolean;
  /** The `approves_id` the parser kept. Empty on any non-approve decision. */
  readonly approvesIdKept: string;
  /** The `ask_ar` the parser returned, verbatim. */
  readonly askAr: string;
  /** Word count of `askAr`, so an over-long ask is visible rather than argued about. */
  readonly askWords: number;
  readonly askSayable: boolean;
  readonly reasonEn: string;
  readonly source: VerdictSource;
  readonly ms: number;
  readonly failure: string | null;
}

export interface IntentReport {
  readonly source: VerdictSource;
  readonly rows: readonly IntentRow[];
  readonly correct: number;
  readonly total: number;
  /** Correct / total, or `null` when there were no cases (never `0/0` printed as a rate). */
  readonly accuracy: number | null;
  /** Per-decision tallies of expected vs actual. */
  readonly confusion: ReadonlyArray<{ readonly decision: string; readonly expected: number; readonly actual: number }>;
  readonly ms: number;
}

const ASKABLE_WORDS = 20;

/** The one property that must hold on every row regardless of accuracy. */
function structuralFaults(row: { readonly actual: AddresseeDecision; readonly approvesIdKept: string }): string[] {
  const faults: string[] = [];
  // `permission.ts:295` drops the id on every decision except approve. A leak here
  // would be a standing permission: an id the gate can name again next turn.
  if (row.actual !== 'approve' && row.approvesIdKept.length > 0) {
    faults.push(`approves_id survived a ${row.actual} verdict`);
  }
  return faults;
}

/**
 * Run the table. `chat` is injected so the same code path serves both sources and
 * a test can drive it with no network and no key.
 */
export async function runIntentTable(cases: readonly IntentCase[], chat: ChatFn, source: VerdictSource): Promise<IntentReport> {
  const started = Date.now();
  const rows: IntentRow[] = [];
  for (const c of cases) {
    // EXACTLY the triple `Coordinator.gate()` builds. If any of these three is
    // substituted, this stops measuring the gate.
    const at = Date.now();
    let actual: AddresseeVerdict;
    let failure: string | null = null;
    try {
      const raw = await chat(
        COORDINATOR_MODEL,
        addresseeSystem({}),
        `${c.utterance}\n\nTASK SPECIFICATION:\n${c.taskEn}`,
        { ...ADDRESSEE_CHAT_OPTIONS, responseFormat: ADDRESSEE_RESPONSE_FORMAT },
      );
      actual = parseAddressee(raw);
    } catch (err) {
      // A transport failure reaches the gate as a throw, and `gate()` catches it
      // and asks (`coordinator.ts:394-399`). The parser's own fail-closed value is
      // `undecided`, and that is what an unreachable model must be recorded as.
      actual = parseAddressee('');
      failure = err instanceof Error ? err.message : 'unknown';
    }
    const askWords = actual.askAr.trim().split(/\s+/).filter((w) => w.length > 0).length;
    rows.push({
      id: c.id,
      expected: c.expected,
      actual: actual.decision,
      match: actual.decision === c.expected,
      addressed: actual.addressed,
      approvesIdKept: actual.approvesId,
      askAr: actual.askAr,
      askWords,
      askSayable: askWords > 0 && askWords <= ASKABLE_WORDS,
      reasonEn: actual.reasonEn,
      source,
      ms: Date.now() - at,
      failure,
    });
  }
  const correct = rows.filter((r) => r.match).length;
  const confusion = [...new Set(rows.map((r) => r.expected))].sort().map((decision) => ({
    decision,
    expected: rows.filter((r) => r.expected === decision).length,
    actual: rows.filter((r) => r.actual === decision).length,
  }));
  return {
    source,
    rows,
    correct,
    total: rows.length,
    accuracy: rows.length === 0 ? null : correct / rows.length,
    confusion,
    ms: Date.now() - started,
  };
}

/** Every structural fault across the table. Empty is the pass condition. */
export function structuralFaultsOf(rows: readonly IntentRow[]): string[] {
  return rows.flatMap((r) => structuralFaults(r).map((f) => `${r.id}: ${f}`));
}

/**
 * The `approve` path, measured against a real `PermissionSlot`.
 *
 * `parseAddressee` returning `approve` authorises NOTHING on its own — the only
 * route to a dispatch is `consume(approvesId)` matching a live slot, which deletes
 * it before returning. This runs the slot's own method, so the single-use property
 * is the product's, not a restatement of it.
 */
export interface SlotProbe {
  readonly consumeWrongId: 'null' | 'returned';
  readonly consumeCorrectId: 'null' | 'returned';
  readonly consumeAgain: 'null' | 'returned';
  readonly taskEnOnConsume: string;
  readonly slotAfterConsume: 'empty' | 'open';
  readonly ttlMs: number;
  readonly violations: string[];
}

export function probePermissionSlot(pendingId: string, taskEn: string, ttlMs: number): SlotProbe {
  // The id source is INJECTED. `PermissionSlot.open()` mints its own random UUID
  // by default (`permission.ts:324-325`), so consuming with a caller-supplied id
  // would always miss and the probe would only ever measure "a wrong id returns
  // null" — which is a true and nearly contentless fact. Injecting the id makes
  // the equality check the thing under test.
  const slot = new PermissionSlot({ now: () => 1_000, ttlMs, newId: () => pendingId });
  const opened = slot.open(taskEn, 'ses_probe', 'بدي غيّر هذا؟');
  const wrong = slot.consume(`${pendingId}-not-the-real-one`);
  const first = slot.consume(opened.id);
  const again = slot.consume(opened.id);
  const violations: string[] = [];
  if (wrong !== null) violations.push('consume() accepted a mismatched id');
  if (first === null) violations.push('consume() rejected the id it was given');
  if (again !== null) violations.push('consume() returned the same permission twice — it is not single-use');
  if (slot.current() !== null) violations.push('the slot is still open after being consumed');
  return {
    consumeWrongId: wrong === null ? 'null' : 'returned',
    consumeCorrectId: first === null ? 'null' : 'returned',
    consumeAgain: again === null ? 'null' : 'returned',
    taskEnOnConsume: first?.taskEn ?? '',
    slotAfterConsume: slot.current() === null ? 'empty' : 'open',
    ttlMs,
    violations,
  };
}

/** The live chat function: the product's own OpenRouter transport. */
export function liveGateChat(apiKey: string): ChatFn {
  return (model, system, user, options) =>
    openRouterChat(
      apiKey,
      model,
      system,
      user,
      fetch,
      {
        ...(options?.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
        ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
      },
    );
}

/** The replay function: the captured completion, no network, no key. */
export function replayGateChat(lookup: (utteranceKey: string) => string | null): ChatFn {
  // `async`, not a bare arrow returning a promise. A synchronous throw out of a
  // `ChatFn` violates the contract every caller is written against —
  // `Coordinator.gate()` wraps the call in `try/catch` for a PROMISE, and a
  // synchronous throw escapes it as an exception rather than landing on the
  // fail-closed ask path. Found by a test that asserted `.rejects` and got a
  // thrown value instead.
  return async (_model, _system, user) => {
    const found = lookup(user);
    if (found === null) throw new Error('no recorded reply for this case');
    return found;
  };
}
