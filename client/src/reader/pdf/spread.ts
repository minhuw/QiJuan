/**
 * Two-page spreads as in a printed book: the first page (the cover) stands alone on the right,
 * then pages pair up left and right, (2, 3), (4, 5), …, and an even last page stands alone on
 * the left.
 */
export interface Spread {
  left: number | null;
  right: number | null;
}

export function spreadOf(page: number, pageCount: number): Spread {
  if (pageCount < 1) return { left: null, right: null };
  const clamped = Math.max(1, Math.min(pageCount, Math.trunc(page)));
  if (clamped === 1) return { left: null, right: 1 };
  const left = clamped % 2 === 0 ? clamped : clamped - 1;
  return { left, right: left + 1 <= pageCount ? left + 1 : null };
}

/** The pages of the spread holding `page`, in reading order. */
export function spreadPages(page: number, pageCount: number): number[] {
  const { left, right } = spreadOf(page, pageCount);
  return [left, right].filter((value): value is number => value !== null);
}

/** 0 for the cover, then 1 for (2, 3), 2 for (4, 5), … */
export function spreadIndex(page: number): number {
  return Math.floor(Math.max(1, Math.trunc(page)) / 2);
}

/** The page that opens the neighbouring spread, or null at either end of the book. */
export function spreadTurnTarget(page: number, pageCount: number, turn: 'next' | 'prev'): number | null {
  const pages = spreadPages(page, pageCount);
  if (pages.length === 0) return null;
  if (turn === 'next') {
    const last = pages[pages.length - 1]!;
    return last < pageCount ? last + 1 : null;
  }
  const first = pages[0]!;
  return first > 1 ? first - 1 : null;
}

/** A move between adjacent spreads is a page turn; any other move is a jump. */
export function spreadTurn(from: number, to: number): 'next' | 'prev' | null {
  const step = spreadIndex(to) - spreadIndex(from);
  return step === 1 ? 'next' : step === -1 ? 'prev' : null;
}
