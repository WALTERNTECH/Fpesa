import { useEffect, useRef, type ReactNode } from 'react';
import { IconClose } from './Icons';

type Props = {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
};

export function Modal({ title, subtitle, onClose, children }: Props): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);

  // Held in a ref so the effect below can run exactly once while still calling
  // the current handler. Callers pass an inline arrow, which is a new reference
  // on every render — and this dialog re-renders four times a second, because
  // the app's context changes on every price tick.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);

    // Stop the page behind the dialog from scrolling on mobile.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    /**
     * Move focus into the dialog so keyboard and screen-reader users land here.
     *
     * This must happen once, on open, and never again. When it depended on the
     * onClose identity it re-ran on every price tick and dragged focus back to
     * the first field several times a second, which made the amount box
     * impossible to type into on a phone — the keyboard was dismissed between
     * keystrokes. Tapping a preset still worked, which is what made it look
     * like the input was deliberately locked rather than broken.
     */
    const focusable = panelRef.current?.querySelector<HTMLElement>(
      'input, button, select, textarea'
    );
    focusable?.focus();

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <IconClose size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
