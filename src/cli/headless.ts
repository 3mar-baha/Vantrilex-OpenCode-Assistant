import { FileVault } from '../voice/vault.js';
import { readKeyPools } from '../voice/key-store.js';
import { vaultPathFromEnv } from '../daemon.js';
import { PERMISSION_TTL_MS } from '../orchestrator/permission.js';
import type { ChatFn } from '../orchestrator/coordinator.js';
import { Keyring, withKey } from '../voice/keyring.js';
import {
  INTENT_CASES,
  liveGateChat,
  probePermissionSlot,
  replayGateChat,
  runIntentTable,
  structuralFaultsOf,
  type IntentCase,
} from './intents.js';
import { reasonCommand } from './reason.js';
import { createSessionCommand, lspCommand, mcpCommand, promptCommand, sessionsCommand, shellCommand, skillsCommand, specCommand } from './bridge.js';
import { agentCommand, waitCommand } from './agent.js';
import { driverCommand } from './driver.js';
import { assertGateInvariant, measureGateInvariant, type GateInvariant } from './turn.js';
import { HEADLESS_COMMANDS, type HeadlessCommand } from './commands.js';
import { readFileSync } from 'node:fs';
import * as out from './report.js';

// THE HEADLESS SURFACE — the argv ladder this file owns.
//
// The five shipped subcommands (`doctor`, `vault bootstrap`, `live`, `serve`,
// `knowledge`) are untouched; this is a new branch, reached before the usage
// fallback so `opencode-voice reason …` works without changing what any existing
// invocation does.
//
// WHAT "HEADLESS" EXCLUDES, WRITTEN DOWN BECAUSE IT IS THE POINT. No Tauri
// webview, no microphone, no `AudioIngest`, no Whisper, no Fish, no daemon and no
// WS-4097 control plane. Every number below comes from a module under `src/`, and
// the report prints that module's path next to it.

function flag(args: readonly string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function option(args: readonly string[], name: string): string | null {
  const prefixed = `--${name}=`;
  for (const a of args) {
    if (a.startsWith(prefixed)) return a.slice(prefixed.length);
  }
  const at = args.indexOf(`--${name}`);
  if (at >= 0) {
    const next = args[at + 1];
    if (next !== undefined && !next.startsWith('--')) return next;
  }
  return null;
}

/**
 * The options that CONSUME the next token.
 *
 * Positional extraction has to know this, and getting it wrong is not cosmetic:
 * a parser that assumes every `--flag` takes a value swallows the utterance
 * itself, so `reason --replay "شوف لي الجلسات"` reports "no text" and exits 2
 * while looking like a correct argument error. Found by running it.
 *
 * Anything not named here is boolean and leaves the next token alone.
 */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  'session',
  'directory',
  'model',
  'agent',
  'case',
  'source',
  'timeout',
  'message',
  // `driver`'s own value options. Named here for the same reason the rest of the
  // set exists: a parser that treats `--transcript out.jsonl` as a flag plus a
  // positional would read `out.jsonl` as the UTTERANCE and run a turn whose input
  // was a file path.
  'transcript',
  'turn-timeout',
  'tool-wait',
]);

/** Positional arguments, in order, ignoring flags and their values. */
function positionals(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    // `noUncheckedIndexedAccess` makes this `string | undefined`; an out-of-range
    // index cannot actually happen inside `i < args.length`, and pushing
    // `undefined` would put a non-string in the positional list.
    if (a === undefined) continue;
    if (!a.startsWith('--')) {
      out.push(a);
      continue;
    }
    // `--name value` consumes the next token; `--name=value` and boolean flags
    // do not.
    const name = a.slice(2).split('=')[0] ?? '';
    const next = args[i + 1] ?? '';
    if (!a.includes('=') && VALUE_OPTIONS.has(name) && next.length > 0 && !next.startsWith('--')) {
      i += 1;
    }
  }
  return out;
}

function usage(): string {
  return [
    `usage: opencode-voice <headless command> [args]   (${HEADLESS_COMMANDS.length} commands)`,
    '',
    '  reason <text> [--approve] [--session <id>] [--replay]',
    '        Full chain: intake → permission gate → plan → dispatch → reply.',
    '        Prints the structural invariant counted from coordinator.ts source.',
    '  intents [--live] [--case <id>]',
    '        Intent table through the real gate; expected vs actual. Offline it',
    '        REPLAYS recorded replies, so its figure is a parser agreement and',
    '        NOT a model measurement. Only --live measures the model.',
    '  sessions                       session list through ServeClient',
    '  mcp [--directory <dir>]        MCP server status (directory-scoped, no /api)',
    '  lsp [--directory <dir>]        LSP diagnostics (directory-scoped, no /api)',
    '  skills                         installed skills through ServeClient',
    '  create-session [--directory <dir>] [--model <provider/id>]',
    '  prompt <sessionId> <text>',
    '                                send one prompt through ServeClient',
    '  shell <sessionId> <command> [--agent <name>]',
    '                                run a command in a session (v1 route)',
    '  spec                           the real OpenAPI document at /doc',
    '  gate [--source <file>]          the structural invariant, counted from source',
    '  agent <sessionId> <name> [--no-reply]',
    '                                switch a session agent; proven from info.agent,',
    '                                never from what was requested',
    '  wait <sessionId> <messageId> [--timeout <ms>]',
    '                                poll a turn to completion; reports which of the',
    '                                four: text / empty / running / errored',
    '  driver [<text>] [--session <id>] [--transcript <file>] [--daemon]',
    '                        [--turn-timeout <ms>] [--tool-wait <ms>]',
    '                        text REPL over the real chain, no UI and no voice;',
    '                        JSONL transcript on stdout AND in a per-session file',
    '',
    'no audio, no webview, no daemon required. serve must be running on 4096.',
  ].join('\n');
}

/** OpenRouter key availability, reported as counts and never as material. */
function brainKeyStatus(): { readonly available: boolean; readonly count: number; readonly detail: string } {
  try {
    const pools = readKeyPools(new FileVault(vaultPathFromEnv()));
    const count = pools.openrouter.length;
    return count > 0
      ? { available: true, count, detail: `${count} openrouter key(s) in the vault` }
      : { available: false, count: 0, detail: 'no openrouter key in the vault — `reason` and `intents --live` need one' };
  } catch (err) {
    return { available: false, count: 0, detail: `vault unreadable: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

async function intentsCommand(args: readonly string[]): Promise<number> {
  const live = flag(args, 'live');
  const only = option(args, 'case');
  const cases: readonly IntentCase[] = only === null ? INTENT_CASES : INTENT_CASES.filter((c) => c.id === only);
  if (cases.length === 0) {
    out.heading('intents');
    out.fail(`no case named "${only ?? ''}" — known: ${INTENT_CASES.map((c) => c.id).join(', ')}`);
    return 2;
  }

  out.heading('intents — src/orchestrator/permission.ts, through its real entry point');
  out.source('src/orchestrator/permission.ts', 'addresseeSystem() → ADDRESSEE_RESPONSE_FORMAT → parseAddressee()');
  out.source('src/orchestrator/coordinator.ts', 'the same triple gate() passes to deps.chat (:388-393)');
  out.field('cases', String(cases.length));

  let source: 'model' | 'replay';
  let chat: ChatFn;
  if (live) {
    const keys = brainKeyStatus();
    out.field('key', keys.detail);
    if (!keys.available) {
      out.fail('no brain key — drop --live to run the table against recorded replies (which measures parseAddressee, not the model)');
      return 1;
    }
    // Through the product's keyring, so a 429 or a 401 advances the pool exactly
    // as the daemon does. `Keyring.load` requires all three pools, so a vault
    // holding only openrouter throws — reported as the vault error it is, rather
    // than worked around with a second key path.
    let ring: Keyring;
    try {
      ring = Keyring.load(new FileVault(vaultPathFromEnv()));
    } catch (err) {
      out.fail(`keyring unavailable: ${err instanceof Error ? err.message : 'unknown'}`);
      out.note('Keyring.load needs all three pools (groq, fish, openrouter) — the live gate needs only openrouter');
      return 1;
    }
    chat = async (model, system, user, options) =>
      withKey(ring, 'openrouter', (key) => liveGateChat(Buffer.from(key.material).toString('utf8'))(model, system, user, options));
    source = 'model';
    out.field('verdict source', 'live model call (free-tier quota spent)');
  } else {
    const byUtterance = new Map(cases.map((c) => [`${c.utterance}\n\nTASK SPECIFICATION:\n${c.taskEn}`, c.reply]));
    chat = replayGateChat((key) => byUtterance.get(key) ?? null);
    source = 'replay';
    out.field('verdict source', 'recorded replies — measures parseAddressee and the round-trip, NOT the model');
  }

  const report = await runIntentTable(cases, chat, source);
  out.heading('RESULTS');
  out.field('  case', 'expected / actual / match');
  for (const row of report.rows) {
    const mark = row.match ? 'ok  ' : 'MISS';
    out.note(`${mark} ${row.id.padEnd(26)} expected=${row.expected.padEnd(15)} actual=${row.actual.padEnd(15)} ${row.ms} ms`);
    out.note(`     addressed=${row.addressed} approves_id=${row.approvesIdKept === '' ? '(dropped)' : row.approvesIdKept} ask_words=${row.askWords}`);
    if (row.failure !== null) out.note(`     transport failure: ${row.failure}`);
    out.note(`     reason_en: ${out.clip(row.reasonEn, 120)}`);
  }
  out.heading(source === 'model' ? 'ACCURACY — live model' : 'REPLAY AGREEMENT — NOT a model measurement');
  out.field('correct', `${report.correct} / ${report.total}`);
  // `agreement`, not `accuracy`: on a replay run the answer key sits in the same
  // object literal as the answer, so calling the figure an accuracy named a
  // number that was 1 before any call was made. `measured against` below is the
  // provenance, and it is now redundant with the heading rather than the only
  // thing carrying it.
  out.field(source === 'model' ? 'accuracy' : 'agreement', report.agreement === null ? 'not computed (no cases)' : `${(report.agreement * 100).toFixed(1)}%`);
  out.field('measured against', source === 'model' ? 'the live model, via the product\'s openRouterChat' : 'recorded replies, via the product\'s parseAddressee');
  out.field('what this measures', report.measures);
  out.field('wall clock', `${report.ms} ms`);
  out.heading('confusion (expected vs actual, per decision)');
  for (const c of report.confusion) out.note(`${c.decision.padEnd(16)} expected=${c.expected} actual=${c.actual}`);

  const faults = structuralFaultsOf(report.rows);
  out.heading('STRUCTURAL');
  for (const f of faults) out.fail(f);
  out.verdict(faults.length === 0, 'no approves_id survived a non-approve verdict');

  // ── The PermissionSlot, through its own methods ─────────────────────────
  out.heading('PERMISSION SLOT — src/orchestrator/permission.ts PermissionSlot');
  out.source('src/orchestrator/permission.ts', `PermissionSlot (ttl ${PERMISSION_TTL_MS} ms, single-slot)`);
  const slot = probePermissionSlot('a0000000-0000-4000-8000-000000000000', 'probe: delete the output directory', PERMISSION_TTL_MS);
  out.field('consume(wrong id)', slot.consumeWrongId);
  out.field('consume(correct id)', slot.consumeCorrectId);
  out.field('consume(same id again)', slot.consumeAgain);
  out.field('taskEn on consume', slot.taskEnOnConsume);
  out.field('slot after consume', slot.slotAfterConsume);
  out.field('ttl', `${slot.ttlMs} ms`);
  for (const v of slot.violations) out.fail(v);
  out.verdict(slot.violations.length === 0, 'an approval names one action, once');
  return faults.length === 0 && slot.violations.length === 0 ? 0 : 1;
}

/**
 * A non-negative integer option, or `null` for "absent or unusable".
 *
 * `null` conflates the two cases deliberately: the caller reports the option name
 * and exits 2 either way, and the distinction between "you did not pass it" and
 * "you passed nonsense" is not one an exit code needs to carry.
 */
function intOption(raw: string | null, name: string): number | null {
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    out.heading('driver');
    out.fail(`--${name} must be a non-negative integer of milliseconds, got "${raw}"`);
    return null;
  }
  return parsed;
}

export async function runHeadless(command: HeadlessCommand, argv: readonly string[]): Promise<number> {
  const args = argv.slice(1);
  switch (command) {
    case 'reason': {
      const text = positionals(args).join(' ');
      if (text.length === 0) {
        out.heading('reason');
        out.fail('no text — `opencode-voice reason "شوف لي الجلسات اللي فشلت"`');
        return 2;
      }
      return reasonCommand({
        text,
        approve: flag(args, 'approve'),
        sessionId: option(args, 'session'),
        replay: flag(args, 'replay'),
      });
    }
    case 'intents':
      return intentsCommand(args);
    case 'gate': {
      console.log(usage());
      out.heading('gate — the structural invariant, counted from source');
      return invariantCommand(option(args, 'source'));
    }
    case 'sessions':
      return sessionsCommand();
    case 'mcp':
      return mcpCommand(option(args, 'directory') ?? process.cwd());
    case 'lsp':
      return lspCommand(option(args, 'directory') ?? process.cwd());
    case 'skills':
      return skillsCommand();
    case 'create-session':
      return createSessionCommand(option(args, 'directory') ?? process.cwd(), option(args, 'model') ?? undefined);
    case 'prompt': {
      const pos = positionals(args);
      const sessionId = pos[0];
      const text = pos.slice(1).join(' ');
      if (sessionId === undefined || text.length === 0) {
        out.heading('prompt');
        out.fail('usage: opencode-voice prompt <sessionId> <text>');
        return 2;
      }
      return promptCommand(sessionId, text);
    }
    case 'shell': {
      const pos = positionals(args);
      const sessionId = pos[0];
      const command = pos.slice(1).join(' ');
      if (sessionId === undefined || command.length === 0) {
        out.heading('shell');
        out.fail('usage: opencode-voice shell <sessionId> <command>');
        return 2;
      }
      // The default is the client's own (`DEFAULT_SHELL_AGENT`), resolved inside
      // `execSessionShell`; it is only named here when the operator overrides it.
      const agent = option(args, 'agent');
      if (agent === null) return shellCommand(sessionId, command, 'build');
      return shellCommand(sessionId, command, agent);
    }
    case 'spec':
      return specCommand();
    case 'agent': {
      const pos = positionals(args);
      const sessionId = pos[0];
      const agent = pos[1];
      if (sessionId === undefined || agent === undefined) {
        out.heading('agent');
        out.fail('usage: opencode-voice agent <sessionId> <agentName> [--no-reply]');
        return 2;
      }
      return agentCommand(sessionId, agent, flag(args, 'no-reply'));
    }
    case 'wait': {
      const pos = positionals(args);
      const sessionId = pos[0];
      const messageId = pos[1];
      if (sessionId === undefined || messageId === undefined) {
        out.heading('wait');
        out.fail('usage: opencode-voice wait <sessionId> <messageId> [--timeout <ms>]');
        return 2;
      }
      // A bad `--timeout` is a usage error rather than a silent default: this
      // option IS the budget, and quietly substituting 30 000 for a typo would
      // answer "did it finish?" with a different question than the caller asked.
      const raw = option(args, 'timeout');
      let timeoutMs = 30_000;
      if (raw !== null) {
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed < 0) {
          out.heading('wait');
          out.fail(`--timeout must be a non-negative integer of milliseconds, got "${raw}"`);
          return 2;
        }
        timeoutMs = parsed;
      }
      return waitCommand(sessionId, messageId, timeoutMs);
    }
    case 'driver': {
      // A bad numeric option is a usage error rather than a silent default, for
      // the reason `--timeout` above gives: these two ARE the budgets, and
      // quietly substituting 0 for a typo would turn "bound every turn" into
      // "bound nothing" while looking like a correct parse.
      const turnTimeout = intOption(option(args, 'turn-timeout'), 'turn-timeout');
      if (turnTimeout === null) return 2;
      const toolWait = intOption(option(args, 'tool-wait'), 'tool-wait');
      if (toolWait === null) return 2;
      const seed = positionals(args).join(' ').trim();
      return driverCommand({
        seed: seed.length === 0 ? null : seed,
        sessionId: option(args, 'session'),
        directory: option(args, 'directory'),
        transcriptFile: option(args, 'transcript'),
        turnTimeoutMs: turnTimeout,
        toolWaitMs: toolWait,
        startDaemon: flag(args, 'daemon'),
      });
    }
    default: {
      out.heading('headless');
      out.fail(`unknown headless command: ${String(command)}`);
      console.log(usage());
      return 2;
    }
  }
}

/**
 * The invariant alone, for a gate that does not need serve or a key.
 *
 * `--source <file>` measures a DIFFERENT file. It exists so the guard can be
 * break-verified end to end: pointing this at a copy of `coordinator.ts` with a
 * second `return { kind: 'proceed' }` has to exit non-zero, and editing the real
 * orchestrator to find out is not an option when the orchestrator is outside the
 * change's write-set. The path is printed on every run, so a report carrying a
 * non-default path cannot be mistaken for a verdict about the shipped file.
 */
export async function invariantCommand(sourceOverride: string | null = null): Promise<number> {
  out.heading('gate — src/orchestrator/coordinator.ts, counted from source');
  let invariant: GateInvariant;
  if (sourceOverride === null) {
    invariant = assertGateInvariant();
  } else {
    try {
      invariant = measureGateInvariant(readFileSync(sourceOverride, 'utf8'), sourceOverride);
    } catch (err) {
      out.fail(`--source ${sourceOverride} unreadable: ${err instanceof Error ? err.message : 'unknown'}`);
      return 1;
    }
    out.warnLine(`measuring ${sourceOverride} — this is NOT the shipped coordinator.ts`);
  }
  out.source('src/orchestrator/coordinator.ts', invariant.file);
  for (const c of invariant.counts) out.field(c.label, `${c.count} (expected ${c.expected})`);
  out.field("naive \"kind: 'proceed'\"", `${invariant.naiveProceedMentions} (the type member at the return annotation plus the returned value)`);
  out.verdict(invariant.ok, invariant.ok ? 'one proceed, one dispatch call site, one consume' : invariant.failures.join('; '));
  return invariant.ok ? 0 : 1;
}

export { usage as headlessUsage };
// Re-exported so `cli.ts` has ONE dynamic import to write, and so a reader (or a
// test) can reach the surface from one module. A SECOND literal list here would be
// able to drift from the one `cli.ts` routes on, and the drift would be a command
// that exists in the help and not in the ladder.
export { HEADLESS_COMMANDS, HEADLESS_USAGE_SUFFIX as headlessUsageSuffix, isHeadlessCommand } from './commands.js';
export type { HeadlessCommand } from './commands.js';
