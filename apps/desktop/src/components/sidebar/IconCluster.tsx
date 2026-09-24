import { Mic, MicOff, Settings, Square, VolumeX } from 'lucide-react';

// Sidebar icon cluster — tree-shaken Lucide glyphs, currentColor inheritance.
// The daemon owns mic/mute state; this cluster only emits intents.
export type ClusterAction = 'mute' | 'abort' | 'deafen' | 'settings';

export interface IconClusterProps {
  readonly muted: boolean;
  readonly deafened: boolean;
  readonly onAction: (action: ClusterAction) => void;
}

export function IconCluster({ muted, deafened, onAction }: IconClusterProps): JSX.Element {
  return (
    <nav aria-label="Voxaura controls" data-testid="icon-cluster" className="voxaura-cluster">
      <button
        data-testid="action-mute"
        aria-label={muted ? 'Unmute AI voice' : 'Mute AI voice'}
        aria-pressed={muted}
        onClick={() => onAction('mute')}
      >
        {muted ? <VolumeX color="currentColor" size={22} /> : <Mic color="currentColor" size={22} />}
      </button>
      <button data-testid="action-abort" aria-label="Stop generation" onClick={() => onAction('abort')}>
        <Square color="currentColor" size={22} />
      </button>
      <button
        data-testid="action-deafen"
        aria-label={deafened ? 'Undeafen microphone' : 'Deafen microphone'}
        aria-pressed={deafened}
        onClick={() => onAction('deafen')}
      >
        {deafened ? <MicOff color="currentColor" size={22} /> : <Mic color="currentColor" size={22} />}
      </button>
      <button data-testid="action-settings" aria-label="Open settings" onClick={() => onAction('settings')}>
        <Settings color="currentColor" size={22} />
      </button>
    </nav>
  );
}
