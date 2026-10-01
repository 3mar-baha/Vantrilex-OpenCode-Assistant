import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App, ORB_SIZE_PX, SHELL_EDGE_PX } from './App.js';
import { BENTO_BASE_WIDTH_PX, auditBento, formatViolations } from './components/bento/layoutBudget.js';

/**
 * The composed shell, AS MOUNTED — the successor to `App.bento.test.tsx`.
 *
 * WHAT REPLACED WHAT. That file audited the bento column: four surfaces composed
 * once each, an `inert` action slot, a bounded task strip, a terminal drawer and
 * a footer of three navigation buttons. The bento column is gone from the shell,
 * and W25 then deleted the components it owned WITH their suites
 * (`BentoGrid.test.tsx`, `TaskCards.test.tsx`, `TerminalDrawer.test.tsx`,
 * `SessionBar.test.tsx`, `SessionChip.test.tsx`, `AgentModelBadge.test.tsx`,
 * `ContextGauge.test.tsx`, `portals.test.tsx`, `matrix/task-state.test.ts`,
 * `matrix/matrix-state.test.ts`, `WaveformEmblem.test.tsx`, `Crest.test.tsx`,
 * `sessions/store.test.ts`), so the coverage that went was coverage of code that
 * no longer exists rather than coverage that was lost.
 *
 * WHAT IS COVERED HERE, and why each item is still worth a test on a shell this
 * small:
 *
 *   · the width budget — `auditBento` runs against the composed tree, at the
 *     window's REAL 380, and nothing masks horizontal overflow with a clip.
 *     `layoutBudget.ts` is dead to the bundle and IS this file's instrument, so
 *     the two facts are the same fact: delete the module and the overflow audit
 *     goes with it. That is the one module in `apps/desktop/src` a dead-code
 *     sweep must never reach, and the reason is this import;
 *   · the vertical clip — this HUD stands down from `useAutoSize` (it is
 *     min-bounded and square), so `overflow-hidden` on a fixed root is a HARD
 *     clip, and the only thing standing between it and an unreadable notice is
 *     the "the orb region is the only shrinkable box" invariant. That invariant
 *     is invisible to every other suite, so it is pinned here structurally;
 *   · exactly three pill buttons, and no fourth one hiding elsewhere;
 *   · every control carries an Arabic label;
 *   · the geometry constants agree with `tauri.conf.json`, read from disk.
 */

/** The options App handed to the bridge, so a test can push frames back in. */
let bridgeOptions: {
  onNotice?: (n: { code: string; detail: string; level: 'info' | 'warn' | 'error' }) => void;
  onVoice?: (v: { phase: string }) => void;
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
      // The daemon greets with `hello` immediately after the upgrade, and the
      // shell only leaves `connecting` on that frame. A mock that never calls it
      // would leave every transport assertion in this file measuring
      // `connecting` rather than the state it means to.
      (bridgeOptions as { onHello?: (h: Record<string, unknown>) => void }).onHello?.({
        contractVersion: '3.1.0',
      });
    }
    dispose(): void {
      /* nothing to do */
    }
    sendPcm(): boolean {
      return true;
    }
    async sendCommand(): Promise<boolean> {
      return true;
    }
    async sendCommandDetailed(): Promise<{ ok: boolean; detail?: string }> {
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
  // The real window width, on the host as well as in the audit, so the intent is
  // on the record even though the audit itself is static.
  host.style.width = `${SHELL_EDGE_PX}px`;
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<App />);
  });
  expect(bridgeOptions.onNotice, 'the notice channel must be wired at all').toBeTypeOf('function');
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

async function deliverNotice(code: string, detail: string, level: 'info' | 'warn' | 'error' = 'warn'): Promise<void> {
  await act(async () => {
    bridgeOptions.onNotice?.({ code, detail, level });
  });
}

beforeEach(() => {
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

describe('the composed shell is clean at the REAL window budget', () => {
  test('the constants in App.tsx agree with tauri.conf.json', () => {
    // The instrument, not the comment. `SHELL_EDGE_PX` and `ORB_SIZE_PX` are
    // what the layout arithmetic in App.tsx is written against, and
    // `tauri.conf.json` is what the user actually gets. Drift between them is
    // invisible until a message is clipped by a frame the code never modelled.
    const conf = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src-tauri', 'tauri.conf.json'), 'utf8'),
    ) as { app: { windows: Array<Record<string, number>> } };
    const win = conf.app.windows[0] as Record<string, number>;
    expect(SHELL_EDGE_PX).toBe(win['width']);
    expect(SHELL_EDGE_PX).toBe(win['minWidth']);
    // Square: the height is the same figure, which is what makes the fixed
    // root's height budget a single number rather than two.
    expect(SHELL_EDGE_PX).toBe(win['height']);
    expect(SHELL_EDGE_PX).toBe(win['minHeight']);
    expect(SHELL_EDGE_PX).toBe(BENTO_BASE_WIDTH_PX);
    expect(ORB_SIZE_PX, 'the orb must leave room for the lines below it').toBeLessThan(SHELL_EDGE_PX);
  });

  test('the resting tree passes the width audit at the window width', async () => {
    await mountApp();
    const found = auditBento(shell(), SHELL_EDGE_PX);
    expect(found, formatViolations(found, SHELL_EDGE_PX)).toEqual([]);
  });

  test('populated — a credit fault AND a long message — still passes it', async () => {
    // The realistic worst case, and the one that used to be the bento's whole
    // problem: a full-width Arabic sentence in a fixed column.
    await mountApp();
    await deliverNotice(
      'serve-degraded',
      'انقطع الاتصال بالخادم على المنفذ ٤٠٩٦ — جارٍ إعادة المحاولة تلقائياً الآن، الرجاء الانتظار قليلاً',
      'error',
    );
    const found = auditBento(shell(), SHELL_EDGE_PX);
    expect(found, formatViolations(found, SHELL_EDGE_PX)).toEqual([]);
  });

  test('nothing in the shell masks horizontal overflow with a clip', async () => {
    // `overflow-x-hidden` would make the audit pass by HIDING the defect it
    // exists to catch. The root's plain `overflow-hidden` is different and is
    // asserted separately below — it is what the hard clip is FOR.
    await mountApp();
    expect(shell().className).not.toContain('overflow-x-hidden');
    for (const node of all('[data-testid]')) expect(node.className).not.toContain('overflow-x-hidden');
  });

  test('the root is fixed and clips vertically, and says why in the class list', async () => {
    // This HUD stands down from `useAutoSize`, so nothing grows the OS frame
    // from here and this clip is HARD: a child that outgrew it would be
    // unreachable. The next case is the one that keeps that from mattering.
    await mountApp();
    expect(shell().className).toContain('fixed');
    expect(shell().className).toContain('overflow-hidden');
  });

  test('the orb region is the ONLY box that may shrink', async () => {
    // THE load-bearing structural property of the compact shell. With no scroll
    // container anywhere, anything that can be pushed out of a 380 px frame is
    // clipped and gone; the only defence is that every other region is
    // `shrink-0` and truncates, so the orb's own box is the single thing that
    // yields. Asserted as a property of the DOM, not as a class name on one
    // element: a future sibling added without `shrink-0` fails here.
    await mountApp();
    await deliverNotice('transport', 'تعذر الاتصال بالخادم على المنفذ ٤٠٩٦ — تتم إعادة المحاولة تلقائياً الآن');
    const region = el('[data-testid="orb-region"]');
    expect(region?.className, 'the orb region must be able to yield').toContain('flex-1');
    expect(region?.className).toContain('min-h-0');

    // Every other region of the column is outside it and refuses to shrink.
    for (const id of ['bridge-status', 'notice-banner', 'control-row']) {
      const node = el(`[data-testid="${id}"]`);
      expect(node, `${id} must be rendered`).not.toBeNull();
      expect(region?.contains(node ?? null), `${id} must not live in the shrinkable region`).toBe(false);
      expect(shell().contains(node ?? null), `${id} must still be in the shell`).toBe(true);
    }
    expect(el('[data-testid="control-row"]')?.className, 'the pill may never shrink').toContain('shrink-0');
  });

  test('a long message is truncated, never wrapped, and keeps its full text', async () => {
    // Hard-constraint proof: at 380 px an untruncated Arabic sentence is the one
    // thing that could push the pill out of the frame. `truncate` makes the
    // rendered box a fixed one line; `title` is what makes the truncation cost
    // a hover instead of the sentence.
    await mountApp();
    const detail =
      'انقطع الاتصال بالخادم على المنفذ ٤٠٩٦ — جارٍ إعادة المحاولة تلقائياً الآن، الرجاء الانتظار قليلاً قبل إعادة المحاولة';
    await deliverNotice('serve-degraded', detail, 'error');
    const notice = el('[data-testid="notice-banner"]');
    expect(notice?.className).toContain('truncate');
    expect(notice?.getAttribute('title')).toBe(detail);
    expect(notice?.textContent).toBe(detail);
    // The pill is still there and still reachable after the message landed.
    expect(el('[data-testid="control-row"]')).not.toBeNull();
  });

  test('the missing-keys notice tells the user which control reaches the window', async () => {
    // The removed `notice-open-keys` button was the escape hatch for a keyless
    // daemon. The pill's third button opens the SAME window, so no capability
    // was lost — but only if the notice SAYS so, because the strip is the one
    // place the user learns a key is missing.
    await mountApp();
    await deliverNotice('voice-disabled-no-keys', 'أدخل مفاتيح الـ API لتفعيل الصوت');
    const notice = el('[data-testid="notice-banner"]');
    expect(notice?.textContent).toContain('مفاتيح');
    expect(el('[data-testid="open-keys"]'), 'and the control that opens it is present').not.toBeNull();
  });
});

describe('the pill is exactly three buttons', () => {
  test('the control row holds three, and the resting shell holds three', async () => {
    await mountApp();
    const pill = all('[data-testid="control-row"] button');
    expect(pill.map((b) => b.getAttribute('data-testid'))).toEqual(['mic-toggle', 'bot-toggle', 'open-keys']);
    // The stronger form: nothing anywhere else in the resting shell is
    // clickable. A fourth control added next to the pill would pass the first
    // assertion and fail this one.
    expect(all('button'), 'a resting companion widget has exactly three controls').toHaveLength(3);
  });

  test('the credit fault adds its own dismiss, and that is the only exception', async () => {
    // Stated rather than hidden. `CreditBanner` is latched on the overdue arm
    // and its dismiss is a deliberate product decision (see CreditBanner.tsx),
    // so the "three buttons" rule is about the PILL and about the resting
    // shell — not about deleting a warning's only way to be closed.
    await mountApp();
    await deliverNotice('tts-credit-exhausted', 'نفد رصيد Fish الصوتي — اشحن الرصيد للمتابعة');
    expect(el('[data-testid="credit-banner"]')).not.toBeNull();
    expect(all('[data-testid="control-row"] button'), 'the pill is unchanged').toHaveLength(3);
    expect(all('button')).toHaveLength(4);
  });

  test('every control in the shell carries an Arabic label', async () => {
    // The house rule, and the one a shell this small still needs: a control with
    // no title is a control whose meaning exists only in the author's head.
    await mountApp();
    await deliverNotice('tts-credit-exhausted', 'نفد رصيد Fish الصوتي');
    for (const node of all('button')) {
      const label = node.getAttribute('title') ?? node.getAttribute('aria-label') ?? '';
      expect(label, `a button with no label: ${node.getAttribute('data-testid')}`).not.toBe('');
      expect(label, `a button with no Arabic label: ${label}`).toMatch(/\p{sc=Arabic}/u);
    }
  });
});

describe('the transport line is still transport truth', () => {
  test('it is a polite live region and it uses the state vocabulary', async () => {
    await mountApp();
    const line = el('[data-testid="bridge-status"]');
    expect(line?.getAttribute('role')).toBe('status');
    expect(line?.getAttribute('aria-live')).toBe('polite');
    // `ready` is the value `boot.spec.ts` pins, so the vocabulary is a contract
    // with the E2E suite and not an internal detail.
    expect(line?.getAttribute('data-state')).toBe('ready');
    expect(line?.textContent).toContain('متصل وبانتظار الأوامر');
  });

  test('it reports the daemon phase, and never claims speech while muted', async () => {
    await mountApp();
    await act(async () => {
      bridgeOptions.onVoice?.({ phase: 'thinking' });
    });
    expect(el('[data-testid="bridge-status"]')?.getAttribute('data-state')).toBe('processing');
    await act(async () => {
      bridgeOptions.onVoice?.({ phase: 'speaking' });
    });
    expect(el('[data-testid="bridge-status"]')?.getAttribute('data-state')).toBe('speaking');
    await act(async () => {
      el('[data-testid="bot-toggle"]')?.click();
    });
    // W6 in the status domain: a silenced assistant is not talking.
    expect(el('[data-testid="bridge-status"]')?.getAttribute('data-state')).not.toBe('speaking');
  });
});