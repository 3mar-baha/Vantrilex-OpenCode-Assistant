import { describe, expect, test } from 'vitest';

import type { SessionActivity, TurnRow } from '../runtime/client.js';
import { ServeClient } from '../runtime/client.js';
import { assistantText, agentSwitchConfirmed, classifyTurn, pollTurn, switchAgent, type PollResult } from './agent.js';

// THE THREE CAPABILITIES, GUARDED AGAINST THE THREE LIES THEY CAN TELL.
//
// Every fixture below is a row SHAPE MEASURED on opencode 1.18.32 on 2026-10-01,
// taken from `/session/{id}/message` during a real turn. The shapes are the point:
// a guard written against an invented fixture proves nothing about a server that
// does not send it.
//
// The three claims, and the three ways each can be broken:
//
//   switch  — "I asked for plan, therefore it is plan."  Broken by reporting
//             success without reading `info.agent`. A 204 accepts an agent name
//             that does not exist, so a request-echoing switch is green forever.
//   poll    — "an assistant row appeared, so the turn is done."  Broken by
//             treating row-presence as completion, which reports the model's
//             silence as its answer.
//   text    — "the turn is done, so here is what it said."  Broken by echoing
//             the request, which makes a spoken report indistinguishable from a
//             real one.

/** A row as serve sends it. `over` is the only thing a test may change. */
function row(over: Partial<TurnRow> = {}): TurnRow {
  return {
    id: 'msg_0f6849a010019h799FPcNxHhiJ',
    role: 'assistant',
    parentId: 'msg_parent',
    agent: 'plan',
    mode: 'plan',
    createdAt: 1_790_842_280_449,
    completedAt: 1_790_842_284_593,
    finish: 'stop',
    error: null,
    text: 'نعم',
    textParts: 1,
    partTypes: ['step-start', 'text', 'step-finish'],
    ...over,
  };
}

// THE USER ROW, exactly as measured. It is the row whose `id` IS the message id
// this client minted, and it carries the request text.
//
// THIS FIXTURE EXISTS BECAUSE THE FIRST VERSION OF `readTurn` MATCHED ON `id`
// AND WAS WRONG. Every fixture above is a single assistant row, so that bug was
// invisible to all of them; it was caught only by running the live poll, which
// then reported `still-running` for 90 s on a turn that completed in 4 s and
// printed the request back as the model's answer. A guard whose fixtures omit
// the real shape of the payload is not a guard.
const USER_ROW: TurnRow = {
  id: 'msg_parent',
  role: 'user',
  parentId: null,
  agent: 'plan',
  mode: null,
  createdAt: 1_790_842_278_410,
  completedAt: null,
  finish: null,
  error: null,
  text: 'رد بكلمة واحدة فقط: ما اسمك؟',
  textParts: 1,
  partTypes: ['text'],
};

// ── MEASURED TIMELINE ────────────────────────────────────────────────────────
//
// One real turn, read at 1 s intervals. The assistant row exists from t+1.5 s
// with ZERO parts; the text only lands at t+4.5 s. The gap between "row" and
// "answer" is 3 seconds of a row that is not a completion.
const AT_1_5S = row({ completedAt: null, finish: null, text: '', textParts: 0, partTypes: [] });
const AT_4_5S = row();

// ── 1 · THE SWITCH ───────────────────────────────────────────────────────────

describe('agentSwitchConfirmed — the switch is read back, never echoed', () => {
  test('accepts only what the server itself confirmed', () => {
    expect(agentSwitchConfirmed('plan', row({ agent: 'plan', mode: 'plan' }))).toBe(true);
  });

  test('BREAK: a requested name with no assistant row is NOT a switch', () => {
    // The live shape of a bad agent name: measured 204 in 5 ms, and then NO row
    // at all — not a row with a different agent, no row. A switch that reported
    // this as successful would be reporting a request that was dropped.
    expect(agentSwitchConfirmed('plan', null)).toBe(false);
  });

  test('BREAK: a row carrying a DIFFERENT agent is not the agent requested', () => {
    // The mirror defect, and the one a mock cannot catch: the transport returns
    // 204, the caller asked for `plan`, and serve ran `build`. Echoing the
    // request here is green on a mock and wrong on every real server.
    expect(agentSwitchConfirmed('plan', row({ agent: 'build', mode: 'build' }))).toBe(false);
  });

  test('BREAK: `agent` alone is not enough — `mode` must be the server\'s too', () => {
    // `mode` is the second, independent echo: serve classifies the turn from its
    // own agent catalog (`GET /agent` declares `mode` per agent). A row carrying
    // only `agent` has been half-populated, and half-populated is not proof.
    expect(agentSwitchConfirmed('plan', row({ agent: 'plan', mode: null }))).toBe(false);
  });

  test('a missing agent field on the row is a failure, not a wildcard', () => {
    expect(agentSwitchConfirmed('plan', row({ agent: null, mode: null }))).toBe(false);
  });
});

describe('switchAgent — the accept/read split', () => {
  test('reports the server\'s echo, not the request', async () => {
    const client = fakeClient([AT_4_5S]);
    const result = await switchAgent(client, 'ses_x', 'plan', { text: 'قل نعم' });
    expect(result.requested).toBe('plan');
    expect(result.observedAgent).toBe('plan');
    expect(result.observedMode).toBe('plan');
    expect(result.confirmed).toBe(true);
  });

  test('BREAK: an accepted-then-dropped turn is reported unconfirmed', async () => {
    // The whole reason the verb reads the row: serve answers 204 for an agent
    // that does not exist, so the acceptance is not the switch.
    const client = fakeClient([]);
    const result = await switchAgent(client, 'ses_x', 'not-an-agent-zzz', { text: 'x' });
    expect(result.observedAgent).toBeNull();
    expect(result.confirmed).toBe(false);
  });

  test('the `noReply` form says it cannot be proven, rather than borrowing the user row', () => {
    // Measured: `noReply` records the user row and sets the session agent with no
    // model call, and produces NO assistant row. The user row carries `agent` too
    // — and it is a field the REQUEST also carried, so reading it back would be
    // the echo this verb is built to avoid. `confirmed` is false and says why.
    const result = { noReply: true, confirmed: false, observedAgent: null, observedMode: null };
    expect(agentSwitchConfirmed('plan', null)).toBe(false);
    expect(result.noReply).toBe(true);
  });
});

// ── 2 · THE POLL ─────────────────────────────────────────────────────────────

describe('classifyTurn — four outcomes, and row-presence is not one of them', () => {
  test('completed with text', () => {
    expect(classifyTurn(AT_4_5S)).toBe('completed-with-text');
  });

  test('completed with NOTHING to say is its own outcome, not running and not an error', () => {
    // A turn that finished and produced no text. Collapsing it into
    // `still-running` would make a finished turn look like a slow one; collapsing
    // it into an error would invent a failure. It is measured to be reachable —
    // it is what the poll returns for the 1.5 s row once the budget is spent.
    expect(classifyTurn(row({ text: '', textParts: 0, partTypes: ['step-start'] }))).toBe('completed-empty');
    // Whitespace-only is the same outcome: a model that emitted a blank line has
    // said nothing, and treating "\n" as speech would put a newline in a TTS call.
    expect(classifyTurn(row({ text: '   \n  ', textParts: 0 }))).toBe('completed-empty');
  });

  test('BREAK: the 1.5 s row — present, empty, NOT finished — is still-running', () => {
    // THE measured trap. This row EXISTS and carries `agent: plan`, so anything
    // that switches on row-presence returns `completed-with-text` here and
    // reports the model's silence as its answer. The only field that separates
    // the two is `time.completed`, and it is absent on this row.
    expect(classifyTurn(AT_1_5S)).toBe('still-running');
  });

  test('BREAK: the USER row is never a completion, however much text it holds', () => {
    // Found by running the live poll, not by reading the code. The first
    // `readTurn` matched on `id`, and the id this client mints IS the user row's —
    // so the poll read the question, waited 90 s for an answer that had already
    // arrived, and printed the request back as the model's reply. The user row
    // carries real text, so a text-based check would have called it a finished
    // answer; only `role` separates it.
    //
    // THE FIXTURE IS DELIBERATELY HOSTILE, and the reason is a break-the-guard
    // result rather than a hunch. Serve's `UserMessage.time` declares only
    // `created` and is `additionalProperties: false`, so a real user row can never
    // carry `completed` — which means an earlier version of this test, built on
    // the real shape, passed whether or not the `role` guard existed. It was
    // VACUOUS: the `completedAt` check caught it anyway. A guard with a test that
    // cannot fail is not a guard, so the row below is given a completion time it
    // would never really carry, and the assertion is that `role` still wins.
    expect(classifyTurn(USER_ROW)).toBe('still-running');
    expect(USER_ROW.text.length).toBeGreaterThan(0);
    // Same row, plus the field serve would not send. Without the `role` check
    // this is `completed-with-text` — the poll reporting the operator's own
    // prompt as the model's finished answer.
    const hostile = { ...USER_ROW, completedAt: 1_790_842_284_593, finish: 'stop' };
    expect(classifyTurn(hostile)).toBe('still-running');
  });

  test('no row at all is still-running, never completed', () => {
    // Measured on an invalid agent name: 204 accepted, zero rows, forever.
    expect(classifyTurn(null)).toBe('still-running');
  });

  test('BREAK: an errored turn is errored even though it also completed', () => {
    // Measured on a rate-limited turn: `time.completed` AND an `error` object,
    // 75 s in. Checking completion first would report a failed turn as a
    // successful empty one — the worst of the four, because it exits 0.
    const err = { name: 'APIError', message: 'Rate limit exceeded', statusCode: 429, retryable: true };
    expect(classifyTurn(row({ text: '', error: err }))).toBe('errored');
  });
});

describe('pollTurn — it waits for the field, not for the row', () => {
  test('BREAK: keeps polling through the empty row and stops on completion', async () => {
    // The live timeline, replayed. A poller that stopped at the first row would
    // return the 1.5 s state and never see the text.
    const reads = [AT_1_5S, AT_1_5S, AT_1_5S, AT_4_5S];
    const result = await runPoll(reads);
    expect(result.outcome).toBe('completed-with-text');
    expect(result.polls).toBe(4);
    expect(assistantText(result.row)).toBe('نعم');
  });

  test('an empty-but-finished turn is reported as such and does not keep polling', async () => {
    const done = row({ text: '', textParts: 0 });
    const result = await runPoll([AT_1_5S, done]);
    expect(result.outcome).toBe('completed-empty');
    expect(result.polls).toBe(2);
  });

  test('a spent budget reports still-running and says what serve thought', async () => {
    // The budget is exhausted, so the outcome is `still-running` — but the
    // `/session/status` entry is what turns a bare "gave up" into an
    // attributable one. Measured on a rate-limited turn, where the status named
    // the exact provider error the assistant row would not carry for 10 more
    // seconds.
    const client = fakeClient([AT_1_5S], { kind: 'retry', detail: 'Rate limit exceeded', attempt: 5 });
    const result = await pollTurn(client, 'ses_x', 'msg_1', { timeoutMs: 1_000, intervalMs: 100, sleep: async () => {} });
    expect(result.outcome).toBe('still-running');
    expect(result.activity?.kind).toBe('retry');
    expect(result.activity?.attempt).toBe(5);
  });

  test('an errored turn stops the poll immediately', async () => {
    const err = { name: 'APIError', message: 'boom', statusCode: 500, retryable: false };
    const result = await runPoll([AT_1_5S, row({ text: '', error: err })]);
    expect(result.outcome).toBe('errored');
    expect(result.polls).toBe(2);
    expect(result.error?.statusCode).toBe(500);
  });

  test('a zero budget still READS once, because still-running must be observed', async () => {
    // A caller that passed `timeoutMs: 0` asked a question this can answer. A
    // loop that returned before its first read would answer it with a default
    // rather than with the server's answer.
    let reads = 0;
    const client = fakeClient([], undefined, () => { reads += 1; });
    const result = await pollTurn(client, 'ses_x', 'msg_1', { timeoutMs: 0, intervalMs: 100, sleep: async () => {} });
    expect(reads).toBe(1);
    expect(result.polls).toBe(1);
    expect(result.outcome).toBe('still-running');
  });

  test('every poll is reported, so a long wait is visible and not a hang', async () => {
    const seen: Array<number | null> = [];
    await pollTurn(fakeClient([AT_1_5S, AT_1_5S, AT_4_5S]), 'ses_x', 'msg_1', {
      timeoutMs: 10_000,
      intervalMs: 100,
      sleep: async () => {},
      onPoll: (r) => seen.push(r === null ? null : r.textParts),
    });
    expect(seen).toEqual([0, 0, 1]);
  });
});

// ── 3 · THE TEXT ─────────────────────────────────────────────────────────────

describe('assistantText — real output, not an echo', () => {
  test('BREAK: an unfinished row yields no speech at all', () => {
    // The single most important line of the three. A status report that printed
    // the request when the model had not answered would be the loudest possible
    // lie, and it is the default a naive implementation produces by falling back
    // to the text it sent.
    expect(assistantText(AT_1_5S)).toBe('');
    expect(assistantText(null)).toBe('');
  });

  test('BREAK: the USER row is never spoken, however much text it holds', () => {
    // The live defect, reproduced as a fixture. The first implementation printed
    // `رد بكلمة واحدة فقط: ما اسمك؟` — the operator's own prompt — under the
    // heading "the assistant's own text", on a turn that had answered `opencode`.
    // The refusal is by `role`, so it holds even if the row is somehow handed in.
    //
    // Unlike the `classifyTurn` guard, THIS one is load-bearing against a shape
    // serve really does send: the user row genuinely holds the prompt text, so
    // removing the check turns a passing suite into one that speaks the request.
    expect(assistantText(USER_ROW)).toBe('');
    expect(assistantText({ ...AT_4_5S, role: 'user' })).toBe('');
    expect(assistantText({ ...AT_4_5S, role: 'other' })).toBe('');
  });

  test('the model\'s own words come through, byte for byte', () => {
    // No Arabic normalization: diacritics, hamza forms and tatweel are the
    // model's output, and rewriting them would make the spoken line disagree with
    // the transcript the user actually received.
    const arabic = 'أكيد يا غالي، هسا بنرتبها';
    expect(assistantText(row({ text: arabic }))).toBe(arabic);
  });

  test('only the edges are trimmed, so a trailing newline cannot truncate a TTS line', () => {
    expect(assistantText(row({ text: '\n  تمام  \n' }))).toBe('تمام');
  });

  test('multi-part turns are concatenated in the order serve returned them', () => {
    // Measured live: a turn is `step-start`, `text`, `step-finish`, and a
    // tool-using turn has several `text` parts. Reading only the first would drop
    // most of the answer.
    expect(assistantText(row({ text: 'السطر الأول\nالسطر الثاني', textParts: 2 }))).toBe('السطر الأول\nالسطر الثاني');
  });
});

// ── FIXTURES ─────────────────────────────────────────────────────────────────

/** A `ServeClient` whose only three methods return scripted values. */
function fakeClient(
  turns: readonly (TurnRow | null)[],
  activity?: SessionActivity,
  onRead?: () => void,
): ServeClient {
  let i = 0;
  const readTurn = async (): Promise<TurnRow | null> => {
    onRead?.();
    const next = turns[Math.min(i, turns.length - 1)];
    i += 1;
    return next ?? null;
  };
  return {
    readTurn,
    sessionStatus: async () => activity ?? { kind: 'idle', detail: 'no entry' },
    promptTurn: async () => ({ messageId: 'msg_sent', status: 204, body: '' }),
  } as unknown as ServeClient;
}

function runPoll(turns: readonly (TurnRow | null)[]): Promise<PollResult> {
  return pollTurn(fakeClient(turns), 'ses_x', 'msg_1', {
    timeoutMs: 60_000,
    intervalMs: 1,
    sleep: async () => {},
  });
}
