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
  /** When embedded inside another dialog, render only the form (no shell). */
  readonly embedded?: boolean;
}

const FIELDS = [
  { id: 'groq', label: 'مفتاح Groq', hint: 'مطلوب لـ Whisper STT' },
  { id: 'fish', label: 'مفتاح Fish Audio', hint: 'مطلوب لـ Kareem و Nour TTS' },
  { id: 'openrouter', label: 'مفتاح OpenRouter', hint: 'مطلوب لـ Dots3 و Inkling' },
] as const;

type FieldId = (typeof FIELDS)[number]['id'];

export function ApiKeysModal({ onSave, onClose, saving = false, saveError, embedded = false }: ApiKeysModalProps): JSX.Element {
  const refs: Record<FieldId, React.RefObject<HTMLInputElement>> = {
    groq: useRef<HTMLInputElement>(null),
    fish: useRef<HTMLInputElement>(null),
    openrouter: useRef<HTMLInputElement>(null),
  };
  const [present, setPresent] = useState<Record<FieldId, boolean>>({ groq: false, fish: false, openrouter: false });
  // Presence is only meaningful once the operator has touched a field; before
  // that the badge stays neutral so a fresh window never reads as "missing".
  const [touched, setTouched] = useState<Record<FieldId, boolean>>({ groq: false, fish: false, openrouter: false });
  const [revealed, setRevealed] = useState<Record<FieldId, boolean>>({ groq: false, fish: false, openrouter: false });
  const complete = present.groq && present.fish && present.openrouter;

  const read = (id: FieldId): string => refs[id].current?.value.trim() ?? '';

  const form = (
    <>
      <p data-testid="apikey-banner" role="alert">
        يرجى إدخال جميع المفاتيح الثلاثة المطلوبة (Groq, Fish Audio, OpenRouter) لتفعيل النظام / All 3 API
        keys are required to activate Voxaura
      </p>
      {FIELDS.map((f) => (
        <div key={f.id} className="space-y-2 rounded-xl border border-slate-700/60 bg-slate-900/50 p-4">
          <label htmlFor={`apikey-${f.id}`} className="block text-base font-semibold text-slate-100">
            {f.label} <span className="block text-sm font-normal text-slate-400">{f.hint}</span>
          </label>
          <div className="flex items-center gap-2">
            <input
              id={`apikey-${f.id}`}
              data-testid={`apikey-${f.id}`}
              ref={refs[f.id]}
              type={revealed[f.id] ? 'text' : 'password'}
              defaultValue=""
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setPresent((s) => ({ ...s, [f.id]: e.target.value.trim().length > 0 }));
                setTouched((s) => (s[f.id] ? s : { ...s, [f.id]: true }));
              }}
              className="min-w-0 flex-1 bg-slate-800/80 border border-slate-700 text-slate-100 px-4 py-2.5 rounded-xl placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
            />
            <button
              data-testid={`toggle-${f.id}`}
              aria-label={`إظهار أو إخفاء ${f.label}`}
              aria-pressed={revealed[f.id]}
              onClick={() => setRevealed((s) => ({ ...s, [f.id]: !s[f.id] }))}
              className="shrink-0 rounded-xl border border-slate-700 px-3 py-2.5 text-sm text-slate-200 hover:bg-slate-800"
            >
              {revealed[f.id] ? 'إخفاء' : 'إظهار'}
            </button>
            <span data-testid={`badge-${f.id}`} aria-live="polite" className="shrink-0 text-sm text-slate-300">
              {touched[f.id] ? (present[f.id] ? 'موجود' : 'مفقود') : '—'}
            </span>
          </div>
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
        className="w-full rounded-xl bg-sky-600 px-4 py-3 text-base font-bold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving ? 'جارٍ الحفظ…' : 'حفظ وتفعيل'}
      </button>
    </>
  );

  if (embedded) return form;
  return (
    <PortalShell label="مفاتيح الـ API" onClose={onClose}>
      {form}
    </PortalShell>
  );
}
