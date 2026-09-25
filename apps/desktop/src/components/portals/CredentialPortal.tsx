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
    <PortalShell label="مجموعات المفاتيح" onClose={onClose}>
      <dl data-testid="credential-counts">
        <dt>مجموعة Groq</dt>
        <dd data-testid="groq-count">{groqKeys} keys</dd>
        <dt>مجموعة Fish Audio</dt>
        <dd data-testid="fish-count">{fishKeys} keys</dd>
        <dt>مجموعة OpenRouter</dt>
        <dd data-testid="openrouter-count">{openrouterKeys} keys</dd>
      </dl>
      <p>القيم محفوظة في الخزنة المشفرة ولا تظهر هنا أبداً.</p>
      <button data-testid="credentials-close" onClick={onClose}>
        إغلاق
      </button>
    </PortalShell>
  );
}
