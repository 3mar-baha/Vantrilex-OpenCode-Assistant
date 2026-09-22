import type { VoiceId } from '../common/brands.js';
import { TEST_SPEECH_PHRASE, type UiSettings } from './settings.js';

// Settings modal view-model — docs/02 §2.7. Pure data contract for the OpenCode
// surface renderer (right-click portal): sections, current values, and the action
// set. No DOM here — the native theme layer renders this model.
export interface ModalSection {
  readonly id: 'persona' | 'test-speech' | 'credentials';
  readonly title: string;
}

export interface PersonaOption {
  readonly id: VoiceId;
  readonly label: string;
  readonly fishVoiceId: string;
  readonly selected: boolean;
}

export interface SettingsModal {
  readonly sections: readonly ModalSection[];
  readonly persona: readonly PersonaOption[];
  readonly testSpeech: { readonly phrase: string; readonly voice: VoiceId };
  readonly credentialPools: Readonly<Record<'groq' | 'fish', { readonly keyCount: number }>>;
}

const FISH_IDS: Record<VoiceId, string> = {
  'male-default': '5b90451e0cd34b2788841744af7c55c3',
  'female-toggle': '88c0375e46fa4e3b929755fa077ca5ad',
};

export function buildSettingsModal(
  settings: UiSettings,
  pools: Readonly<Record<'groq' | 'fish', { readonly keyCount: number }>>,
): SettingsModal {
  const persona: PersonaOption[] = (Object.keys(FISH_IDS) as VoiceId[]).map((id) => ({
    id,
    label: id === 'male-default' ? 'Male (default)' : 'Female',
    fishVoiceId: FISH_IDS[id],
    selected: settings.voice === id,
  }));
  return {
    sections: [
      { id: 'persona', title: 'Voice persona (applies globally)' },
      { id: 'test-speech', title: 'Audition voice' },
      { id: 'credentials', title: 'Key pools (stored in vault, never shown)' },
    ],
    persona,
    testSpeech: { phrase: TEST_SPEECH_PHRASE, voice: settings.voice },
    credentialPools: pools,
  };
}
