import { PERSONA_LABEL, PERSONA_VOICE, type PersonaId, type VoiceId } from '../common/brands.js';
import { TEST_SPEECH_PHRASE, type UiSettings } from './settings.js';

// Settings modal view-model — docs/02 §2.7, ADR-010 (O4 remediation). Pure data
// contract for the Voxaura surface renderer (floating portals): five tab
// sections, Kareem/Nour persona options, and the action set. No DOM here —
// the native theme layer renders this model.
export type ModalTabId = 'identity' | 'audio' | 'bridge' | 'keyring' | 'system';

export interface ModalSection {
  readonly id: ModalTabId;
  readonly title: string;
}

export interface PersonaOption {
  readonly id: PersonaId;
  readonly label: string;
  readonly voice: VoiceId;
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
  const persona: PersonaOption[] = (Object.keys(PERSONA_VOICE) as PersonaId[]).map((id) => ({
    id,
    label: PERSONA_LABEL[id],
    voice: PERSONA_VOICE[id],
    fishVoiceId: FISH_IDS[PERSONA_VOICE[id]],
    selected: settings.persona === id,
  }));
  return {
    sections: [
      { id: 'identity', title: 'Persona (Kareem / Nour)' },
      { id: 'audio', title: 'Audio & hardware' },
      { id: 'bridge', title: 'OpenCode bridge' },
      { id: 'keyring', title: 'Key pools (stored in vault, never shown)' },
      { id: 'system', title: 'System & telemetry' },
    ],
    persona,
    testSpeech: { phrase: TEST_SPEECH_PHRASE, voice: settings.voice },
    credentialPools: pools,
  };
}
