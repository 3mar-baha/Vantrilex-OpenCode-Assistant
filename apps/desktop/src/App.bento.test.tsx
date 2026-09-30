import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import { BENTO_BASE_WIDTH_PX, auditBento, formatViolations } from './components/bento/layoutBudget.js';
import type { OutputFrameLike } from './components/terminal/TerminalDrawer.js';

// The bento composition, AS MOUNTED — the same split `App.task-cards.test.tsx`
// makes, and for the same reason: that file proved the strip renders by
// asserting nothing about the layout around it, and `App.test.tsx` mocks the
// bridge to prove audio and silence. Neither mounts the whole shell to ask
// "does the grid compose", which is the question that only the composed tree can
// answer — `App.tsx` is where the bento, the chrome around it and the
// blockable action surface are put together, and that assembly is a seam of its
// own.
//
// WHAT IS COVERED HERE, and what is not:
//   · the four bento surfaces appear EXACTLY once each, and the composed tree is
//     clean against the 440 px audit;
//   · an `output` frame reaches the drawer, a REPLAY of it does not double the
//     log, and the producer's truncation is surfaced in Arabic exactly once;
//   · a serve-health notice raises the reconnect banner and makes the action
//     surface really `inert`, and nothing else does;
//   · the controls that used to live directly in `App`'s JSX still work.
//
// NOT COVERED, stated plainly: that any `output` frame is ever SENT. The
// renderer cannot see the producer, and `serve-health.ts` documents that it is
// not wired into the daemon yet, so these tests are about the wiring the shell
// does with a frame, never about the daemon producing one. That is the whole
// `output`-frame phase: the producer side is a separate contract with its own
// suite on the other side of the boundary.

/** Every command the HUD pushed at the bridge, in order. */
let sent: Array<{ kind: string }> = [];
/** The options App handed to the bridge, so a test can push frames back in. */
let bridgeOptions: {
  onInventory?: (sessions: Array<{ sessionId: string; state: string }>) => void;
  onVoice?: (v: { phase: string; transcript?: string }) => void;
  onNotice?: (n: { code: string; detail: string; level: 'info' | 'warn' | 'error' }) => void;
  onOutput?: (frame: OutputFrameLike) => void;
};

vi.mock('./settings/ipc-token.js', () => ({
  envToken: () => 'test-token',
  isTauriHost: () => false,
  resolveIpcToken: async () => 'test-token',
  resolveIpcTokenWithRetry: async () => 'test-token',
}));

vi.mock('./bridge/ws.js', () => ({
  UI_WS_URL: 'ws://127.0.0.1:4097/v1/ui',
  UI_SUBPROTOCOL: 'voice-ui.v1',
  VoxauraBridge: class VoxauraBridge {
    constructor(opts: Record<string, unknown>) {
      bridgeOptions = opts as typeof bridgeOptions;
    }
    get live(): boolean {
      return true;
    }
    connect(): void {
      /* nothing to do */
    }
    dispose(): void {
      /* nothing to do */
    }
    sendPcm(): boolean {
      return true;
    }
    async sendCommand(cmd: { kind: string }): Promise<boolean> {
      sent.push({ kind: cmd.kind });
      return true;
    }
    async sendCommandDetailed(cmd: { kind: string }): Promise<{ ok: boolean; detail?: string }> {
      sent.push({ kind: cmd.kind });
      return { ok: true };
    }
  },
}));

vi.mock('./audio/capture.js', () => ({
  AudioCapture: class AudioCapture {
    start(): Promise<void> {
      return Promise.resolve();
    }
    stop(): void {
      /* nothing to do */
    }
  },
  encodeFrame: (samples: Int16Array): Uint8Array => new Uint8Array(samples.buffer),
}));

vi.mock('./audio/playback.js', () => ({
  AudioPlayer: class AudioPlayer {},
  createDefaultPlayer: () => ({
    setMuted: (): void => {},
    enqueue: (): void => {},
    stop: (): void => {},
    dispose: (): void => {},
  }),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mountApp(): Promise<void> {
  host = document.createElement('div');
  // The base window width, stated on the host as well as asserted on the tree,
  // so the intent is on the record even though the audit is static.
  host.style.width = `${BENTO_BASE_WIDTH_PX}px`;
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<App />);
  });
  // The gap, asserted rather than assumed: `bridge/ws.ts` has no `output` branch
  // yet, so if `App` ever stopped passing the callback this mount would quietly
  // stop exercising the drawer and the tests below would pass on an empty log.
  expect(bridgeOptions.onOutput, 'App must hand the bridge an onOutput callback').toBeTypeOf('function');
  expect(bridgeOptions.onNotice, 'serve health arrives on the notice channel').toBeTypeOf('function');
  sent = [];
}

/**
 * ONE `output` frame, with the fields the renderer reads.
 *
 * `sessionId` and `outcome` ARE HERE, and they were not: the fixtures this
 * replaced omitted both, which pushed a `warn` line onto every delivered frame —
 * `تحذير: الإطار لا يحمل حقل outcome …` — so a test asserting the composition of
 * a command's log was quietly asserting the composition of a CONTRACT VIOLATION.
 * Both fields are REQUIRED by `OutputFrameSchema` and both are enforced by
 * `bridge/ws.ts` `isOutputFrame`, so a frame without them is unreachable from
 * production: these were FICTIONAL frames, and the warn path they exercised is a
 * path production cannot take.
 *
 * `outcome: 'unknown'` with `exitCode: null` is the honest value and not a
 * placeholder: `deriveShellOutcome('completed', null)` returns `'unknown'`, which
 * is the MEASURED common case because serve reports no exit code at all. A
 * fixture that said `'ok'` would assert a verdict the daemon would never send.
 *
 * The one test that still omits `outcome` is named as such and is deliberate —
 * see 'a frame that breaks the contract says so, loudly'.
 */
function outputFrame(overrides: Partial<OutputFrameLike> = {}): OutputFrameLike {
  return {
    commandId: 'cmd_1',
    command: 'npm run build',
    sessionId: 'ses_alpha',
    status: 'completed',
    outcome: 'unknown',
    exitCode: null,
    output: 'vite v7.1.0 building for production…',
    droppedBytes: 0,
    truncated: false,
    durationMs: 812,
    ...overrides,
  };
}

async function deliverOutput(frame: OutputFrameLike): Promise<void> {
  await act(async () => {
    bridgeOptions.onOutput?.(frame);
  });
}

async function deliverNotice(code: string, detail: string): Promise<void> {
  await act(async () => {
    bridgeOptions.onNotice?.({ code, detail, level: 'warn' });
  });
}

function el(selector: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(selector);
}

function all(selector: string): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(selector));
}

function shell(): HTMLElement {
  const found = el('[data-testid="voxaura-shell"]');
  if (found === null) throw new Error('voxaura-shell not rendered');
  return found;
}

function lineTexts(): string[] {
  return all('[data-testid="terminal-line"]').map((n) => n.textContent ?? '');
}

beforeEach(() => {
  sent = [];
  bridgeOptions = {};
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('bento: the four surfaces compose, once each', () => {
  test('every surface is mounted exactly once', async () => {
    await mountApp();
    // The task strip is the one surface that is legitimately ABSENT: it renders
    // `null` with no cards, because an empty in-flow box would take a row of the
    // HUD for every user with no live work, which is most of them. It is
    // asserted once, populated, in the second test.
    for (const id of ['session-bar', 'terminal-drawer']) {
      expect(all(`[data-testid="${id}"]`), `${id} must appear exactly once`).toHaveLength(1);
    }
    // The session bar owns the ONE canonical switcher. A second one would make
    // `getByTestId('session-chip')` ambiguous in E2E and would be two session
    // lists in a window with 440 px of width.
    expect(all('[data-testid="session-chip"]')).toHaveLength(1);
  });

  test('with work to show, the task strip joins them — and appears once', async () => {
    await mountApp();
    expect(el('[data-testid="task-strip"]'), 'no strip, no height').toBeNull();
    await act(async () => {
      bridgeOptions.onInventory?.([
        { sessionId: 'ses_a', state: 'running' },
        { sessionId: 'ses_b', state: 'error' },
      ]);
    });
    expect(all('[data-testid="task-strip"]')).toHaveLength(1);
    expect(all('[data-testid="task-chip"]')).toHaveLength(2);
  });

  test('the action surface is INSIDE the blocked slot; the session bar is NOT', async () => {
    // The single most important structural property of the composition. The
    // block is an `inert` attribute on `bento-actions`, so anything inside it
    // stops working while serve is down. `switchSession` and `execSessionShell`
    // are serve-INDEPENDENT (daemon-local state) — the router answers them
    // without touching a port — so a dead 4096 must not take the session
    // switcher or the log down with it.
    //
    // LINE 224 USED TO ASSERT `abort-button ∈ bento-actions`, and that assertion
    // PINNED THE BUG rather than the intent. `inert` is inherited, so the stop
    // control inside the blocked subtree was unclickable during an outage — the
    // exact failure `src/runtime/serve-health.ts` names when it allowlists
    // `abort`: it would "strand a mid-utterance user behind a dead port with no
    // way to make it stop". This file's own later case, "the keys escape hatch
    // stays LIVE while serve is down", asserts the opposite policy for the other
    // escape hatch, so the two were in direct contradiction. The stop and
    // silence controls now live in the sibling `bento-escape` slot, which is
    // never `inert`; `App.escape.test.tsx` owns that property's suite.
    await mountApp();
    const slot = el('[data-testid="bento-actions"]');
    expect(slot).not.toBeNull();
    expect(slot?.contains(el('[data-testid="mic-toggle"]') ?? null)).toBe(true);
    expect(
      slot?.contains(el('[data-testid="abort-button"]') ?? null),
      'the stop control is deliberately NOT in the inherited-inert subtree',
    ).toBe(false);
    expect(el('[data-testid="bento-escape"]')?.contains(el('[data-testid="abort-button"]') ?? null)).toBe(true);
    expect(slot?.contains(el('[data-testid="session-bar"]') ?? null)).toBe(false);
    expect(el('[data-testid="bento-scroll"]')?.contains(el('[data-testid="session-bar"]') ?? null)).toBe(true);
  });

  test('the session-scoped controls are above the grid and NOT in the blocked slot', async () => {
    // `setSessionAgent` is on the daemon's serve-INDEPENDENT allowlist, so the
    // renderer must not gate it. This is the assertion that keeps the
    // recomposition from quietly contradicting the router.
    await mountApp();
    const slot = el('[data-testid="bento-actions"]');
    expect(slot?.contains(el('[data-testid="agent-model-badge"]') ?? null)).toBe(false);
    expect(slot?.contains(el('[data-testid="context-gauge"]') ?? null)).toBe(false);
    // …and they are still reachable, i.e. inside the measured root.
    expect(shell().contains(el('[data-testid="agent-model-badge"]') ?? null)).toBe(true);
  });

  test('the composed HUD is clean at the 440 px budget', async () => {
    await mountApp();
    const found = auditBento(shell(), BENTO_BASE_WIDTH_PX);
    expect(found, formatViolations(found, BENTO_BASE_WIDTH_PX)).toEqual([]);
  });

  test('populated — sessions, cards, output and a notice — stays inside 440 px', async () => {
    await mountApp();
    await act(async () => {
      bridgeOptions.onInventory?.(
        Array.from({ length: 12 }, (_, i) => ({ sessionId: `ses_${'طويل_'.repeat(6)}${i}`, state: 'running' })),
      );
    });
    await deliverNotice('transport', 'تعذر الاتصال بالخادم على المنفذ ٤٠٩٦ — تتم إعادة المحاولة تلقائياً الآن');
    await deliverOutput(
      outputFrame({ commandId: 'cmd_long', command: 'cat ' + 'a'.repeat(400), output: 'x'.repeat(2000) }),
    );
    const found = auditBento(shell(), BENTO_BASE_WIDTH_PX);
    expect(found, formatViolations(found, BENTO_BASE_WIDTH_PX)).toEqual([]);
  });

  test('nothing in the HUD masks horizontal overflow with a clip', async () => {
    // `overflow-x-hidden` would make the audit pass by HIDING the defect it
    // exists to catch. If a future change needs it, the layout is wrong.
    await mountApp();
    expect(shell().className).not.toContain('overflow-x-hidden');
    for (const node of [shell(), el('[data-testid="bento-grid"]'), el('[data-testid="bento-scroll"]')]) {
      expect(node?.className ?? '').not.toContain('overflow-x-hidden');
    }
  });

  test('the vertical column is allowed to shrink, so a banner cannot push the drawer out', async () => {
    // The 600 px obligation is structural: `min-h-0` on every flex child in the
    // chain is what lets it be SMALLER than its content, and the overflow lands
    // in a scroll container the user owns rather than in the window frame.
    await mountApp();
    for (const id of ['bento-grid', 'bento-actions', 'bento-scroll']) {
      expect(el(`[data-testid="${id}"]`)?.className, `${id} must be able to shrink`).toContain('min-h-0');
    }
    expect(el('[data-testid="bento-scroll"]')?.className).toContain('overflow-y-auto');
  });
});

describe('bento: an output frame reaches the drawer, and only once', () => {
  test('the frame projects into log lines, and the drawer opens itself once', async () => {
    await mountApp();
    // Closed at rest: a log that grows on every command would eat the HUD from
    // below on a window with a 600 px minimum.
    expect(el('[data-testid="terminal-drawer"]')?.getAttribute('data-open')).toBe('false');

    await deliverOutput(outputFrame());
    expect(el('[data-testid="terminal-drawer"]')?.getAttribute('data-open')).toBe('true');

    const texts = lineTexts();
    // Command first (the user asked for it), then the body, then the verdict.
    // The leading `❯` is `TerminalDrawer`'s per-kind shape glyph, asserted here
    // rather than stripped so a future kind change shows up here.
    //
    // IT WAS `'❯npm run build'`, AND IT IS NOW `'alpha❯npm run build'`, and the
    // change is the point rather than a regression. The fixture used to omit
    // `sessionId`, and every line therefore rendered NO chip — the projection's
    // missing-value path, on a frame production cannot send. With the field
    // present, every line carries its own `terminal-line-session` chip, and
    // `textContent` of the row is chip + glyph + text. The assertion stays
    // EXACT rather than loosening to `toContain`, because exactness is what makes
    // it a guard on the line's composition at all.
    expect(texts[0]).toBe('alpha❯npm run build');
    // …and the attribution is asserted through the DOM, not through the string
    // above: `data-session` carries the unabbreviated id on every row, so a chip
    // that rendered a plausible-looking wrong token would still fail here.
    const rows = all('[data-testid="terminal-line"]');
    expect(rows.every((r) => r.getAttribute('data-session') === 'ses_alpha'), 'every line is attributed').toBe(true);
    expect(
      rows.every((r) => r.querySelector('[data-testid="terminal-line-session"]') !== null),
      'and every line carries a chip',
    ).toBe(true);
    // The missing-field warnings are GONE, which is the observable proof the
    // fixtures are now frames the daemon could actually send.
    expect(
      all('[data-testid="terminal-line"][data-kind="warn"]'),
      'a conforming frame produces no contract warning',
    ).toHaveLength(0);
    expect(texts.join('\n')).toContain('vite v7.1.0 building for production');
    expect(texts.at(-1)).toContain('اكتمل الأمر');
    // …and the verdict is the one the frame CARRIED, not one re-derived from
    // `status` + `exitCode`. `unknown` in, "النتيجة غير مؤكدة" out; a drawer
    // that read the frame would say the same, and one that re-derived it would
    // reach the same answer only because `exitCode` is `null`.
    expect(texts.at(-1)).toContain('غير مؤكدة');
  });

  test('a frame that breaks the contract says so, LOUDLY — the one deliberate omission', async () => {
    // The single fixture in this file that omits `outcome`, kept on purpose.
    //
    // `OutputFrameSchema` requires `outcome` and `bridge/ws.ts` `isOutputFrame`
    // rejects a frame without it, so this frame CANNOT arrive from the daemon —
    // which is precisely why the projection's response has to be visible when it
    // does. A silent fallback would put a re-derived guess on screen in the
    // producer's name, and `status: 'completed'` with a null exit code is exactly
    // the combination where the guess happens to be right, so nothing else would
    // ever notice it being made.
    //
    // `sessionId` IS present here, deliberately: one defect per test, so the
    // single `warn` below is unambiguous. `TerminalDrawer.test.tsx` owns the
    // missing-`sessionId` half of the same rule.
    await mountApp();
    await deliverOutput(outputFrame({ commandId: 'cmd_noverdict', outcome: undefined }));
    const warns = all('[data-testid="terminal-line"][data-kind="warn"]');
    expect(warns, 'a missing verdict must not be silent').toHaveLength(1);
    const text = warns[0]?.textContent ?? '';
    expect(text).toContain('outcome');
    expect(text).toMatch(/\p{sc=Arabic}/u);
    // It states that the value below was INFERRED rather than reported — the
    // whole difference between "here is the result" and "here is a guess, and
    // here is why you should not trust it".
    expect(text).toContain('مستنتجة');
    // …and the verdict it qualified is still rendered, so the warning ADDS a
    // statement rather than replacing the line the user needed.
    expect(lineTexts().join('\n')).toContain('غير مؤكدة');
  });

  test('a REPLAYED frame does not double the log', async () => {
    // Frames really do re-deliver: the `seq > lastSeq` resume filter exists
    // precisely because they can. The dedupe is the id scheme in
    // `linesFromOutputFrame` + `appendTerminalLines`, and this is the assertion
    // that App is relying on it rather than inventing a second layer that would
    // also eat a genuine second result for the same command.
    await mountApp();
    await deliverOutput(outputFrame());
    const once = all('[data-testid="terminal-line"]').length;
    await deliverOutput(outputFrame());
    expect(all('[data-testid="terminal-line"]').length, 'a replay is not a second result').toBe(once);

    // …and a DIFFERENT command id does append, which is the half a
    // `commandId`-blind dedupe gets wrong.
    await deliverOutput(outputFrame({ commandId: 'cmd_2', command: 'npm run test' }));
    expect(all('[data-testid="terminal-line"]').length).toBeGreaterThan(once);
  });

  test("the producer's truncation is SURFACED, in Arabic, exactly once", async () => {
    await mountApp();
    await deliverOutput(
      outputFrame({ truncated: true, droppedBytes: 40_884, output: 'the kept prefix' }),
    );
    const markers = lineTexts().filter((t) => t.includes('حُذف'));
    expect(markers, 'a silent trim reads as "that is all of it"').toHaveLength(1);
    expect(markers[0]).toContain('40');
    expect(markers[0]).toMatch(/\p{sc=Arabic}/u);
  });

  test('the renderer adds NO second truncation of its own', async () => {
    // `TerminalDrawer` deliberately keeps a hostile-payload guard at 8192 chars,
    // and it states so when it fires. What App must not do is clamp ordinary
    // output — the producer already owns the cap and reported it, so a renderer
    // clamp would assert a completeness the frame never claimed.
    const body = 'س'.repeat(4000);
    await mountApp();
    await deliverOutput(outputFrame({ commandId: 'cmd_big', command: '', output: body }));
    expect(lineTexts().some((t) => t.includes(body)), 'the frame text is rendered as it arrived').toBe(true);
  });

  test('an untruncated frame shows no drop marker at all', async () => {
    await mountApp();
    await deliverOutput(outputFrame());
    expect(lineTexts().filter((t) => t.includes('حُذف'))).toHaveLength(0);
  });
});

describe('bento: serve health raises a banner that really blocks', () => {
  test('no source yet means NO banner and NO block — absence of evidence is not health', async () => {
    // THE load-bearing test of this file's third block. A renderer that rendered
    // "connected to 4096" out of nothing would be the `layaReady: true` defect
    // wearing a health banner's clothes, and every other assertion would still
    // pass. `serve-health.ts` documents that nothing emits these codes yet.
    await mountApp();
    expect(el('[data-testid="reconnect-banner"]')).toBeNull();
    expect(el('[data-testid="bento-actions"]')?.getAttribute('data-blocked')).toBe('false');
    expect(el('[data-testid="bento-actions"]')?.hasAttribute('inert')).toBe(false);
  });

  test.each(['serve-degraded', 'serve-reconnecting', 'serve-reconnect-exhausted'])(
    'a %s notice raises the banner, verbatim, and blocks the actions',
    async (code) => {
      await mountApp();
      await deliverNotice(code, 'انقطع الاتصال بالخادم على المنفذ ٤٠٩٦ — جارٍ إعادة المحاولة…');

      const banner = el('[data-testid="reconnect-banner"]');
      expect(banner).not.toBeNull();
      // The daemon's own Arabic wording is shown, not a second wording of it.
      expect(el('[data-testid="reconnect-banner-text"]')?.textContent).toContain('٤٠٩٦');
      // The block is the mechanism: `inert` takes the subtree out of the
      // accessibility tree and stops pointer, focus and click. A class that only
      // dims things is the "merely warns" failure.
      expect(el('[data-testid="bento-actions"]')?.hasAttribute('inert')).toBe(true);
      // …and the session bar and the log keep working: they are outside the slot.
      expect(el('[data-testid="bento-actions"]')?.contains(el('[data-testid="session-bar"]') ?? null)).toBe(false);
    },
  );

  test('an ordinary notice raises nothing', async () => {
    // The gate is `reconnectFromNotice` itself — it re-checks the code — so this
    // asserts the OUTCOME, not which of the two checks in `App` did it. The
    // `isServeHealthCode` early-out in `App` exists so an ordinary notice frame
    // does not schedule a state updater at all; deleting it would leave this
    // test green, and that is honest: the module is the single authority.
    await mountApp();
    for (const code of ['assistant-said', 'voice-disabled-no-keys', 'persona-changed', 'tts-credit-exhausted']) {
      await deliverNotice(code, 'تفاصيل');
      expect(el('[data-testid="reconnect-banner"]'), `${code} must not fabricate an outage`).toBeNull();
      expect(el('[data-testid="bento-actions"]')?.hasAttribute('inert')).toBe(false);
    }
  });

  test('dismissal hides the WORDS and never the consequence', async () => {
    await mountApp();
    await deliverNotice('serve-degraded', 'انقطع الاتصال بالخادم');
    await act(async () => {
      el('[data-testid="reconnect-dismiss"]')?.click();
    });
    expect(el('[data-testid="reconnect-banner"]'), 'the banner is gone').toBeNull();
    expect(
      el('[data-testid="bento-actions"]')?.hasAttribute('inert'),
      '4096 is still dead, so the controls must still be inert',
    ).toBe(true);
  });

  test('a second notice in the same outage does NOT resurrect the dismissed banner', async () => {
    await mountApp();
    await deliverNotice('serve-degraded', 'انقطع الاتصال بالخادم');
    await act(async () => {
      el('[data-testid="reconnect-dismiss"]')?.click();
    });
    // The second failed probe / the next refused command. A banner that came
    // back here would last five seconds between notices and nag forever.
    await deliverNotice('serve-degraded', 'انقطع الاتصال بالخادم');
    expect(el('[data-testid="reconnect-banner"]')).toBeNull();
    expect(el('[data-testid="bento-actions"]')?.hasAttribute('inert')).toBe(true);
  });

  test('the keys escape hatch stays LIVE while serve is down', async () => {
    // `voice-disabled-no-keys` is the one notice whose CTA must survive an
    // outage: `saveApiKeys` writes the encrypted vault and never touches a
    // port, so a renderer that `inert`ed it would strand exactly the user the
    // banner is meant to help. The outage is raised FIRST here, because that is
    // the ordering the user hits it in — and because the strip shows one notice
    // at a time, so a later notice would simply replace this one.
    await mountApp();
    await deliverNotice('serve-degraded', 'انقطع الاتصال بالخادم');
    await deliverNotice('voice-disabled-no-keys', 'أدخل مفاتيح الـ API لتفعيل الصوت');
    expect(el('[data-testid="bento-actions"]')?.hasAttribute('inert'), 'precondition: serve is down').toBe(true);
    const cta = el('[data-testid="notice-open-keys"]');
    expect(cta).not.toBeNull();
    expect(cta?.closest('[data-testid="bento-actions"]'), 'the escape hatch is outside the block').toBeNull();
    // And the same for the credit banner, which is renderer-local state with a
    // dismiss button and therefore also belongs outside the block.
    expect(el('[data-testid="credit-banner"]')?.closest('[data-testid="bento-actions"]') ?? null).toBeNull();
  });
});

describe('bento: the controls that moved did not stop working', () => {
  test('the persona switch still sends setPersona and still repaints the thread', async () => {
    await mountApp();
    await act(async () => {
      el('[data-testid="hud-persona-nour"]')?.click();
    });
    expect(sent.map((c) => c.kind)).toContain('setPersona');
    expect(el('[data-testid="hud-persona-nour"]')?.getAttribute('aria-checked')).toBe('true');
    // D8: the thread takes the persona's palette, so the switch is visible on
    // the largest surface in the window and not only on a chip.
    expect(el('[data-testid="siri-wave"]')).not.toBeNull();
  });

  test('the mic toggle still sends deafen and still reports its state', async () => {
    await mountApp();
    await act(async () => {
      el('[data-testid="mic-toggle"]')?.click();
    });
    expect(sent.map((c) => c.kind)).toContain('deafen');
    expect(el('[data-testid="mic-toggle"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  test('the abort button still switches between abort and arm', async () => {
    await mountApp();
    expect(el('[data-testid="abort-button"]')?.textContent).toBe('إعادة التوليد');
    await act(async () => {
      el('[data-testid="abort-button"]')?.click();
    });
    expect(sent.map((c) => c.kind)).toEqual(['arm']);
  });

  test('the footer navigation is reachable and never scrolls away', async () => {
    await mountApp();
    for (const id of ['open-settings', 'open-apikeys', 'open-calibration']) {
      const button = el(`[data-testid="${id}"]`);
      expect(button, `${id} must be in the DOM`).not.toBeNull();
      // Outside the scroll region: navigation that scrolls off the bottom of a
      // 600 px window is navigation a user cannot find.
      expect(el('[data-testid="bento-scroll"]')?.contains(button ?? null)).toBe(false);
    }
  });

  test('the status pill is still on the window header, above everything scrollable', async () => {
    await mountApp();
    const pill = el('[data-testid="bridge-status"]');
    expect(pill?.getAttribute('role')).toBe('status');
    expect(el('[data-testid="bento-scroll"]')?.contains(pill ?? null)).toBe(false);
  });

  test('every interactive element in the composed HUD carries an Arabic tooltip', async () => {
    // The HUD's house rule, and the one rule the recomposition could most easily
    // break by moving a control: a control without a title is a control whose
    // meaning exists only in the author's head.
    await mountApp();
    await deliverNotice('voice-disabled-no-keys', 'أدخل مفاتيح الـ API');
    await act(async () => {
      el('[data-testid="session-chip-trigger"]')?.click();
    });
    for (const node of all('button')) {
      const label = node.getAttribute('title') ?? node.getAttribute('aria-label') ?? '';
      expect(label, `a button with no label: ${node.getAttribute('data-testid') ?? node.textContent ?? ''}`).not.toBe('');
      expect(label, `a button with no Arabic label: ${label}`).toMatch(/\p{sc=Arabic}/u);
    }
  });
});
