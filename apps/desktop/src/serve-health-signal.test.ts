import { describe, expect, test } from 'vitest';
import { INITIAL_RECONNECT, actionsBlocked, type ReconnectState } from './components/bento/ReconnectBanner.js';
import {
  SERVE_COMMAND_CLASS,
  SERVE_HEALTH_CODES,
  SERVE_LOCAL_ONLY_COMMANDS,
  SERVE_PROBE_COMMANDS,
  SERVE_REACHING_COMMANDS,
  isServeHealthCode,
  isServeLocalOnlyCommand,
  reconnectFromAck,
  reconnectFromNotice,
} from './serve-health-signal.js';
import type { CommandKind } from './bridge/ws.js';

// The renderer half of the serve-health contract, asserted on its own.
//
// WHY A SEPARATE FILE: `App.test.tsx` can prove the banner APPEARS when App is
// handed a serve-health notice. It cannot prove the banner stays away when it is
// handed everything else, because "nothing happened" is not an assertion a mount
// makes for you. The policy is four lines and every one of them is a decision
// somebody could get wrong in the direction of a false amber bar over a live
// user — so it is a pure module with a pure suite.
//
// WHAT IS NOT PROVEN HERE: that any of these codes is ever emitted.
// `src/runtime/serve-health.ts` states it is not wired into the daemon yet, so
// every test below is about the FOLD, and none of it is evidence about 4096.

/** A drop, folded the way App folds it, with the episode already advanced. */
function dropped(detailAr = 'انقطع الاتصال'): ReconnectState {
  return reconnectFromNotice(INITIAL_RECONNECT, 'serve-degraded', detailAr);
}

describe('serve-health-signal: only the documented codes are serve-health', () => {
  test('the vocabulary is exactly the three literals serve-health.ts defines', () => {
    // `SERVE_BLOCKED_DETAIL_DEGRADED` / `_RECONNECTING` / `_EXHAUSTED` and
    // `SERVE_NOTICE_RECONNECTING`. Renaming one there is a rename here, and this
    // is the assertion that says so out loud.
    expect([...SERVE_HEALTH_CODES]).toEqual(['serve-degraded', 'serve-reconnecting', 'serve-reconnect-exhausted']);
  });

  test.each([...SERVE_HEALTH_CODES])('%s is recognised', (code) => {
    expect(isServeHealthCode(code)).toBe(true);
  });

  test.each([
    'tts-credit-exhausted',
    'voice-disabled-no-keys',
    'persona-changed',
    'assistant-said',
    // Case matters: the codes are machine tokens compared verbatim, so a
    // shell that lower-cased or de-punctuated them would accept nothing.
    'Serve-Degraded',
    'serve_degraded',
    '',
  ])('%s is not a serve-health code', (code) => {
    expect(isServeHealthCode(code)).toBe(false);
  });
});

describe('serve-health-signal: no producer yet, so no banner and no block', () => {
  // THE load-bearing test of this file. A renderer that turned "I have not been
  // told serve is down" into a green light is the `layaReady: true` defect in a
  // new place, and it is invisible because every assertion would still pass.
  test('an ordinary notice leaves the state untouched — no banner, no block', () => {
    for (const code of ['assistant-said', 'voice-disabled-no-keys', 'persona-changed', 'tts-credit-exhausted']) {
      const next = reconnectFromNotice(INITIAL_RECONNECT, code, 'تفاصيل');
      expect(next, `${code} must not fabricate an outage`).toBe(INITIAL_RECONNECT);
      expect(actionsBlocked(next)).toBe(false);
    }
  });

  test('a LOCAL command ack is not health evidence, even when it succeeds', () => {
    // These are the commands `serve-health.ts` allowlists as serve-independent.
    // Their `ok` is manufactured by the router — `mute`/`deafen`/`arm` return it
    // with no dependency call whatsoever — so treating one as "serve answered"
    // would declare a dead port healthy on a mic keypress.
    for (const kind of ['mute', 'deafen', 'arm', 'switchSession', 'setPersona', 'saveApiKeys', 'abort']) {
      expect(reconnectFromAck(dropped(), kind, true), `${kind} must not clear an outage`).toEqual(dropped());
    }
  });

  test('a failed ack is not evidence either way', () => {
    // A refusal carries `ack.detail: 'serve-degraded'`, which the NOTICE frame
    // reports. Reading the failure as a drop here would turn one outage into two
    // episodes and re-arm a banner the user had closed.
    expect(reconnectFromAck(INITIAL_RECONNECT, 'setSessionAgent', false)).toBe(INITIAL_RECONNECT);
    const live = dropped();
    expect(reconnectFromAck(live, 'setSessionAgent', false)).toEqual(live);
  });
});

describe('serve-health-signal: a documented code raises one episode', () => {
  test.each([...SERVE_HEALTH_CODES])('%s drops and blocks the action surface', (code) => {
    const next = reconnectFromNotice(INITIAL_RECONNECT, code, 'انقطع الاتصال بالخادم');
    expect(next.dropped).toBe(true);
    expect(actionsBlocked(next), 'the block is the whole point — a dead 4096 is not a warning').toBe(true);
    expect(next.detailAr).toBe('انقطع الاتصال بالخادم');
    // One episode, so the banner's identity is stable across the outage.
    expect(next.episode).toBe(1);
  });

  test('the daemon\'s Arabic detail is carried verbatim, not re-worded here', () => {
    const detail = 'انقطع الاتصال بالخادم على المنفذ ٤٠٩٦ — جارٍ إعادة المحاولة…';
    expect(reconnectFromNotice(INITIAL_RECONNECT, 'serve-reconnecting', detail).detailAr).toBe(detail);
  });

  test('a re-notification inside one outage does NOT resurrect a dismissed banner', () => {
    // The 15 s poll shape: two failures, one outage. If the second re-armed, a
    // dismissal would last five seconds and the banner would nag forever.
    const dismissed: ReconnectState = { ...dropped(), dismissed: true };
    const again = reconnectFromNotice(dismissed, 'serve-degraded', 'نفس العطل');
    expect(again).toBe(dismissed);
    expect(again.dismissed, 'still dismissed').toBe(true);
    expect(actionsBlocked(again), 'and still blocked — dismissing the words never unlocks a dead port').toBe(true);
  });

  test('a NEW outage after a recovery gets a NEW episode', () => {
    const restored = reconnectFromAck(dropped(), 'execSessionShell', true);
    expect(restored.dropped).toBe(false);
    const second = reconnectFromNotice(restored, 'serve-degraded', 'عطل ثانٍ');
    expect(second.dropped).toBe(true);
    expect(second.dismissed, 'a new episode re-arms; a dismissal is scoped to its outage').toBe(false);
    expect(second.detailAr).toBe('عطل ثانٍ');
  });
});

describe('serve-health-signal: recovery is proven, never assumed', () => {
  test.each([...SERVE_PROBE_COMMANDS])('an ok ack on %s clears the outage', (kind) => {
    const next = reconnectFromAck(dropped(), kind, true);
    expect(next.dropped).toBe(false);
    expect(actionsBlocked(next), 'the controls come back the moment the port answers').toBe(false);
  });

  test('the probe set is exactly the serve-reaching commands MINUS confirm', () => {
    // The complement of `SERVE_LOCAL_ONLY_COMMANDS` is SEVEN kinds. The probe set
    // is SIX of them, and the difference is `confirm`, which is the judgement call
    // stated in the module header: a confirm that finds nothing pending never
    // reaches serve, so counting it would let an idle shell "prove" a dead port
    // healthy. An earlier version of this comment called the probe set "the exact
    // complement" and the assertion inherited the claim; it was wrong by one.
    expect([...SERVE_PROBE_COMMANDS].sort()).toEqual([
      'createSession',
      'execSessionShell',
      'sessionContext',
      'setSessionAgent',
      'setSessionModel',
      'toggleSessionSkill',
    ]);
  });

  test('recovering from a clean state is a no-op by identity', () => {
    expect(reconnectFromAck(INITIAL_RECONNECT, 'sessionContext', true)).toBe(INITIAL_RECONNECT);
  });
});

// ── THE MIRROR ────────────────────────────────────────────────────────────────
//
// `SERVE_LOCAL_ONLY_COMMANDS` is copied from `src/runtime/serve-health.ts`. A
// copy is a claim about another file, and a claim about another file goes stale
// silently — so the whole of this block is about making staleness FAIL.
//
// There are three independent pins, and it is worth being precise about what
// each one can and cannot catch, because three agents in the previous wave
// shipped guards that could not:
//
//   1. THE LITERAL SET (below). Catches a rename, an add or a drop in the
//      mirror itself. It is a snapshot: it says "these nine, no more".
//   2. THE CLASSIFICATION MAP vs THE SET. Catches the map drifting away from the
//      set — the failure mode where somebody reclassifies a kind in the map and
//      forgets the set. Independent of (1): breaking either alone is a failure.
//   3. THE PARTITION. `local ∪ serve == every CommandKind`, disjointly. Catches a
//      kind that is on neither side.
//
// And one pin that is NOT a test at all: `SERVE_COMMAND_CLASS` is typed
// `Record<CommandKind, 'local' | 'serve'>`, so a seventeenth kind in the bridge's
// union fails `npx tsc --noEmit` before any test runs. That is the strongest of
// the four, and it is the one that cannot be satisfied by editing a test.

describe('serve-health-signal: the mirror of SERVE_LOCAL_ONLY_COMMANDS', () => {
  test('it is exactly the nine members serve-health.ts allowlists', () => {
    // `src/runtime/serve-health.ts:250`. Sorted, so a reordering in either file
    // is not a failure and an ADDITION or a RENAME is.
    expect([...SERVE_LOCAL_ONLY_COMMANDS].sort()).toEqual([
      'abort',
      'arm',
      'deafen',
      'mute',
      'playbackStarted',
      'saveApiKeys',
      'setPersona',
      'stopSpeech',
      'switchSession',
    ]);
  });

  test('abort and stopSpeech are in it — the two the outage must not take away', () => {
    // The whole reason this mirror exists, as an assertion rather than a comment.
    // `withServeGate`'s own doc: blocking `abort` would "strand a mid-utterance
    // user behind a dead port with no way to make it stop".
    expect(isServeLocalOnlyCommand('abort')).toBe(true);
    expect(isServeLocalOnlyCommand('stopSpeech')).toBe(true);
  });

  test('the classification map and the allowlist agree, member for member', () => {
    // Pin 2. The two structures exist separately ON PURPOSE — a single one cannot
    // be checked against itself — and this is the assertion that keeps the second
    // honest.
    const fromMap = Object.entries(SERVE_COMMAND_CLASS)
      .filter(([, side]) => side === 'local')
      .map(([kind]) => kind)
      .sort();
    expect(fromMap).toEqual([...SERVE_LOCAL_ONLY_COMMANDS].sort());
  });

  test('local and serve partition every CommandKind, with no kind on neither side', () => {
    // Pin 3, and the only one that can catch a kind nobody classified. The
    // expected list is written out rather than derived from the map, so
    // re-deriving it from the map would make the assertion vacuous.
    const all: CommandKind[] = [
      'abort',
      'stopSpeech',
      'mute',
      'deafen',
      'arm',
      'setPersona',
      'switchSession',
      'setSessionAgent',
      'setSessionModel',
      'toggleSessionSkill',
      'execSessionShell',
      'saveApiKeys',
      'confirm',
      'sessionContext',
      'createSession',
      'playbackStarted',
    ];
    expect(Object.keys(SERVE_COMMAND_CLASS).sort()).toEqual([...all].sort());
    const local = all.filter((k) => SERVE_COMMAND_CLASS[k] === 'local');
    const serve = all.filter((k) => SERVE_COMMAND_CLASS[k] === 'serve');
    expect(local.length + serve.length, 'disjoint and total').toBe(all.length);
    expect(local.filter((k) => serve.includes(k))).toEqual([]);
    expect([...SERVE_LOCAL_ONLY_COMMANDS].sort()).toEqual([...local].sort());
  });

  test('the derived complement is the seven serve-reaching kinds', () => {
    expect([...SERVE_REACHING_COMMANDS].sort()).toEqual([
      'confirm',
      'createSession',
      'execSessionShell',
      'sessionContext',
      'setSessionAgent',
      'setSessionModel',
      'toggleSessionSkill',
    ]);
  });

  test('the probe set is a strict SUBSET of the complement, and the gap is confirm', () => {
    // The relation between the three sets, which is the part a reader has to be
    // able to trust: allowlist ∪ probe set does NOT cover the vocabulary, and the
    // one kind in neither is the deliberate judgement call.
    const neither = SERVE_REACHING_COMMANDS.filter((k) => !SERVE_PROBE_COMMANDS.has(k));
    expect(neither).toEqual(['confirm']);
    const overlap = [...SERVE_PROBE_COMMANDS].filter((k) => SERVE_LOCAL_ONLY_COMMANDS.has(k));
    expect(overlap, 'the two allowlists must not share a member').toEqual([]);
  });

  test('a local kind cannot clear an outage even if it is ADDED to the probe set', () => {
    // The belt to `SERVE_PROBE_COMMANDS`' braces, and the only way to reach it:
    // the two sets are disjoint today, so the only way a local kind can reach the
    // probe branch is a FUTURE edit that adds one. This test performs exactly
    // that edit, at runtime, and asserts the allowlist is consulted first — which
    // is a claim about the ORDER of two guards and cannot be checked any other
    // way. Restored in a `finally`, because a leaked mutation would make the rest
    // of this file lie.
    const probes = SERVE_PROBE_COMMANDS as Set<string>;
    const had = probes.has('abort');
    probes.add('abort');
    try {
      expect(reconnectFromAck(dropped(), 'abort', true), 'a keypress must not clear an outage').toEqual(
        dropped(),
      );
    } finally {
      if (!had) probes.delete('abort');
    }
    // Sanity, so a broken restore cannot pass silently: the same ack with the set
    // back to its real contents still does not restore, and a real probe still
    // does.
    expect(reconnectFromAck(dropped(), 'abort', true)).toEqual(dropped());
    expect(reconnectFromAck(dropped(), 'execSessionShell', true).dropped).toBe(false);
  });

  test('a serve-reaching kind still clears it — the mirror has not over-blocked', () => {
    // The other direction, and the one that catches an over-broad mirror. A
    // mirror that classified everything as local would satisfy every test above
    // and never restore, which is a shell stuck behind a banner forever.
    for (const kind of SERVE_REACHING_COMMANDS) {
      if (kind === 'confirm') continue; // deliberately outside the probe set
      expect(reconnectFromAck(dropped(), kind, true).dropped, `${kind} must restore`).toBe(false);
    }
  });
});
