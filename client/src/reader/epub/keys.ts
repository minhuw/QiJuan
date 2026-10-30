export type ReadingDirection = 'ltr' | 'rtl';
export type PageTurn = 'next' | 'prev';

export interface ReaderKeyEvent {
  key: string;
  target: EventTarget | null;
  cancelable?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  preventDefault: () => void;
}

/** Inputs inside the chapter iframe are not the parent window's HTMLElement. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const node = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return node.isContentEditable === true;
}

/** Right/down move forward, except in rtl books where left moves forward. */
export function pageTurnForKey(key: string, direction: ReadingDirection): PageTurn | null {
  const forward = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
  const back = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
  if (key === forward || key === 'ArrowDown') return 'next';
  if (key === back || key === 'ArrowUp') return 'prev';
  return null;
}

/**
 * Chapter keydown is often passive (epub.js registers it that way), so cancellation
 * must be skipped when the event refuses it.
 */
export function preventReaderKeyDefault(event: ReaderKeyEvent): void {
  if (event.cancelable === false) return;
  try {
    event.preventDefault();
  } catch {
    // A passive listener cannot cancel the key.
  }
}

export function onReaderKey(
  event: ReaderKeyEvent,
  options: {
    enabled: boolean;
    direction: ReadingDirection;
    next: () => void;
    prev: () => void;
  },
): void {
  if (!options.enabled || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  if (isTypingTarget(event.target)) return;
  const turn = pageTurnForKey(event.key, options.direction);
  if (!turn) return;
  preventReaderKeyDefault(event);
  if (turn === 'next') options.next();
  else options.prev();
}
