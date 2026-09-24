import { PERSONA_LABEL, PERSONA_VOICE, VOICE_IDS, type PersonaId, type VoiceId } from '../common/brands.js';
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

export function buildSettingsModal(
  settings: UiSettings,
  pools: Readonly<Record<'groq' | 'fish', { readonly keyCount: number }>>,
): SettingsModal {
  // Explicit order — never rely on Object.keys enumeration.
  const order: readonly PersonaId[] = ['kareem', 'nour'];
  const persona: PersonaOption[] = order.map((id) => ({
    id,
    label: PERSONA_LABEL[id],
    voice: PERSONA_VOICE[id],
    fishVoiceId: VOICE_IDS[PERSONA_VOICE[id]],
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
