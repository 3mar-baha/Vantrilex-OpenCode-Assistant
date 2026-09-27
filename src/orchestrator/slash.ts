// Phase 4 — the slash interpreter.
//
// A leading `/` is never forwarded to the model as prose. It is either a command
// this daemon implements natively, or it is rejected with a message that names
// what IS available. Forwarding `/rm -rf /` to an agent is how a typo becomes an
// incident, and the audit's own conclusion was "map to typed commands, never
// forward blindly".
//
// Pure by design: no I/O, no client, no side effects. The daemon decides what to
// execute; this module only decides what the text MEANS.

export interface SlashCommand {
  readonly name: string;
  /** Arabic, shown in the HUD and by `/help`. */
  readonly description: string;
  /** Whether the command accepts trailing arguments. */
  readonly takesArgs: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'compact', description: 'تلخيص الجلسة لتحرير نافذة السياق', takesArgs: false },
  { name: 'new', description: 'بدء جلسة جديدة مع عنوان اختياري', takesArgs: true },
  { name: 'help', description: 'عرض الأوامر المتاحة', takesArgs: false },
];

const BY_NAME: ReadonlyMap<string, SlashCommand> = new Map(SLASH_COMMANDS.map((c) => [c.name, c]));

/** Control characters are exactly what this rejects, so the rule is inline-built. */
const CONTROL_RE = new RegExp('[\\u0000-\\u001F\\u007F]');

export interface ParsedSlash {
  readonly name: string;
  readonly args: string;
}

/** Longest argument we accept. Beyond this we reject rather than truncate. */
export const SLASH_MAX_ARGS = 200;

/**
 * Interpret a message that begins with `/`.
 *
 * Returns `null` when the text is not a command at all — including a slash that
 * appears mid-sentence, which is prose the user meant to send.
 */
export function parseSlashCommand(text: string): ParsedSlash | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const rest = trimmed.slice(1);
  // A lone slash, or a slash followed only by spaces, is not a command.
  const head = rest.split(/\s/, 1)[0] ?? '';
  if (head.length === 0) return null;
  const name = head.toLowerCase();
  const args = rest.slice(head.length).trim();
  return { name, args };
}

/**
 * Validate a parsed command. `null` means it may execute; a string is a message
 * for the user, in Arabic, safe to show and to log.
 */
export function slashCommandError(text: string): string | null {
  const parsed = parseSlashCommand(text);
  if (parsed === null) return 'الأمر غير صالح';
  const command = BY_NAME.get(parsed.name);
  if (command === undefined) {
    // Never echo an arbitrary attacker- or typo-supplied name back at length.
    return `أمر غير معروف: /${parsed.name.slice(0, 32)}. الأوامر المتاحة: ${SLASH_COMMANDS.map((c) => `/${c.name}`).join('، ')}`;
  }
  if (!command.takesArgs && parsed.args.length > 0) {
    return `الأمر /${command.name} لا يقبل وسائط`;
  }
  if (parsed.args.length > SLASH_MAX_ARGS) return 'وسائط الأمر طويلة جداً';
  if (CONTROL_RE.test(parsed.args)) return 'وسائط الأمر تحتوي محارف غير مسموحة';
  return null;
}

/** Arabic one-liner per command, for `/help` and the HUD hint line. */
export function describeSlashCommands(): string[] {
  return SLASH_COMMANDS.map((c) => `/${c.name} — ${c.description}`);
}
