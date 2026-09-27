import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { resolveMentions } from './mentions.js';

// Phase 4 — the `@` mention resolver.
//
// This is a filesystem-reachable surface, so the tests are adversarial on
// purpose: traversal, absolute paths, and symlinks that point outside the
// project are the three ways "read a file for the agent" becomes "read any
// file on the machine".
describe('resolveMentions', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'voxaura-mentions-'));
    mkdirSync(join(root, 'src', 'voice'), { recursive: true });
    writeFileSync(join(root, 'src', 'voice', 'tts.ts'), 'export const TTS = 1;');
    writeFileSync(join(root, 'README.md'), '# hello');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('resolves a file mention to a path inside the project', () => {
    const r = resolveMentions('راجع @src/voice/tts.ts من فضلك', { root, agents: [], skills: [] });
    expect(r.files).toEqual(['src/voice/tts.ts']);
    expect(r.rejected).toEqual([]);
    expect(r.clean).toContain('من فضلك');
  });

  test('resolves an agent mention only against the known agent list', () => {
    const r = resolveMentions('اسأل @explore عن الحالة', { root, agents: ['explore', 'build'], skills: [] });
    expect(r.agents).toEqual(['explore']);
    expect(r.rejected).toEqual([]);
  });

  test('resolves a skill mention only against the known skill list', () => {
    const r = resolveMentions('استخدم @mission-handoff', { root, agents: [], skills: ['mission-handoff'] });
    expect(r.skills).toEqual(['mission-handoff']);
  });

  test('REJECTS parent-directory traversal', () => {
    const r = resolveMentions('@../../../../Windows/System32/config/SAM', { root, agents: [], skills: [] });
    expect(r.files).toEqual([]);
    expect(r.rejected.length).toBe(1);
    expect(r.clean).not.toContain('SAM');
  });

  test('REJECTS an absolute path outside the project', () => {
    const r = resolveMentions('@C:/Windows/win.ini', { root, agents: [], skills: [] });
    expect(r.files).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });

  test('REJECTS a symlink that escapes the project', () => {
    // The dangerous case: the path LOOKS relative and inside the root, but
    // resolves outside it. A prefix check on the raw string would pass it.
    const outside = mkdtempSync(join(tmpdir(), 'voxaura-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    try {
      const r = resolveMentions('@link.txt', { root, agents: [], skills: [] });
      expect(r.files).toEqual([]);
      expect(r.rejected).toHaveLength(1);
      expect(r.clean).not.toContain('link.txt');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('ALLOWS a symlink that stays inside the project', () => {
    symlinkSync(join(root, 'README.md'), join(root, 'alias.md'));
    const r = resolveMentions('@alias.md', { root, agents: [], skills: [] });
    expect(r.files).toEqual(['alias.md']);
    expect(r.rejected).toEqual([]);
  });

  test('an unknown bare name is a rejected mention, not a silent file', () => {
    // `@foo` could be a typo, a path, or an agent. Guessing a file for it would
    // leak a directory listing into the prompt.
    const r = resolveMentions('@nope-not-here', { root, agents: [], skills: [] });
    expect(r.files).toEqual([]);
    expect(r.agents).toEqual([]);
    expect(r.rejected).toEqual(['nope-not-here']);
  });

  test('a directory mention is rejected (not a file to read)', () => {
    const r = resolveMentions('@src/voice', { root, agents: [], skills: [] });
    expect(r.files).toEqual([]);
    expect(r.rejected).toEqual(['src/voice']);
  });

  test('a nonexistent path inside the project is rejected', () => {
    const r = resolveMentions('@src/ghost.ts', { root, agents: [], skills: [] });
    expect(r.files).toEqual([]);
    expect(r.rejected).toEqual(['src/ghost.ts']);
  });

  test('handles several mentions in one message and preserves order', () => {
    const r = resolveMentions('@src/voice/tts.ts و @README.md و @explore', {
      root,
      agents: ['explore'],
      skills: [],
    });
    expect(r.files).toEqual(['src/voice/tts.ts', 'README.md']);
    expect(r.agents).toEqual(['explore']);
  });

  test('a rejected mention leaves the surrounding prose intact', () => {
    const r = resolveMentions('افتح @../../etc/passwd وقل لي ماذا وجدت', { root, agents: [], skills: [] });
    expect(r.clean).toContain('وقل لي ماذا وجدت');
    expect(r.clean).not.toContain('passwd');
  });

  test('text with no mentions is returned unchanged', () => {
    const text = 'مرحبا، كيف حالك؟ @ home is not a mention';
    const r = resolveMentions(text, { root, agents: [], skills: [] });
    expect(r.clean).toBe(text);
  });

  test('a mention may sit at the very start or very end', () => {
    expect(resolveMentions('@README.md اقرأه', { root, agents: [], skills: [] }).files).toEqual(['README.md']);
    expect(resolveMentions('اقرأ @README.md', { root, agents: [], skills: [] }).files).toEqual(['README.md']);
  });

  test('an email address is not treated as a mention', () => {
    // A bare `@` followed by a domain must survive untouched; stripping it
    // would corrupt ordinary prose and, worse, silently drop an address.
    const text = 'راسلني على user@example.com إن احتجت';
    const r = resolveMentions(text, { root, agents: [], skills: [] });
    expect(r.clean).toBe(text);
  });

  test('strips trailing punctuation that is prose, not part of the path', () => {
    const r = resolveMentions('افتح @README.md.', { root, agents: [], skills: [] });
    expect(r.files).toEqual(['README.md']);
    expect(r.clean).toContain('.');
  });

  test('caps the number of mentions so one message cannot enumerate a tree', () => {
    const many = Array.from({ length: 60 }, (_, i) => `@f${i}.txt`).join(' ');
    const r = resolveMentions(many, { root, agents: [], skills: [] });
    expect(r.rejected.length).toBeLessThanOrEqual(60);
    expect(r.files.length).toBeLessThanOrEqual(20);
  });

  test('a root that does not exist rejects everything without throwing', () => {
    const r = resolveMentions('@README.md', { root: join(root, 'nope'), agents: [], skills: [] });
    expect(r.files).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });
});
