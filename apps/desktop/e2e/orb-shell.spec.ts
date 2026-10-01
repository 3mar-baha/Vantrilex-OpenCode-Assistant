import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { searchOf } from './keys-window.js';

// The Orb shell (bd103b2) — the widget as it actually renders.
//
// Everything asserted here is read from the LIVE DOM. The components the bento
// owned (session bar, agent/model badge, task cards, calibration wizard, confirm
// portal, abort button) still exist in `apps/desktop/src` with their own unit
// suites; they are simply not mounted. A test that greps the source for a
// testid proves the COMPONENT exists, never that the SHELL renders it, so every
// assertion below is a locator against the running page and a measured box.

/** Cold Vite transform of the whole graph is harness cost — see credit.spec.ts. */
async function open(page: Page): Promise<void> {
  await page.goto('/', { timeout: 90_000 });
  await expect(page.getByTestId('bridge-status')).toContainText('متصل', { timeout: 15_000 });
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://localhost:4197${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function commands(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch('http://localhost:4197/commands');
  return (await res.json()) as Array<Record<string, unknown>>;
}

test('the Orb renders, visible, and the shell is a square of the declared edge', async ({ page }) => {
  await open(page);

  const orb = page.getByTestId('orb');
  await expect(orb).toBeVisible();
  await expect(orb).toHaveAttribute('role', 'img');
  // The label is the shell's own dialect, and it changes with the phase — a
  // colour-only readout would leave this unlabelled for a screen reader.
  await expect(orb).toHaveAttribute('aria-label', /الكرة/);

  // MEASURED, not asserted against a comment. The window edge lives in
  // `tauri.conf.json` (width/height/minWidth/minHeight = 380); the layout
  // constant is `SHELL_EDGE_PX` in App.tsx. If those three ever disagree, the
  // composition clips — so the test reads the box rather than the source.
  const shell = page.getByTestId('voxaura-shell');
  const box = await shell.boundingBox();
  expect(box, 'the shell root has a box').not.toBeNull();

  // The Playwright viewport is the browser window, not the Tauri window, so the
  // shell fills 1280x720 here. What IS the product's frame is the ORB's box and
  // the square-ness of the composition, both of which are viewport-independent
  // and both of which are asserted below. The 380 figure is asserted against
  // `tauri.conf.json` in the config test at the bottom of this file.
  const orbBox = await orb.boundingBox();
  expect(orbBox).not.toBeNull();
  // ORB_SIZE_PX = 232, and the orb must not be squashed by the region it sits in.
  expect(orbBox?.width).toBeCloseTo(orbBox?.height ?? 0, 0);
  expect(Math.round(orbBox?.width ?? 0)).toBe(232);

  // It must sit inside the region and stay inside the viewport — the region is
  // the only element allowed to shrink (App.tsx's height arithmetic).
  const regionBox = await page.getByTestId('orb-region').boundingBox();
  expect(regionBox).not.toBeNull();
  const orbCentreX = (orbBox?.x ?? 0) + (orbBox?.width ?? 0) / 2;
  const regionCentreX = (regionBox?.x ?? 0) + (regionBox?.width ?? 0) / 2;
  expect(Math.abs(orbCentreX - regionCentreX)).toBeLessThan(2);
  const vp = page.viewportSize();
  expect(vp).not.toBeNull();
  expect((orbBox?.y ?? 0) + (orbBox?.height ?? 0)).toBeLessThanOrEqual(vp?.height ?? 0);
});

test('EXACTLY THREE buttons — a fourth fails this test', async ({ page }) => {
  await open(page);

  // The count is the assertion. Asserting only that the three known ids are
  // visible would pass just as happily with a fourth control bolted on, which is
  // the exact drift the rewrite brief pins the shell against.
  await expect(page.getByTestId('control-row').locator('button')).toHaveCount(3);
  await expect(page.locator('button')).toHaveCount(3);

  for (const id of ['mic-toggle', 'bot-toggle', 'open-keys']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }

  // Every control is named in the shell's dialect — role, label and tooltip.
  await expect(page.getByTestId('mic-toggle')).toHaveAttribute('aria-label', 'ميكروفون المستخدم');
  await expect(page.getByTestId('bot-toggle')).toHaveAttribute('aria-label', 'صوت المساعد');
  await expect(page.getByTestId('open-keys')).toHaveAttribute('aria-label', 'مفاتيح الـ API');
  for (const id of ['mic-toggle', 'bot-toggle', 'open-keys']) {
    expect(await page.getByTestId(id).getAttribute('title'), `${id} has an Arabic tooltip`).toMatch(/\p{sc=Arabic}/u);
  }

  // The fourth control the old strip carried (`notice-open-keys`) was folded
  // into the pill's third button: same window, so no capability was lost.
  await expect(page.getByTestId('notice-open-keys')).toHaveCount(0);
});

test('mic-toggle flips its pressed state and sends `deafen` to the daemon', async ({ page }) => {
  await open(page);
  const mic = page.getByTestId('mic-toggle');

  // Privacy-safe default: the mic starts muted, and `aria-pressed` MIRRORS the
  // mute state (true = muted). The old bento used the same polarity.
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  const deafensBefore = (await commands()).filter((c) => c['kind'] === 'deafen').length;

  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(async () => (await commands()).filter((c) => c['kind'] === 'deafen').length, { timeout: 5_000 })
    .toBe(deafensBefore + 1);

  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(async () => (await commands()).filter((c) => c['kind'] === 'deafen').length, { timeout: 5_000 })
    .toBe(deafensBefore + 2);

  // It is a mute, not a mute-THE-ASSISTANT: the bot's own pressed state is
  // untouched by the user's mic.
  await expect(page.getByTestId('bot-toggle')).toHaveAttribute('aria-pressed', 'false');
});

test('bot-toggle flips its pressed state and sends NO command to the daemon', async ({ page }) => {
  await open(page);
  const bot = page.getByTestId('bot-toggle');

  // W6: the assistant mute is RENDERER-LOCAL. It used to send `{kind:'mute'}`
  // and the daemon acked a success it never delivered. Asserting the ABSENCE of
  // a command is the assertion — a control that asked the daemon to do something
  // the daemon does not own would be lying again.
  await expect(bot).toHaveAttribute('aria-pressed', 'false');
  const before = (await commands()).length;

  await bot.click();
  await expect(bot).toHaveAttribute('aria-pressed', 'true');
  await expect(bot).toHaveAttribute('title', /مكتوم/);

  // Give a wrongly-sent frame time to arrive before declaring it absent.
  await page.waitForTimeout(1_500);
  expect((await commands()).length, 'the bot mute sends nothing').toBe(before);
  // Nor does it touch the user's microphone.
  await expect(page.getByTestId('mic-toggle')).toHaveAttribute('aria-pressed', 'true');

  await bot.click();
  await expect(bot).toHaveAttribute('aria-pressed', 'false');
});

test('open-keys opens the dedicated keys window', async ({ page, context }) => {
  await open(page);

  const [keys] = await Promise.all([context.waitForEvent('page'), page.getByTestId('open-keys').click()]);
  await keys.waitForLoadState('domcontentloaded');
  expect(searchOf(keys.url())).toBe('?view=keys');
  await expect(keys.getByTestId('keys-view')).toBeVisible();
  await expect(keys.getByTestId('apikey-groq')).toBeVisible();
  await keys.close();
});

test('the Orb reflects voicePhase: idle → listening → thinking → speaking', async ({ page }) => {
  await open(page);
  const orb = page.getByTestId('orb');
  await expect(orb).toHaveAttribute('data-phase', 'idle');

  await post('/voice', { phase: 'listening', transcript: 'اعرض الملخص' });
  await expect(orb).toHaveAttribute('data-phase', 'listening', { timeout: 5_000 });

  await post('/voice', { phase: 'thinking', transcript: 'اعرض الملخص' });
  await expect(orb).toHaveAttribute('data-phase', 'thinking', { timeout: 5_000 });

  await post('/voice', { phase: 'speaking' });
  await expect(orb).toHaveAttribute('data-phase', 'speaking', { timeout: 5_000 });
  // The speaking label names the persona, which is the only phase that does.
  await expect(orb).toHaveAttribute('aria-label', /تحدث بصوت/);

  await post('/voice', { phase: 'idle' });
  await expect(orb).toHaveAttribute('data-phase', 'idle', { timeout: 5_000 });
});

test('persona colour state: Kareem wears green, Nour wears pink', async ({ page }) => {
  // The orb is a canvas and its colour lives in pixels, not in the DOM, so this
  // is the one test in the suite that READS the framebuffer. Two things keep it
  // deterministic rather than flaky:
  //   · `reducedMotion: 'no-preference'` is forced, because the component draws
  //     ONCE and stops when the OS asks for reduced motion — a seeded first
  //     frame would never cross-fade and the assertion would read the MOUNT
  //     palette instead of the target one;
  //   · the colour is read through `expect.poll`, so the wait is on the
  //     cross-fade CONVERGING (App/Orb contract: ~200 ms), never on a clock.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await open(page);
  const orb = page.getByTestId('orb');

  /** The core pixel: the centre of the radial gradient, the `core` stop. */
  const corePixel = (): Promise<{ r: number; g: number; b: number }> =>
    orb.evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('no 2d context');
      const d = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0 };
    });

  await expect(orb).toHaveAttribute('data-persona', 'kareem');

  // The mapping under test is the one in `orb/palette.ts`: `speaking` is the
  // ONLY persona-coloured phase (idle/listening/thinking colour by phase), so the
  // palette is observable only while the assistant speaks. Asserting it at rest
  // would compare two charcoals and pass without proving anything.
  await post('/voice', { phase: 'speaking' });
  await expect(orb).toHaveAttribute('data-phase', 'speaking', { timeout: 5_000 });

  const GREEN_CORE = { r: 0x4a, g: 0xde, b: 0x80 };
  // Poll on the CONVERGENCE, not on a value that is true before the fade
  // finishes — an earlier revision polled `expect.any(Number)`, which is true of
  // every pixel and therefore read the still-charcoal `idle` frame.
  await expect
    .poll(
      async () => {
        const px = await corePixel();
        return Math.abs(px.g - GREEN_CORE.g) < 40;
      },
      { timeout: 5_000, message: 'the orb cross-fades to Kareem green' },
    )
    .toBe(true);
  const green = await corePixel();
  // kareem = '#4ade80'. Green dominates, and blue is the smallest channel — the
  // shape of a green, asserted rather than described.
  expect(green.g, 'Kareem is green-dominant').toBeGreaterThan(green.r);
  expect(green.g, 'Kareem is green-dominant').toBeGreaterThan(green.b);
  expect(green.b, 'blue is the weak channel in green').toBeLessThan(green.g);
  expect(Math.abs(green.g - GREEN_CORE.g)).toBeLessThan(40);

  // The switch itself is NOT in the widget (the pill is pinned at three
  // buttons), so persona moves the way it moves in production: the daemon
  // announces `persona-changed` and both surfaces follow (daemon.ts:946). This
  // is the real frame the real daemon sends, not a synthetic one.
  await post('/notice', { code: 'persona-changed', detail: 'nour', level: 'info' });
  await expect(orb).toHaveAttribute('data-persona', 'nour', { timeout: 5_000 });
  // `speaking` is the one phase whose label names the persona.
  await expect(orb).toHaveAttribute('aria-label', 'الكرة تتحدث بصوت نور');

  const PINK_CORE = { r: 0xf4, g: 0x72, b: 0xb6 };
  await expect
    .poll(
      async () => {
        const px = await corePixel();
        return Math.abs(px.r - PINK_CORE.r) < 40;
      },
      { timeout: 5_000, message: 'the orb cross-fades to Nour pink' },
    )
    .toBe(true);
  const pink = await corePixel();
  expect(pink.r, 'Nour is red-dominant').toBeGreaterThan(pink.b);
  expect(pink.r, 'Nour is red-dominant').toBeGreaterThan(pink.g);
  expect(pink.g, 'green is the weak channel in pink').toBeLessThan(pink.r);
  expect(Math.abs(pink.r - PINK_CORE.r)).toBeLessThan(40);

  // The two personas are genuinely different colours, not one palette relabelled.
  expect(Math.abs(green.g - pink.g), 'green and pink differ').toBeGreaterThan(60);
});

test('the settings window — and therefore the persona SWITCH — is reachable by Ctrl+, only', async ({
  page,
  context,
}) => {
  await open(page);

  // The rewrite spends the pill's third button on the keys window, which leaves
  // the settings window (and with it the persona switch) keyboard-only. That is
  // a deliberate consequence of the three-button rule, and this test is what
  // keeps the route from rotting silently: if `Ctrl+,` breaks, persona becomes
  // UNREACHABLE from the product and this goes red.
  const [settings] = await Promise.all([context.waitForEvent('page'), page.keyboard.press('Control+Comma')]);
  await settings.waitForLoadState('domcontentloaded');
  expect(searchOf(settings.url())).toBe('?view=settings&persona=kareem');
  await expect(settings.getByTestId('settings-view')).toBeVisible();

  // The persona radio pair, and it really switches.
  await settings.getByRole('tab', { name: /الصوت/ }).click();
  const nour = settings.getByTestId('persona-nour');
  const kareem = settings.getByTestId('persona-kareem');
  await expect(nour).toHaveAttribute('aria-checked', 'false');
  await nour.click();
  await expect(nour).toHaveAttribute('aria-checked', 'true');
  await expect(kareem).toHaveAttribute('aria-checked', 'false');

  // The command really travelled — the same WS-4097 the widget uses.
  const setPersona = await commands().then((rows) => rows.filter((c) => c['kind'] === 'setPersona'));
  expect(setPersona.length, 'setPersona reached the daemon').toBeGreaterThan(0);
  expect(setPersona[setPersona.length - 1]?.['persona']).toBe('nour');

  await settings.close();
});

test('a notice renders on the single message line, and Ctrl+, coexists with it', async ({ page }) => {
  await open(page);

  await post('/notice', { code: 'stt-timeout', detail: 'تجاوز تحويل الصوت المهلة', level: 'warn' });
  // Scoped to THIS sentence rather than to the bare testid: the strip is a
  // single slot that any later notice overwrites, and the shared stub emits a
  // `resume-gap` notice per connection. Waiting for our own text first makes
  // the assertion immune to a foreign writer winning the slot.
  const banner = page.getByTestId('notice-banner').filter({ hasText: 'تجاوز تحويل الصوت المهلة' });
  await expect(banner).toBeVisible({ timeout: 5_000 });
  await expect(banner).toHaveAttribute('data-level', 'warn');
  await expect(banner).toHaveText('تجاوز تحويل الصوت المهلة');
  // The full sentence survives truncation on `title`, so a hover never costs
  // the user the text.
  await expect(banner).toHaveAttribute('title', 'تجاوز تحويل الصوت المهلة');
  // Still exactly three buttons with a notice on screen.
  await expect(page.locator('button')).toHaveCount(3);
});

test('the window edge the shell composes for is 380×380 in tauri.conf.json', async () => {
  // The viewport in a browser run is the browser's, not the Tauri window's, so
  // the 380 square is asserted at its source. This is the drift that would clip
  // the widget: a window resized without the layout constant following.
  //
  // Resolved from this file's own URL rather than the cwd — Playwright runs with
  // the project root as cwd, so a repo-relative path resolves to
  // `apps/desktop/src-tauri/...`, which does not exist.
  const here = new URL('.', import.meta.url).pathname.replace(/^\//, '');
  const confPath = `${here}../src-tauri/tauri.conf.json`;
  const conf = JSON.parse(await readFile(confPath, 'utf8')) as {
    app: { windows: Array<{ width: number; height: number; minWidth: number; minHeight: number }> };
  };
  const win = conf.app.windows[0];
  expect(win).toBeDefined();
  expect(win?.width).toBe(380);
  expect(win?.height).toBe(380);
  expect(win?.minWidth).toBe(380);
  expect(win?.minHeight).toBe(380);
  // Square, so the orb's centred composition holds at the minimum.
  expect(win?.width).toBe(win?.height);
});
