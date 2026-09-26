import { useEffect, useReducer, useRef, useState } from 'react';
import { VoxauraBridge } from './bridge/ws.js';
import { WaveformEmblem } from './components/brand/WaveformEmblem.js';
import { SiriWaveCanvas } from './components/waveform/SiriWaveCanvas.js';
import { AgentModelBadge } from './components/session/AgentModelBadge.js';
import { SessionChip } from './components/session/SessionChip.js';
import { MicGlyph, MicOffGlyph, BotGlyph, BotOffGlyph } from './components/icons/ControlGlyphs.js';
import { AudioCapture } from './audio/capture.js';
import { matrixForDaemonState, type MatrixState } from './matrix/matrix-state.js';
import { initialSessionsState, sessionsReducer } from './sessions/store.js';
import { envToken, resolveIpcToken } from './settings/ipc-token.js';
import { ensureServices } from './settings/services.js';
import { openKeysWindow, openSettingsWindow } from './settings/open-settings.js';
import { useAutoSize } from './window/useAutoSize.js';
import './index.css';

// Voxaura companion HUD — one control per intent, no duplicated toolbars.
// Every interactive element carries an Arabic tooltip; the status pill is
// driven entirely by live daemon state, never local guesswork.
type BridgeState = 'connecting' | 'live' | 'degraded' | 'refused';

const FONT = 'var(--vx-font)';

export function App(): JSX.Element {
  const [bridge, setBridge] = useState<BridgeState>(envToken() !== undefined ? 'connecting' : 'degraded');
  const [persona, setPersona] = useState<'kareem' | 'nour'>('kareem');
  const [matrix, setMatrix] = useState<MatrixState>(0);
  const [userMuted, setUserMuted] = useState(true);
  const [botMuted, setBotMuted] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [sessionState, dispatchSession] = useReducer(sessionsReducer, initialSessionsState);
  const [agentModel, setAgentModel] = useState<{ agent: string | null; model: string | null }>({
    agent: null,
    model: null,
  });
  const [agents, setAgents] = useState<readonly { id: string; name: string }[]>([]);
  const activeSession = sessionState.activeId;
  const bridgeRef = useRef<VoxauraBridge | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  if (captureRef.current === null) captureRef.current = new AudioCapture();
  const cardRef = useRef<HTMLDivElement>(null);
  useAutoSize(cardRef, { paddingY: 16 });
  const lastFrameAt = useRef<number>(Date.now());
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
    let disposed = false;
    let client: VoxauraBridge | null = null;
    // Zero-click: bring the tiers up first (no-op off Tauri). The bridge also
    // retries with backoff, so a slow cold start converges without the user.
    void ensureServices().then((result) => {
      if (!disposed && result !== null && !result.ok) setAnnounce(`تعذّر بدء الخدمات: ${result.detail}`);
    });
    void resolveIpcToken().then((token) => {
      if (disposed || token === undefined) {
        if (!disposed && token === undefined) setBridge('degraded');
        return;
      }
      const b = new VoxauraBridge({
        token,
        contractVersion: '3.1.0',
        onHello: () => setBridge('live'),
        onEvent: (event) => {
          const mapped = matrixForDaemonState(event.state, personaRef.current);
          if (mapped !== null) setMatrix(mapped);
          lastFrameAt.current = Date.now();
        },
        onInventory: (sessions) =>
          dispatchSession({ kind: 'replace', sessions: sessions.map((x) => ({ id: x.sessionId, state: x.state })) }),
        onAgents: (list) => setAgents(list.map((a) => ({ id: a.id, name: a.name }))),
        onClose: () => setBridge((s) => (s === 'live' ? 'degraded' : s)),
        onRefusal: () => setBridge('refused'),
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

  // Staleness watchdog: a silent socket must not keep showing "متصل".
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (bridgeRef.current === null) return;
      if (Date.now() - lastFrameAt.current > 45_000) setBridge((s) => (s === 'live' ? 'degraded' : s));
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key === ',') {
        e.preventDefault();
        void openSettingsWindow(personaRef.current);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Release the microphone when the shell unmounts (no dangling tracks).
  useEffect(() => () => captureRef.current?.stop(), []);

  const send = (cmd: Parameters<VoxauraBridge['sendCommand']>[0], ok: string, fail: string): void => {
    const bridgeClient = bridgeRef.current;
    if (bridgeClient === null) {
      setAnnounce('الخادم غير متصل');
      return;
    }
    void bridgeClient.sendCommand(cmd).then((accepted) => setAnnounce(accepted ? ok : fail));
  };

  const handleSelectPersona = (id: 'kareem' | 'nour'): void => {
    setPersona(id);
    setMatrix(id === 'kareem' ? 3 : 4);
    send({ id: nextCmdId(), kind: 'setPersona', persona: id }, 'تم تبديل الشخصية', 'تعذّر تبديل الشخصية');
  };

  const handleSelectSession = (id: string): void => {
    dispatchSession({ kind: 'select', id });
    send({ id: nextCmdId(), kind: 'switchSession', sessionId: id }, 'تم تبديل الجلسة', 'تعذّر تبديل الجلسة');
  };

  const promptTarget = (label: string): string | null => {
    const value = window.prompt(label)?.trim();
    return value !== undefined && value.length > 0 ? value : null;
  };

  const handleSelectAgent = (agentId: string): void => {
    const active = sessionState.activeId;
    setAgentModel((s) => ({ ...s, agent: agentId }));
    if (active === null) {
      setAnnounce('اختر جلسة أولاً');
      return;
    }
    send({ id: nextCmdId(), kind: 'setSessionAgent', sessionId: active, agent: agentId }, 'تم تعيين الوكيل', 'تعذّر تعيين الوكيل');
  };

  const handleSwitchAgent = (): void => {
    const active = sessionState.activeId;
    if (active === null) {
      setAnnounce('اختر جلسة أولاً');
      return;
    }
    const target = promptTarget('بدّل الوكيل (المعرف):');
    if (target === null) return;
    setAgentModel((s) => ({ ...s, agent: target }));
    send({ id: nextCmdId(), kind: 'setSessionAgent', sessionId: active, agent: target }, 'تم تعيين الوكيل', 'تعذّر تعيين الوكيل');
  };

  const handleSwitchModel = (): void => {
    const active = sessionState.activeId;
    if (active === null) {
      setAnnounce('اختر جلسة أولاً');
      return;
    }
    const target = promptTarget('بدّل النموذج (المعرف):');
    if (target === null) return;
    setAgentModel((s) => ({ ...s, model: target }));
    send({ id: nextCmdId(), kind: 'setSessionModel', sessionId: active, model: target }, 'تم تبديل النموذج', 'تعذّر تبديل النموذج');
  };

  const toggleUserMute = (): void => {
    const next = !userMuted;
    setUserMuted(next);
    const capture = captureRef.current;
    if (capture !== null) {
      if (next) {
        capture.stop();
      } else {
        void capture
          .start({
            onFrame: (bytes) => {
              bridgeRef.current?.sendPcm(bytes);
            },
            onError: () => setAnnounce('تعذّر الوصول إلى الميكروفون'),
          })
          .catch(() => setAnnounce('تعذّر الوصول إلى الميكروفون'));
      }
    }
    send({ id: nextCmdId(), kind: 'deafen' }, next ? 'تم صمّ الميكروفون' : 'تم تشغيل الميكروفون', 'تعذّر تغيير حالة الميكروفون');
  };

  const toggleBotMute = (): void => {
    const next = !botMuted;
    setBotMuted(next);
    send({ id: nextCmdId(), kind: 'mute' }, next ? 'تم كتم صوت المساعد' : 'تم تشغيل صوت المساعد', 'تعذّر تغيير حالة الصوت');
  };

  const statusPill =
    bridge !== 'live'
      ? { text: '● غير متصل', state: 'offline' }
      : matrix === 0
        ? { text: '● متصل وبانتظار الأوامر', state: 'ready' }
        : matrix === 1
          ? { text: '● جاري الاستماع...', state: 'listening' }
          : matrix === 2
            ? { text: '● جاري المعالجة...', state: 'processing' }
            : { text: '● جاري التحدث...', state: 'speaking' };

  const live = matrix !== 0;
  const noSessions = sessionState.sessions.length === 0;

  return (
    <div
      dir="rtl"
      data-testid="voxaura-shell"
      data-tauri-drag-region
      className="inline-block bg-[#121316] text-[#f4f4f5]"
      style={{ fontFamily: FONT }}
    >
      <div
        ref={cardRef}
        data-tauri-drag-region
        className="flex w-[440px] flex-col overflow-hidden rounded-lg border border-[#26282e] bg-[#18191d]"
      >
        <header data-tauri-drag-region className="flex items-center gap-3 border-b border-[#26282e] px-4 py-3">
          <WaveformEmblem />
          <h1 data-testid="app-title" className="text-base font-semibold">
            Voxaura
          </h1>
          <span className="vx-kbd ms-1" title="اختصار فتح الإعدادات">
            Ctrl + ,
          </span>
          <span
            data-testid="bridge-status"
            data-state={statusPill.state}
            role="status"
            aria-live="polite"
            title={`حالة الاتصال: ${statusPill.text.replace('● ', '')}`}
            className="ms-auto text-sm text-[#a1a1aa]"
          >
            {statusPill.text}
          </span>
        </header>

        {bridge !== 'live' && (
          <p
            data-testid="reconnect-hint"
            title="يُعاد الاتصال تلقائياً بتراجع تدريجي"
            className="border-b border-[#26282e] bg-[#0e0f12] px-4 py-2 text-xs text-[#fbbf24]"
          >
            انقطع الاتصال بالخادم — تتم إعادة المحاولة تلقائياً…
          </p>
        )}

        <div className="flex flex-col gap-3 border-b border-[#26282e] px-4 py-3">
          <SessionChip sessions={sessionState.sessions} activeId={activeSession} onSelect={handleSelectSession} />
          {noSessions && (
            <p data-testid="empty-sessions" title="لا توجد جلسات بعد" className="text-xs text-[#71717a]">
              لا توجد جلسات بعد — افتح جلسة في OpenCode لتظهر هنا.
            </p>
          )}
          <AgentModelBadge
            agent={agentModel.agent}
            model={agentModel.model}
            agents={agents}
            onSwitchAgent={handleSwitchAgent}
            onSelectAgent={handleSelectAgent}
            onSwitchModel={handleSwitchModel}
            compact
          />
          <div role="radiogroup" aria-label="شخصية الصوت" className="flex items-center gap-2">
            <span className="text-xs text-[#71717a]">الصوت</span>
            {(['kareem', 'nour'] as const).map((p) => (
              <button
                key={p}
                role="radio"
                aria-checked={persona === p}
                data-testid={`hud-persona-${p}`}
                title={p === 'kareem' ? 'كريم — الصوت الافتراضي' : 'نور — الصوت البديل'}
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
          <div className="flex items-center gap-3" data-testid="control-row">
            <button
              data-testid="mic-toggle"
              aria-pressed={userMuted}
              aria-label="ميكروفون المستخدم"
              title={userMuted ? 'الميكروفون مكتوم — اضغط للتشغيل' : 'الميكروفون يعمل — اضغط للكتم'}
              onClick={toggleUserMute}
              className={`flex h-14 w-14 items-center justify-center rounded-full border transition ${
                userMuted
                  ? 'border-[#f87171] text-[#f87171]'
                  : 'border-[#26282e] bg-[#0e0f12] text-[#a1a1aa] hover:border-[#3b82f6] hover:text-[#f4f4f5]'
              }`}
            >
              {userMuted ? <MicOffGlyph /> : <MicGlyph />}
            </button>
            <button
              data-testid="bot-toggle"
              aria-pressed={botMuted}
              aria-label="صوت المساعد"
              title={botMuted ? 'صوت المساعد مكتوم — اضغط للتشغيل' : 'صوت المساعد يعمل — اضغط للكتم'}
              onClick={toggleBotMute}
              className={`flex h-14 w-14 items-center justify-center rounded-full border transition ${
                botMuted
                  ? 'border-[#f87171] text-[#f87171]'
                  : 'border-[#26282e] bg-[#0e0f12] text-[#a1a1aa] hover:border-[#3b82f6] hover:text-[#f4f4f5]'
              }`}
            >
              {botMuted ? <BotOffGlyph /> : <BotGlyph />}
            </button>
          </div>
          <p
            data-testid="announce"
            role="status"
            aria-live="polite"
            title="آخر نتيجة أمر"
            className="min-h-[16px] text-xs text-[#71717a]"
          >
            {announce}
          </p>
          <button
            data-testid="abort-button"
            title={live ? 'إيقاف التوليد فوراً' : 'بدء توليد جديد'}
            onClick={() => {
              if (live) {
                setMatrix(0);
                send({ id: nextCmdId(), kind: 'abort' }, 'تم إيقاف التوليد', 'تعذّر إيقاف التوليد');
              } else {
                setMatrix(1);
                send({ id: nextCmdId(), kind: 'arm' }, 'تمت إعادة التوليد', 'تعذّرت إعادة التوليد');
              }
            }}
            className={`rounded-[6px] border px-3 py-1 text-xs transition ${
              live
                ? 'border-[#f87171] text-[#f87171] hover:bg-[#f87171]/10'
                : 'border-[#26282e] text-[#a1a1aa] hover:border-[#3b82f6] hover:text-[#f4f4f5]'
            }`}
          >
            {live ? 'إيقاف التوليد' : 'إعادة التوليد'}
          </button>
        </main>

        <div className="flex border-t border-[#26282e]">
          <button
            data-testid="open-settings"
            title="الإعدادات العامة (Ctrl + ,)"
            onClick={() => void openSettingsWindow(persona)}
            className="flex-1 px-4 py-2.5 text-sm text-[#a1a1aa] hover:bg-[#1d1e23] hover:text-[#f4f4f5]"
          >
            الإعدادات
          </button>
          <span className="w-px bg-[#26282e]" />
          <button
            data-testid="open-apikeys"
            title="نافذة مفاتيح الـ API"
            onClick={() => void openKeysWindow()}
            className="flex-1 px-4 py-2.5 text-sm text-[#a1a1aa] hover:bg-[#1d1e23] hover:text-[#f4f4f5]"
          >
            مفاتيح الـ API
          </button>
        </div>
      </div>
    </div>
  );
}