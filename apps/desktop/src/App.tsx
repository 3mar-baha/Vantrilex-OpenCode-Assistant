import { useEffect, useReducer, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { VoxauraBridge } from './bridge/ws.js';
import { ActionBar } from './components/actionbar/ActionBar.js';
import { WaveformEmblem } from './components/brand/WaveformEmblem.js';
import { SiriWaveCanvas } from './components/waveform/SiriWaveCanvas.js';
import { AgentModelBadge } from './components/session/AgentModelBadge.js';
import { SessionChip } from './components/session/SessionChip.js';
import { matrixForDaemonState, type MatrixState } from './matrix/matrix-state.js';
import { initialSessionsState, sessionsReducer } from './sessions/store.js';
import { AGENT_CHAIN } from './settings/chain.js';
import { openSettingsWindow } from './settings/open-settings.js';
import type { ClusterAction } from './components/sidebar/IconCluster.js';
import './index.css';

// Voxaura companion HUD — restrained engineering surface. All settings live in
// the dedicated native settings window (see settings/open-settings.ts); this
// tree owns no modal overlays. Latin technical tokens stay verbatim.
type BridgeState = 'connecting' | 'live' | 'degraded' | 'refused';

const FONT = 'var(--vx-font)';

export function App(): JSX.Element {
  const [bridge, setBridge] = useState<BridgeState>(() => {
    const token = import.meta.env['VOICE_RUNTIME_IPC_TOKEN'] as string | undefined;
    return typeof token === 'string' && token.length > 0 ? 'connecting' : 'degraded';
  });
  const [persona, setPersona] = useState<'kareem' | 'nour'>('kareem');
  const [matrix, setMatrix] = useState<MatrixState>(0);
  const [sessionState, dispatchSession] = useReducer(sessionsReducer, initialSessionsState);
  const [agentModel, setAgentModel] = useState<{ agent: string | null; model: string | null }>({
    agent: null,
    model: null,
  });
  const [agents, setAgents] = useState<readonly { id: string; name: string }[]>([]);
  const activeSession = sessionState.activeId;
  const bridgeRef = useRef<VoxauraBridge | null>(null);
  const personaRef = useRef(persona);
  const cmdCounter = useRef(0);
  useEffect(() => {
    personaRef.current = persona;
  }, [persona]);

  const nextCmdId = (): string => {
    cmdCounter.current += 1;
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `cmd-${Date.now()}-${cmdCounter.current}-${Math.floor(Math.random() * 1e6)}`;
  };

  useEffect(() => {
    const token = import.meta.env['VOICE_RUNTIME_IPC_TOKEN'] as string | undefined;
    if (typeof token !== 'string' || token.length === 0) return; // degraded initial state stands
    const b = new VoxauraBridge({
      token,
      contractVersion: '3.1.0',
      onHello: () => setBridge('live'),
      onEvent: (event) => {
        const mapped = matrixForDaemonState(event.state, personaRef.current);
        if (mapped !== null) setMatrix(mapped);
      },
      onInventory: (sessions) =>
        dispatchSession({ kind: 'replace', sessions: sessions.map((x) => ({ id: x.sessionId, state: x.state })) }),
      onAgents: (list) => setAgents(list.map((a) => ({ id: a.id, name: a.name }))),
      onClose: () => setBridge((s) => (s === 'live' ? 'degraded' : s)),
      onRefusal: () => setBridge('refused'),
    });
    bridgeRef.current = b;
    b.connect();
    return () => {
      b.dispose();
      bridgeRef.current = null;
    };
  }, []);

  // Ctrl+, opens the native settings window (browser popup off-Tauri).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key === ',') {
        e.preventDefault();
        void openSettingsWindow(`persona=${personaRef.current}`);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const handleSelectPersona = (id: 'kareem' | 'nour'): void => {
    setPersona(id);
    setMatrix(id === 'kareem' ? 3 : 4);
    void bridgeRef.current?.sendCommand({ id: nextCmdId(), kind: 'setPersona', persona: id });
  };

  const handleSelectSession = (id: string): void => {
    dispatchSession({ kind: 'select', id });
    void bridgeRef.current?.sendCommand({ id: nextCmdId(), kind: 'switchSession', sessionId: id });
  };

  const promptTarget = (label: string): string | null => {
    const value = window.prompt(label)?.trim();
    return value !== undefined && value.length > 0 ? value : null;
  };

  const handleSelectAgent = (agentId: string): void => {
    const active = sessionState.activeId;
    setAgentModel((s) => ({ ...s, agent: agentId }));
    if (active === null) return;
    void bridgeRef.current?.sendCommand({ id: nextCmdId(), kind: 'setSessionAgent', sessionId: active, agent: agentId });
  };

  const handleSwitchAgent = (): void => {
    const active = sessionState.activeId;
    if (active === null) return;
    const target = promptTarget('بدّل الوكيل (المعرف):');
    if (target === null) return;
    setAgentModel((s) => ({ ...s, agent: target }));
    void bridgeRef.current?.sendCommand({ id: nextCmdId(), kind: 'setSessionAgent', sessionId: active, agent: target });
  };

  const handleSwitchModel = (): void => {
    const active = sessionState.activeId;
    if (active === null) return;
    const target = promptTarget('بدّل النموذج (المعرف):');
    if (target === null) return;
    setAgentModel((s) => ({ ...s, model: target }));
    void bridgeRef.current?.sendCommand({ id: nextCmdId(), kind: 'setSessionModel', sessionId: active, model: target });
  };

  const handleAction = (action: ClusterAction, minutes?: number): void => {
    if (action === 'settings') {
      void openSettingsWindow(`persona=${personaRef.current}`);
      return;
    }
    if (action === 'abort') setMatrix(0);
    const id = nextCmdId();
    if (action === 'mute') {
      void bridgeRef.current?.sendCommand(
        minutes !== undefined ? { id, kind: 'mute', minutes } : { id, kind: 'mute' },
      );
      return;
    }
    void bridgeRef.current?.sendCommand({ id, kind: action });
  };

  const statusPill =
    bridge !== 'live'
      ? '● غير متصل'
      : matrix === 0
        ? '● في وضع الاستعداد'
        : matrix === 1
          ? '● جاري الاستماع...'
          : matrix === 2
            ? '● جاري المعالجة...'
            : '● جاري التحدث...';

  const live = matrix !== 0;

  return (
    <div
      dir="rtl"
      data-testid="voxaura-shell"
      className="flex min-h-screen items-center justify-center bg-[#121316] p-4 text-[#f4f4f5]"
      style={{ fontFamily: FONT }}
    >
      <div className="flex w-full max-w-[440px] flex-col overflow-hidden rounded-lg border border-[#26282e] bg-[#18191d]">
        <header className="flex items-center gap-3 border-b border-[#26282e] px-4 py-3">
          <WaveformEmblem />
          <h1 data-testid="app-title" className="text-base font-semibold">
            Voxaura
          </h1>
          <span className="vx-kbd ms-1">Ctrl + ,</span>
          <span
            data-testid="bridge-status"
            className="ms-auto text-sm text-[#a1a1aa]"
            data-live={live}
          >
            {statusPill}
          </span>
        </header>

        <div className="flex flex-col gap-3 border-b border-[#26282e] px-4 py-3">
          <SessionChip sessions={sessionState.sessions} activeId={activeSession} onSelect={handleSelectSession} />
          <AgentModelBadge
            agent={agentModel.agent}
            model={agentModel.model}
            agents={agents}
            onSwitchAgent={handleSwitchAgent}
            onSelectAgent={handleSelectAgent}
            onSwitchModel={handleSwitchModel}
          />
          <div role="radiogroup" aria-label="شخصية الصوت" className="flex items-center gap-2">
            <span className="text-xs text-[#71717a]">الصوت</span>
            {(['kareem', 'nour'] as const).map((p) => (
              <button
                key={p}
                role="radio"
                aria-checked={persona === p}
                data-testid={`hud-persona-${p}`}
                onClick={() => handleSelectPersona(p)}
                className={`rounded-[6px] border px-3 py-1 text-xs ${
                  persona === p
                    ? 'border-[#3b82f6] text-[#f4f4f5]'
                    : 'border-[#26282e] text-[#a1a1aa] hover:text-[#f4f4f5]'
                }`}
              >
                {p === 'kareem' ? 'كريم' : 'نور'}
              </button>
            ))}
          </div>
        </div>

        <main className="flex flex-col items-center gap-4 px-4 py-5">
          <SiriWaveCanvas mode={live ? 'active' : 'idle'} color="#3b82f6" />
          <button
            data-testid="mic-core"
            aria-label="الميكروفون"
            onClick={() => handleAction('deafen')}
            className="flex h-16 w-16 items-center justify-center rounded-full border border-[#26282e] bg-[#0e0f12] text-[#a1a1aa] transition hover:border-[#3b82f6] hover:text-[#f4f4f5]"
          >
            <Mic size={26} />
          </button>
          <ActionBar onAction={handleAction} />
        </main>

        <div className="flex border-t border-[#26282e]">
          <button
            data-testid="open-settings"
            onClick={() => handleAction('settings')}
            className="flex-1 px-4 py-2.5 text-sm text-[#a1a1aa] hover:bg-[#1d1e23] hover:text-[#f4f4f5]"
          >
            الإعدادات
          </button>
          <span className="w-px bg-[#26282e]" />
          <button
            data-testid="open-apikeys"
            onClick={() => handleAction('settings')}
            className="flex-1 px-4 py-2.5 text-sm text-[#a1a1aa] hover:bg-[#1d1e23] hover:text-[#f4f4f5]"
          >
            مفاتيح الـ API
          </button>
        </div>

        <dl className="grid grid-cols-3 divide-x divide-[#26282e] border-t border-[#26282e] text-center [direction:ltr]">
          {AGENT_CHAIN.map((c) => (
            <div key={c.id} className="px-2 py-2">
              <dt className="font-mono text-[11px] text-[#f4f4f5]">{c.name}</dt>
              <dd className="text-[11px] text-[#71717a]">{c.role}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}