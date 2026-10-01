import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';
import { FileVault } from '../voice/vault.js';
import { Keyring, withKey } from '../voice/keyring.js';
import { vaultPathFromEnv } from '../daemon.js';
import { buildHandoff, type ChatFn, type MissionResult } from '../orchestrator/coordinator.js';
import type { ServeClient } from '../runtime/client.js';
import { MAX_SPOKEN_ASK_WORDS } from '../orchestrator/permission.js';
import { openRouterChat } from '../voice/brain.js';
import { openServeTarget, requirePassword } from './serve.js';
import { HeadlessBrain, checkRuntimeInvariant, assertGateInvariant } from './turn.js';
import type { TurnTrace } from './turn.js';
import * as out from './report.js';
import { dispatchTruth } from './report.js';

// HEADLESS `reason` — the full chain, one utterance, printed stage by stage.
//
// THE CLAIM THIS SUBCOMMAND MAKES. That Voxaura's own brain, running headless,
// reaches a dispatch on port 4096 and nowhere else. Every stage below is named by
// the module that produced it, and the one stage that must not be skipped — the
// contextual permission gate — is reported from the model's own verdict, never
// from an assumption about what the runner wanted to happen.
//
// HEADLESS MEANS HEADLESS. No Tauri webview, no microphone, no STT, no TTS, no
// daemon on 4097. The transcript is a CLI argument, which is the only thing that
// differs from the shipped path, and the difference is stated in the output.

export interface ReasonOptions {
  readonly text: string;
  /** `--approve`: answer the gate's own ask and carry the turn through. */
  readonly approve: boolean;
  /** `--session <id>`: dispatch into a named session instead of the newest. */
  readonly sessionId: string | null;
  /** `--replay`: skip the network and the vault; the gate replays a fixture. */
  readonly replay: boolean;
  /** `--envelope flat|nested`: the prompt body shape, via `ServeClient`'s own option. */
  readonly envelope: 'flat' | 'nested';
}

/** The chat function, from the vault pool, through the product's keyring. */
function brainChat(): ChatFn {
  const ring = Keyring.load(new FileVault(vaultPathFromEnv()));
  return async (model, system, user, options) => {
    // `withKey` is the product's own acquisition: per-call copies, released with
    // the real status, so a 429 or a 401 advances the pool instead of retrying a
    // dead key. Reusing it rather than reading a key out of the vault is the
    // difference between a faithful run and one that lies about rotation.
    const out = await withKey(ring, 'openrouter', async (key) => {
      const material = Buffer.from(key.material).toString('utf8');
      return openRouterChat(material, model, system, user, fetch, {
        ...(options?.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
        ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
      });
    });
    // Zero the pool on the way out (A.6: the daemon has the same hole).
    try {
      ring.destroy();
    } catch {
      // destroy() is best-effort; a throw here must not mask a turn's result.
    }
    return out;
  };
}

/**
 * The gate's own ask, sent back as the next utterance.
 *
 * The user hears the ask and answers it; here there is no user, so the runner
 * speaks for one — and the words it uses are the ask the MODEL wrote, not a
 * string this file invented. That is the point: if the gate asked the wrong
 * question, the approval names the wrong question, and the run says so.
 */
const APPROVAL_UTTERANCE = 'اي هلا سويت، كمّل';

/**
 * The model that actually split the utterance, or an honest "did not run".
 *
 * Read off the ack the chain produced, never a slug typed here. The old heading
 * said `Dots3` unconditionally, which became a false label the day a quota
 * outage moved the intake slot onto another slug: the report named a model that
 * never ran. A display that lies about which model served is worse than one that
 * prints nothing, so the constant lives in `coordinator.ts` and this file never
 * restates it. On a failed intake no model served, and `intakeModel` is absent.
 */
function intakerOf(trace: TurnTrace): string {
  return trace.ack.intakeModel ?? '(no intake model — intake did not produce an ack)';
}

/**
 * The model that actually built the plan, or an honest "did not run".
 *
 * Same rule as `intakerOf`: read off the ledger rows the chain recorded. The old
 * heading said `Inkling` unconditionally, which was false on every turn where the
 * plan never happened and on every turn where another model built it.
 */
function plannerOf(trace: TurnTrace): string {
  const call = trace.chatCalls.filter((c) => c.stage === 'plan').at(-1);
  return call?.model ?? '(no plan call — nothing decomposed the task)';
}

/** Print one turn's trace. Every field names the module behind it. */
function printTurn(trace: TurnTrace, label: string): void {
  out.heading(`${label} — "${out.clip(trace.text, 90)}"`);
  out.field('turn wall clock', `${trace.ms} ms`);

  out.heading(`STAGE 1 · INTAKE — ${intakerOf(trace)} splits the utterance`);
  out.source('src/orchestrator/coordinator.ts', 'Coordinator.intake()');
  out.field('ok', String(trace.ack.ok));
  if (trace.ack.ok) {
    out.field('reply_ar (spoken)', trace.ack.replyAr ?? '');
    out.field('task_en (dispatched)', out.clip(trace.ack.taskEn ?? '', 200));
    out.field('served by', trace.ack.intakeModel ?? '(not recorded)');
    out.field('re-ask ran', String(trace.ack.reasked === true));
  } else {
    out.field('detail', trace.ack.detail ?? '(none)');
  }
  const intakeCalls = trace.chatCalls.filter((c) => c.stage === 'intake' || c.stage === 'intake-failover' || c.stage === 'intake-reask');
  out.field('model calls', String(intakeCalls.length));
  for (const c of intakeCalls) {
    out.note(`${c.stage} ${c.model} ${c.ms} ms schema=${c.schema}${c.failure !== null ? ` FAILED ${c.failure}` : ''}`);
  }

  out.heading('STAGE 2 · CONTEXTUAL PERMISSION GATE — the thing that guards dispatch');
  out.source('src/orchestrator/coordinator.ts', 'Coordinator.gate(), in front of deps.dispatch');
  out.source('src/orchestrator/permission.ts', 'parseAddressee() applied to the model reply');
  const gateCall = trace.chatCalls.find((c) => c.stage === 'gate');
  if (gateCall === undefined) {
    out.field('gate call', 'NOT MADE — see stage 1; nothing downstream can have run');
  } else {
    out.field('model', `${gateCall.model} (${gateCall.ms} ms, schema=${gateCall.schema})`);
    if (gateCall.failure !== null) {
      out.field('gate transport', `FAILED ${gateCall.failure} — gate() catches this and asks (fail-closed)`);
    }
  }
  if (trace.gateVerdict === null) {
    out.field('decision', '(no verdict — no gate reply to parse)');
  } else {
    out.field('decision', trace.gateVerdict.decision);
    out.field('addressed', String(trace.gateVerdict.addressed));
    out.field('approves_id kept', trace.gateVerdict.approvesId === '' ? '(none)' : trace.gateVerdict.approvesId);
    out.field('reason_en', out.clip(trace.gateVerdict.reasonEn, 160));
    if (trace.gateVerdict.askAr.length > 0) {
      const words = trace.gateVerdict.askAr.split(/\s+/).length;
      out.field('ask_ar (model wrote)', trace.gateVerdict.askAr);
      out.field('ask words', `${words} / ${MAX_SPOKEN_ASK_WORDS} cap`);
    }
  }
  if (trace.openedAsk !== null) {
    out.field('gate asked', `yes — slot ${trace.openedAsk.id}`);
    out.field('slot task', out.clip(trace.openedAsk.taskEn, 120));
    out.field('slot bound to', trace.openedAsk.sessionId === '' ? '(no session)' : trace.openedAsk.sessionId);
  } else {
    out.field('gate asked', 'no');
  }

  out.heading(`STAGE 3 · PLAN — ${plannerOf(trace)} decomposes the task`);
  out.source('src/orchestrator/coordinator.ts', 'Coordinator.plan() → PlanSchema');
  if (trace.plan === null) {
    const why = trace.result.detail ?? 'no plan';
    out.field('plan', `none (${why})`);
  } else {
    out.field('steps', String(trace.plan.steps.length));
    for (const s of trace.plan.steps) out.note(`[${s.id}] ${s.kind} :: ${out.clip(s.detail, 120)}`);
  }
  if (trace.result.needsConfirmation === true) {
    out.field('FR-12 hold', `destructive steps held: ${(trace.result.flagged ?? []).join(', ')}`);
  }

  out.heading('STAGE 4 · DISPATCH — the only egress, on the session');
  out.source('src/runtime/client.ts', 'ServeClient.promptSession() via Coordinator deps.dispatch');
  const truth = dispatchTruth({
    attempts: trace.dispatches.length,
    delivered: trace.dispatches.filter((d) => d.delivered).length,
    failure: trace.dispatchError,
    resultDetail: trace.result.detail ?? null,
    needsPermission: trace.result.needsPermission === true,
  });
  out.field('dispatched', truth.headline);
  out.field('why', truth.why);
  if (truth.headline === 'ATTEMPTED, FAILED' && trace.gateVerdict?.decision === 'approve') {
    out.note('the gate DID authorise this; the transport rejected the request. The refusal above is serve\'s, not the gate\'s.');
  }
  for (const d of trace.dispatches) {
    out.field('  delivered', String(d.delivered));
    if (d.delivered) {
      out.field('  serve state', d.state);
      // `delivered` is the flag the runner itself set after the call returned;
      // a null receipt on a delivered call is printed as such rather than
      // substituted, because serve's own body is what decides it.
      out.field('  receipt', d.receipt ?? '(serve returned no receipt id)');
    } else {
      out.field('  failure', d.failure ?? 'unknown');
    }
    out.field('  round trip', `${d.ms} ms`);
    out.field('  payload', out.clip(d.text, 300));
  }

  out.heading('REPLY');
  out.field('ok', String(trace.result.ok));
  if (trace.result.replyAr !== undefined && trace.result.replyAr.length > 0) out.field('spoken', trace.result.replyAr);
  if (trace.result.detail !== undefined) out.field('detail', trace.result.detail);
}

/** The session the dispatch lands in: named, or the newest serve reports. */
async function resolveSession(explicit: string | null, client: ServeClient): Promise<{ session: SessionId; label: string }> {
  if (explicit !== null) return { session: explicit as SessionId, label: `${explicit} (--session)` };
  const rows = await client.listSessions();
  if (rows.length === 0) {
    throw new OrchestratorError('SESSION_NOT_FOUND', false, 'serve reports no sessions — create one with `opencode-voice create-session` first');
  }
  // `updatedAt` is serve's own field, not a sort this file invented; ties fall
  // back to list order, which is serve's.
  const sorted = [...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const newest = sorted[0];
  if (newest === undefined) {
    throw new OrchestratorError('SESSION_NOT_FOUND', false, 'serve returned sessions but none had a usable row');
  }
  return {
    session: newest.sessionId as SessionId,
    label: `${newest.sessionId} (newest of ${rows.length}${newest.title !== undefined ? `, "${out.clip(newest.title, 40)}"` : ''})`,
  };
}

/**
 * The reply field, and the ONE line a reader must not skim past.
 *
 * `missionResult` is the coordinator's own result object. It is printed whole
 * minus the plan and the transcript, so nothing here can soften a `detail` the
 * product set.
 */
function printResult(result: MissionResult): void {
  // The plan is printed in its own stage from the `PlanSchema`-validated copy, so
  // it is dropped here rather than printed twice. Everything else — `detail`
  // included — is printed exactly as the coordinator set it.
  const rest: Record<string, unknown> = { ...result };
  delete rest['plan'];
  out.heading('MISSION RESULT (coordinator verbatim)');
  out.json(rest);
}

export async function reasonCommand(opts: ReasonOptions): Promise<number> {
  // ── The structural invariant first ──────────────────────────────────────
  // Before any spend and before any network call: if the source no longer has
  // exactly one `kind: 'proceed'`, this run has nothing to measure and says so
  // rather than reporting a healthy-looking chain.
  out.heading('STRUCTURAL INVARIANT — counted from source, not asserted');
  const invariant = assertGateInvariant();
  out.source('src/orchestrator/coordinator.ts', invariant.file);
  for (const c of invariant.counts) {
    out.field(c.label, `${c.count} (expected ${c.expected})`);
  }
  out.field("naive \"kind: 'proceed'\"", `${invariant.naiveProceedMentions} — includes the type member, not only the returned value`);
  out.verdict(invariant.ok, invariant.ok ? 'one proceed, one dispatch call site, one consume' : invariant.failures.join('; '));
  if (!invariant.ok) return 1;

  // ── Transport ───────────────────────────────────────────────────────────
  out.heading('TRANSPORT');
  const target = await openServeTarget({ promptEnvelope: opts.envelope });
  out.field('serve', `${target.baseUrl} (password from ${target.passwordSource})`);
  out.field('serve healthy', String(target.healthy));
  out.field('prompt envelope', `${target.promptEnvelope} (ServeClient's own option; this serve is 1.18.32)`);
  out.field('daemon on 4097', 'not required — this runner never opens the WS control plane');
  out.field('audio', 'disabled — no microphone, no STT, no TTS, no voice pipeline');
  if (!target.healthy) {
    out.warnLine('serve is not answering; the chain below will reach the dispatch stage and fail there, which is itself the finding');
  }
  requirePassword(target);

  const resolved = await resolveSession(opts.sessionId, target.client);
  out.field('session', resolved.label);
  if (!target.healthy) {
    // Refuse before spending a model call on a turn that cannot be delivered.
    out.fail('serve unreachable — nothing dispatched, and no model call was made');
    return 1;
  }

  // ── The chain ───────────────────────────────────────────────────────────
  if (opts.replay) {
    out.warnLine('--replay: intake, the gate and the plan run on recorded replies — NO model was called and NO quota was spent');
  }
  // The session is a single constant, and the replay's approval reads the LIVE
  // slot id off the brain through a holder. The holder is late-bound on purpose:
  // resolving it eagerly would mean the approval could name an id that is not the
  // one the product just opened, and `PermissionSlot.consume()` compares for exact
  // equality — a stale id is the fail-closed re-ask, not a dispatch.
  const session: SessionId = resolved.session;
  const holder: { brain: HeadlessBrain | null } = { brain: null };
  const brain: HeadlessBrain = new HeadlessBrain({
    chat: opts.replay ? replayChat(() => holder.brain?.pendingPermission?.id ?? null) : brainChat(),
    activeSessionId: () => session,
    dispatch: async (text) => {
      const r = await target.client.promptSession(session, text, { origin: 'cli', actor: 'headless-reason' });
      return { receipt: r.receipt, state: r.state };
    },
  });
  holder.brain = brain;

  // A fixed task id per turn, so `buildHandoff()` output is reproducible and the
  // "envelope matches sent" comparison below is a real equality rather than a
  // coincidence about `Date.now()`.
  const first = await brain.turn(opts.text, { taskId: `headless-turn-1` });
  printTurn(first, 'TURN 1');
  printResult(first.result);

  const traces: TurnTrace[] = [first];
  if (opts.approve) {
    const asked = first.openedAsk;
    if (asked === null) {
      out.heading('TURN 2 — requested but not run');
      out.warnLine('turn 1 raised no ask, so there is nothing to approve; --approve would have had to invent a question');
    } else {
      out.heading('TURN 2 — the user answers the ask');
      out.note(`the model asked: "${asked.askAr}"`);
      out.note(`the runner answers: "${APPROVAL_UTTERANCE}"`);
      const second = await brain.turn(APPROVAL_UTTERANCE, { taskId: 'headless-turn-2' });
      traces.push(second);
      printTurn(second, 'TURN 2');
      printResult(second.result);
    }
  }

  // ── The runtime invariant, over every dispatch in the run ───────────────
  out.heading('RUNTIME INVARIANT — measured from what the chain actually did');
  const runtime = checkRuntimeInvariant({
    dispatches: brain.ledger.dispatches,
    gateVerdicts: traces.map((t) => t.gateVerdict),
    slotAfter: brain.pendingPermission,
    slotEverOpened: brain.slotEverOpened,
  });
  out.field('dispatch attempts', String(runtime.attempts));
  out.field('delivered', String(runtime.delivered));
  out.field('gate decisions', runtime.gateDecisions.join(', '));
  out.field('gate authorised', String(runtime.gateAuthorised));
  out.field('slot after run', runtime.slotAfter);
  for (const v of runtime.violations) out.fail(v);
  out.verdict(runtime.ok, runtime.ok ? 'dispatch count agrees with the gate verdict' : 'the chain and the gate disagree');

  out.heading('HANDOFF PAYLOAD — buildHandoff() for any delivered dispatch');
  const delivered = brain.ledger.dispatches.filter((d) => d.delivered);
  if (delivered.length === 0) {
    out.field('handoff', 'none — no dispatch happened, so there is no payload to show');
  } else {
    for (const d of delivered) {
      // `buildHandoff()` is called here with the DELIVERED step list where the
      // run has one, so the printed envelope is produced by the product's own
      // serialiser rather than quoted from a log. The objective is the task the
      // gate approved — the same field `plan()` dispatched from — and saying so
      // is the point: an approval turn replaces the user's utterance with the
      // action they were shown (`coordinator.ts:438`), and this makes that visible.
      const stepTurn = traces.find((t) => t.dispatches.some((x) => x.text === d.text));
      const steps = stepTurn?.plan?.steps ?? [];
      const taskId = stepTurn === undefined ? 'headless-turn-?' : stepTurn === first ? 'headless-turn-1' : 'headless-turn-2';
      const rebuilt = buildHandoff(taskId, stepTurn?.result.taskEn ?? '', resolved.session, steps);
      out.field('objective (approved)', stepTurn?.result.taskEn ?? '(not recorded)');
      out.field('rebuilt envelope', out.clip(rebuilt, 400));
      out.field('sent to serve', out.clip(d.text, 400));
      out.field('envelope matches sent', String(rebuilt === d.text));
    }
  }

  const ok = invariant.ok && runtime.ok && brain.ledger.dispatches.every((d) => d.delivered);
  out.heading('VERDICT');
  if (!ok && brain.ledger.dispatches.some((d) => !d.delivered)) {
    out.fail('at least one dispatch attempt did not reach serve');
  }
  out.verdict(ok, ok ? 'chain traced end to end' : 'see the failures above');
  return ok ? 0 : 1;
}

/** Re-exported so the truth line can be guarded without running the whole chain. */
export { dispatchTruth } from './report.js';

/**
 * `--replay` chat: the recorded completions, keyed by which stage asked for them.
 *
 * The replies are the product's own schema shapes. A replay measures the WIRING —
 * which stage calls which, whether the gate can reach a dispatch, whether the
 * invariants hold — and NOT the model. The output says `replay` for that reason
 * and never prints a latency as if it were a provider measurement.
 *
 * `slotId` is a getter rather than a value, and that is load-bearing: the
 * approval reply has to name the LIVE slot id, because `PermissionSlot.consume()`
 * compares it for exact equality (`permission.ts:365`). A hardcoded id would make
 * the approval-unbound path the only reachable one, and the runner would report a
 * gate that can never be satisfied when the product's can.
 */
function replayChat(slotId: () => string | null): ChatFn {
  const intake = JSON.stringify({ reply_ar: 'تمام، بلش اشتغل.', task_en: 'Replay: no model was called for this turn.' });
  const ask = {
    addressed: true,
    needs_opencode: true,
    decision: 'ask_permission',
    ask_ar: 'بدي أبعت هالشي للـ OpenCode، نمشي؟',
    approves_id: '',
    reason_en: 'replay fixture: the task needs OpenCode.',
  };
  const plan = JSON.stringify({ steps: [{ id: 's1', kind: 'prompt', detail: 'Replay step: report the state of the repository.' }] });
  return (_model, _system, _user, options) => {
    const format = options?.responseFormat as { json_schema?: { name?: string } } | undefined;
    const name = format?.json_schema?.name;
    if (name === 'addressee_verdict') {
      const live = slotId();
      // No live slot: answer `approve` with an empty id anyway. That is the
      // fail-closed case the product exists to refuse, and the run reporting a
      // re-ask instead of a dispatch is the evidence that it does.
      return Promise.resolve(JSON.stringify(live === null ? ask : { ...ask, decision: 'approve', approves_id: live }));
    }
    if (name === 'task_plan') return Promise.resolve(plan);
    return Promise.resolve(intake);
  };
}
