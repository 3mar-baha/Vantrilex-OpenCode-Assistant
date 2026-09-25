import { useState } from 'react';
import { ApiKeysModal, type ApiKeyBundle } from './ApiKeysModal.js';
import { PortalShell } from './PortalShell.js';

// Large square settings dialog with sidebar tabs. Arabic-first copy; technical
// tokens (API, MCP, model/agent ids) stay Latin verbatim. The API-keys tab
// reuses the mandatory 3-key intake; models shows the static 3-agent roster;
// system surfaces only daemon-reported facts, never fabricated counts.
export interface ChainEntry {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

export interface SettingsDialogProps {
  readonly onClose: () => void;
  readonly keysSaving: boolean;
  readonly keysError: string | undefined;
  readonly onSaveKeys: (keys: ApiKeyBundle) => void;
  readonly chain: readonly ChainEntry[];
  readonly activeModel: string | null;
  readonly agents: readonly { id: string; name: string }[];
  readonly onSelectAgent: (id: string) => void;
  readonly persona: 'kareem' | 'nour';
  readonly onSelectPersona: (id: 'kareem' | 'nour') => void;
  readonly bridgeStatus: string;
}

type TabId = 'keys' | 'models' | 'skills' | 'voice' | 'system';

const TABS: ReadonlyArray<{ id: TabId; title: string }> = [
  { id: 'keys', title: '🔑 مفاتيح الـ API' },
  { id: 'models', title: '🤖 النماذج والوكلاء' },
  { id: 'skills', title: '⚡ المهارات والـ MCP' },
  { id: 'voice', title: '🎙️ الصوت والشخصيات' },
  { id: 'system', title: '🛡️ النظام والخزنة' },
];

const MCP_SERVERS = ['sequential-thinking', 'memory', 'filesystem', 'github', 'context7', 'obsidian-vault'] as const;
const BRIDGE_SKILLS = ['mission-handoff', 'prompt-synthesis', 'vault-sync'] as const;

export function SettingsDialog(props: SettingsDialogProps): JSX.Element {
  const [tab, setTab] = useState<TabId>('keys');
  return (
    <PortalShell label="الإعدادات" onClose={props.onClose}>
      <div
        data-testid="settings-dialog"
        role="dialog"
        aria-label="إعدادات Voxaura"
        className="w-[680px] h-[580px] max-w-[90vw] max-h-[85vh] rounded-2xl shadow-2xl backdrop-blur-xl bg-[#0f172a]/95 border border-slate-700/80"
      >
        <div role="tablist" aria-label="أقسام الإعدادات" data-testid="settings-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              data-testid={`tab-${t.id}`}
              onClick={() => setTab(t.id)}
            >
              {t.title}
            </button>
          ))}
        </div>
        <div data-testid="settings-content">
          {tab === 'keys' && (
            <ApiKeysModal
              onSave={props.onSaveKeys}
              onClose={props.onClose}
              saving={props.keysSaving}
              saveError={props.keysError}
            />
          )}
          {tab === 'models' && (
            <div>
              <h3>سلسلة الوكلاء النشطة</h3>
              <p>تعمل هذه السلسلة داخل جلسات OpenCode v2 حصراً.</p>
              <ul data-testid="chain-list">
                {props.chain.map((c) => (
                  <li key={c.id} data-testid={`chain-${c.id}`}>
                    {c.name} — {c.role}
                  </li>
                ))}
              </ul>
              <p data-testid="active-model">
                النموذج النشط: {props.activeModel ?? 'غير معيّن'}
              </p>
              {props.agents.length > 0 && (
                <div role="group" aria-label="Session model picker">
                  {props.agents.map((a) => (
                    <button key={a.id} data-testid={`pick-agent-${a.id}`} onClick={() => props.onSelectAgent(a.id)}>
                      {a.name}
                    </button>
                  ))}
                </div>
              )}
              <p>مخزون الجلسات المباشر، حالة الجسر WS-4097، وإيصالات JSON — والتوجيه عبر MCP.</p>
            </div>
          )}
          {tab === 'skills' && (
            <div>
              <h3>مهارات الجسر</h3>
              <ul data-testid="bridge-skills">
                {BRIDGE_SKILLS.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              <h3>خوادم MCP المتصلة</h3>
              <ul data-testid="mcp-servers">
                {MCP_SERVERS.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {tab === 'voice' && (
            <div>
              <h3>شخصية الصوت</h3>
              <div role="radiogroup" aria-label="Voice persona" data-testid="persona-group">
                <button
                  role="radio"
                  aria-checked={props.persona === 'kareem'}
                  data-testid="persona-kareem"
                  onClick={() => props.onSelectPersona('kareem')}
                >
                  كريم
                </button>
                <button
                  role="radio"
                  aria-checked={props.persona === 'nour'}
                  data-testid="persona-nour"
                  onClick={() => props.onSelectPersona('nour')}
                >
                  نور
                </button>
              </div>
              <p>Whisper للاستماع · Fish Audio للنطق · عتبات الصمت من إعدادات الخادم.</p>
            </div>
          )}
          {tab === 'system' && (
            <div>
              <h3>حالة النظام</h3>
              <p data-testid="system-bridge">الجسر: {props.bridgeStatus}</p>
              <p>الخزنة: مشفرة محلياً (vault/keyring.dat) — القيم لا تغادر الخادم.</p>
              <p>الذاكرة: vault/projects/voxaura عبر Obsidian vault MCP.</p>
            </div>
          )}
        </div>
      </div>
    </PortalShell>
  );
}
