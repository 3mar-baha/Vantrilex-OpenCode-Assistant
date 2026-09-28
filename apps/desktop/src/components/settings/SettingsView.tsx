import { useEffect, useRef, useState } from 'react';
import { VoxauraBridge } from '../../bridge/ws.js';
import { resolveIpcToken } from '../../settings/ipc-token.js';
import { useAutoSize } from '../../window/useAutoSize.js';
import { closeCurrentWindow } from '../../window/close-current-window.js';

// SettingsView — the general settings window surface (?view=settings).
// Credentials live in the dedicated keys window (?view=keys); this surface owns
// models/skills/voice/system. It keeps its own WS-4097 link for persona changes.
export interface ChainEntry {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

export interface SettingsViewProps {
  readonly chain: readonly ChainEntry[];
  readonly initialPersona?: 'kareem' | 'nour';
}

type TabId = 'models' | 'skills' | 'voice' | 'system';

const TABS: ReadonlyArray<{ id: TabId; title: string; tip: string }> = [
  { id: 'models', title: 'النماذج والوكلاء', tip: 'سلسلة الوكلاء والنماذج النشطة' },
  { id: 'skills', title: 'المهارات والـ MCP', tip: 'المهارات وخوادم MCP المتصلة' },
  { id: 'voice', title: 'الصوت والشخصيات', tip: 'اختيار شخصية الصوت كريم أو نور' },
  { id: 'system', title: 'النظام والخزنة', tip: 'حالة الخزنة والذاكرة والجسر' },
];

const MCP_SERVERS = ['sequential-thinking', 'memory', 'filesystem', 'github', 'context7', 'obsidian-vault'] as const;
const BRIDGE_SKILLS = ['mission-handoff', 'prompt-synthesis', 'vault-sync'] as const;

const MODEL_ROSTER = [
  { role: 'الاستقبال الحواري', slug: 'dots-studio/dots-3-note-preview:free' },
  { role: 'المنسق الرئيسي', slug: 'thinkingmachines/inkling:free' },
  { role: 'المنفذ داخل الجلسة', slug: 'thinkingmachines/inkling:free' },
  { role: 'STT', slug: 'whisper-large-v3-turbo (Groq)' },
  { role: 'TTS', slug: 's2.1-pro-free (Fish Audio)' },
] as const;

function nextCmdId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `cmd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export function SettingsView({ chain, initialPersona = 'kareem' }: SettingsViewProps): JSX.Element {
  const [tab, setTab] = useState<TabId>('models');
  const [persona, setPersona] = useState<'kareem' | 'nour'>(initialPersona);
  // L22: lets the hello/notice callbacks compare against the live value
  // without depending on `persona`, which would tear down and re-create the
  // bridge on every change and drop the connection mid-flight.
  //
  // Synced in an effect, not during render. Assigning a ref while rendering is
  // what `react(refs)` flags: the write is a side effect of a function that must
  // stay pure, and the React Compiler refuses to optimise a component that does
  // it. An effect runs after the persona commits, which is still long before any
  // inbound hello/notice frame can arrive — those come off the WebSocket.
  const personaRef = useRef(persona);
  useEffect(() => {
    personaRef.current = persona;
  }, [persona]);
  const [modelTarget, setModelTarget] = useState('');
  const [copied, setCopied] = useState(false);
  const bridgeRef = useRef<VoxauraBridge | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useAutoSize(rootRef, { minWidth: 560, minHeight: 460, maxWidth: 900, maxHeight: 1000, paddingX: 2, paddingY: 2 });

  useEffect(() => {
    let disposed = false;
    let client: VoxauraBridge | null = null;
    void resolveIpcToken().then((token) => {
      if (disposed || token === undefined) return;
      const b = new VoxauraBridge({
      token,
      contractVersion: '3.1.0',
      onHello: (h) => {
        // L22: adopt the daemon persona on connect. This window opens with
        // initialPersona defaulting to kareem, so without this it showed the
        // wrong persona whenever the HUD had already changed it.
        if (h.persona !== undefined && h.persona !== personaRef.current) {
          setPersona(h.persona);
        }
      },
      onNotice: (n) => {
        // L22: follow a persona change made in the HUD. Local state ONLY —
        // sending back would bounce the change between the two windows.
        if (n.code === 'persona-changed' && (n.detail === 'kareem' || n.detail === 'nour')) {
          if (n.detail !== personaRef.current) setPersona(n.detail);
        }
      },
      onEvent: () => undefined,
      onClose: () => undefined,
      onRefusal: () => undefined,
    });
      client = b;
      bridgeRef.current = b;
      b.connect();
    });
    return () => {
      disposed = true;
      client?.dispose();
      bridgeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void closeCurrentWindow();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const selectPersona = (id: 'kareem' | 'nour'): void => {
    setPersona(id);
    void bridgeRef.current?.sendCommand({ id: nextCmdId(), kind: 'setPersona', persona: id });
  };

  // Redacted diagnostics only — never key material.
  const copyDiagnostics = (): void => {
    const report = [
      'Voxaura diagnostics (redacted)',
      `persona: ${persona}`,
      `chain: ${chain.map((c) => c.name).join(' -> ')}`,
      `mcp: ${MCP_SERVERS.join(', ')}`,
      `skills: ${BRIDGE_SKILLS.join(', ')}`,
      `version: 0.5.0`,
    ].join('\n');
    void navigator.clipboard?.writeText(report).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      ref={rootRef}
      dir="rtl"
      data-testid="settings-view"
      className="flex w-full overflow-hidden bg-[#121316] text-[#f4f4f5]"
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
          <span className="vx-kbd ms-auto" title="إغلاق النافذة">
            Esc
          </span>
        </div>
        <nav className="flex flex-col p-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              data-testid={`tab-${t.id}`}
              title={t.tip}
              onClick={() => setTab(t.id)}
              className="vx-tab px-3 py-2 text-start text-sm hover:bg-[#1d1e23]"
            >
              {t.title}
            </button>
          ))}
        </nav>
        <div className="mt-auto border-t border-[#26282e] p-3">
          <button
            data-testid="copy-diagnostics"
            title="نسخ تشخيصات النظام (بدون مفاتيح)"
            onClick={copyDiagnostics}
            className="w-full rounded-[6px] border border-[#26282e] px-3 py-2 text-xs text-[#a1a1aa] hover:text-[#f4f4f5]"
          >
            {copied ? 'تم النسخ' : 'نسخ التشخيصات'}
          </button>
        </div>
      </aside>

      <section data-testid="settings-content" className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="max-w-[560px]">
          {tab === 'models' && (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">سلسلة الوكلاء النشطة</h2>
            <p className="text-sm text-[#a1a1aa]" title="وكلاء OpenCode v2">
              تعمل هذه السلسلة داخل جلسات OpenCode v2 حصراً.
            </p>
            <ul data-testid="chain-list" className="flex flex-wrap items-center gap-2">
              {chain.map((c) => (
                <li
                  key={c.id}
                  data-testid={`chain-${c.id}`}
                  title={`${c.name} — ${c.role}`}
                  className="rounded-[6px] border border-[#26282e] bg-[#18191d] px-3 py-2 text-sm"
                >
                  <span className="font-semibold">{c.name}</span>
                  <span className="text-[#a1a1aa]"> — {c.role}</span>
                </li>
              ))}
            </ul>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-[#a1a1aa]">
                  <th className="border-b border-[#26282e] px-2 py-2 text-start font-medium">الدور</th>
                  <th className="border-b border-[#26282e] px-2 py-2 text-start font-medium">Model</th>
                </tr>
              </thead>
              <tbody data-testid="model-roster">
                {MODEL_ROSTER.map((m) => (
                  <tr key={m.slug} title={m.slug}>
                    <td className="border-b border-[#26282e] px-2 py-2">{m.role}</td>
                    <td className="border-b border-[#26282e] px-2 py-2 font-mono text-[#a1a1aa]">{m.slug}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center gap-2">
              <input
                data-testid="model-input"
                value={modelTarget}
                onChange={(e) => setModelTarget(e.target.value)}
                placeholder="provider/model"
                title="معرّف النموذج بالصيغة provider/model"
                className="vx-input min-w-0 flex-1"
              />
              <button
                data-testid="switch-model"
                title="تعيين النموذج للجلسة النشطة"
                onClick={() => {
                  const target = modelTarget.trim();
                  if (target.length === 0) return;
                  void bridgeRef.current?.sendCommand({ id: nextCmdId(), kind: 'setSessionModel', model: target });
                  setModelTarget('');
                }}
                className="shrink-0 rounded-[6px] border border-[#3b82f6] px-3 py-2 text-sm text-[#f4f4f5] hover:bg-[#3b82f6]/10"
              >
                تبديل النموذج
              </button>
            </div>
          </div>
        )}

        {tab === 'skills' && (
          <div className="flex flex-col gap-6">
            <div>
              <h2 className="text-lg font-semibold">مهارات الجسر</h2>
              <ul data-testid="bridge-skills" className="mt-2 flex flex-wrap gap-2">
                {BRIDGE_SKILLS.map((s) => (
                  <li
                    key={s}
                    title={`مهارة: ${s}`}
                    className="rounded-[6px] border border-[#26282e] bg-[#18191d] px-3 py-1 font-mono text-xs text-[#a1a1aa]"
                  >
                    {s}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="text-lg font-semibold">خوادم MCP المتصلة</h2>
              <ul data-testid="mcp-servers" className="mt-2 flex flex-wrap gap-2">
                {MCP_SERVERS.map((s) => (
                  <li
                    key={s}
                    title={`خادم MCP: ${s}`}
                    className="rounded-[6px] border border-[#26282e] bg-[#18191d] px-3 py-1 font-mono text-xs text-[#a1a1aa]"
                  >
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
            <div role="radiogroup" aria-label="شخصية الصوت" data-testid="persona-group" className="flex gap-2">
              {(['kareem', 'nour'] as const).map((p) => (
                <button
                  key={p}
                  role="radio"
                  aria-checked={persona === p}
                  data-testid={`persona-${p}`}
                  title={p === 'kareem' ? 'كريم — الصوت الافتراضي' : 'نور — الصوت البديل'}
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
              {[
                ['الخزنة', 'vault/keyring.dat (AES-256-GCM)'],
                ['الذاكرة', 'vault/projects/voxaura · Obsidian MCP'],
                ['الجسر', 'WS-4097 · /v1/ui'],
                ['الإصدار', 'v0.5.0'],
              ].map(([k, v]) => (
                <li key={k} title={`${k}: ${v}`} className="flex items-center justify-between border-b border-[#26282e] pb-2">
                  <span className="text-[#a1a1aa]">{k}</span>
                  <span>{v}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-[#71717a]">
              المفاتيح تُدار من نافذة «مفاتيح الـ API» المنفصلة.
            </p>
          </div>
        )}
        </div>
      </section>
    </div>
  );
}