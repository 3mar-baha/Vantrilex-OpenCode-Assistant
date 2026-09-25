import { useEffect, useRef, useState } from 'react';
import { ApiKeysModal, type ApiKeyBundle } from '../portals/ApiKeysModal.js';
import { VoxauraBridge } from '../../bridge/ws.js';
import { resolveIpcToken } from '../../settings/ipc-token.js';

// KeysView — the dedicated API-keys window (?view=keys). Decoupled from the
// general settings window so the credential task has a focused surface: no
// tabs, no unrelated panels, just the mandatory 3-key intake and a receipt.
function nextCmdId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `cmd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export function KeysView(): JSX.Element {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const bridgeRef = useRef<VoxauraBridge | null>(null);

  useEffect(() => {
    let disposed = false;
    let client: VoxauraBridge | null = null;
    void resolveIpcToken().then((token) => {
      if (disposed || token === undefined) return;
      const b = new VoxauraBridge({
      token,
      contractVersion: '3.1.0',
      onHello: () => undefined,
      onEvent: () => undefined,
      onClose: () => undefined,
      onRefusal: () => undefined,
    });
      client = b;
      bridgeRef.current = b;
      b.connect();
    });
    return () => {
      disposed = true;
      client?.dispose();
      bridgeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const save = (keys: ApiKeyBundle): void => {
    const bridge = bridgeRef.current;
    if (bridge === null) {
      setError('الخادم غير متصل — لم تُرسل المفاتيح');
      return;
    }
    setSaving(true);
    setError(undefined);
    void bridge
      .sendCommand({
        id: nextCmdId(),
        kind: 'saveApiKeys',
        groqKey: keys.groq,
        fishKey: keys.fish,
        openrouterKey: keys.openrouter,
      })
      .then((ok) => {
        setSaving(false);
        if (ok) setSavedAt(new Date().toLocaleTimeString('ar'));
        else setError('رفض الخادم المفاتيح — الثلاثة مطلوبة');
      });
  };

  return (
    <div
      dir="rtl"
      data-testid="keys-view"
      className="flex h-screen w-screen flex-col overflow-hidden bg-[#121316] text-[#f4f4f5]"
      style={{ fontFamily: 'var(--vx-font)' }}
    >
      <header className="flex items-center gap-3 border-b border-[#26282e] bg-[#18191d] px-5 py-3">
        <h1 className="text-sm font-semibold">مفاتيح الـ API</h1>
        <span className="text-xs text-[#71717a]">تُحفظ مشفّرة محلياً في vault/keyring.dat</span>
        <span className="vx-kbd ms-auto">Esc</span>
      </header>
      <main className="flex-1 overflow-y-auto p-5">
        <ApiKeysModal onSave={save} onClose={() => window.close()} saving={saving} saveError={error} embedded />
        {savedAt !== null && (
          <p data-testid="keys-saved" className="mt-4 text-sm text-[#4ade80]">
            حُفظت المفاتيح · {savedAt}
          </p>
        )}
      </main>
    </div>
  );
}