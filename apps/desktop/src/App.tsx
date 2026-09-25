import { useEffect, useReducer, useRef, useState } from 'react';
import { VoxauraBridge } from './bridge/ws.js';
import { ActionBar } from './components/actionbar/ActionBar.js';
import { WaveformEmblem } from './components/brand/WaveformEmblem.js';
import { SiriWaveCanvas } from './components/waveform/SiriWaveCanvas.js';
import { matrixForDaemonState } from './matrix/matrix-state.js';
import type { MatrixState } from './matrix/matrix-state.js';
import { SettingsDialog } from './components/settings/SettingsDialog.js';
import { ApiKeysModal } from './components/portals/ApiKeysModal.js';
import { Mic } from 'lucide-react';
import { AgentModelBadge } from './components/session/AgentModelBadge.js';
import { SessionChip } from './components/session/SessionChip.js';
import { initialSessionsState, sessionsReducer } from './sessions/store.js';
import type { ClusterAction } from './components/sidebar/IconCluster.js';
import type { ApiKeyBundle } from './components/portals/ApiKeysModal.js';
import './index.css';

// Voxaura shell — ambient Arabic-first status surface. The daemon owns all
// state; this tree renders bridge status, the Siri wave, action bar and the
// tabbed settings dialog. Latin technical tokens stay verbatim; all chrome
// copy is Arabic. No secrets, no model calls here.
type BridgeState = 'connecting' | 'live' | 'degraded' | 'refused';

const ARABIC_FONT = "-apple-system, 'Segoe UI', Tahoma, Arial, sans-serif";

const CHAIN = [
  { id: 'dots3', name: 'Dots3', role: 'الاستقبال الحواري' },
  { id: 'nemotron', name: 'Nemotron', role: 'المنسق الرئيسي' },
  { id: 'inkling', name: 'Inkling', role: 'المنفذ داخل الجلسة' },
] as const;

export function App(): JSX.Element {
  const [bridge, setBridge] = useState<BridgeState>(() => {
    const token = import.meta.env['VOICE_RUNTIME_IPC_TOKEN'] as string | undefined;
    return typeof token === 'string' && token.length > 0 ? 'connecting' : 'degraded';
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [keysSaving, setKeysSaving] = useState(false);
  const [keysError, setKeysError] = useState<string | undefined>(undefined);
  const [persona, setPersona] = useState<'kareem' | 'nour'>('kareem');
  const [matrix, setMatrix] = useState<MatrixState>(0);
  // Sessions surface from the daemon inventory (Phase 2 follow-up); until
  // then the chip renders the active id only — never fabricated entries.
  const [sessionState, dispatchSession] = useReducer(sessionsReducer, initialSessionsState);
  // Agent/model surface from daemon reports (Phase 3 follow-up streams them);
  // null renders unassigned — never guessed.
  const [agentModel, setAgentModel] = useState<{ agent: string | null; model: string | null }>({
    agent: null,
    model: null,
  });
  const [agents, setAgents] = useState<readonly { id: string; name: string }[]>([]);
  const activeSession = sessionState.activeId;
  const bridgeRef = useRef<VoxauraBridge | null>(null);
  const cmdCounter = useRef(0);
  const personaRef = useRef(persona);
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
      onInventory: (sessions) => dispatchSession({ kind: 'replace', sessions: sessions.map((x) => ({ id: x.sessionId, state: x.state })) }),
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

  const handleSaveKeys = (keys: ApiKeyBundle): void => {
    const bridge = bridgeRef.current;
    if (bridge === null) {
      setKeysError('الجسر غير متصل — لم تُرسل المفاتيح');
      return;
    }
    setKeysSaving(true);
    setKeysError(undefined);
    void bridge
      .sendCommand({
        id: nextCmdId(),
        kind: 'saveApiKeys',
        groqKey: keys.groq,
        fishKey: keys.fish,
        openrouterKey: keys.openrouter,
      })
      .then((ok) => {
        setKeysSaving(false);
        if (ok) {
          setKeysOpen(false);
        } else {
          setKeysError('رفض الخادم المفاتيح — الثلاثة مطلوبة');
        }
      });
  };

  const handleAction = (action: ClusterAction, minutes?: number): void => {
    if (action === 'settings') {
      setSettingsOpen(true);
      return;
    }
    if (action === 'abort') setMatrix(0); // snap to idle; G4 drives states from bridge events
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

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-[#0a0f1d] p-4 text-slate-200"
      data-testid="voxaura-shell"
      dir="rtl"
      style={{ fontFamily: ARABIC_FONT }}
    >
      <div className="flex w-full max-w-[420px] flex-col gap-5 rounded-3xl border border-slate-700/70 bg-slate-900/80 p-5 shadow-2xl backdrop-blur-xl">
        <header className="flex items-center gap-3">
          <WaveformEmblem />
          <h1 data-testid="app-title" className="text-2xl font-bold text-slate-50">
            Voxaura
          </h1>
          <span
            data-testid="bridge-status"
            className="ms-auto rounded-full border border-slate-700/70 bg-slate-800/70 px-3 py-1 text-sm text-sky-300"
          >
            {statusPill}
          </span>
        </header>
        <SessionChip sessions={sessionState.sessions} activeId={activeSession} onSelect={handleSelectSession} />
        <AgentModelBadge
          agent={agentModel.agent}
          model={agentModel.model}
          agents={agents}
          onSwitchAgent={handleSwitchAgent}
          onSelectAgent={handleSelectAgent}
          onSwitchModel={handleSwitchModel}
        />
        <main className="flex flex-col items-center gap-4">
          <div
            className="w-full rounded-2xl border border-slate-700/60 bg-slate-950/60 p-2"
            style={{ filter: 'drop-shadow(0 0 12px rgba(56, 189, 248, 0.45))' }}
          >
            <SiriWaveCanvas mode={matrix === 0 ? 'idle' : 'active'} color="#38bdf8" />
          </div>
          <button
            data-testid="mic-core"
            aria-label="الميكروفون"
            onClick={() => handleAction('deafen')}
            className="flex h-20 w-20 items-center justify-center rounded-full border border-sky-400/40 bg-sky-500/15 text-sky-300 shadow-[0_0_28px_rgba(56,189,248,0.35)] transition hover:bg-sky-500/25"
          >
            <Mic size={32} />
          </button>
          <ActionBar onAction={handleAction} />
        </main>
        <div className="flex gap-3">
          <button
            data-testid="open-settings"
            onClick={() => setSettingsOpen(true)}
            className="flex-1 rounded-xl border border-slate-700/70 bg-slate-800/70 px-4 py-2.5 text-slate-100 hover:bg-slate-700/70"
          >
            الإعدادات
          </button>
          <button
            data-testid="open-apikeys"
            onClick={() => setKeysOpen(true)}
            className="flex-1 rounded-xl border border-sky-500/40 bg-sky-500/15 px-4 py-2.5 text-sky-200 hover:bg-sky-500/25"
          >
            مفاتيح الـ API
          </button>
        </div>
      </div>
      {keysOpen && (
        <ApiKeysModal
          onSave={handleSaveKeys}
          onClose={() => setKeysOpen(false)}
          saving={keysSaving}
          saveError={keysError}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          keysSaving={keysSaving}
          keysError={keysError}
          onSaveKeys={handleSaveKeys}
          chain={[...CHAIN]}
          activeModel={agentModel.model}
          agents={agents}
          onSelectAgent={handleSelectAgent}
          persona={persona}
          onSelectPersona={handleSelectPersona}
          bridgeStatus={bridge}
        />
      )}
    </div>
  );
}

