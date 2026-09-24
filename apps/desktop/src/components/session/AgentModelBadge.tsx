// AgentModelBadge — active agent/model surface beside the session chip.
// Displays daemon-reported values only (null = unassigned, never fabricated);
// switch buttons emit intents the daemon acks.
export interface AgentModelBadgeProps {
  readonly agent: string | null;
  readonly model: string | null;
  readonly onSwitchAgent: () => void;
  readonly onSwitchModel: () => void;
}

export function AgentModelBadge({ agent, model, onSwitchAgent, onSwitchModel }: AgentModelBadgeProps): JSX.Element {
  return (
    <div data-testid="agent-model-badge" role="group" aria-label="Active agent and model">
      <span data-testid="badge-agent">agent: {agent ?? 'unassigned'}</span>
      <button data-testid="badge-switch-agent" aria-label="Switch agent" onClick={onSwitchAgent}>
        ⇄
      </button>
      <span data-testid="badge-model">model: {model ?? 'unassigned'}</span>
      <button data-testid="badge-switch-model" aria-label="Switch model" onClick={onSwitchModel}>
        ⇄
      </button>
    </div>
  );
}
