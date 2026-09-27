import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MicControl } from './mic.js';
import { buildSettingsModal } from './modal.js';
import { decideSpeech, SettingsStore, type SpeechEnvironment } from './settings.js';

const baseEnv: SpeechEnvironment = {
  mic: { captureLive: true, briefingsLive: true },
  fullscreenApp: false,
  meetingMicInUse: false,
  doNotDisturb: false,
  terminalFocused: false,
  elapsedMs: 120_000,
  tier: 'T1',
};

describe('mic control (FR-11)', () => {
  test('default Armed; toggle flips; mute-listen keeps briefings live', () => {
    const mic = new MicControl();
    expect(mic.current).toBe('armed');
    expect(mic.captureLive).toBe(true);
    expect(mic.toggleArmed()).toBe('disarmed');
    expect(mic.briefingsLive).toBe(false);
    expect(mic.setMuteListen(true)).toBe('mute-listen');
    expect(mic.captureLive).toBe(false);
    expect(mic.briefingsLive).toBe(true);
  });

  test('state persists across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mic-'));
    new MicControl(dir).toggleArmed();
    expect(new MicControl(dir).current).toBe('disarmed');
    expect(JSON.parse(readFileSync(join(dir, 'mic-state.json'), 'utf8') as string)).toEqual({ mode: 'disarmed' });
  });
});

describe('speech policy (C2/C10, zero-focus proof)', () => {
  test('short foreground run stays silent; T2 always speaks', () => {
    expect(decideSpeech({ ...baseEnv, elapsedMs: 30_000, terminalFocused: true }))
      .toEqual({ speak: false, fallback: 'silent' });
    expect(decideSpeech({ ...baseEnv, elapsedMs: 30_000, terminalFocused: true, tier: 'T2' }).speak).toBe(true);
  });

  test('meeting/DND mutes to notification; fullscreen ducks', () => {
    expect(decideSpeech({ ...baseEnv, meetingMicInUse: true }))
      .toEqual({ speak: false, fallback: 'notification' });
    expect(decideSpeech({ ...baseEnv, doNotDisturb: true }).speak).toBe(false);
    expect(decideSpeech({ ...baseEnv, fullscreenApp: true }))
      .toEqual({ speak: true, ducked: true });
  });

  test('disarmed mic silences everything', () => {
    const env: SpeechEnvironment = {
      ...baseEnv, tier: 'T2', mic: { captureLive: false, briefingsLive: false },
    };
    expect(decideSpeech(env)).toEqual({ speak: false, fallback: 'silent' });
  });
});

describe('settings store + modal', () => {
  test('persona applies globally and persists; modal reflects selection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-'));
    const store = new SettingsStore(dir);
    expect(store.current.persona).toBe('kareem');
    expect(store.current.voice).toBe('male-default');
    store.update({ persona: 'nour' });
    expect(new SettingsStore(dir).current.persona).toBe('nour');
    // Persona is the source of truth: voice follows it.
    expect(new SettingsStore(dir).current.voice).toBe('female-toggle');
    const modal = buildSettingsModal(store.current, { groq: { keyCount: 3 }, fish: { keyCount: 2 } });
    expect(modal.sections.map((s) => s.id)).toEqual(['identity', 'audio', 'bridge', 'keyring', 'system']);
    expect(modal.persona.find((p) => p.selected)?.id).toBe('nour');
    expect(modal.persona.find((p) => p.id === 'kareem')?.fishVoiceId).toBe('5b90451e0cd34b2788841744af7c55c3');
    expect(modal.testSpeech.phrase.length).toBeGreaterThan(0);
    expect(modal.credentialPools.groq.keyCount).toBe(3);
  });

  test('corrupt ui-settings.json falls back to defaults (disk is untrusted)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-'));
    writeFileSync(join(dir, 'ui-settings.json'), JSON.stringify({ persona: 'x', voice: 99 }));
    const loaded = new SettingsStore(dir);
    expect(loaded.current.persona).toBe('kareem');
    expect(loaded.current.voice).toBe('male-default');
  });

  test('lone voice patch reverse-maps to its persona', () => {
    const store = new SettingsStore();
    store.update({ voice: 'female-toggle' });
    expect(store.current.persona).toBe('nour');
  });
});
