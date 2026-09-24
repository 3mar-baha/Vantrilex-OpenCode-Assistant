import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Floating dialog portal shell — focus trap, Esc to close, focus restore.
// Pure DOM behavior; the daemon owns all data shown inside.
export interface PortalShellProps {
  readonly label: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function PortalShell({ label, onClose, children }: PortalShellProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const first = root?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        closeRef.current();
        return;
      }
      if (ev.key !== 'Tab' || root === null) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.hasAttribute('disabled'),
      );
      if (items.length === 0) return;
      const firstItem = items[0] as HTMLElement;
      const lastItem = items[items.length - 1] as HTMLElement;
      if (ev.shiftKey && document.activeElement === firstItem) {
        ev.preventDefault();
        lastItem.focus();
      } else if (!ev.shiftKey && document.activeElement === lastItem) {
        ev.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previouslyFocused?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="voxaura-portal"
      data-testid="portal-shell"
    >
      {children}
    </div>,
    document.body,
  );
}
