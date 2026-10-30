import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { useLocale } from '../shell';

export function ReaderOptions({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    }
    let blurFrame = 0;
    function frameFocus() {
      blurFrame = requestAnimationFrame(() => {
        if (document.activeElement?.tagName === 'IFRAME') setOpen(false);
      });
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', frameFocus);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', frameFocus);
      cancelAnimationFrame(blurFrame);
    };
  }, [open]);

  return (
    <div className="reader-options" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="reader-tool reader-tool-icon"
        aria-label={t('reader.options')}
        title={t('reader.options')}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <SlidersHorizontal size={18} aria-hidden="true" />
      </button>
      <div
        id={id}
        className="reader-options-body"
        role="dialog"
        aria-label={t('reader.options')}
        hidden={!open}
        onSubmit={() => {
          setOpen(false);
          trigger.current?.focus({ preventScroll: true });
        }}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('[data-dismiss-options]')) {
            setOpen(false);
            trigger.current?.focus({ preventScroll: true });
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Keep keyboard focus attached to the control or panel the reader just opened. */
export function useReaderPanelFocus(panel: string | null) {
  const root = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (panel) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && !root.current?.contains(active)) {
        opener.current = active;
      }
      const target = panel === 'search' ? root.current?.querySelector<HTMLInputElement>('input') : null;
      (target ?? root.current)?.focus({ preventScroll: true });
    } else if (opener.current) {
      if (opener.current.isConnected && !opener.current.closest('[hidden]')) opener.current.focus({ preventScroll: true });
      opener.current = null;
    }
  }, [panel]);

  return root;
}
