import { useEffect, useRef, useState } from 'react';
import { IconCluster, type ClusterAction } from '../sidebar/IconCluster.js';

// Floating pill action bar — mute presets, hard abort, mic deafen, settings.
// Timed mutes arm a local countdown; manual unmute or remute clears it.
export interface ActionBarProps {
  readonly onAction: (action: ClusterAction, minutes?: number) => void;
}

const MUTE_PRESETS = [5, 15, 30, 60] as const;

export function ActionBar({ onAction }: ActionBarProps): JSX.Element {
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customMinutes, setCustomMinutes] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const clearMuteTimer = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const applyMute = (minutes?: number): void => {
    clearMuteTimer();
    setMuted(true);
    setPickerOpen(false);
    onAction('mute', minutes);
    if (minutes !== undefined) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setMuted(false);
      }, minutes * 60_000);
    }
  };

  const handle = (action: ClusterAction): void => {
    if (action === 'mute' && !muted) {
      setPickerOpen((open) => !open);
      return;
    }
    if (action === 'mute') {
      clearMuteTimer();
      setMuted(false);
      onAction('mute');
      return;
    }
    if (action === 'deafen') {
      setDeafened((d) => !d);
      onAction('deafen');
      return;
    }
    onAction(action);
  };

  return (
    <div data-testid="action-bar" className="voxaura-actionbar">
      <IconCluster
        muted={muted}
        deafened={deafened}
        onAction={(action) => {
          if (action === 'settings') {
            onAction('settings');
            return;
          }
          handle(action);
        }}
      />
      {pickerOpen && (
        <div role="dialog" aria-label="مدة الكتم" data-testid="mute-picker">
          {MUTE_PRESETS.map((m) => (
            <button key={m} data-testid={`mute-${m}m`} onClick={() => applyMute(m)}>
              {m}m
            </button>
          ))}
          <input
            data-testid="mute-custom"
            aria-label="Custom minutes"
            inputMode="numeric"
            value={customMinutes}
            onChange={(e) => setCustomMinutes(e.target.value.replace(/[^0-9]/g, ''))}
          />
          <button
            data-testid="mute-custom-apply"
            disabled={customMinutes.length === 0}
            onClick={() => applyMute(Number.parseInt(customMinutes, 10))}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
