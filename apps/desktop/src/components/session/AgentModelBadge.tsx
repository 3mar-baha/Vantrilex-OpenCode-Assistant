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
  /** HUD mode: friendly agent selector only — raw model ids stay hidden. */
  readonly compact?: boolean;
}

export function AgentModelBadge({
  agent,
  model,
  agents,
  onSwitchAgent,
  onSelectAgent,
  onSwitchModel,
  compact = false,
}: AgentModelBadgeProps): JSX.Element {
  const hasAgents = agents !== undefined && agents.length > 0;
  return (
    <div data-testid="agent-model-badge" role="group" aria-label="الوكيل والنموذج النشطان">
      {hasAgents ? (
        <select
          data-testid="agent-select"
          aria-label="الوكيل النشط"
          title="اختر الوكيل النشط"
          value={agent ?? ''}
          onChange={(e) => onSelectAgent?.(e.target.value)}
        >
          <option value="" disabled>
            الوكيل: غير معيّن
          </option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      ) : (
        <span data-testid="badge-agent">الوكيل: {agent ?? 'غير معيّن'}</span>
      )}
      <button data-testid="badge-switch-agent" aria-label="بدّل الوكيل" title="تعيين وكيل للجلسة النشطة" onClick={onSwitchAgent}>
        ⇄
      </button>
      {!compact && <span data-testid="badge-model">النموذج: {model ?? 'غير معيّن'}</span>}
      <button data-testid="badge-switch-model" aria-label="بدّل النموذج" title="تعيين نموذج للجلسة النشطة" onClick={onSwitchModel}>
        ⇄
      </button>
    </div>
  );
}
