// AgentModelBadge — active agent/model surface beside the session chip.
// Displays daemon-reported values only (null = unassigned, never fabricated).
// When discovered agents are supplied it renders a live selector; otherwise it
// falls back to the prompt-driven switch button.
export interface AgentOption {
  readonly id: string;
  readonly name: string;
}

export interface AgentModelBadgeProps {
  readonly agent: string | null;
  readonly model: string | null;
  readonly agents?: readonly AgentOption[];
  readonly onSwitchAgent: () => void;
  readonly onSelectAgent?: (id: string) => void;
  readonly onSwitchModel: () => void;
}

export function AgentModelBadge({
  agent,
  model,
  agents,
  onSwitchAgent,
  onSelectAgent,
  onSwitchModel,
}: AgentModelBadgeProps): JSX.Element {
  const hasAgents = agents !== undefined && agents.length > 0;
  return (
    <div data-testid="agent-model-badge" role="group" aria-label="Active agent and model">
      {hasAgents ? (
        <select
          data-testid="agent-select"
          aria-label="Active agent"
          value={agent ?? ''}
          onChange={(e) => onSelectAgent?.(e.target.value)}
        >
          <option value="" disabled>
            agent: unassigned
          </option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      ) : (
        <span data-testid="badge-agent">agent: {agent ?? 'unassigned'}</span>
      )}
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
