// THE HEADLESS COMMAND LIST — deliberately its own module with no imports.
//
// WHY IT IS NOT IN `headless.ts`. `cli.ts` needs the type guard to route, and
// routing happens for EVERY invocation including `doctor` and `knowledge`. If the
// guard lived beside the runner, the static import graph of the ladder would pull
// the coordinator, the serve client, the vault and `daemon.js` into `doctor` — a
// module-load side effect on five subcommands that are supposed to be unchanged.
// `cli.ts` imports this file (zero dependencies) and dynamically imports
// `headless.ts` only once a headless command is actually named.
//
// Consequence to preserve: adding a command name here costs a headless run
// nothing, and adding an import here would cost every run a module load. The test
// `headless-commands.test.ts` pins that this file has no import statement at all.

export const HEADLESS_COMMANDS = [
  'reason',
  'intents',
  'gate',
  'sessions',
  'mcp',
  'lsp',
  'skills',
  'create-session',
  'prompt',
  'shell',
  'spec',
  'agent',
  'wait',
  'driver',
] as const;

export type HeadlessCommand = (typeof HEADLESS_COMMANDS)[number];

export function isHeadlessCommand(command: string | undefined): command is HeadlessCommand {
  return command !== undefined && (HEADLESS_COMMANDS as readonly string[]).includes(command);
}

/** The one-line addition printed under the original usage string. */
export const HEADLESS_USAGE_SUFFIX =
  '       opencode-voice reason | intents | gate | sessions | mcp | lsp | skills | create-session | prompt | shell | spec | agent | wait | driver';
