import { useEffect, useRef, useState } from 'react';
import { ApiKeysModal, type ApiKeyBundle } from '../portals/ApiKeysModal.js';
import { VoxauraBridge } from '../../bridge/ws.js';
import { resolveIpcToken } from '../../settings/ipc-token.js';
import { restrictVaultFile } from '../../settings/vault-dacl.js';
import { useAutoSize } from '../../window/useAutoSize.js';
import { closeCurrentWindow } from '../../window/close-current-window.js';

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
  // A.2: save succeeded and DACL re-lock are SEPARATE facts. 'pending' is never
  // rendered — the receipt and the lock land in the same commit, so the user
  // never sees a "saved" line that still needs a re-lock.
  const [dacl, setDacl] = useState<'ok' | 'warn' | 'skipped' | null>(null);
  const bridgeRef = useRef<VoxauraBridge | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useAutoSize(rootRef, { minWidth: 560, minHeight: 460, maxWidth: 820, maxHeight: 1000, paddingX: 2, paddingY: 2 });

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
      if (e.key === 'Escape') void closeCurrentWindow();
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
      .then(async (ok) => {
        if (!ok) {
          setDacl(null);
          setSavedAt(null);
          setError('رفض الخادم المفاتيح — الثلاثة مطلوبة');
          setSaving(false);
          return;
        }
        // A.2: the save rewrote keyring.dat, so the startup owner-only DACL is
        // no longer guaranteed. Re-apply it BEFORE showing the receipt, and
        // never fold a lock failure into saveError — the keys ARE on disk, and
        // telling the user to re-enter them would be a lie. The button stays
        // disabled until the verdict lands: two quick saves must not interleave
        // verdicts.
        let locked: 'ok' | 'warn' | 'skipped' = 'warn';
        try {
          const res = await restrictVaultFile();
          // `skipped` = no Tauri host (web/E2E): render NOTHING. An 'ok' line
          // here would assert a lock that never happened.
          locked = res === null ? 'skipped' : res.ok ? 'ok' : 'warn';
        } catch {
          locked = 'warn';
        }
        setDacl(locked);
        setSavedAt(new Date().toLocaleTimeString('ar'));
        setSaving(false);
      });
  };

  return (
    <div
      ref={rootRef}
      dir="rtl"
      data-testid="keys-view"
      className="flex w-full flex-col overflow-hidden bg-[#121316] text-[#f4f4f5]"
      style={{ fontFamily: 'var(--vx-font)' }}
    >
      <header className="flex items-center gap-3 border-b border-[#26282e] bg-[#18191d] px-5 py-3">
        <h1 className="text-sm font-semibold">مفاتيح الـ API</h1>
        <span className="text-xs text-[#71717a]">تُحفظ مشفّرة محلياً في vault/keyring.dat</span>
        <span className="vx-kbd ms-auto">Esc</span>
      </header>
      <main className="flex-1 overflow-y-auto p-5">
        <ApiKeysModal onSave={save} onClose={() => void closeCurrentWindow()} saving={saving} saveError={error} embedded />
        {savedAt !== null && (
          <div className="mt-4 space-y-1">
            <p data-testid="keys-saved" className="text-sm text-[#4ade80]">
              حُفظت المفاتيح · {savedAt}
            </p>
            {dacl === 'ok' && (
              <p data-testid="keys-dacl-ok" className="text-xs text-[#a1a1aa]">
                الملف مقصور على صاحب الحساب — Owner-only
              </p>
            )}
            {dacl === 'warn' && (
              // AMBER, not red: the keys are saved and encrypted. What failed is
              // narrowing the ACL to the owner account, which is worth saying
              // out loud and is NOT a reason to re-enter credentials.
              <p data-testid="keys-dacl-warn" role="status" className="text-xs text-[#fbbf24]">
                حُفظت المفاتيح، بس ما قدرنا نأكد صلاحيات الملف للمالك وحده — Owner-only ACL unconfirmed
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}