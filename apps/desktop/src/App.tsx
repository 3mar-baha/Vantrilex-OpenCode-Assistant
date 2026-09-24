import { useEffect, useRef, useState } from 'react';
import { VoxauraBridge } from './bridge/ws.js';
import { ActionBar } from './components/actionbar/ActionBar.js';
import { Crest } from './components/brand/Crest.js';
import { PixelMatrix } from './matrix/PixelMatrix.js';
import { matrixForDaemonState } from './matrix/matrix-state.js';
import { SettingsPortal } from './components/portals/SettingsPortal.js';
import type { ClusterAction } from './components/sidebar/IconCluster.js';
import type { MatrixState } from './matrix/matrix-state.js';
import './index.css';

// Voxaura shell — ambient status surface. The daemon owns all state; this tree
// renders bridge status, the matrix/action-bar placeholders (G3 builds them),
// and the floating portals (G2). No secrets, no model calls here.
type BridgeState = 'connecting' | 'live' | 'degraded' | 'refused';

const TABS = [
  { id: 'identity', title: 'Persona (Kareem / Nour)' },
  { id: 'audio', title: 'Audio & hardware' },
  { id: 'bridge', title: 'OpenCode bridge' },
  { id: 'keyring', title: 'Key pools' },
  { id: 'system', title: 'System & telemetry' },
];

export function App(): JSX.Element {
  const [bridge, setBridge] = useState<BridgeState>(() => {
    const token = import.meta.env['VOICE_RUNTIME_IPC_TOKEN'] as string | undefined;
    return typeof token === 'string' && token.length > 0 ? 'connecting' : 'degraded';
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('identity');
  const [persona, setPersona] = useState<'kareem' | 'nour'>('kareem');
  const [matrix, setMatrix] = useState<MatrixState>(0);
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

  return (
    <div className="min-h-full bg-obsidian text-stone-200" data-testid="voxaura-shell">
      <header data-testid="bridge-status">
        <Crest size={24} />
        <span>bridge: {bridge}</span>
      </header>
      <main>
        <PixelMatrix state={matrix} energy={0} />
        <ActionBar onAction={handleAction} />
      </main>
      <button data-testid="open-settings" onClick={() => setSettingsOpen(true)}>
        Settings
      </button>
      {settingsOpen && (
        <SettingsPortal
          tabs={TABS}
          activeTab={activeTab}
          persona={[
            { id: 'kareem', label: 'Kareem (كريم)', selected: persona === 'kareem' },
            { id: 'nour', label: 'Nour (نور)', selected: persona === 'nour' },
          ]}
          onSelectTab={setActiveTab}
          onSelectPersona={handleSelectPersona}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
