import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { SessionId } from '../common/brands.js';
import type { UiCommand } from '../ipc/protocol.js';
import {
  COMMAND_TIERS,
  DESTRUCTIVE_KINDS,
  MAX_PARKED,
  PENDING_PROTOCOL_KINDS,
  CONFIRMATION_TTL_MS,
  createCommandHandler,
  describeAction,
  filePathError,
  isPendingProtocolKind,
  tierOf,
  type CommandTier,
  type GovernedCommand,
  type PendingProtocolCommand,
  type WorkCommandKind,
} from './command-router.js';
import { MAX_SPOKEN_ASK_WORDS, spokenAsk, type PendingConfirmation } from './permission.js';

// PHASE 5 — GOVERNANCE TIERS.
//
// WHY THESE ARE SHAPED THE WAY THEY ARE. Four guards in `permission-gate.test.ts`
// were VACUOUS on first write and had to be rewritten; the stated cause was a
// fake that hid the defect — a turn-counting gate, an id-echoing gate, an
// always-approving gate. The lesson generalises: a guard that passes with the
// mechanism DELETED is not a guard, it is a description. So every structural
// claim here is made against the SOURCE or against an observation that cannot
// be produced by a cooperative fake, and each one was verified by breaking the
// implementation and confirming the guard fails. The breaks are recorded in the
// report; the comment above each guard names the break that proves it.

interface Recorder {
  readonly handler: (cmd: GovernedCommand) => Promise<{ ok: boolean; detail?: string }>;
  readonly shells: string[];
  /** The WS command id each shell call was given, in call order. */
  readonly shellIds: string[];
  readonly files: Array<{ kind: string; path: string; contents?: string }>;
  readonly configs: Array<{ key: string; value?: string }>;
  readonly sessions: string[];
  readonly asks: PendingConfirmation[];
  readonly executed: string[];
}

interface HarnessOpts {
  readonly withFileOps?: boolean;
  readonly withConfigOps?: boolean;
  readonly withCreateSession?: boolean;
  readonly askLine?: (p: PendingConfirmation) => string | null;
  readonly clock?: { value: number };
}

function harness(opts: HarnessOpts = {}): Recorder {
  const shells: string[] = [];
  const shellIds: string[] = [];
  const files: Array<{ kind: string; path: string; contents?: string }> = [];
  const configs: Array<{ key: string; value?: string }> = [];
  const sessions: string[] = [];
  const asks: PendingConfirmation[] = [];
  const executed: string[] = [];
  const handler = createCommandHandler(
    {
      client: {
        setSessionAgent: async () => undefined,
        setSessionModel: async () => undefined,
        toggleSessionSkill: async () => undefined,
        // Returns a real verdict rather than `void`, so this harness can fail
        // the way production does. `unknown` is the MEASURED common case: serve
        // reports no exit code on a shell call.
        execSessionShell: async (_s: SessionId, c: string, id: string) => {
          shells.push(c);
          shellIds.push(id);
          return { outcome: 'unknown' as const };
        },
        ...(opts.withCreateSession === true
          ? {
              // Honours the `{ sessionId }` return contract rather than casting
              // it away: a fake that returns `void` where the interface promises
              // an object is a fake that cannot fail the way production does.
              createSession: async (d: string) => {
                sessions.push(d);
                return { sessionId: 'ses_created' as SessionId };
              },
            }
          : {}),
      },
      switchSession: () => undefined,
      activeSessionId: () => 'ses_active' as SessionId,
      projectDirectory: () => 'O:/project',
      ...(opts.withFileOps === true
        ? {
            mutateFile: async (_s: SessionId, op: { kind: 'writeFile' | 'deleteFile'; path: string; contents?: string }) => {
              files.push({ kind: op.kind, path: op.path, ...(op.contents !== undefined ? { contents: op.contents } : {}) });
            },
          }
        : {}),
      ...(opts.withConfigOps === true
        ? {
            setSensitiveConfig: async (_s: SessionId, op: { key: string; value?: string }) => {
              configs.push({ key: op.key, ...(op.value !== undefined ? { value: op.value } : {}) });
            },
          }
        : {}),
      ...(opts.askLine !== undefined ? { askLine: opts.askLine } : {}),
      onConfirmationRequired: (p) => void asks.push(p),
      onExecuted: (c) => void executed.push(c.kind),
    },
    { now: () => opts.clock?.value ?? 1_000 },
  );
  return { handler, shells, shellIds, files, configs, sessions, asks, executed };
}

/**
 * The tier of a kind named by a STRING — or `null` when it has none.
 *
 * This exists so the totality guard can read the real enum out of `protocol.ts`
 * without a cast. `tierOf` takes a `GovernedKind`, and a string scraped out of
 * a source file is genuinely not one; the honest way to cross that boundary is a
 * function that ADMITS the failure (`null` = unclassified) rather than an `as
 * never` that pretends the question was never asked. The `null` branch is the
 * whole point: it is what the guard asserts on, so an unclassified kind fails
 * with its name instead of being cast into a call that cannot fail.
 */
function tierFor(kind: string): CommandTier | null {
  const table = COMMAND_TIERS as Readonly<Record<string, CommandTier>>;
  return Object.prototype.hasOwnProperty.call(table, kind) ? (table[kind] ?? null) : null;
}

const shell = (id: string, command: string): UiCommand => ({ id, kind: 'execSessionShell', command });const confirm = (id: string, confirmId: string, approve?: boolean): UiCommand =>
  approve === undefined ? { id, kind: 'confirm', confirmId } : { id, kind: 'confirm', confirmId, approve };
const write = (id: string, path: string, contents?: string): PendingProtocolCommand => ({
  id,
  kind: 'writeFile',
  path,
  ...(contents !== undefined ? { contents } : {}),
});
const remove = (id: string, path: string): PendingProtocolCommand => ({ id, kind: 'deleteFile', path });
const setConfig = (id: string, key: string, value?: string): PendingProtocolCommand => ({
  id,
  kind: 'setSensitiveConfig',
  configKey: key,
  ...(value !== undefined ? { configValue: value } : {}),
});

// ── THE OWNER'S CORRECTION: TIER 1 FLOWS FREELY ──────────────────────────────
describe('tier 1 — read-only and conversational: NO GATE  [ANTI-DEFECT]', () => {
  test('switchSession executes on the asking turn, with no ask raised', async () => {
    const h = harness();
    const res = await h.handler({ id: 'c1', kind: 'switchSession', sessionId: 'ses_b' } as UiCommand);
    expect(res).toEqual({ ok: true });
    expect(h.asks, 'a session switch must never raise an ask').toEqual([]);
  });

  test('sessionContext executes on the asking turn, with no ask raised', async () => {
    // The owner's tier-1 list names this verb explicitly. It is the read that
    // most obviously must not cost a round trip, and it is the one a
    // deny-list-everything reading would have caught.
    const h = harness();
    const res = await h.handler({ id: 'c1', kind: 'sessionContext', sessionId: 'ses_a' } as UiCommand);
    // Fails on telemetry, not on a park — either way it never asked.
    expect(res.ok).toBe(false);
    expect(res.detail).not.toBe('confirmation-required');
    expect(h.asks).toEqual([]);
  });

  test('the session-selection verbs execute on the asking turn', async () => {
    // The regression this whole tier model exists to prevent. `setSessionModel`
    // behind an approval prompt is "switch to opus" asking "are you sure?".
    const h = harness();
    expect(await h.handler({ id: 'a', kind: 'setSessionAgent', agent: 'build' } as UiCommand)).toEqual({ ok: true });
    expect(await h.handler({ id: 'b', kind: 'setSessionModel', model: 'anthropic/opus' } as UiCommand)).toEqual({ ok: true });
    // `setPersona` answers with the literal detail `persona-set` (pre-existing
    // contract, pinned in command-router.test.ts), so `ok` is what is asserted.
    expect((await h.handler({ id: 'c', kind: 'setPersona', persona: 'nour' } as UiCommand)).ok).toBe(true);
    expect(h.asks).toEqual([]);
  });

  test('a barge still costs nothing, even with the ask hook wired', async () => {
    // M2's own invariant, re-pinned under the new gate: `stopSpeech` must not
    // be able to acquire a confirmation round-trip as a side effect of Phase 5.
    const h = harness();
    expect(await h.handler({ id: 'z', kind: 'stopSpeech' } as UiCommand)).toEqual({ ok: true });
    expect(await h.handler({ id: 'y', kind: 'abort' } as UiCommand)).toEqual({ ok: true });
    expect(h.asks).toEqual([]);
  });

  test('NOT ONE read-only kind is in the gated set', () => {
    // Structural, and the direct statement of the owner's table. Written
    // against the SOURCE-DERIVED export rather than a hard-coded list, so it
    // fails if a kind is reclassified — and it is verified by the break below.
    //
    // `WorkCommandKind`, NOT `UiCommand['kind']`. `confirm` is deliberately not
    // a governed kind and this annotation is what says so: it is the approval
    // PATH, not work, so there is no tier for it. Declaring the list over the
    // full wire union would have forced a cast here to hide the mismatch — and
    // a cast is how a test starts passing for the wrong reason. The production
    // call site is the same shape for the same reason: `tierOf(cmd.kind)` sits
    // after the `if (cmd.kind === 'confirm')` block that has already returned.
    const readOnly: ReadonlyArray<WorkCommandKind> = [
      'switchSession',
      'sessionContext',
      'setSessionAgent',
      'setSessionModel',
      'setPersona',
      'abort',
      'stopSpeech',
      'playbackStarted',
      'mute',
      'deafen',
      'arm',
      'saveApiKeys',
    ];
    for (const kind of readOnly) {
      expect(tierOf(kind), `${kind} is the owner's tier 1 or a no-op`).toBe('read-only');
      // `DESTRUCTIVE_KINDS` is `ReadonlySet<WorkCommandKind>` and `kind` is a
      // `WorkCommandKind`, so `.has` needs no cast. It needed one before only
      // because the list was over-typed — the same defect one line up.
      expect(DESTRUCTIVE_KINDS.has(kind), `${kind} must not be gated`).toBe(false);
    }
  });

  test('`confirm` is not a governed kind, and has no tier', () => {
    // The type-level half, stated as a runtime fact so it cannot be quietly
    // widened later. `confirm` is the mechanism that RELEASES a state-mutating
    // command, not a verb that does work, so filing it under either tier would
    // be a lie: "read-only" would put a confirm in the free path, and
    // "state-mutating" would make confirming a confirmable action.
    expect(Object.prototype.hasOwnProperty.call(COMMAND_TIERS, 'confirm')).toBe(false);
    expect(DESTRUCTIVE_KINDS.has('confirm' as WorkCommandKind)).toBe(false);
  });
});

// ── TIER 2: THE OWNER'S LIST, GATED AND FAIL-CLOSED ──────────────────────────
describe('tier 2 — state-mutating: verbal confirmation, fail-closed', () => {
  test('execSessionShell parks and runs nothing on the asking turn', async () => {
    const h = harness();
    expect(await h.handler(shell('c1', 'git status'))).toEqual({ ok: true, detail: 'confirmation-required' });
    expect(h.shells).toEqual([]);
  });

  test('a file write parks and writes nothing on the asking turn', async () => {
    const h = harness({ withFileOps: true });
    expect(await h.handler(write('c1', 'src/app.ts', 'x'))).toEqual({ ok: true, detail: 'confirmation-required' });
    expect(h.files).toEqual([]);
  });

  test('a file delete parks and deletes nothing on the asking turn', async () => {
    const h = harness({ withFileOps: true });
    expect(await h.handler(remove('c1', 'src/app.ts'))).toEqual({ ok: true, detail: 'confirmation-required' });
    expect(h.files).toEqual([]);
  });

  test('a sensitive-config toggle parks and applies nothing on the asking turn', async () => {
    const h = harness({ withConfigOps: true });
    expect(await h.handler(setConfig('c1', 'permissions.autoApprove', 'true'))).toEqual({ ok: true, detail: 'confirmation-required' });
    expect(h.configs).toEqual([]);
  });

  test('each tier-2 verb executes exactly what was parked, on the confirming turn', async () => {
    const h = harness({ withFileOps: true, withConfigOps: true });
    await h.handler(write('c1', 'src/a.ts', 'A'));
    expect(await h.handler(confirm('x1', 'c1'))).toEqual({ ok: true });
    expect(h.files).toEqual([{ kind: 'writeFile', path: 'src/a.ts', contents: 'A' }]);

    await h.handler(remove('c2', 'src/b.ts'));
    await h.handler(confirm('x2', 'c2'));
    expect(h.files).toHaveLength(2);
    expect(h.files[1]).toEqual({ kind: 'deleteFile', path: 'src/b.ts' });

    await h.handler(setConfig('c3', 'sandbox', 'off'));
    await h.handler(confirm('x3', 'c3'));
    expect(h.configs).toEqual([{ key: 'sandbox', value: 'off' }]);
  });

  test('a shell command is executed under the id the SHELL sent, not the confirm id', async () => {
    // The half of the threading the gate could have broken: the payload that
    // runs is `parked.cmd`, so `cmd.id` at the execution site is the exec
    // command's own id. A regression that read the CONFIRM's id would pass every
    // other test in this file — nothing else looks at it.
    const h = harness();
    await h.handler(shell('exec-42', 'rm -rf build'));
    await h.handler(confirm('confirm-99', 'exec-42'));
    expect(h.shells).toEqual(['rm -rf build']);
    expect(h.shellIds).toEqual(['exec-42']);
    expect(h.shellIds).not.toContain('confirm-99');
  });

  test('a dispatched shell command acks its DERIVED outcome, not a bare ok', async () => {
    // `ok` is dispatch; the verdict rides `detail`. The harness answers
    // `unknown` (the measured case: no exit code from serve), and the ack has to
    // say so — a bare `{ ok: true }` is what left the ack, the output frame and
    // the task notice telling three different stories about one command.
    const h = harness();
    await h.handler(shell('exec-1', 'exit 3'));
    expect(await h.handler(confirm('c-1', 'exec-1'))).toEqual({
      ok: true,
      detail: 'shell-outcome-unknown',
    });
  });

  test('an unavailable tier-2 verb refuses WITHOUT parking or asking', async () => {
    // Availability before attention. A daemon that cannot write a file must not
    // make the user confirm a write it will refuse on the next line.
    const h = harness();
    expect(await h.handler(write('c1', 'src/a.ts', 'A'))).toEqual({ ok: false, detail: 'file operations unavailable' });
    expect(await h.handler(setConfig('c2', 'sandbox', 'off'))).toEqual({ ok: false, detail: 'configuration writes unavailable' });
    expect(h.asks, 'an unreachable verb must not raise an ask').toEqual([]);
  });

  test('a malformed tier-2 verb is refused BEFORE it is parked', async () => {
    const h = harness({ withFileOps: true });
    expect(await h.handler(remove('c1', '../secrets.txt'))).toEqual({ ok: false, detail: 'path rejected (path traversal)' });
    expect(await h.handler(shell('c2', 'rm -rf *'))).toEqual({ ok: false, detail: 'command rejected (unsafe metacharacters)' });
    expect(h.asks).toEqual([]);
  });
});

// ── SINGLE USE, BOUND TO THE ACTION ──────────────────────────────────────────
describe('an approval is single-use and bound to ONE action  [ANTI-DEFECT]', () => {
  test('the same confirm replayed does not execute the action twice', async () => {
    // NOT a turn-counting fake: the replay is an explicit second call carrying
    // the identical payload. The first break-guard of this file's phase proved
    // that a fake which only approves once can make this pass on its own
    // bookkeeping even if nothing was deleted.
    const h = harness({ withFileOps: true });
    await h.handler(write('c1', 'src/a.ts', 'A'));
    const first = await h.handler(confirm('x1', 'c1'));
    const replay = await h.handler(confirm('x1', 'c1'));
    expect(first).toEqual({ ok: true });
    expect(replay).toEqual({ ok: false, detail: 'no pending action' });
    expect(h.files, 'exactly one write').toHaveLength(1);
  });

  test('a confirm naming a DIFFERENT id executes nothing', async () => {
    const h = harness({ withFileOps: true });
    await h.handler(write('c1', 'src/a.ts', 'A'));
    expect(await h.handler(confirm('x1', 'c-not-parsed'))).toEqual({ ok: false, detail: 'no pending action' });
    expect(h.files).toEqual([]);
  });

  test('a confirm cannot be re-pointed at a later action with the same id', async () => {
    // Re-using the id must not resurrect the old grant: the slot for `c1` is
    // gone, so parking a NEW `c1` and confirming it runs the NEW action only.
    const h = harness({ withFileOps: true });
    await h.handler(write('c1', 'first.ts', '1'));
    await h.handler(confirm('x1', 'c1'));
    await h.handler(write('c1', 'second.ts', '2'));
    await h.handler(confirm('x2', 'c1'));
    expect(h.files.map((f) => f.path)).toEqual(['first.ts', 'second.ts']);
  });

  test('an EXPIRED approval executes nothing, and the slot is gone afterwards', async () => {
    // The control for the expiry test, because a guard that only ever sees
    // "expired → nothing ran" passes if the slot is deleted on ANY path.
    const clock = { value: 1_000 };
    const live = harness({ withFileOps: true, clock });
    await live.handler(write('c1', 'a.ts', 'A'));
    clock.value += CONFIRMATION_TTL_MS - 1;
    expect(await live.handler(confirm('x1', 'c1'))).toEqual({ ok: true });
    expect(live.files).toHaveLength(1);

    const dead = harness({ withFileOps: true, clock });
    await dead.handler(write('c1', 'a.ts', 'A'));
    clock.value += CONFIRMATION_TTL_MS + 1;
    expect(await dead.handler(confirm('x1', 'c1'))).toEqual({ ok: false, detail: 'confirmation expired' });
    // Expired AND consumed: a second attempt is not "not found", it is gone.
    expect(await dead.handler(confirm('x2', 'c1'))).toEqual({ ok: false, detail: 'no pending action' });
    expect(dead.files).toEqual([]);
  });

  test('a denial consumes the ask, so a later confirm of the same id is dead', async () => {
    const h = harness({ withFileOps: true });
    await h.handler(write('c1', 'a.ts', 'A'));
    expect(await h.handler(confirm('x1', 'c1', false))).toEqual({ ok: true, detail: 'cancelled' });
    expect(await h.handler(confirm('x2', 'c1'))).toEqual({ ok: false, detail: 'no pending action' });
    expect(h.files).toEqual([]);
  });

  test('a crash during execution leaves nothing replayable', async () => {
    // The half-applied-permission case. The dep throws on the SECOND write, so
    // the first must have happened exactly once and the retry must not fire it
    // again: a surviving grant would write the file a second time.
    let n = 0;
    const files: string[] = [];
    const h = harness({ withFileOps: true });
    const crashing = createCommandHandler(
      {
        client: {
          setSessionAgent: async () => undefined,
          setSessionModel: async () => undefined,
          toggleSessionSkill: async () => undefined,
          execSessionShell: async () => undefined,
        },
        switchSession: () => undefined,
        activeSessionId: () => 'ses_active' as SessionId,
        projectDirectory: () => 'O:/project',
        mutateFile: async () => {
          n += 1;
          files.push('write');
          throw new Error('serve 4096 refused the connection');
        },
        onConfirmationRequired: () => undefined,
      },
      { now: () => 1_000 },
    );
    await crashing(write('c1', 'a.ts', 'A'));
    // It does NOT reject: the router's contract is that no exception escapes to
    // the socket. It must also not read as success — a swallowed crash that
    // returns `{ok:true}` is the same lie as a swallowed permission.
    expect(await crashing(confirm('x1', 'c1'))).toEqual({ ok: false, detail: 'internal' });
    // The grant was consumed BEFORE the action, so the identical confirm is
    // now an unknown id rather than a retry.
    expect(await crashing(confirm('x2', 'c1'))).toEqual({ ok: false, detail: 'no pending action' });
    expect(n, 'the crashed action is not re-runnable').toBe(1);
    expect(files).toEqual(['write']);
    void h;
  });

  test('the park cap still evicts oldest-first across the whole tier', async () => {
    // The cap is a property of the SLOT, not of one kind, so it is exercised
    // with a mix — a cap that only counted `execSessionShell` would pass a
    // same-kind test and fail this one.
    const h = harness({ withFileOps: true, withConfigOps: true, withCreateSession: true });
    const ids: string[] = [];
    for (let i = 0; i < MAX_PARKED * 3; i += 1) {
      const id = `p${i}`;
      ids.push(id);
      if (i % 3 === 0) await h.handler(shell(id, `echo ${i}`));
      else if (i % 3 === 1) await h.handler(write(id, `f${i}.ts`, 'x'));
      else await h.handler(setConfig(id, `k${i}`, 'v'));
    }
    let executed = 0;
    for (const id of ids) {
      const r = await h.handler(confirm(`c-${id}`, id));
      if (r.ok) executed += 1;
    }
    expect(executed).toBe(MAX_PARKED);
    // The newest survives, across kinds.
    await h.handler(write('newest', 'newest.ts', 'x'));
    await h.handler(confirm('cn', 'newest'));
    expect(h.files[h.files.length - 1]).toEqual({ kind: 'writeFile', path: 'newest.ts', contents: 'x' });
  });
});

// ── THE ASK: PERSONA VOICE, SHORT, AND RAISED ON THE ASKING TURN ─────────────
describe('the ask is raised, in the persona voice, and nothing runs', () => {
  test('the ask carries the action it is bound to, derived from the payload', async () => {
    const h = harness({ withFileOps: true, askLine: () => 'بدي أحذف هالملف، أكمل؟' });
    await h.handler(remove('c1', 'src/old.ts'));
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.taskEn).toBe('delete file: src/old.ts');
    expect(h.asks[0]?.id).toBe('c1');
    expect(h.asks[0]?.sessionId).toBe('ses_active');
    expect(h.asks[0]?.tier).toBe('state-mutating');
  });

  test('a shell ask names the command, and never claims a verb it did not do', async () => {
    const h = harness({ askLine: () => 'أشغّل هالأمر؟' });
    await h.handler(shell('c1', 'rm -rf build'));
    // "shell:", not "run": the model wrote the proposal, the router only
    // handed the string to the shell. See `describeAction`.
    expect(h.asks[0]?.taskEn).toBe('shell: rm -rf build');
  });

  test('the persona line is what reaches the ask, and it is bounded', async () => {
    const long = Array.from({ length: MAX_SPOKEN_ASK_WORDS + 1 }, (_, i) => `كلمة${i}`).join(' ');
    const h = harness({ withFileOps: true, askLine: () => long });
    await h.handler(write('c1', 'a.ts', 'A'));
    // Over the cap → withheld, NOT replaced by a template.
    expect(h.asks[0]?.askAr).toBe('');
    expect(h.files, 'and the action is still parked').toEqual([]);
  });

  test('an unwired ask-writer withholds the line and still parks', async () => {
    const h = harness({ withFileOps: true });
    await h.handler(write('c1', 'a.ts', 'A'));
    expect(h.asks[0]?.askAr).toBe('');
    expect(h.asks[0]?.taskEn).toBe('write file: a.ts');
  });

  test('a THROWING ask-writer changes nothing but the sentence', async () => {
    // The gate must not depend on the writer. If a throw could turn into a
    // proceed, this is the test that would catch it.
    const h = harness({
      withFileOps: true,
      askLine: () => {
        throw new Error('openrouter 500');
      },
    });
    expect(await h.handler(write('c1', 'a.ts', 'A'))).toEqual({ ok: true, detail: 'confirmation-required' });
    expect(h.asks[0]?.askAr).toBe('');
    expect(h.files).toEqual([]);
    // And the action is still approvable — the writer is decoration.
    expect(await h.handler(confirm('x1', 'c1'))).toEqual({ ok: true });
    expect(h.files).toHaveLength(1);
  });

  test('spokenAsk never returns a template, and caps at twenty words', () => {
    expect(spokenAsk('أشغّل هالأمر؟')).toBe('أشغّل هالأمر؟');
    expect(spokenAsk('  "أكمل؟"  '), 'quotes and space are stripped').toBe('أكمل؟');
    // A `تم:` PREFIX is stripped, matching `narrate()`'s documented behaviour
    // (narrator.ts:158). The remainder is NOT pattern-matched for outcome
    // claims: that is `coordinator.claimsOutcome`'s job on intake, and a second
    // Arabic regex here would be the class of widening `normalizeArabic` and
    // `OUTCOME_CLAIM_AR` both exist to warn about.
    expect(spokenAsk('تم: أكمل؟'), 'the outcome prefix is stripped').toBe('أكمل؟');
    expect(spokenAsk('   ')).toBeNull();
    expect(spokenAsk('')).toBeNull();
    const atCap = Array.from({ length: MAX_SPOKEN_ASK_WORDS }, (_, i) => `ك${i}`).join(' ');
    expect(spokenAsk(atCap), 'exactly at the cap is allowed').not.toBeNull();
    expect(spokenAsk(`${atCap} زائد`), 'one word over is withheld').toBeNull();
  });
});

// ── THE COMPILER IS THE GATE ────────────────────────────────────────────────
describe('the tier table is total, and the compiler is what enforces it', () => {
  test('every kind in the wire contract is classified, with no default branch', async () => {
    // Reads the ACTUAL enum out of protocol.ts rather than a copied list, so a
    // kind added there without a tier fails HERE as well as at compile time.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../ipc/protocol.ts'), 'utf8');
    const block = source.match(/kind: z\.enum\(\[([\s\S]*?)\]\)/);
    expect(block, 'the kind enum is where this guard expects it').not.toBeNull();
    // `string` is the honest type for text scraped out of a source file; the
    // `as string` is a WIDENING from `string | undefined` under
    // `noUncheckedIndexedAccess`, not an escape from a type error.
    const kinds = [...(block?.[1] ?? '').matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1] as string);
    expect(kinds.length).toBeGreaterThan(10);
    const unclassified: string[] = [];
    for (const kind of kinds) {
      // `confirm` is the approval path, not work: it has no tier by design.
      if (kind === 'confirm') continue;
      const tier = tierFor(kind);
      if (tier === null) {
        unclassified.push(kind);
        continue;
      }
      expect(tier, `${kind} has an honest tier`).toMatch(/^(read-only|state-mutating)$/);
    }
    // Collected and asserted once, so an unclassified kind is reported by NAME
    // rather than as a `tierOf` call on a value the compiler will not accept.
    expect(unclassified, 'every wire kind is classified').toEqual([]);
  });

  test('the three pending kinds are classified AND reported as pending', () => {
    // Guards the honesty of the report: if these were quietly dropped, the
    // integration wave would never learn it has work to do.
    for (const kind of PENDING_PROTOCOL_KINDS) {
      expect(tierOf(kind)).toBe('state-mutating');
      expect(isPendingProtocolKind(kind)).toBe(true);
      expect(isPendingProtocolKind('execSessionShell')).toBe(false);
    }
    expect(PENDING_PROTOCOL_KINDS).toHaveLength(3);
  });

  test('DESTRUCTIVE_KINDS is derived from the table, not a second list', () => {
    // If the export is ever hand-edited instead of derived, the two drift and
    // this fails. It is the guard against a second source of truth.
    const expected = (Object.keys(COMMAND_TIERS) as Array<keyof typeof COMMAND_TIERS>).filter(
      (k) => COMMAND_TIERS[k] === 'state-mutating' && !isPendingProtocolKind(k),
    );
    expect([...DESTRUCTIVE_KINDS].sort()).toEqual(expected.sort());
  });

  test('the gated set contains exactly the three adopted state-mutating verbs', () => {
    // A plain assertion of the delivered classification, so a future
    // reclassification is a deliberate diff against this line.
    expect([...DESTRUCTIVE_KINDS].sort()).toEqual(
      ['createSession', 'execSessionShell', 'toggleSessionSkill'].sort(),
    );
  });
});

// ── STRUCTURAL PROPERTIES THAT MUST NOT DRIFT ───────────────────────────────
describe('the structural properties the tier model must not break', () => {
  test('the router executes a parked action from EXACTLY ONE place', () => {
    // The router's mirror of `permission-gate.test.ts`'s single-`dispatch`
    // guard. `execute(` is called from the confirm branch and from the
    // read-only tail; a THIRD call site would be a route to execution that does
    // not pass through a slot.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, 'command-router.ts'), 'utf8');
    expect(source.match(/await execute\(/g) ?? []).toHaveLength(2);
    // …and exactly one of them is the parked one.
    expect(source.match(/await execute\(parked\.cmd\)/g) ?? []).toHaveLength(1);
  });

  test('the confirm branch deletes the slot BEFORE it executes the action', () => {
    // Ordering, read from the source. Moving the delete below the `execute`
    // call would make a crash replayable, and no behavioural test can see the
    // difference without instrumenting the delete itself.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, 'command-router.ts'), 'utf8');
    const del = source.indexOf('pending.delete(id);');
    const run = source.indexOf('await execute(parked.cmd)');
    expect(del, 'the delete exists').toBeGreaterThan(-1);
    expect(run, 'the execute exists').toBeGreaterThan(-1);
    expect(del, 'delete must precede execute').toBeLessThan(run);
  });

  test('the tier lookup is the ONLY thing that decides whether a command is gated', () => {
    // If a second condition can park a command, the table is not the model.
    //
    // SCOPED DELIBERATELY to `tierOf(`, not to `'state-mutating'`. An earlier
    // revision of this guard counted the string and found 2 — the second being
    // the `DESTRUCTIVE_KINDS` derivation, which is a CLASSIFICATION of the
    // table rather than a decision about a command. Broadening the pattern
    // until it went green would have been a guard that passes for the wrong
    // reason; narrowing it to the decision site is the real invariant. The
    // adjacent test below pins that the derivation stays a derivation.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, 'command-router.ts'), 'utf8');
    expect(source.match(/tierOf\(cmd\.kind\) === 'state-mutating'/g) ?? []).toHaveLength(1);
    // …and no other kind-of test can park: `DESTRUCTIVE_KINDS` is used nowhere
    // in a gating position, so removing it would not weaken the gate.
    const gateUses = source.match(/DESTRUCTIVE_KINDS\.[a-z]+\(/g) ?? [];
    expect(gateUses, 'DESTRUCTIVE_KINDS must not be consulted to gate').toEqual([]);
  });

  test('`coordinator.ts` is untouched by this change: still one proceed, one dispatch', () => {
    // The property the whole Phase-5 correction had to preserve lives in
    // `coordinator.ts`, which this change does not edit. Asserting it here
    // means a future edit that widens the gate is caught by THIS suite too.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, 'coordinator.ts'), 'utf8');
    expect(source.match(/this\.deps\.dispatch\(/g) ?? []).toHaveLength(1);
    expect(source.match(/return \{ kind: 'proceed'/g) ?? []).toHaveLength(1);
  });
});

// ── PURE HELPERS ────────────────────────────────────────────────────────────
describe('filePathError and describeAction', () => {
  test('filePathError refuses the shapes a path must not have', () => {
    expect(filePathError('src/app.ts')).toBeNull();
    expect(filePathError('')).toBe('path required');
    expect(filePathError('   ')).toBe('path required');
    expect(filePathError('../secrets')).toBe('path rejected (path traversal)');
    expect(filePathError('src/../../etc/passwd')).toBe('path rejected (path traversal)');
    expect(filePathError('a\nb')).toBe('path rejected (control characters)');
    expect(filePathError('x'.repeat(1025))).toBe('path too long');
  });

  test('the rejection message never echoes the path back', () => {
    // The message lands in the supervisor log and on the HUD.
    expect(filePathError('../secret-project-name')).not.toContain('secret-project-name');
  });

  test('describeAction names the payload argument, never a template', () => {
    expect(describeAction(shell('c1', 'npm test'))).toBe('shell: npm test');
    expect(describeAction(write('c1', 'a.ts', 'x'))).toBe('write file: a.ts');
    expect(describeAction(remove('c1', 'a.ts'))).toBe('delete file: a.ts');
    expect(describeAction(setConfig('c1', 'k'))).toBe('set config: k');
  });

  test('describeAction is bounded, so a long command cannot become a wall of text', () => {
    const long = describeAction(shell('c1', 'echo ' + 'a'.repeat(512)));
    expect(long.length).toBeLessThanOrEqual(240);
  });
});
