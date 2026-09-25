// SessionChip — active project/session indicator + switcher. Renders only
// what the daemon has surfaced: with an empty list it shows the active id
// (or unassigned), never fabricated sessions.
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
  return (
    <div data-testid="session-chip" role="group" aria-label="جلسة المشروع النشطة">
      {sessions.length === 0 ? (
        <span data-testid="session-active-only">{activeId ?? 'غير معيّنة'}</span>
      ) : (
        <ul data-testid="session-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                data-testid={`session-${s.id}`}
                aria-current={s.id === activeId}
                title={`تبديل إلى الجلسة ${s.id} (${s.state})`}
                onClick={() => onSelect(s.id)}
              >
                {s.id} · {s.state}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
