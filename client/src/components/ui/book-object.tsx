import { useCallback, useState } from 'react';
import type { LibraryEdition } from '../../api';
import { CoverArt } from './cover-art';

/** Height over width of the shared book shape; keep in step with `--book-aspect` (5 / 7). */
export const BOOK_ASPECT = 7 / 5;
/** A cover within this fraction of the book shape fills it; the trim is too small to notice. */
const FILL_TOLERANCE = 0.06;

/**
 * How a cover with this height/width ratio sits in the book shape: null fills it (trimmed from
 * the centre), a number shows it whole at that fraction of the shape's width. A taller cover is
 * narrower at full height; a wider one keeps the full width and is shorter.
 */
export function coverFit(ratio: number): number | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  if (Math.abs(ratio / BOOK_ASPECT - 1) <= FILL_TOLERANCE) return null;
  return Math.min(1, BOOK_ASPECT / ratio);
}

/** Each cover's ratio once loaded, so a remounted book takes its shape at once. */
const knownRatios = new Map<number, number>();

/** A cover drawn as a book: no mat or frame, soft depth and a spine highlight. */
export function BookObject({ book, size, eager = false }: { book: Pick<LibraryEdition, 'id' | 'title' | 'authors' | 'hasCover'>; size: 'hero' | 'shelf' | 'mini'; eager?: boolean }) {
  const [ratio, setRatio] = useState<number | null>(() => knownRatios.get(book.id) ?? null);
  const onImage = useCallback(
    (image: HTMLImageElement) => {
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
      const next = image.naturalHeight / image.naturalWidth;
      knownRatios.set(book.id, next);
      setRatio(next);
    },
    [book.id],
  );
  const fit = book.hasCover && ratio !== null ? coverFit(ratio) : null;
  return (
    <span
      className={fit === null ? `book-object book-object-${size}` : `book-object book-object-${size} book-object-whole`}
      style={fit === null ? undefined : { width: `${(fit * 100).toFixed(2)}%` }}
    >
      <CoverArt editionId={book.id} title={book.title} author={book.authors[0]} hasCover={book.hasCover} eager={eager} onImage={onImage} />
    </span>
  );
}
