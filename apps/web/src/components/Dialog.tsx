import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/** Native <dialog> modal: focus trapped by the platform, Escape closes, backdrop click closes. */
export function Dialog({ title, open, onClose, children, footer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dlg-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-body" onClick={(e) => e.stopPropagation()}>
        <h2 id="dlg-title">{title}</h2>
        {children}
      </div>
      {footer && (
        <div className="dialog-foot" onClick={(e) => e.stopPropagation()}>
          {footer}
        </div>
      )}
    </dialog>
  );
}
