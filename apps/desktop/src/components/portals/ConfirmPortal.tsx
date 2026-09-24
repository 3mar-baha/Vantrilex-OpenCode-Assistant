import { PortalShell } from './PortalShell.js';

// FR-12 confirmation portal — the T2 surface for ambiguous/destructive intent.
// The daemon decides escalation; this component only presents and reports back.
export interface ConfirmPortalProps {
  readonly title: string;
  readonly detail: string;
  readonly destructiveScore?: number;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmPortal({
  title,
  detail,
  destructiveScore,
  onConfirm,
  onCancel,
}: ConfirmPortalProps): JSX.Element {
  return (
    <PortalShell label="Confirm before acting" onClose={onCancel}>
      <h2 data-testid="confirm-title">{title}</h2>
      <p data-testid="confirm-detail">{detail}</p>
      {destructiveScore !== undefined && (
        <p data-testid="confirm-score">
          Destructive score: {destructiveScore.toFixed(2)}
        </p>
      )}
      <div>
        <button data-testid="confirm-ok" onClick={onConfirm}>
          Confirm
        </button>
        <button data-testid="confirm-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </PortalShell>
  );
}
