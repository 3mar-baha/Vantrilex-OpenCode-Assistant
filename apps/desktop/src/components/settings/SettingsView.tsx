import { useEffect, useRef, useState } from 'react';
import { ApiKeysModal, type ApiKeyBundle } from '../portals/ApiKeysModal.js';
import { VoxauraBridge } from '../../bridge/ws.js';

// SettingsView — the dedicated settings window surface (?view=settings).
// Fills the native window; no HUD chrome. It owns its own WS-4097 connection
// so key saves and persona switches reach the daemon independently of the
// companion window. Latin technical tokens stay verbatim.
export interface ChainEntry {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

export interface SettingsViewProps {
  readonly chain: readonly ChainEntry[];
  readonly initialPersona?: 'kareem' | 'nour';
}

type TabId = 'keys' | 'models' | 'skills' | 'voice' | 'system';

const TABS: ReadonlyArray<{ id: TabId; title: string }> = [
  { id: 'keys', title: 'مفاتيح الـ API' },
  { id: 'models', title: 'النماذج والوكلاء' },
  { id: 'skills', title: 'المهارات والـ MCP' },
  { id: 'voice', title: 'الصوت والشخصيات' },
  { id: 'system', title: 'النظام والخزنة' },
];

const MCP_SERVERS = ['sequential-thinking', 'memory', 'filesystem', 'github', 'context7', 'obsidian-vault'] as const;
const BRIDGE_SKILLS = ['mission-handoff', 'prompt-synthesis', 'vault-sync'] as const;

const MODEL_ROSTER = [
  { role: 'الاستقبال الحواري', slug: 'dots-studio/dots-3-note-preview:free' },
  { role: 'المنسق الرئيسي', slug: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
  { role: 'المنفذ داخل الجلسة', slug: 'thinkingmachines/inkling:free' },
  { role: 'STT', slug: 'whisper-large-v3-turbo (Groq)' },
  { role: 'TTS', slug: 's2.1-pro-free (Fish Audio)' },
] as const;

function nextCmdId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `cmd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export function SettingsView({ chain, initialPersona = 'kareem' }: SettingsViewProps): JSX.Element {
  const [tab, setTab] = useState<TabId>('keys');
  const [persona, setPersona] = useState<'kareem' | 'nour'>(initialPersona);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const bridgeRef = useRef<VoxauraBridge | null>(null);

  useEffect(() => {
    const token = import.meta.env['VOICE_RUNTIME_IPC_TOKEN'] as string | undefined;
    if (typeof token !== 'string' || token.length === 0) return;
    const b = new VoxauraBridge({
      token,
      contractVersion: '3.1.0',
      onHello: () => undefined,
      onEvent: () => undefined,
      onClose: () => undefined,
      onRefusal: () => undefined,
    });
    bridgeRef.current = b;
    b.connect();
    return () => {
      b.dispose();
      bridgeRef.current = null;
    };
  }, []);

  const saveKeys = (keys: ApiKeyBundle): void => {
    const bridge = bridgeRef.current;
    if (bridge === null) {
      setSaveError('الخادم غير متصل — لم تُرسل المفاتيح');
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    void bridge
      .sendCommand({
        id: nextCmdId(),
        kind: 'saveApiKeys',
        groqKey: keys.groq,
        fishKey: keys.fish,
        openrouterKey: keys.openrouter,
      })
      .then((ok) => {
        setSaving(false);
        if (ok) setSavedAt(new Date().toLocaleTimeString('ar'));
        else setSaveError('رفض الخادم المفاتيح — الثلاثة مطلوبة');
      });
  };

  const selectPersona = (id: 'kareem' | 'nour'): void => {
    setPersona(id);
    void bridgeRef.current?.sendCommand({ id: nextCmdId(), kind: 'setPersona', persona: id });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      dir="rtl"
      data-testid="settings-view"
      className="flex h-screen w-screen overflow-hidden bg-[#121316] text-[#f4f4f5]"
      style={{ fontFamily: 'var(--vx-font)' }}
    >
      <aside
        role="tablist"
        aria-label="أقسام الإعدادات"
        data-testid="settings-tabs"
        className="flex w-56 shrink-0 flex-col border-e border-[#26282e] bg-[#18191d]"
      >
        <div className="flex items-center gap-2 border-b border-[#26282e] px-4 py-3">
          <span className="text-sm font-semibold">الإعدادات</span>
          <span className="vx-kbd ms-auto">Esc</span>
        </div>
        <nav className="flex flex-col p-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              data-testid={`tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className="vx-tab px-3 py-2 text-start text-sm hover:bg-[#1d1e23]"
            >
              {t.title}
            </button>
          ))}
        </nav>
      </aside>
      <section data-testid="settings-content" className="min-w-0 flex-1 overflow-y-auto p-6">
        {tab === 'keys' && (
          <div className="flex flex-col gap-4">
            <header className="flex items-baseline gap-3">
              <h2 className="text-lg font-semibold">مفاتيح الـ API</h2>
              <span className="text-sm text-[#a1a1aa]">مطلوبة لتفعيل النظام بالكامل</span>
            </header>
            <ApiKeysModal
              onSave={saveKeys}
              onClose={() => window.close()}
              saving={saving}
              saveError={saveError}
              embedded
            />
            {savedAt !== null && (
              <p data-testid="keys-saved" className="text-sm text-[#4ade80]">
                حُفظت المفاتيح في الخزنة المشفرة · {savedAt}
              </p>
            )}
          </div>
        )}

        {tab === 'models' && (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">سلسلة الوكلاء النشطة</h2>
            <p className="text-sm text-[#a1a1aa]">تعمل هذه السلسلة داخل جلسات OpenCode v2 حصراً.</p>
            <ul data-testid="chain-list" className="flex flex-wrap items-center gap-2">
              {chain.map((c) => (
                <li
                  key={c.id}
                  data-testid={`chain-${c.id}`}
                  className="rounded-[6px] border border-[#26282e] bg-[#18191d] px-3 py-2 text-sm"
                >
                  <span className="font-semibold">{c.name}</span>
                  <span className="text-[#a1a1aa]"> — {c.role}</span>
                </li>
              ))}
            </ul>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-start text-[#a1a1aa]">
                  <th className="border-b border-[#26282e] px-2 py-2 text-start font-medium">الدور</th>
                  <th className="border-b border-[#26282e] px-2 py-2 text-start font-medium">Model</th>
                </tr>
              </thead>
              <tbody data-testid="model-roster">
                {MODEL_ROSTER.map((m) => (
                  <tr key={m.slug}>
                    <td className="border-b border-[#26282e] px-2 py-2">{m.role}</td>
                    <td className="border-b border-[#26282e] px-2 py-2 font-mono text-[#a1a1aa]">{m.slug}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'skills' && (
          <div className="flex flex-col gap-6">
            <div>
              <h2 className="text-lg font-semibold">مهارات الجسر</h2>
              <ul data-testid="bridge-skills" className="mt-2 flex flex-wrap gap-2">
                {BRIDGE_SKILLS.map((s) => (
                  <li key={s} className="rounded-[6px] border border-[#26282e] bg-[#18191d] px-3 py-1 font-mono text-xs text-[#a1a1aa]">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="text-lg font-semibold">خوادم MCP المتصلة</h2>
              <ul data-testid="mcp-servers" className="mt-2 flex flex-wrap gap-2">
                {MCP_SERVERS.map((s) => (
                  <li key={s} className="rounded-[6px] border border-[#26282e] bg-[#18191d] px-3 py-1 font-mono text-xs text-[#a1a1aa]">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {tab === 'voice' && (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">شخصية الصوت</h2>
            <div role="radiogroup" aria-label="Voice persona" data-testid="persona-group" className="flex gap-2">
              {(['kareem', 'nour'] as const).map((p) => (
                <button
                  key={p}
                  role="radio"
                  aria-checked={persona === p}
                  data-testid={`persona-${p}`}
                  onClick={() => selectPersona(p)}
                  className={`rounded-[6px] border px-4 py-2 text-sm ${
                    persona === p
                      ? 'border-[#3b82f6] bg-[#3b82f6]/10 text-[#f4f4f5]'
                      : 'border-[#26282e] bg-[#18191d] text-[#a1a1aa]'
                  }`}
                >
                  {p === 'kareem' ? 'كريم' : 'نور'}
                </button>
              ))}
            </div>
            <p className="text-sm text-[#a1a1aa]">
              Whisper للاستماع · Fish Audio للنطق · تُدار عتبات الصمت من إعدادات الخادم.
            </p>
          </div>
        )}

        {tab === 'system' && (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">حالة النظام</h2>
            <ul className="flex flex-col gap-2 text-sm">
              <li className="flex items-center justify-between border-b border-[#26282e] pb-2">
                <span className="text-[#a1a1aa]">الخزنة</span>
                <span>vault/keyring.dat (AES-256-GCM)</span>
              </li>
              <li className="flex items-center justify-between border-b border-[#26282e] pb-2">
                <span className="text-[#a1a1aa]">الذاكرة</span>
                <span>vault/projects/voxaura · Obsidian MCP</span>
              </li>
              <li className="flex items-center justify-between border-b border-[#26282e] pb-2">
                <span className="text-[#a1a1aa]">الجسر</span>
                <span>WS-4097 · /v1/ui</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-[#a1a1aa]">الإصدار</span>
                <span>v0.2.0</span>
              </li>
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}