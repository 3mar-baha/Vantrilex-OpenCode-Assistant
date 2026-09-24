import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERSONA_VOICE, type PersonaId, type VoiceId } from '../common/brands.js';

// Speech policy — docs/02 §2.2/C2/C10. Single decision point answering "may the
// daemon speak right now?" Fullscreen gaming → ducked speech; active meeting mic
// or DND → silent + desktop notification; Disarmed → silent entirely.
export interface SpeechEnvironment {
  readonly mic: { captureLive: boolean; briefingsLive: boolean };
  readonly fullscreenApp: boolean;
  readonly meetingMicInUse: boolean;
  readonly doNotDisturb: boolean;
  readonly terminalFocused: boolean;
  readonly elapsedMs: number;
  readonly tier: 'T1' | 'T2';
}

export type SpeechVerdict =
  | { readonly speak: true; readonly ducked: boolean }
  | { readonly speak: false; readonly fallback: 'notification' | 'silent' };

export function decideSpeech(env: SpeechEnvironment): SpeechVerdict {
  if (!env.mic.briefingsLive) return { speak: false, fallback: 'silent' };
  if (env.meetingMicInUse || env.doNotDisturb) return { speak: false, fallback: 'notification' };
  if (env.tier === 'T2') {
    return env.fullscreenApp ? { speak: true, ducked: true } : { speak: true, ducked: false };
  }
  if (env.elapsedMs < 60_000 && env.terminalFocused) return { speak: false, fallback: 'silent' };
  return { speak: true, ducked: env.fullscreenApp };
}

// Settings store — docs/02 §2.7 modal. Persona + UX prefs persist as JSON;
// credential pools NEVER persist here — they flow exclusively to the vault.
// `persona` (Kareem/Nour, ADR-010) is the source of truth; `voice` follows it
// and is retained for transport compatibility.
export interface UiSettings {
  persona: PersonaId;
  voice: VoiceId;
  captureMode: 'push-to-talk' | 'wake-word';
  briefings: 'bluf' | 'full';
  quietHours: string;
  muteOnCall: boolean;
}

export const DEFAULT_SETTINGS: UiSettings = {
  persona: 'kareem',
  voice: 'male-default',
  captureMode: 'push-to-talk',
  briefings: 'bluf',
  quietHours: '22:00-07:00',
  muteOnCall: true,
};

export const TEST_SPEECH_PHRASE = 'أمورك تمام، هذا اختبار الصوت';

export class SettingsStore {
  private settings: UiSettings;

  constructor(private readonly dir?: string) {
    this.settings = { ...DEFAULT_SETTINGS };
    if (dir !== undefined) {
      const path = join(dir, 'ui-settings.json');
      if (existsSync(path)) {
        try {
          const parsed = JSON.parse(readFileSync(path, 'utf8') as string) as Partial<UiSettings>;
          this.settings = { ...DEFAULT_SETTINGS, ...parsed };
        } catch {
          this.settings = { ...DEFAULT_SETTINGS };
        }
      }
    }
  }

  get current(): UiSettings {
    return { ...this.settings };
  }

  update(patch: Partial<UiSettings>): UiSettings {
    this.settings = { ...this.settings, ...patch };
    // Persona wins: a persona change re-keys the transport voice so the two
    // can never disagree. A lone voice patch is honored but persona stays.
    if (patch.persona !== undefined) {
      this.settings = { ...this.settings, voice: PERSONA_VOICE[patch.persona] };
    }
    if (this.dir !== undefined) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, 'ui-settings.json'), JSON.stringify(this.settings));
    }
    return this.current;
  }
}
