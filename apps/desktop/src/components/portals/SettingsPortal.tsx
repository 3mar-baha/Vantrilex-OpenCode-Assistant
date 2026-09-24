import { PortalShell } from './PortalShell.js';

// Voxaura settings portal — renders the daemon's 5-tab SettingsModal model.
// Persona options carry Fish IDs for display routing only; key material never
// enters this tree (counts only, enforced by the modal contract).
export interface PortalTab {
  readonly id: string;
  readonly title: string;
}

export interface PortalPersona {
  readonly id: 'kareem' | 'nour';
  readonly label: string;
  readonly selected: boolean;
}

export interface SettingsPortalProps {
  readonly tabs: readonly PortalTab[];
  readonly activeTab: string;
  readonly persona: readonly PortalPersona[];
  readonly onSelectTab: (id: string) => void;
  readonly onSelectPersona: (id: 'kareem' | 'nour') => void;
  readonly onClose: () => void;
}

export function SettingsPortal({
  tabs,
  activeTab,
  persona,
  onSelectTab,
  onSelectPersona,
  onClose,
}: SettingsPortalProps): JSX.Element {
  return (
    <PortalShell label="Voxaura settings" onClose={onClose}>
      <div role="tablist" aria-label="Settings sections" data-testid="settings-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTab}
            data-testid={`tab-${tab.id}`}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.title}
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="Voice persona" data-testid="persona-group">
        {persona.map((p) => (
          <button
            key={p.id}
            role="radio"
            aria-checked={p.selected}
            data-testid={`persona-${p.id}`}
            onClick={() => onSelectPersona(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </PortalShell>
  );
}
