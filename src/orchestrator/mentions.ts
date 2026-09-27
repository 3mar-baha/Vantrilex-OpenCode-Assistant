import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';

// Phase 4 — the `@` mention resolver.
//
// Resolves `@file`, `@agent` and `@skill` tokens in user text into a validated
// set the dispatcher can attach as metadata.
//
// SECURITY: this turns arbitrary user text into filesystem reads handed to an
// agent, so the rules are deliberately strict:
//   * a mention must resolve to a real FILE (not a directory), inside the
//     project root, AFTER realpath — so a symlink pointing out of the tree is
//     rejected even though its literal path looks safely relative;
//   * a name that is not a known agent/skill and not a real in-project file is
//     REJECTED, never guessed;
//   * nothing is echoed back into `clean` unless it survived those checks, so
//     a rejected token cannot reach the model as text.
//
// The audit's point on this was that it also closes the old metacharacter
// guard's blind spots: `..` and absolute paths now have a home.

/** Cap so a single message cannot be used to enumerate a project tree. */
export const MENTION_MAX_FILES = 20;
/** Cap on how many tokens we even inspect. */
export const MENTION_MAX_TOKENS = 60;

export interface MentionOptions {
  /** Project root. Nothing outside it can ever be resolved. */
  readonly root: string;
  readonly agents: readonly string[];
  readonly skills: readonly string[];
}

export interface ResolvedMentions {
  /** Project-relative file paths, in order of appearance. */
  readonly files: readonly string[];
  readonly agents: readonly string[];
  readonly skills: readonly string[];
  /** Tokens that were not resolved, stripped from `clean`. */
  readonly rejected: readonly string[];
  /** The message with every mention token removed, or rejected ones removed. */
  readonly clean: string;
}

/**
 * A mention token: `@` then a run of path-ish characters, stopping at
 * whitespace and at Arabic/Latin punctuation that cannot appear in a path.
 */
const MENTION_RE = /@([\w.\-[\]/\\]+)/gu;

/** Punctuation that is prose rather than part of a path. */
const TRAILING_PUNCT = /[.,;:!?،؛؟]+$/u;

/** True when `candidate` is inside `root` after resolving symlinks. */
function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

export function resolveMentions(text: string, options: MentionOptions): ResolvedMentions {
  const files: string[] = [];
  const agents: string[] = [];
  const skills: string[] = [];
  const rejected: string[] = [];

  let root: string | null = null;
  try {
    root = realpathSync(options.root);
  } catch {
    root = null;
  }

  let inspected = 0;
  const clean = text.replace(MENTION_RE, (match: string, rawToken: string, offset: number) => {
    // An `@` glued to a word character is an email, not a mention. Stripping
    // `user@example.com` would silently corrupt ordinary prose.
    const prev = offset > 0 ? text.charAt(offset - 1) : '';
    if (/[\w@]/.test(prev)) return match;
    if (inspected >= MENTION_MAX_TOKENS) return match;
    inspected += 1;

    const stripped = rawToken.replace(TRAILING_PUNCT, '');
    // Trailing prose punctuation is not part of the path and must survive.
    const tail = rawToken.slice(stripped.length);
    if (stripped.length === 0) return match;
    const token = stripped;

    // 1. Known agent or skill wins over a same-named file.
    if (options.agents.includes(token)) {
      if (!agents.includes(token)) agents.push(token);
      return tail;
    }
    if (options.skills.includes(token)) {
      if (!skills.includes(token)) skills.push(token);
      return tail;
    }

    // 2. File. Absolute paths and traversal are refused outright, before any
    //    filesystem access, so a rejected token costs no syscall.
    if (root === null || isAbsolute(token) || token.includes('..')) {
      rejected.push(token);
      return tail;
    }

    const abs = resolvePath(root, token);
    if (!insideRoot(root, abs)) {
      rejected.push(token);
      return tail;
    }
    try {
      // realpath FIRST: this is what catches an in-tree symlink pointing out.
      const real = realpathSync(abs);
      if (!insideRoot(root, real) || !statSync(real).isFile()) {
        rejected.push(token);
        return tail;
      }
      if (files.length >= MENTION_MAX_FILES) {
        rejected.push(token);
        return tail;
      }
      // Report the path AS TYPED (posix-normalised), not the realpath: a
      // same-tree symlink is a legitimate way to refer to a file, and the
      // caller asked for that name. Containment was proven on `real`.
      const rel = toPosix(token);
      if (!files.includes(rel)) files.push(rel);
      return tail;
    } catch {
      rejected.push(token);
      return tail;
    }
  });

  return { files, agents, skills, rejected, clean: collapse(clean) };
}

/** Forward slashes regardless of platform: these travel to an agent, not a shell. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Tidy the gaps left by removed tokens without collapsing deliberate breaks. */
function collapse(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([،,.;:!?؟])/g, '$1')
    .trim();
}

/** Exposed for the daemon's log line: a stable, non-sensitive summary. */
export function mentionSummary(resolved: ResolvedMentions): string {
  const parts: string[] = [];
  if (resolved.files.length > 0) parts.push(`${resolved.files.length} ملف`);
  if (resolved.agents.length > 0) parts.push(`${resolved.agents.length} وكيل`);
  if (resolved.skills.length > 0) parts.push(`${resolved.skills.length} مهارة`);
  if (resolved.rejected.length > 0) parts.push(`${resolved.rejected.length} مرفوض`);
  return parts.length === 0 ? 'لا إشارات' : parts.join('، ');
}

/** `true` when the token contains a separator, i.e. it is a path not a name. */
export function looksLikePath(token: string): boolean {
  return token.includes('/') || token.includes(sep);
}
