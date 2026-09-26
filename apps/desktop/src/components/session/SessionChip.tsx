import { useEffect, useRef, useState } from 'react';

// SessionChip — compact active-session indicator + switcher (single row).
//
// Historical sessions previously rendered as a vertical stack, which stretched
// the auto-sized HUD and pushed the mic + visualizer off screen. Now the chip
// is one fixed-height row showing only the active session; the full history
// lives in a dropdown that opens on demand and closes on select / outside
// click / Escape. The list is never in the DOM while collapsed, so it can
// never affect the window's measured height.
export interface ChipSession {
  readonly id: string;
  readonly state: string;
}

export interface SessionChipProps {
  readonly sessions: readonly ChipSession[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
}

export function SessionChip({ sessions, activeId, onSelect }: SessionChipProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (sessions.length === 0) {
    return (
      <div data-testid="session-chip" className="vx-session-bar" role="group" aria-label="جلسة المشروع النشطة">
        <span data-testid="session-active-only" className="vx-mono-metric text-xs text-[#71717a]">
          {activeId ?? 'غير معيّنة'}
        </span>
      </div>
    );
  }

  const active = sessions.find((s) => s.id === activeId) ?? null;

  const choose = (id: string): void => {
    setOpen(false);
    onSelect(id);
  };

  return (
    <div
      ref={rootRef}
      data-testid="session-chip"
      className="vx-session-bar relative"
      role="group"
      aria-label="جلسة المشروع النشطة"
    >
      <button
        type="button"
        data-testid="session-chip-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="تبديل الجلسة"
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 w-full items-center gap-2 rounded-[6px] border border-[#26282e] bg-[#0e0f12] px-3 text-xs text-[#f4f4f5] hover:border-[#2563eb]"
      >
        <span aria-hidden className="text-[#2563eb]">◆</span>
        <span data-testid="session-active-label" className="vx-mono-metric truncate">
          {active !== null ? active.id : (activeId ?? 'غير معيّنة')}
        </span>
        {active !== null && <span className="vx-mono-metric shrink-0 text-[#71717a]">· {active.state}</span>}
        <span aria-hidden className="ms-auto text-[#71717a]">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <ul
          data-testid="session-list"
          role="listbox"
          aria-label="الجلسات السابقة"
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-[240px] overflow-y-auto rounded-[6px] border border-[#2563eb] bg-[#0e0f12] py-1 shadow-lg"
        >
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                role="option"
                data-testid={`session-${s.id}`}
                aria-current={s.id === activeId}
                title={`تبديل إلى الجلسة ${s.id} (${s.state})`}
                onClick={() => choose(s.id)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-start text-xs hover:bg-[#1d1e23] ${
                  s.id === activeId ? 'text-[#2563eb]' : 'text-[#a1a1aa]'
                }`}
              >
                <span className="vx-mono-metric truncate">{s.id}</span>
                <span className="vx-mono-metric ms-auto shrink-0 text-[#71717a]">{s.state}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
