import { PortalShell } from './PortalShell.js';

// Credential pool portal — key COUNTS only. Values never enter the renderer;
// the vault is the sole custodian of key material.
export interface CredentialPortalProps {
  readonly groqKeys: number;
  readonly fishKeys: number;
  readonly openrouterKeys: number;
  readonly onClose: () => void;
}

export function CredentialPortal({ groqKeys, fishKeys, openrouterKeys, onClose }: CredentialPortalProps): JSX.Element {
  return (
    <PortalShell label="Key pools" onClose={onClose}>
      <dl data-testid="credential-counts">
        <dt>Groq pool</dt>
        <dd data-testid="groq-count">{groqKeys} keys</dd>
        <dt>Fish Audio pool</dt>
        <dd data-testid="fish-count">{fishKeys} keys</dd>
        <dt>OpenRouter pool</dt>
        <dd data-testid="openrouter-count">{openrouterKeys} keys</dd>
      </dl>
      <p>Values are stored in the encrypted vault and are never shown here.</p>
      <button data-testid="credentials-close" onClick={onClose}>
        Close
      </button>
    </PortalShell>
  );
}
