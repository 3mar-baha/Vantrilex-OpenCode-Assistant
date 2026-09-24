import { useEffect, useRef, useState } from 'react';
import { VoxauraBridge, UI_WS_URL } from './bridge/ws.js';
import { ActionBar } from './components/actionbar/ActionBar.js';
import { Crest } from './components/brand/Crest.js';
import { PixelMatrix } from './matrix/PixelMatrix.js';
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

  useEffect(() => {
    const token = import.meta.env['VOICE_RUNTIME_IPC_TOKEN'] as string | undefined;
    if (typeof token !== 'string' || token.length === 0) return; // degraded initial state stands
    const b = new VoxauraBridge({
      token,
      contractVersion: '3.1.0',
      onHello: () => setBridge('live'),
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

  const handleAction = (action: ClusterAction, minutes?: number): void => {
    if (action === 'settings') {
      setSettingsOpen(true);
      return;
    }
    if (action === 'abort') setMatrix(0); // snap to idle; G4 drives states from bridge events
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `cmd-${Date.now()}`;
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
          onSelectPersona={setPersona}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <ConfirmPortalHost url={UI_WS_URL} />
    </div>
  );
}

// Placeholder host: G4 wires live T2 confirmations through the bridge.
function ConfirmPortalHost({ url }: { url: string }): JSX.Element | null {
  void url;
  return null;
}
