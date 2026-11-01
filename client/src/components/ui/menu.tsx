import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Check } from 'lucide-react';

export type MenuItem =
  | { kind: 'link'; label: string; to: string; icon?: ReactNode }
  | { kind: 'action'; label: string; onSelect: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean }
  | { kind: 'radio' | 'check'; label: string; checked: boolean; onSelect: () => void }
  | { kind: 'label'; label: string }
  | { kind: 'separator' };

/**
 * A popup menu at a viewport point: right-click, the ⋯ button, long-press and the bulk bar all
 * open it. Arrow keys move, Enter or Space choose, Escape and Tab close; focus returns to
 * `returnFocus`. It keeps itself inside the viewport.
 */
export function Menu({
  label,
  items,
  at,
  onClose,
  returnFocus,
}: {
  label: string;
  items: MenuItem[];
  at: { x: number; y: number };
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState(at);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    setPlace({
      x: Math.max(margin, Math.min(at.x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, at.y + rect.height > window.innerHeight - margin ? at.y - rect.height : at.y),
    });
    entries()[0]?.focus();
  }, [at.x, at.y]);

  useEffect(() => {
    function onPointer(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) close(false);
    }
    function onScroll() {
      close(false);
    }
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  });

  function entries(): HTMLElement[] {
    return Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []);
  }

  function close(restore = true) {
    onClose();
    if (restore) returnFocus?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = entries();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      list[(next + list.length) % list.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(list.length - 1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') close(false);
  }

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={label}
      style={{ left: place.x, top: place.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => {
        if (item.kind === 'separator') return <div key={index} className="menu-separator" role="separator" />;
        if (item.kind === 'label') {
          return (
            <div key={index} className="menu-label" role="presentation">
              {item.label}
            </div>
          );
        }
        if (item.kind === 'link') {
          return (
            <Link key={index} className="menu-item" role="menuitem" tabIndex={-1} to={item.to} onClick={() => close(false)}>
              <span className="menu-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </Link>
          );
        }
        if (item.kind === 'action') {
          return (
            <button
              key={index}
              type="button"
              className={item.danger ? 'menu-item menu-item-danger' : 'menu-item'}
              role="menuitem"
              tabIndex={-1}
              aria-disabled={item.disabled ? true : undefined}
              onClick={() => {
                if (item.disabled) return;
                close(false);
                item.onSelect();
              }}
            >
              <span className="menu-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </button>
          );
        }
        return (
          <button
            key={index}
            type="button"
            className="menu-item"
            role={item.kind === 'radio' ? 'menuitemradio' : 'menuitemcheckbox'}
            aria-checked={item.checked}
            tabIndex={-1}
            onClick={() => {
              close(false);
              item.onSelect();
            }}
          >
            <span className="menu-icon" aria-hidden="true">
              {item.checked ? <Check size={15} strokeWidth={2} /> : null}
            </span>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
