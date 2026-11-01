import { BookOpen, ExternalLink, Pencil, Trash2 } from 'lucide-react';
import type { LibraryEdition, LibraryShelf, ReadingStatus } from './api';
import { setFavorite, setOnShelf, setStatus } from './book-actions';
import type { MenuItem } from './components/ui/menu';

export const BOOK_STATUSES: ReadingStatus[] = ['want', 'reading', 'finished', 'on_hold'];

type Change = () => Promise<{ patch: Partial<LibraryEdition> } | { error: string }>;

/**
 * The book menu shared by the Library and Reading tabs: Open, Read or Continue, status,
 * favourite, shelves, and for admins Edit details and Move to Trash. `run` performs a change and
 * updates the page; `onTrash` asks the page to confirm a removal.
 */
export function bookMenuItems(
  book: LibraryEdition,
  options: {
    t: (key: string) => string;
    admin: boolean;
    shelves: LibraryShelf[];
    run: (book: LibraryEdition, change: Change) => void;
    onTrash: (book: LibraryEdition) => void;
  },
): MenuItem[] {
  const { t, admin, shelves, run } = options;
  const items: MenuItem[] = [
    { kind: 'link', label: t('library.menu.open'), to: `/books/${book.id}`, icon: <ExternalLink size={15} strokeWidth={1.75} /> },
  ];
  if (book.readAssetId) {
    items.push({
      kind: 'link',
      label: book.status === 'reading' ? t('readingTab.continue') : t('library.menu.read'),
      to: `/books/${book.id}/read/${book.readAssetId}`,
      icon: <BookOpen size={15} strokeWidth={1.75} />,
    });
  }
  items.push({ kind: 'separator' }, { kind: 'label', label: t('library.status') });
  for (const item of BOOK_STATUSES) {
    items.push({
      kind: 'radio',
      label: t(`reading.${item}`),
      checked: book.status === item,
      onSelect: () => run(book, () => setStatus(book.id, book.status === item ? null : item)),
    });
  }
  items.push(
    { kind: 'separator' },
    { kind: 'check', label: t('reading.favorite'), checked: book.favorite, onSelect: () => run(book, () => setFavorite(book.id, !book.favorite)) },
  );
  if (shelves.length > 0) {
    items.push({ kind: 'separator' }, { kind: 'label', label: t('library.shelves') });
    for (const shelf of shelves) {
      const on = book.shelfIds?.includes(shelf.id) ?? false;
      items.push({ kind: 'check', label: shelf.name, checked: on, onSelect: () => run(book, () => setOnShelf(book.id, shelf.id, !on)) });
    }
  }
  if (admin) {
    items.push(
      { kind: 'separator' },
      { kind: 'link', label: t('library.menu.edit'), to: `/books/${book.id}#details`, icon: <Pencil size={15} strokeWidth={1.75} /> },
      { kind: 'action', label: t('trash.removeAction'), danger: true, icon: <Trash2 size={15} strokeWidth={1.75} />, onSelect: () => options.onTrash(book) },
    );
  }
  return items;
}
