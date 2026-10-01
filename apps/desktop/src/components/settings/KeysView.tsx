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
  //
  // C.1: 'error' is a THIRD outcome, and it is not a flavour of 'warn'. The
  // host command fails closed by DELETING `keyring.dat` (main.rs:917-919), so
  // 'error' means the encrypted store is gone and the keys must be re-entered.
  // 'skipped' (no Tauri host) still renders nothing at all.
  const [dacl, setDacl] = useState<'ok' | 'warn' | 'error' | 'skipped' | null>(null);
  // Bumped to wipe the form after a lost keyring: the inputs are uncontrolled,
  // so only a remount clears the secret strings the operator typed.
  const [formKey, setFormKey] = useState(0);
  const bridgeRef = useRef<VoxauraBridge | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // W20 — see the identical comment in `SettingsView.tsx`; the reasoning is the
  // same and it belongs to both call sites. Short version: `enabled` defaults to
  // false, so this call was complete-looking and inert; these are separate
  // frames with their own minimum bounds, which is the case the stand-down's own
  // reason 2 exists for; and this file's root clips (`overflow-hidden`, line 145)
  // under a global scrollbar-hiding rule, so a form taller than the frame was
  // unreachable with nothing on screen to say so.
  //
  // The 460 floor is the window's own `minHeight` (`open-settings.ts`), so the
  // hook can never push below what the OS would allow — the two agree by
  // construction rather than by luck, and `useAutoSize.test.tsx` pins the pair.
  useAutoSize(rootRef, {
    enabled: true,
    minWidth: 560,
    minHeight: 460,
    maxWidth: 820,
    maxHeight: 1000,
    paddingX: 2,
    paddingY: 2,
  });

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
        // no longer guaranteed. Re-apply it BEFORE showing the receipt. The
        // button stays disabled until the verdict lands: two quick saves must
        // not interleave verdicts.
        //
        // C.1: the three verdicts are materially different and none of them
        // may be folded into `saveError`, which means "the server rejected your
        // keys" and would be a lie — the daemon did record them.
        //   - ok              the host confirmed the owner-only ACL.
        //   - warn            the host ran and did not confirm. The keys ARE on
        //                     disk with an ACL nobody can vouch for.
        //   - error           the host FAILED, and that path deletes
        //                     keyring.dat. There is nothing at rest to claim a
        //                     receipt for, so the green line is withdrawn, the
        //                     form is wiped and the operator re-enters.
        let locked: 'ok' | 'warn' | 'error' | 'skipped' = 'warn';
        try {
          const res = await restrictVaultFile();
          // `skipped` = no Tauri host (web/E2E): render NOTHING. An 'ok' line
          // here would assert a lock that never happened. The two failure
          // states are mapped EXPLICITLY, one at a time — collapsing them back
          // into `res.ok` is the bug this case was written for.
          if (res === null) locked = 'skipped';
          else if (res.state === 'ok') locked = 'ok';
          else if (res.state === 'keyring-lost') locked = 'error';
          else locked = 'warn';
        } catch {
          // restrictVaultFile does not throw; this is belt-and-braces only,
          // and a thrown verdict is no evidence that a file was deleted.
          locked = 'warn';
        }
        if (locked === 'error') {
          setDacl('error');
          setSavedAt(null);
          // C.1: the form is the only place the renderer ever held these
          // strings, and the operator must enter them again. Bumping the key
          // is what empties uncontrolled inputs.
          setFormKey((k) => k + 1);
          setSaving(false);
          return;
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
        {/* C.1: `key` is the wipe. The inputs are uncontrolled, so no amount of
            re-rendering empties them — a remount does, and it takes the
            presence flags with it, so the form comes back as "nothing
            entered" and Save is disabled until the keys are re-typed. */}
        <ApiKeysModal
          key={formKey}
          onSave={save}
          onClose={() => void closeCurrentWindow()}
          saving={saving}
          saveError={error}
          embedded
        />
        {dacl === 'error' && (
          // C.1 — the red arm. We are not claiming to have inspected the disk:
          // the honest statement is that the lock could not be confirmed, that
          // the host deletes the keyring on this path, and that the keys have
          // to be entered again to be encrypted and locked once more. Rendered
          // ABOVE the form's own state and with the receipt withheld, because a
          // green "keys saved" line above a deleted keyring is the one thing
          // this surface must never do.
          <p
            data-testid="keys-dacl-error"
            role="alert"
            className="mt-4 rounded-lg border border-[#7f1d1d] bg-[#2a1215] px-3 py-2 text-xs text-[#fca5a5]"
          >
            ما نقدر نأكد قفل الملف، وعند فشل القفل المضيف يحذف keyring.dat — أعد إدخال المفاتيح الثلاثة /
            Lock unconfirmed; the host deletes keyring.dat on this path — re-enter all three keys
          </p>
        )}
        {dacl !== null && dacl !== 'error' && savedAt !== null && (
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
              // out loud and is NOT a reason to re-enter credentials. (That is
              // true of THIS arm only — see the red arm above.)
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