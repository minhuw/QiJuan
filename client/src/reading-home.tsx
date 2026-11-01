import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight, BookOpen, Library, MoreHorizontal } from 'lucide-react';
import { api, type ContinueBook, type HomePayload, type LibraryEdition, type LibraryPage } from './api';

/** Opens the shared book menu at a point, returning focus to `returnFocus` when it closes. */
type OpenMenu = (book: LibraryEdition, at: { x: number; y: number }, returnFocus: HTMLElement | null) => void;
import { BookObject } from './components/ui/book-object';
import { ErrorNotice, LoadingState } from './components/ui/states';
import { bookMenuItems } from './book-menu';
import { ConfirmDialog } from './components/ui/confirm-dialog';
import { Menu } from './components/ui/menu';
import { lastReadText, RemovalBand, type RemovalNotice } from './library';
import { MoreButton, useBookGestures, type ItemHandlers } from './library-items';
import { useLocale } from './shell';

const WANT_LIMIT = 12;

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** Where the reader opens: the file last read, or the book page when none is known. */
function continueHref(book: ContinueBook): string {
  return book.assetId ? `/books/${book.id}/read/${book.assetId}` : `/books/${book.id}`;
}

function percentText(locale: string, fraction: number): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(fraction);
}

/** "p. 212 of 629 · 34%" for PDFs, "34% read" otherwise; null until a reader has reported progress. */
export function progressText(t: (key: string) => string, locale: string, book: ContinueBook): string | null {
  const progress = book.progress;
  if (!progress) return null;
  const percent = percentText(locale, progress.fraction);
  if (progress.page && progress.pageCount) {
    return fill(t('readingTab.progressPages'), { page: String(progress.page), pages: String(progress.pageCount), percent });
  }
  return fill(t('readingTab.progressPercent'), { percent });
}

function ProgressBar({ fraction }: { fraction: number }) {
  return (
    <span className="progress-bar" aria-hidden="true">
      <span className="progress-bar-fill" style={{ width: `${Math.round(fraction * 1000) / 10}%` }} />
    </span>
  );
}

/** The book read last, on a soft wash of its own cover. */
function Hero({ book, onMenu }: { book: ContinueBook; onMenu: OpenMenu }) {
  const { t, locale } = useLocale();
  const gestures = useBookGestures({ onMenu: (at, focus) => onMenu(book, at, focus) });
  const read = lastReadText(book.updatedAt, locale);
  const tint = book.coverTint
    ? ({ '--tint-day': book.coverTint.light, '--tint-night': book.coverTint.dark } as CSSProperties)
    : undefined;
  const progress = book.progress ?? null;
  return (
    <section className="rh-hero" style={tint} aria-labelledby="rh-hero-title" onContextMenu={gestures.onContextMenu}>
      {book.hasCover ? <img className="rh-hero-wash" src={`/api/editions/${book.id}/cover`} alt="" aria-hidden="true" /> : null}
      <div className="rh-hero-inner">
        <Link className="rh-hero-cover" to={continueHref(book)} tabIndex={-1} aria-hidden="true">
          <BookObject book={book} size="hero" eager />
        </Link>
        <div className="rh-hero-copy">
          <p className="rh-eyebrow">
            {t('readingTab.continue')}
            {read ? (
              <>
                {' · '}
                <time dateTime={book.updatedAt}>
                  {t('library.lastRead')} {read}
                </time>
              </>
            ) : null}
          </p>
          <h2 className="rh-hero-title" id="rh-hero-title">
            {book.title}
          </h2>
          {book.authors.length > 0 ? <p className="rh-hero-authors">{book.authors.join(', ')}</p> : null}
          {progress ? (
            <div className="rh-hero-progress">
              <ProgressBar fraction={progress.fraction} />
              <p className="rh-hero-figures">
                <strong>{percentText(locale, progress.fraction)}</strong>
                {progress.page && progress.pageCount ? (
                  <span>{fill(t('readingTab.pageOf'), { page: String(progress.page), pages: String(progress.pageCount) })}</span>
                ) : null}
              </p>
            </div>
          ) : null}
          <div className="rh-hero-actions">
            <Link className="soft-button soft-button-primary" to={continueHref(book)} aria-label={`${t('readingTab.continue')}: ${book.title}`}>
              <BookOpen size={17} strokeWidth={1.75} aria-hidden="true" />
              {t('readingTab.continue')}
            </Link>
            <Link className="soft-button soft-button-quiet" to={`/books/${book.id}`}>
              {t('readingTab.details')}
            </Link>
            <button
              type="button"
              className="soft-button soft-button-quiet soft-button-icon"
              aria-haspopup="menu"
              aria-label={t('library.moreActions').replace('{title}', book.title)}
              title={t('library.moreActions').replace('{title}', book.title)}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onMenu(book, { x: rect.left, y: rect.bottom + 6 }, event.currentTarget);
              }}
            >
              <MoreHorizontal size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionHead({ id, title, more }: { id: string; title: string; more?: { to: string; label: string } }) {
  return (
    <div className="section-head">
      <h2 id={id}>{title}</h2>
      {more ? (
        <Link className="section-more" to={more.to}>
          {more.label}
          <ArrowRight size={15} strokeWidth={1.75} aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

function AlsoReading({ books, onMenu }: { books: ContinueBook[]; onMenu: OpenMenu }) {
  const { t, locale } = useLocale();
  return (
    <section className="rh-section" aria-labelledby="rh-also">
      <SectionHead id="rh-also" title={t('readingTab.alsoReading')} />
      <ul className="rh-cards">
        {books.map((book) => (
          <MenuItemShell key={book.id} book={book} onMenu={onMenu}>
            {(gestures) => (
            <Link className="rh-card" to={continueHref(book)} {...gestures}>
              <BookObject book={book} size="mini" />
              <span className="rh-card-copy">
                <span className="rh-card-title">{book.title}</span>
                {book.authors.length > 0 ? <span className="rh-card-authors">{book.authors.join(', ')}</span> : null}
                {book.progress ? (
                  <span className="rh-card-progress">
                    <ProgressBar fraction={book.progress.fraction} />
                    <span>{progressText(t, locale, book)}</span>
                  </span>
                ) : null}
              </span>
            </Link>
            )}
          </MenuItemShell>
        ))}
      </ul>
    </section>
  );
}

/** A list item whose book opens the shared menu by right-click, long-press, keyboard or ⋯. */
function MenuItemShell({
  book,
  onMenu,
  children,
}: {
  book: LibraryEdition;
  onMenu: OpenMenu;
  children: (gestures: ReturnType<typeof useBookGestures>) => ReactNode;
}) {
  const handlers: ItemHandlers = { selected: false, selecting: false, onSelect: () => undefined, onMenu: (at, focus) => onMenu(book, at, focus) };
  const gestures = useBookGestures({ onMenu: handlers.onMenu });
  return (
    <li className="menu-host">
      {children(gestures)}
      <MoreButton book={book} handlers={handlers} />
    </li>
  );
}

function Shelf({ books, onMenu }: { books: LibraryEdition[]; onMenu: OpenMenu }) {
  const { t } = useLocale();
  return (
    <section className="rh-section" aria-labelledby="rh-want">
      <SectionHead id="rh-want" title={t('reading.want')} more={{ to: '/library', label: t('readingTab.seeLibrary') }} />
      <ul className="book-shelf">
        {books.map((book) => (
          <MenuItemShell key={book.id} book={book} onMenu={onMenu}>
            {(gestures) => (
            <Link className="book-shelf-book" to={`/books/${book.id}`} {...gestures}>
              <BookObject book={book} size="shelf" />
              <span className="book-shelf-title">{book.title}</span>
              {book.authors.length > 0 ? <span className="book-shelf-authors">{book.authors.join(', ')}</span> : null}
            </Link>
            )}
          </MenuItemShell>
        ))}
      </ul>
    </section>
  );
}

/** The Reading tab: the book read last, the others in progress, then Want to read as one shelf. */
export function ReadingHome({ role = 'reader' }: { role?: 'admin' | 'reader' }) {
  const { t } = useLocale();
  const admin = role === 'admin';
  const [menu, setMenu] = useState<{ book: LibraryEdition; at: { x: number; y: number }; returnFocus: HTMLElement | null } | null>(null);
  const [trashing, setTrashing] = useState<LibraryEdition | null>(null);
  const [trashPending, setTrashPending] = useState(false);
  const [removal, setRemoval] = useState<RemovalNotice | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const openMenu: OpenMenu = (book, at, returnFocus) => setMenu({ book, at, returnFocus });

  /** A change from the menu; the tab reloads quietly, since a status change can move a book between sections. */
  async function run(change: () => Promise<{ patch: Partial<LibraryEdition> } | { error: string }>) {
    setActionError(null);
    const result = await change();
    if ('error' in result) setActionError(result.error);
    setGeneration((value) => value + 1);
  }

  async function moveToTrash(book: LibraryEdition) {
    setTrashPending(true);
    const result = await api(`/api/editions/${book.id}/trash`, { method: 'POST' });
    setTrashPending(false);
    setTrashing(null);
    if (result.error) setActionError(result.error);
    else setRemoval({ books: [{ id: book.id, title: book.title }], phase: 'moved' });
    setGeneration((value) => value + 1);
  }

  async function undoRemoval() {
    if (!removal) return;
    setRemoval({ ...removal, phase: 'undoing' });
    const book = removal.books[0]!;
    const result = await api(`/api/editions/${book.id}/restore`, { method: 'POST' });
    setRemoval({ ...removal, phase: result.error ? 'failed' : 'restored' });
    setGeneration((value) => value + 1);
  }

  const [home, setHome] = useState<HomePayload | null>(null);
  const [want, setWant] = useState<LibraryEdition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    void Promise.all([
      api<HomePayload>('/api/home'),
      api<LibraryPage>(`/api/library?status=want&limit=${WANT_LIMIT}&offset=0`),
    ]).then(([homeResult, wantResult]) => {
      if (!alive) return;
      if (homeResult.error || !homeResult.data) {
        setError(homeResult.error ?? 'network');
        return;
      }
      setHome(homeResult.data);
      setWant(wantResult.data?.editions ?? []);
    });
    return () => {
      alive = false;
    };
  }, [generation]);

  const heading = <h1 className="visually-hidden">{t('tabs.reading')}</h1>;
  if (error) {
    return (
      <div className="reading-home">
        {heading}
        <ErrorNotice
          message={t(`errors.${['network', 'unauthorized', 'forbidden'].includes(error) ? error : 'internal'}`)}
          onRetry={() => setGeneration((value) => value + 1)}
        />
      </div>
    );
  }
  if (!home) {
    return (
      <div className="reading-home">
        {heading}
        <LoadingState />
      </div>
    );
  }

  const [last, ...others] = home.continueReading;
  return (
    <div className="reading-home">
      {heading}
      {removal ? <RemovalBand notice={removal} onUndo={() => void undoRemoval()} /> : null}
      {actionError ? (
        <ErrorNotice message={t(`errors.${['network', 'unauthorized', 'forbidden'].includes(actionError) ? actionError : 'internal'}`)} />
      ) : null}
      {last ? (
        <Hero book={last} onMenu={openMenu} />
      ) : (
        <section className="rh-hero rh-hero-empty">
          <div className="rh-hero-inner">
            <div className="rh-hero-copy">
              <p className="rh-eyebrow">{t('tabs.reading')}</p>
              <h2 className="rh-hero-title">{t('readingTab.empty')}</h2>
              <p className="rh-hero-authors">{t('readingTab.emptyHint')}</p>
              <div className="rh-hero-actions">
                <Link className="soft-button soft-button-primary" to="/library">
                  <Library size={17} strokeWidth={1.75} aria-hidden="true" />
                  {t('readingTab.browse')}
                </Link>
              </div>
            </div>
          </div>
        </section>
      )}
      {others.length > 0 ? <AlsoReading books={others} onMenu={openMenu} /> : null}
      {want.length > 0 ? <Shelf books={want} onMenu={openMenu} /> : null}
      {menu ? (
        <Menu
          label={menu.book.title}
          items={bookMenuItems(menu.book, {
            t,
            admin,
            shelves: home.shelves,
            run: (_book, change) => void run(change),
            onTrash: (book) => setTrashing(book),
          })}
          at={menu.at}
          returnFocus={menu.returnFocus}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {trashing ? (
        <ConfirmDialog
          title={t('trash.removeTitle')}
          text={t('trash.removeConfirm').replace('{title}', trashing.title)}
          action={t('trash.removeAction')}
          cancel={t('trash.cancel')}
          pending={trashPending}
          dismissOnBackdrop
          onConfirm={() => void moveToTrash(trashing)}
          onCancel={() => setTrashing(null)}
        />
      ) : null}
    </div>
  );
}
