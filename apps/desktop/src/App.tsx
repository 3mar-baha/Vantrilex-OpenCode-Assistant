import { useEffect, useRef, useState } from 'react';
import { VoxauraBridge, UI_WS_URL } from './bridge/ws.js';
import { SettingsPortal } from './components/portals/SettingsPortal.js';
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

  return (
    <div className="min-h-full bg-obsidian text-stone-200" data-testid="voxaura-shell">
      <header data-testid="bridge-status">bridge: {bridge}</header>
      <main>
        <section data-testid="matrix-slot" aria-label="Pixel matrix (G3)" />
        <section data-testid="actionbar-slot" aria-label="Action bar (G3)" />
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
