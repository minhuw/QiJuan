import { useEffect, useId, useRef, type MouseEvent, type SyntheticEvent } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * A modal confirm for destructive actions, on the native <dialog>: focus is trapped and the page
 * behind is inert. Focus starts on Cancel and returns to `returnFocusId` when it closes. Escape and
 * Cancel close it; the backdrop closes it only when `dismissOnBackdrop` (reversible actions).
 * Render it only while open; it opens itself on mount.
 */
export function ConfirmDialog({
  title,
  text,
  action,
  cancel,
  pending,
  error,
  dismissOnBackdrop = false,
  returnFocusId,
  onConfirm,
  onCancel,
}: {
  title: string;
  text: string;
  action: string;
  cancel: string;
  pending: boolean;
  /** Shown inside the dialog, which stays open so the action can be tried again. */
  error?: string | null;
  dismissOnBackdrop?: boolean;
  returnFocusId?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    cancelRef.current?.focus();
    return () => {
      if (dialog?.open && typeof dialog.close === 'function') dialog.close();
      if (returnFocusId) document.getElementById(returnFocusId)?.focus();
    };
  }, [returnFocusId]);

  function dismiss() {
    if (!pendingRef.current) onCancel();
  }

  // Escape fires `cancel`; keep the dialog under React's control instead of letting it close itself.
  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    dismiss();
  }

  // A press on the dialog element itself, outside the sheet, is a press on the backdrop.
  function handleClick(event: MouseEvent<HTMLDialogElement>) {
    if (dismissOnBackdrop && event.target === event.currentTarget) dismiss();
  }

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-text`}
      aria-busy={pending ? true : undefined}
      onCancel={handleCancel}
      onClick={handleClick}
    >
      <div className="confirm-dialog-sheet">
        <h2 className="confirm-dialog-title" id={`${id}-title`}>
          {title}
        </h2>
        <p className="confirm-dialog-text" id={`${id}-text`}>
          {text}
        </p>
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} className="btn btn-sm" type="button" disabled={pending} onClick={dismiss}>
            {cancel}
          </button>
          <button className="btn btn-sm btn-danger" type="button" disabled={pending} onClick={onConfirm}>
            {pending ? <Loader2 className="spin" size={14} strokeWidth={1.5} aria-hidden="true" /> : null}
            {action}
          </button>
        </div>
      </div>
    </dialog>
  );
}
