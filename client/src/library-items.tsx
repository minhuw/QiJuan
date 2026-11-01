import { useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { Link } from 'react-router';
import { Check, Heart, MoreHorizontal, Star } from 'lucide-react';
import type { LibraryEdition } from './api';
import { BookObject } from './components/ui/book-object';
import { UnidentifiedMark } from './components/ui/identifiers';
import { StatusMark } from './components/ui/status-mark';
import { useLocale } from './shell';

const LONG_PRESS_MS = 500;

/** How a book item reports a menu request and a selection change. */
export interface ItemHandlers {
  selected: boolean;
  /** Some book is selected: a plain click then selects instead of opening. */
  selecting: boolean;
  onSelect: (mode: 'toggle' | 'range') => void;
  onMenu: (at: { x: number; y: number }, returnFocus: HTMLElement | null) => void;
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * Right-click, long-press (touch), the menu key or Shift+F10 open the book's menu; ⌘/Ctrl-click
 * toggles selection and Shift-click selects a range. While anything is selected, a click selects.
 */
export function useBookGestures(handlers: Pick<ItemHandlers, 'onMenu'> & Partial<Pick<ItemHandlers, 'onSelect' | 'selecting'>>) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);

  function cancel() {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }

  return {
    onContextMenu(event: MouseEvent<HTMLElement>) {
      event.preventDefault();
      cancel();
      handlers.onMenu({ x: event.clientX, y: event.clientY }, event.currentTarget);
    },
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.pointerType !== 'touch') return;
      const target = event.currentTarget;
      const { clientX: x, clientY: y } = event;
      cancel();
      press.current = {
        x,
        y,
        timer: setTimeout(() => {
          press.current = null;
          suppressClick.current = true;
          handlers.onMenu({ x, y }, target);
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClick(event: MouseEvent<HTMLElement>) {
      if (suppressClick.current) {
        suppressClick.current = false;
        event.preventDefault();
        return;
      }
      if (!handlers.onSelect) return;
      if (event.shiftKey) {
        event.preventDefault();
        handlers.onSelect('range');
      } else if (event.metaKey || event.ctrlKey || handlers.selecting) {
        event.preventDefault();
        handlers.onSelect('toggle');
      }
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        handlers.onMenu({ x: rect.left + 12, y: rect.top + Math.min(rect.height, 48) }, event.currentTarget);
      }
    },
  };
}

function SelectBox({ book, handlers }: { book: LibraryEdition; handlers: ItemHandlers }) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      className="lib-select"
      role="checkbox"
      aria-checked={handlers.selected}
      aria-label={fill(t('library.select'), { title: book.title })}
      onClick={(event) => handlers.onSelect(event.shiftKey ? 'range' : 'toggle')}
    >
      <Check size={14} strokeWidth={2.5} aria-hidden="true" />
    </button>
  );
}

export function MoreButton({ book, handlers }: { book: LibraryEdition; handlers: ItemHandlers }) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      className="lib-more"
      aria-haspopup="menu"
      aria-label={fill(t('library.moreActions'), { title: book.title })}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        handlers.onMenu({ x: rect.left, y: rect.bottom + 6 }, event.currentTarget);
      }}
    >
      <MoreHorizontal size={18} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

function Signals({ book }: { book: LibraryEdition }) {
  const { t } = useLocale();
  if (!book.status && !book.favorite && !book.rating && book.identified !== false) return null;
  return (
    <span className="lib-signals">
      {book.status ? <StatusMark status={book.status} /> : null}
      {book.favorite ? (
        <span className="favorite-meta">
          <Heart size={12} strokeWidth={1.5} fill="currentColor" aria-hidden="true" />
          <span className="visually-hidden">{t('reading.favorite')}</span>
        </span>
      ) : null}
      {book.rating ? (
        <span className="rating-meta">
          <Star size={12} strokeWidth={1.5} aria-hidden="true" />
          <span className="visually-hidden">{t('reading.rating')} </span>
          {book.rating}
        </span>
      ) : null}
      {book.identified === false ? <UnidentifiedMark /> : null}
    </span>
  );
}

function formatsText(book: LibraryEdition): string {
  return book.formats.map((format) => format.toUpperCase()).join(' · ');
}

/** A book in the grid: the cover as an object, its title and author, and on hover select and ⋯. */
export function LibraryCard({ book, handlers }: { book: LibraryEdition; handlers: ItemHandlers }) {
  const gestures = useBookGestures(handlers);
  const authors = book.authors.join(', ');
  return (
    <li className={handlers.selected ? 'lib-card is-selected' : handlers.selecting ? 'lib-card is-selecting' : 'lib-card'}>
      <Link className="lib-card-link" to={`/books/${book.id}`} {...gestures}>
        <span className="lib-card-cover">
          <BookObject book={book} size="shelf" />
        </span>
        <span className="lib-card-title">{book.title}</span>
        <span className="lib-card-meta">
          {authors ? <span className="lib-card-author">{authors}</span> : null}
          {book.formats.length > 0 ? <span className="lib-card-format">{formatsText(book)}</span> : null}
        </span>
        <Signals book={book} />
      </Link>
      <SelectBox book={book} handlers={handlers} />
      <MoreButton book={book} handlers={handlers} />
    </li>
  );
}

/** A book in the list view: one row with the same select and ⋯ controls. */
export function LibraryRow({ book, handlers }: { book: LibraryEdition; handlers: ItemHandlers }) {
  const gestures = useBookGestures(handlers);
  return (
    <li className={handlers.selected ? 'lib-row is-selected' : handlers.selecting ? 'lib-row is-selecting' : 'lib-row'} onContextMenu={gestures.onContextMenu}>
      <SelectBox book={book} handlers={handlers} />
      <Link className="lib-row-cover" to={`/books/${book.id}`} tabIndex={-1} aria-hidden="true" onClick={gestures.onClick}>
        <BookObject book={book} size="mini" />
      </Link>
      <span className="lib-row-main">
        <Link className="lib-row-title" to={`/books/${book.id}`} {...gestures}>
          {book.title}
        </Link>
        {book.authors.length > 0 ? <span className="lib-row-author">{book.authors.join(', ')}</span> : null}
      </span>
      <span className="lib-row-lang">{book.language ?? ''}</span>
      <span className="lib-row-formats">{formatsText(book)}</span>
      <Signals book={book} />
      <MoreButton book={book} handlers={handlers} />
    </li>
  );
}
