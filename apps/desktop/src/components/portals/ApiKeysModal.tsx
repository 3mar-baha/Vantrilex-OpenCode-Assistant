import { useRef, useState } from 'react';
import { PortalShell } from './PortalShell.js';

// Mandatory 3-key intake. Hardened shape: inputs are UNCONTROLLED, so secret
// strings never enter React state and never serialize into markup — only
// presence booleans are tracked. Values are read from refs exactly once, on
// Save, and leave the renderer via onSave over the localhost bridge. Save is
// fail-closed: disabled until Groq + Fish + OpenRouter are all non-empty.
export interface ApiKeyBundle {
  readonly groq: string;
  readonly fish: string;
  readonly openrouter: string;
}

export interface ApiKeysModalProps {
  readonly onSave: (keys: ApiKeyBundle) => void;
  readonly onClose: () => void;
  readonly saving?: boolean;
  readonly saveError?: string | undefined;
}

const FIELDS = [
  { id: 'groq', label: 'مفتاح Groq', hint: 'مطلوب لـ Whisper STT' },
  { id: 'fish', label: 'مفتاح Fish Audio', hint: 'مطلوب لـ Kareem و Nour TTS' },
  { id: 'openrouter', label: 'مفتاح OpenRouter', hint: 'مطلوب لـ Dots3 و Nemotron و Inkling' },
] as const;

type FieldId = (typeof FIELDS)[number]['id'];

export function ApiKeysModal({ onSave, onClose, saving = false, saveError }: ApiKeysModalProps): JSX.Element {
  const refs: Record<FieldId, React.RefObject<HTMLInputElement>> = {
    groq: useRef<HTMLInputElement>(null),
    fish: useRef<HTMLInputElement>(null),
    openrouter: useRef<HTMLInputElement>(null),
  };
  const [present, setPresent] = useState<Record<FieldId, boolean>>({ groq: false, fish: false, openrouter: false });
  const [revealed, setRevealed] = useState<Record<FieldId, boolean>>({ groq: false, fish: false, openrouter: false });
  const complete = present.groq && present.fish && present.openrouter;

  const read = (id: FieldId): string => refs[id].current?.value.trim() ?? '';

  return (
    <PortalShell label="مفاتيح الـ API" onClose={onClose}>
      <p data-testid="apikey-banner" role="alert">
        يرجى إدخال جميع المفاتيح الثلاثة المطلوبة (Groq, Fish Audio, OpenRouter) لتفعيل النظام / All 3 API
        keys are required to activate Voxaura
      </p>
      {FIELDS.map((f) => (
        <div key={f.id}>
          <label htmlFor={`apikey-${f.id}`}>
            {f.label} <span>{f.hint}</span>
          </label>
          <input
            id={`apikey-${f.id}`}
            data-testid={`apikey-${f.id}`}
            ref={refs[f.id]}
            type={revealed[f.id] ? 'text' : 'password'}
            defaultValue=""
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setPresent((s) => ({ ...s, [f.id]: e.target.value.trim().length > 0 }))}
          />
          <button
            data-testid={`toggle-${f.id}`}
            aria-label={`إظهار أو إخفاء ${f.label}`}
            aria-pressed={revealed[f.id]}
            onClick={() => setRevealed((s) => ({ ...s, [f.id]: !s[f.id] }))}
          >
            {revealed[f.id] ? 'إخفاء' : 'إظهار'}
          </button>
          <span data-testid={`badge-${f.id}`} aria-live="polite">
            {present[f.id] ? 'موجود' : 'مفقود'}
          </span>
        </div>
      ))}
      {saveError !== undefined && (
        <p data-testid="apikey-error" role="alert">
          {saveError}
        </p>
      )}
      <button
        data-testid="apikey-save"
        disabled={!complete || saving}
        onClick={() => {
          const keys = { groq: read('groq'), fish: read('fish'), openrouter: read('openrouter') };
          if (keys.groq.length > 0 && keys.fish.length > 0 && keys.openrouter.length > 0) onSave(keys);
        }}
      >
        {saving ? 'جارٍ الحفظ…' : 'حفظ وتفعيل'}
      </button>
    </PortalShell>
  );
}
