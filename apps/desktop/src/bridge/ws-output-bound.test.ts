import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { VoxauraBridge, type OutputFrameMsg, type SocketLike } from './ws.js';
// This file's own subject, inlined by Vite's `?raw` transform. `import.meta.url`
// is NOT usable here — measured, not assumed: under the `happy-dom` environment
// it does not resolve to the on-disk file, so `readFileSync(new URL('./ws.ts',
// import.meta.url))` opened `O:\src\bridge\ws.ts` and threw ENOENT.
import WS_SOURCE from './ws.ts?raw';

// THE MICRO-GAP, MEASURED INSTEAD OF ASSUMED.
//
// The `output` branch in `onMessage` ends in `this.opts.onOutput?.(output)` on a
// frame whose `output` is a producer-bounded blob, and `isOutputFrame` — the
// only guard on the way in — checks TYPES and the two bounded echoes
// (`command` ≤ 512, `commandId` ≤ 128) and is DELIBERATELY silent about the
// length of `output`. That is a policy, not an oversight: the producer owns
// `MAX_OUTPUT_TEXT_BYTES` and reports the drop on the frame, so a renderer-side
// clamp would hide a real drop and assert a completeness the frame never
// claimed.
//
// A policy is only as good as the thing it delegates to, so this file pins BOTH
// halves of the delegation:
//
//   1. `isOutputFrame` is the only gate on that path and nothing can reach
//      `onOutput` without passing it — not by calling around it (it is not
//      exported), not by taking another branch (there is exactly one call site),
//      and not by arriving on a non-text payload (`ArrayBuffer` / `Blob`).
//   2. The producer it delegates to is real, singular and does the capping. This
//      suite cannot import it — the root `src/` tree is outside the desktop
//      tsconfig's `include`, and importing `protocol.ts` would drag zod into the
//      renderer bundle — so the daemon half is asserted by READING the source and
//      by CROSS-REFERENCING the root suite that already measures the bound at
//      runtime (`src/ipc/output-frame.test.ts`, 'buildOutputFrame — the cap is on
//      the PRODUCTION path'). Reading is a real check here and not a proxy: what
//      has to hold is a property of the producer's call graph, and the set of
//      files that mention `buildOutputFrame` is exactly that property.
//
// WHAT THIS DOES NOT CLAIM. A hostile or compromised daemon can put a 50 MB
// string in `output` and the bridge will forward it — it has to, or a real 32 KiB
// frame would be indistinguishable from a fake one, and `TerminalDrawer`'s 8192
// `clampLine` is the backstop that states the clamp in Arabic when it fires. The
// transport here is loopback + a bearer the renderer must already hold, so the
// daemon is not the adversary; asserting otherwise would be inventing a threat
// model to justify a check.

// ── LOCATING THE ROOT TREE ───────────────────────────────────────────────────

/**
 * The repository root, found by walking up from the vitest working directory.
 *
 * `import.meta.url` is NOT usable here — measured, not assumed: this suite runs
 * under `happy-dom`, where it is not a `file:` URL, so
 * `readFileSync(new URL(…, import.meta.url))` throws "The URL must be of scheme
 * file". Walking up finds the tree from either the root runner or the desktop
 * one, and the assertion below is LOUD rather than a silent skip, so a tree that
 * moved fails instead of passing nothing.
 */
const REPO_ROOT = (() => {
  let dir = resolve(process.cwd());
  for (let hop = 0; hop < 6; hop += 1) {
    if (existsSync(join(dir, 'src', 'ipc', 'protocol.ts')) && existsSync(join(dir, 'apps', 'desktop'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error(`repo root not found from ${process.cwd()} — the source-reading checks cannot be trusted`);
})();

const ROOT_SOURCE = (relative: string): string => readFileSync(join(REPO_ROOT, 'src', relative), 'utf8');

/**
 * The same file with comments removed.
 *
 * Needed and not decorative: `daemon/shell-tasks.ts` names `buildOutputFrame` in
 * three PROSE lines, and a naive `includes` would report it as a producer. A
 * comment is not a call site, and a scan that cannot tell the two apart would
 * have to be loosened until it no longer guarded anything.
 */
const ROOT_CODE = (relative: string): string =>
  ROOT_SOURCE(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/** Every production `.ts` under `src/`, repo-relative, tests and archive excluded. */
function productionModules(): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.opencode') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
      out.push(full.slice(join(REPO_ROOT, 'src').length + 1).replace(/\\/g, '/'));
    }
  };
  walk(join(REPO_ROOT, 'src'));
  return out.sort();
}

/** Every production `.ts(x)` under `apps/desktop/src`, comments stripped. */
function productionDesktopModules(): ReadonlyArray<{ readonly rel: string; readonly code: string }> {
  const base = join(REPO_ROOT, 'apps', 'desktop', 'src');
  const out: Array<{ rel: string; code: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(full) || /\.(test|spec)\.tsx?$/.test(full)) continue;
      const text = readFileSync(full, 'utf8');
      out.push({
        rel: full.slice(base.length + 1).replace(/\\/g, '/'),
        code: text
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^[ \t]*\/\/.*$/gm, ''),
      });
    }
  };
  walk(base);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

// ── HARNESS ──────────────────────────────────────────────────────────────────

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor() {}
  send(): void {}
  sendBinary(): void {}
  close(): void {}
  peer(data: unknown): void {
    this.onmessage?.({ data });
  }
}

interface Harness {
  readonly bridge: VoxauraBridge;
  readonly socket: FakeSocket;
  readonly output: OutputFrameMsg[];
  readonly errors: string[];
}

function harness(): Harness {
  const output: OutputFrameMsg[] = [];
  const errors: string[] = [];
  const socket = new FakeSocket();
  const bridge = new VoxauraBridge({
    token: 'tok',
    contractVersion: '3.1.0',
    createSocket: () => socket,
    onOutput: (f) => output.push(f),
    onErrorFrame: (d) => errors.push(d),
  });
  bridge.connect();
  return { bridge, socket, output, errors };
}

/**
 * One wire-legal `output` frame, per `OutputFrameSchema`.
 */
function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'output',
    seq: 4,
    sessionId: 'ses_alpha',
    commandId: 'cmd_1',
    command: 'npm run build',
    status: 'completed',
    outcome: 'unknown',
    exitCode: null,
    output: 'hi',
    outputBytes: 2,
    droppedBytes: 0,
    truncated: false,
    durationMs: 812,
    ...overrides,
  };
}

// ── 1 · THE GUARD IS THE ONLY GATE, AND IT IS NOT SKIPPABLE ──────────────────

describe('isOutputFrame cannot be bypassed by a frame that skips validation', () => {
  test('the guard is module-private, so no other file can skip it', () => {
    // `private` in TypeScript is compile-time only, so the EXPORT list is the
    // real claim: an unexported function has no named import anywhere in the
    // tree, and a whole-tree scan is what makes that a fact about the repo rather
    // than a fact about this file's own import statement.
    expect(WS_SOURCE, 'ws.ts was not read — this check is vacuous if it silently reads nothing').not.toBe('');
    expect(WS_SOURCE).toMatch(/function isOutputFrame\(/);
    expect(WS_SOURCE, 'isOutputFrame must NOT be exported').not.toMatch(/export\s+(?:function|const)\s+isOutputFrame/);
    // …and nothing else in the renderer's own tree imports the name, which is the
    // whole-tree half stated over the tree rather than over one import line.
    const importers = productionDesktopModules()
      .filter((m) => /\bisOutputFrame\b/.test(m.code))
      .map((m) => m.rel);
    expect(importers, 'the only module that mentions isOutputFrame is ws.ts itself').toEqual(['bridge/ws.ts']);
  });

  test('`onOutput` is called from EXACTLY ONE place, and the guard dominates it', () => {
    // A second call site is how a validation-skipping path would be born: some
    // later branch that fires the handler before checking the shape. Asserting
    // "one call site" plus "the guard is between the branch and the call" is the
    // structural half of the claim, and it is over the bridge's OWN source, so
    // it holds for any future edit to `onMessage` rather than for this file.
    const source = WS_SOURCE;
    const calls = [...source.matchAll(/opts\.onOutput\?\.\(/g)];
    expect(calls.length, 'exactly one onOutput call site in ws.ts').toBe(1);
    const branch = source.indexOf("if (msg['type'] === 'output')");
    expect(branch, 'the output branch exists').toBeGreaterThan(-1);
    const slice = source.slice(branch);
    const guard = slice.indexOf('if (!isOutputFrame(output))');
    const call = slice.indexOf('opts.onOutput?.(');
    expect(guard, 'the guard is inside the output branch').toBeGreaterThan(-1);
    expect(call, 'the handler is inside the output branch').toBeGreaterThan(-1);
    // The guard comes FIRST, and everything between it and the handler is the
    // refusal itself — `onErrorFrame` plus a `return`. A path that reported the
    // frame and then called the handler anyway would fail on the `return`.
    expect(guard).toBeLessThan(call);
    expect(slice.slice(guard, call)).toContain('malformed output frame');
    expect(slice.slice(guard, call)).toMatch(/\breturn;/);
  });

  test('a non-TEXT payload carrying a valid frame never reaches onOutput', () => {
    // The paths AROUND the guard, which the malformed-frame table in
    // `ws-output.test.ts` does not reach: `onMessage` handles `ArrayBuffer` and
    // `Blob` before it looks at `type`, so a frame that arrives wrapped in one is
    // consumed by the BINARY path and dropped. That is a loss and not a bypass —
    // `adaptWebSocket` sets `binaryType = 'arraybuffer'`, so a text frame never
    // arrives as a Blob — and it is asserted so that if the binary path is ever
    // reordered ahead of the text path, this says so instead of silently
    // doubling the ways a frame can appear.
    const h = harness();
    const json = JSON.stringify(frame());
    h.socket.peer(new TextEncoder().encode(json).buffer);
    h.socket.peer(new Blob([json]));
    expect(h.output, 'neither may reach the handler').toHaveLength(0);
    expect(h.errors, 'and neither is even a malformed contract frame').toHaveLength(0);
    // The socket is untouched: the text path still works.
    h.socket.peer(json);
    expect(h.output).toHaveLength(1);
    h.bridge.dispose();
  });

  test('a frame missing any ONE required field is refused, and the good ones still arrive', () => {
    // A narrower table than `ws-output.test.ts`'s and on purpose: this one exists
    // to show the refusal is per-FIELD rather than all-or-nothing, which is what
    // "the guard is a whole-shape check and not a type test" means in practice.
    // The three mutations are the two REQUIRED fields the renderer newly depends
    // on plus the echoed `command` bound.
    const h = harness();
    for (const [label, override] of [
      ['no outcome', { outcome: undefined }],
      ['no sessionId', { sessionId: undefined }],
      ['an over-long command', { command: 'c'.repeat(513) }],
    ] as const) {
      h.socket.peer(JSON.stringify(frame(override)));
      expect(h.output, `${label} must not reach the handler`).toHaveLength(0);
    }
    expect(h.errors, 'each is reported as the one contract error').toEqual([
      'malformed output frame',
      'malformed output frame',
      'malformed output frame',
    ]);
    h.socket.peer(JSON.stringify(frame()));
    expect(h.output, 'the socket and the handler both survive').toHaveLength(1);
    h.bridge.dispose();
  });
});

// ── 2 · THE PRODUCER IT DELEGATES TO IS REAL, SINGULAR, AND CAPS ──────────────

describe('the bound the renderer delegates to: 32 KiB, one producer', () => {
  test('`MAX_OUTPUT_TEXT_BYTES` is 32 KiB and is enforced twice on the producer', () => {
    const protocol = ROOT_CODE('ipc/protocol.ts');
    // The constant.
    expect(protocol).toMatch(/export const MAX_OUTPUT_TEXT_BYTES = 32 \* 1024;/);
    // Enforcement 1 — the accumulator, which caps CUMULATIVELY and before it
    // retains a fragment, so the bound holds on memory and not only on the
    // emitted string.
    expect(protocol).toMatch(/if \(this\.storedBytes \+ n > MAX_OUTPUT_TEXT_BYTES\)/);
    // Enforcement 2 — the schema refine, in BYTES rather than UTF-16 code units,
    // so 32 KiB of Arabic cannot become 128 KiB of wire.
    expect(protocol).toMatch(
      /\.refine\(\(s\) => Buffer\.byteLength\(s, 'utf8'\) <= MAX_OUTPUT_TEXT_BYTES, 'output exceeds MAX_OUTPUT_TEXT_BYTES'\)/,
    );
    // Both run on the ONLY production path: `buildOutputFrame` constructs an
    // assembler and PARSES, so a producer that skipped the assembler still cannot
    // emit an over-cap frame.
    const builder = /export function buildOutputFrame\([\s\S]*?\n\}/.exec(protocol)?.[0] ?? '';
    expect(builder, 'buildOutputFrame was not found — this check is vacuous if it reads nothing').not.toBe('');
    expect(builder).toContain('new OutputAssembler()');
    expect(builder).toContain('OutputFrameSchema.parse');
    expect(builder, 'the cap runs on the single-shot path too').toContain('asm.pushPrefixText(input.output)');
  });

  test('`buildOutputFrame` has exactly ONE production importer', () => {
    // The property that matters is not "the constant is 32 KiB" but "everything
    // that reaches the wire went through the thing that caps it". So: the set of
    // production modules that even NAME `buildOutputFrame` is exactly the
    // definition plus its one caller. A second caller that hand-built a frame
    // would show up here as a third file, which is the failure this asserts
    // against.
    const mentions = productionModules().filter((rel) => /\bbuildOutputFrame\b/.test(ROOT_CODE(rel)));
    expect(mentions, 'every production module that CALLS or DEFINES buildOutputFrame').toEqual([
      'ipc/protocol.ts',
      'ipc/ui-server.ts',
    ]);
    // …and the ONE caller publishes exactly what the builder returned: the wire
    // bytes and the retained replay copy are the same object, so the bound holds
    // on the resume path too and not only on the live send. This replaced an
    // assertion on the caller's COMMENT saying the same thing, which was both
    // weaker and a drift trap — a stale comment is not a bound.
    const method =
      /output\(input: OutputFrameInput\): OutputFrame \{[\s\S]*?\n {2}\}/.exec(ROOT_CODE('ipc/ui-server.ts'))?.[0] ?? '';
    expect(method, 'UiServer.output() was not found — this check is vacuous if it reads nothing').not.toBe('');
    expect(method).toContain('const frame = buildOutputFrame(this.seq, input)');
    expect(method, 'the retained replay copy is the built frame').toContain('this.retainForResume(frame)');
    expect(method, 'and so are the wire bytes').toContain('encodeTextFrame(JSON.stringify(frame))');
    expect([...method.matchAll(/buildOutputFrame\(/g)].length, 'exactly one build per published frame').toBe(1);
  });

  test('nothing in `src/` hand-builds an `output` frame', () => {
    // The stronger form of the same claim, over a pattern rather than a symbol:
    // any frame built from a literal — `type: 'output'` or the `OUTPUT_KIND`
    // constant — skips `buildOutputFrame` and therefore skips the cap. Comments
    // are stripped first because `shell-tasks.ts` names both in prose, and a
    // comment is not a producer.
    const offenders = productionModules().filter((rel) => {
      const code = ROOT_CODE(rel);
      return /\btype:\s*'output'\b/.test(code) || /\bOUTPUT_KIND\b/.test(code);
    });
    expect(offenders, 'modules that construct an output frame by hand').toEqual(['ipc/protocol.ts']);
    // And the one wiring point: `ui.output(input)` is reached from a single site,
    // so the producer's input is the command result and nothing else.
    const daemon = ROOT_SOURCE('daemon.ts');
    expect([...daemon.matchAll(/ui\.output\(/g)].length, 'ui.output() call sites in daemon.ts').toBe(1);
  });

  test('the renderer forwards `output` BY REFERENCE — it never copies, concatenates or clamps it', () => {
    // The "no re-clamp" policy only holds if the string the handler receives is
    // the string the guard inspected. A defensive `.slice()`, a re-encoding, or a
    // rebuilt object would all preserve the text while breaking the identity, and
    // identity is what makes "the renderer adds no second truncation" a fact
    // rather than a comparison someone can arrange to pass.
    const h = harness();
    const body = 'س'.repeat(20_000);
    h.socket.peer(JSON.stringify(frame({ output: body, outputBytes: 40_000, droppedBytes: 20_000, truncated: true })));
    expect(h.output).toHaveLength(1);
    const forwarded = h.output[0];
    expect(forwarded?.output).toBe(body);
    expect(Object.getPrototypeOf(forwarded ?? {})).toBe(Object.prototype);
    expect(h.errors, 'the guard said nothing about this frame').toHaveLength(0);
    h.bridge.dispose();
  });
});
