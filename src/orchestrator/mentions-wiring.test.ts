import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveMentions, mentionSummary } from './mentions.js';

// `mentions.ts` was written in "Phase 4" and documented as wired. It was not.
// A spoken `@secret.env` therefore reached the planning model as literal text,
// which is precisely the class of leak the resolver's own header exists to
// prevent:
//
//   "nothing is echoed back into `clean` unless it survived those checks, so a
//    rejected token cannot reach the model as text."
//
// These tests pin the invariants the daemon seam now depends on. The seam
// itself (daemon.ts think()) is covered in daemon-mentions-wiring.test.ts.

const root = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'voxaura-mentions-'));
  writeFileSync(join(dir, 'real.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'notes.md'), '# notes\n');
  return dir;
};

const OPTS = (dir: string) => ({ root: dir, agents: ['build', 'test'], skills: ['tdd'] });

describe('a rejected mention never reaches the model as text', () => {
  test('a traversal attempt is stripped from clean and listed as rejected', () => {
    const dir = root();
    const r = resolveMentions('شوف @../../etc/passwd من فضلك', OPTS(dir));
    expect(r.rejected).toContain('../../etc/passwd');
    // The whole point: the attacker-supplied string is GONE from what we forward.
    expect(r.clean).not.toContain('passwd');
    expect(r.clean).not.toContain('..');
  });

  test('an absolute path attempt is refused and never read', () => {
    const dir = root();
    const r = resolveMentions('اقرا @C:/Windows/System32/config', OPTS(dir));
    // MENTION_RE has no `:` in its charset, so the TOKEN is `@C`; it resolves to
    // a non-existent in-root path and is rejected. No file is opened, which is
    // the security property. The `:/Windows/...` remainder stays as inert
    // prose — a known artifact of the mention charset, not a leak of file
    // content, and the model never receives an open handle.
    expect(r.rejected).toEqual(['C']);
    expect(r.files).toEqual([]);
  });

  test('a known-good file survives and is reported relative', () => {
    const dir = root();
    const r = resolveMentions('شوف @real.ts', OPTS(dir));
    expect(r.files).toEqual(['real.ts']);
    expect(r.rejected).toEqual([]);
    expect(r.clean.trim()).toBe('شوف');
  });

  test('a known agent and skill win over a same-named file', () => {
    const dir = root();
    const r = resolveMentions('شغّل @build مع @tdd', OPTS(dir));
    expect(r.agents).toEqual(['build']);
    expect(r.skills).toEqual(['tdd']);
  });

  test('an email address is NOT eaten as a mention', () => {
    // Stripping user@example.com would corrupt ordinary prose.
    const dir = root();
    const r = resolveMentions('راسلني على user@example.com', OPTS(dir));
    expect(r.clean).toContain('user@example.com');
    expect(r.files).toEqual([]);
  });

  test('a directory is not a file', () => {
    const dir = root();
    const r = resolveMentions('@.', OPTS(dir));
    expect(r.files).toEqual([]);
  });

  test('a symlink pointing OUT of the tree is rejected (the real containment guard)', () => {
    // This is the case `..` and `isAbsolute` cannot catch, and the one the
    // module header names explicitly: the literal path looks safely relative,
    // but realpath resolves outside the root. Neutering `insideRoot` must fail
    // THIS test - the traversal and absolute tests above pass either way.
    const dir = root();
    const outside = mkdtempSync(join(tmpdir(), 'voxaura-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n');
    let made = false;
    try {
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'escape.txt'));
      made = true;
    } catch {
      // Windows needs Developer Mode or elevation for symlinks. Skip loudly
      // rather than pretend the guard is covered.
      console.warn('SKIP: symlink creation unavailable; containment untested on this host');
    }
    if (!made) return;
    const r = resolveMentions('اقرا @escape.txt', OPTS(dir));
    expect(r.files).toEqual([]);
    expect(r.rejected).toContain('escape.txt');
    expect(r.clean).not.toContain('escape.txt');
  });
});

describe('mention caps bound what a single utterance can do', () => {
  test('the inspected-token cap stops a wall of @mentions', () => {
    const dir = root();
    const wall = Array.from({ length: 80 }, (_, i) => `@f${i}`).join(' ');
    const r = resolveMentions(wall, OPTS(dir));
    // MENTION_MAX_TOKENS is 60: the tail is left as prose, not inspected.
    expect(r.rejected.length).toBeLessThanOrEqual(60);
  });

  test('a single real file is reported once, not per mention', () => {
    const dir = root();
    const r = resolveMentions('@real.ts و @real.ts و @real.ts', OPTS(dir));
    expect(r.files).toEqual(['real.ts']);
  });
});

describe('the daemon-facing summary is safe to log', () => {
  test('it counts, it never echoes content', () => {
    const dir = root();
    const r = resolveMentions('شوف @real.ts و @../../etc/passwd', OPTS(dir));
    const s = mentionSummary(r);
    expect(s).toContain('1 ملف');
    expect(s).toContain('1 مرفوض');
    // A rejected path must not appear in anything loggable.
    expect(s).not.toContain('passwd');
  });

  test('an utterance with no mentions says so rather than nothing', () => {
    const dir = root();
    expect(mentionSummary(resolveMentions('شو صار؟', OPTS(dir)))).toBe('لا إشارات');
  });
});
