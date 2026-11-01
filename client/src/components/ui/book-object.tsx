import type { LibraryEdition } from '../../api';
import { CoverArt } from './cover-art';

/** A cover drawn as a book: no mat or frame, soft depth and a spine highlight. */
export function BookObject({ book, size, eager = false }: { book: Pick<LibraryEdition, 'id' | 'title' | 'authors' | 'hasCover'>; size: 'hero' | 'shelf' | 'mini'; eager?: boolean }) {
  return (
    <span className={`book-object book-object-${size}`}>
      <CoverArt editionId={book.id} title={book.title} author={book.authors[0]} hasCover={book.hasCover} eager={eager} />
    </span>
  );
}
