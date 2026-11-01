import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ChevronLeft, ChevronRight, Heart, LayoutGrid, List, Plus, Search, Trash2, X } from 'lucide-react';
import {
  api,
  type HomePayload,
  type LibraryEdition,
  type LibraryIndexEntry,
  type LibraryInfo,
  type LibraryPage,
  type ReadingStatus,
  type TrashListing,
} from './api';
import { setFavorite, setOnShelf, setStatus } from './book-actions';
import { bookMenuItems } from './book-menu';
import { CatalogHome } from './catalog-home';
import { BookObject } from './components/ui/book-object';
import { ConfirmDialog } from './components/ui/confirm-dialog';
import { Menu, type MenuItem } from './components/ui/menu';
import { EmptyState, ErrorNotice, SkeletonGrid } from './components/ui/states';
import { LibraryCard, LibraryRow, type ItemHandlers } from './library-items';
import { useLocale } from './shell';
import { fill } from './trash-screen';

const PAGE_LIMIT = 24;
const ERROR_CODES = new Set([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'required',
  'network',
  'internal',
  'conflict',
]);

const STATUSES: ReadingStatus[] = ['want', 'reading', 'finished', 'on_hold'];
/** Catalogue order is one A–Z: Chinese titles file under their pinyin initial; '#' holds the rest. */
const BAND_KEYS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

function errorText(t: (key: string) => string, code: string | null): string {
  const known = code && ERROR_CODES.has(code) ? code : 'internal';
  return t(`errors.${known}`);
}

function libraryPath(input: {
  q: string;
  language: string;
  format: string;
  status: string;
  shelfId: string;
  identified: string;
  offset: number;
}): string {
  const params = new URLSearchParams();
  params.set('limit', String(PAGE_LIMIT));
  params.set('offset', String(input.offset));
  if (input.q) params.set('q', input.q);
  if (input.language) params.set('language', input.language);
  if (input.format) params.set('format', input.format);
  if (input.status) params.set('status', input.status);
  if (input.shelfId) params.set('shelfId', input.shelfId);
  if (input.identified) params.set('identified', input.identified);
  return `/api/library?${params.toString()}`;
}


export function lastReadText(value: string, locale: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = 86_400_000;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const then = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((today - then) / day);
  if (days >= 0 && days < 7) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-days, 'day');
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

interface Band {
  key: string;
  target: number | null;
  inView: boolean;
  current: boolean;
}

/** Folds the server's runs into one band per key; a key recurs only before sort keys are filled in. */
export function thumbBands(index: LibraryIndexEntry[], offset: number, shown: number): Band[] {
  const end = offset + shown;
  return BAND_KEYS.map((key) => {
    const runs = index.filter((entry) => entry.key === key && entry.count > 0);
    return {
      key,
      target: runs.length > 0 ? Math.min(...runs.map((entry) => entry.offset)) : null,
      inView: runs.some((entry) => entry.offset < end && entry.offset + entry.count > offset),
      current: runs.some((entry) => entry.offset <= offset && offset < entry.offset + entry.count),
    };
  });
}

function ThumbIndex({
  index,
  offset,
  shown,
  onJump,
}: {
  index: LibraryIndexEntry[];
  offset: number;
  shown: number;
  onJump: (offset: number) => void;
}) {
  const { t } = useLocale();
  return (
    <nav className="thumb-index" aria-label={t('library.thumbIndex')}>
      <ol>
        {thumbBands(index, offset, shown).map((band) => {
          const label = band.key;
          const className = [
            'thumb-tab',
            band.inView ? 'thumb-tab-in' : '',
            band.current ? 'thumb-tab-current' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <li key={band.key}>
              <button
                type="button"
                className={className}
                disabled={band.target === null}
                aria-current={band.current ? 'location' : undefined}
                aria-label={band.key === '#' ? t('library.indexOther') : undefined}
                onClick={() => {
                  if (band.target !== null) onJump(Math.floor(band.target / PAGE_LIMIT) * PAGE_LIMIT);
                }}
              >
                {label}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function revealCatalogue(section: RefObject<HTMLElement | null>, heading: RefObject<HTMLHeadingElement | null>) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  section.current?.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  heading.current?.focus({ preventScroll: true });
}

/** Set by the book page after a removal: the library shows the Undo notice once. */
export interface TrashedState {
  trashed: { id: number; title: string };
}

function trashedFrom(state: unknown): TrashedState['trashed'] | null {
  if (typeof state !== 'object' || state === null || !('trashed' in state)) return null;
  const trashed = (state as TrashedState).trashed;
  return trashed && typeof trashed.id === 'number' && typeof trashed.title === 'string' ? trashed : null;
}

/** Books just moved to Trash: one names its title, several give a count. Undo restores them all. */
export type RemovalNotice = { books: Array<{ id: number; title: string }>; phase: 'moved' | 'undoing' | 'restored' | 'failed' };

export function RemovalBand({ notice, onUndo }: { notice: RemovalNotice; onUndo: () => void }) {
  const { t } = useLocale();
  const single = notice.books.length === 1 ? notice.books[0]! : null;
  if (notice.phase === 'restored') {
    return (
      <p className="alert alert-success removal-notice" role="status">
        <span>
          {single ? fill(t('trash.restored'), { title: single.title }) : fill(t('trash.restoredMany'), { count: String(notice.books.length) })}
        </span>
        {single ? (
          <Link className="text-link" to={`/books/${single.id}`}>
            {t('trash.open')}
          </Link>
        ) : null}
      </p>
    );
  }
  const moved = single ? fill(t('trash.moved'), { title: single.title }) : fill(t('trash.movedMany'), { count: String(notice.books.length) });
  return (
    <p className={notice.phase === 'failed' ? 'alert alert-error removal-notice' : 'alert alert-info removal-notice'} role="status">
      <span>{notice.phase === 'failed' ? t('trash.errors.failed') : moved}</span>
      <span aria-hidden="true">·</span>
      <button type="button" className="link-button" disabled={notice.phase === 'undoing'} onClick={onUndo}>
        {t('trash.undo')}
      </button>
    </p>
  );
}

type OpenMenu =
  | { kind: 'book'; book: LibraryEdition; at: { x: number; y: number }; returnFocus: HTMLElement | null }
  | { kind: 'bulk-status' | 'bulk-shelf'; at: { x: number; y: number }; returnFocus: HTMLElement | null };

function FilterChip({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={active ? 'chip chip-active' : 'chip'} aria-label={label} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}

export function LibraryBrowser({
  libraries = [],
  role = 'reader',
}: {
  libraries?: LibraryInfo[];
  role?: 'admin' | 'reader';
}) {
  const { t } = useLocale();
  const location = useLocation();
  const navigate = useNavigate();
  const admin = role === 'admin';
  const [removal, setRemoval] = useState<RemovalNotice | null>(() => {
    const trashed = trashedFrom(location.state);
    return trashed ? { books: [trashed], phase: 'moved' } : null;
  });
  const [trashCount, setTrashCount] = useState(0);
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const catalogueRef = useRef<HTMLElement>(null);
  const catalogueHeadingRef = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [language, setLanguage] = useState('');
  const [format, setFormat] = useState('');
  const [status, setStatusFilter] = useState('');
  const [shelfId, setShelfId] = useState('');
  /** '' any, '1' identified, '0' Unidentified: the server's identified= filter. */
  const [identified, setIdentified] = useState('');
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [generation, setGeneration] = useState(0);
  const [home, setHome] = useState<HomePayload | null>(null);
  const [homeError, setHomeError] = useState<string | null>(null);
  const [homeLoading, setHomeLoading] = useState(true);
  const [page, setPage] = useState<LibraryPage | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const anchor = useRef<number | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [trashing, setTrashing] = useState<LibraryEdition[] | null>(null);
  const [trashPending, setTrashPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The notice is shown once: a reload or Back does not bring it again.
  useEffect(() => {
    if (trashedFrom(location.state)) navigate(location.pathname + location.search, { replace: true, state: null });
  }, [location.state, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (!admin) return;
    let active = true;
    void api<TrashListing>('/api/trash').then((result) => {
      if (!active || !result.data) return;
      setTrashCount(result.data.editions.length + result.data.assets.length);
    });
    return () => {
      active = false;
    };
  }, [admin, generation]);

  async function undoRemoval() {
    if (!removal) return;
    setRemoval({ ...removal, phase: 'undoing' });
    let failed = false;
    for (const book of removal.books) {
      const result = await api(`/api/editions/${book.id}/restore`, { method: 'POST' });
      if (result.error) failed = true;
    }
    setRemoval({ ...removal, phase: failed ? 'failed' : 'restored' });
    setGeneration((value) => value + 1);
  }

  useEffect(() => {
    let active = true;
    setHomeLoading(true);
    void api<HomePayload>('/api/home').then((result) => {
      if (!active) return;
      setHomeLoading(false);
      if (result.error || !result.data) {
        setHomeError(result.error ?? 'network');
        setHome(null);
        return;
      }
      setHomeError(null);
      setHome(result.data);
    });
    return () => {
      active = false;
    };
  }, [generation]);

  useEffect(() => {
    let active = true;
    setPageLoading(true);
    void api<LibraryPage>(libraryPath({ q, language, format, status, shelfId, identified, offset })).then((result) => {
      if (!active) return;
      setPageLoading(false);
      if (result.error || !result.data) {
        setPageError(result.error ?? 'network');
        setPage(null);
        return;
      }
      setPageError(null);
      setPage(result.data);
    });
    return () => {
      active = false;
    };
  }, [q, language, format, status, shelfId, identified, offset, generation]);

  // A new page or filter starts a fresh selection.
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [q, language, format, status, shelfId, identified, offset]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (event.key === 'Escape' && !typing && !menu && !trashing) {
        setSelected((current) => (current.size === 0 ? current : new Set()));
        return;
      }
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || typing) return;
      event.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, trashing]);

  /** Applies a reading or shelf change to the shown cards, then refreshes the shelf counts quietly. */
  const patchCards = useCallback((patches: Map<number, Partial<LibraryEdition>>) => {
    const apply = (book: LibraryEdition) => (patches.has(book.id) ? { ...book, ...patches.get(book.id) } : book);
    setPage((current) => (current ? { ...current, editions: current.editions.map(apply) } : current));
    setHome((current) => (current ? { ...current, recent: current.recent.map(apply) } : current));
    void api<HomePayload>('/api/home').then((result) => {
      if (result.data) setHome(result.data);
    });
  }, []);

  /** Runs one change on each book in turn; failures are reported once, the rest still apply. */
  async function runOn(books: LibraryEdition[], change: (book: LibraryEdition) => Promise<{ patch: Partial<LibraryEdition> } | { error: string }>) {
    setBusy(true);
    setActionError(null);
    const patches = new Map<number, Partial<LibraryEdition>>();
    let failure: string | null = null;
    for (const book of books) {
      const result = await change(book);
      if ('error' in result) failure = result.error;
      else patches.set(book.id, result.patch);
    }
    setBusy(false);
    if (patches.size > 0) patchCards(patches);
    if (failure) setActionError(failure);
  }

  async function moveToTrash(books: LibraryEdition[]) {
    setTrashPending(true);
    const moved: Array<{ id: number; title: string }> = [];
    let failure: string | null = null;
    for (const book of books) {
      const result = await api(`/api/editions/${book.id}/trash`, { method: 'POST' });
      if (result.error) failure = result.error;
      else moved.push({ id: book.id, title: book.title });
    }
    setTrashPending(false);
    setTrashing(null);
    setSelected(new Set());
    if (moved.length > 0) setRemoval({ books: moved, phase: 'moved' });
    if (failure) setActionError(failure);
    setGeneration((value) => value + 1);
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setQ(draft.trim());
    setOffset(0);
  }

  function clearFilters() {
    setDraft('');
    setQ('');
    setLanguage('');
    setFormat('');
    setStatusFilter('');
    setShelfId('');
    setIdentified('');
    setOffset(0);
  }

  const shelves = page?.shelves ?? home?.shelves ?? [];
  const editions = page && !pageLoading ? page.editions : [];
  const selectedBooks = editions.filter((book) => selected.has(book.id));

  function select(book: LibraryEdition, mode: 'toggle' | 'range') {
    setSelected((current) => {
      const next = new Set(current);
      if (mode === 'range' && anchor.current !== null) {
        const ids = editions.map((item) => item.id);
        const from = ids.indexOf(anchor.current);
        const to = ids.indexOf(book.id);
        if (from >= 0 && to >= 0) {
          for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(id);
          return next;
        }
      }
      if (next.has(book.id)) next.delete(book.id);
      else next.add(book.id);
      anchor.current = book.id;
      return next;
    });
  }

  function handlersFor(book: LibraryEdition): ItemHandlers {
    return {
      selected: selected.has(book.id),
      selecting: selected.size > 0,
      onSelect: (mode) => select(book, mode),
      onMenu: (at, returnFocus) => setMenu({ kind: 'book', book, at, returnFocus }),
    };
  }

  function bulkMenuItems(kind: 'bulk-status' | 'bulk-shelf'): MenuItem[] {
    if (kind === 'bulk-status') {
      return [
        ...STATUSES.map<MenuItem>((item) => ({
          kind: 'action',
          label: t(`reading.${item}`),
          onSelect: () => void runOn(selectedBooks, (book) => setStatus(book.id, item)),
        })),
        { kind: 'separator' },
        { kind: 'action', label: t('library.menu.clearStatus'), onSelect: () => void runOn(selectedBooks, (book) => setStatus(book.id, null)) },
      ];
    }
    return shelves.map<MenuItem>((shelf) => ({
      kind: 'action',
      label: shelf.name,
      onSelect: () => void runOn(selectedBooks.filter((book) => !book.shelfIds?.includes(shelf.id)), (book) => setOnShelf(book.id, shelf.id, true)),
    }));
  }

  const initialLoading = homeLoading && !home;
  const showPageLoading = pageLoading && !initialLoading;
  const alertCode = homeError ?? pageError;
  const activeFilters = Boolean(q || language || format || status || shelfId || identified);
  const total = page?.total ?? 0;
  const first = total === 0 ? 0 : offset + 1;
  const last = offset + (page?.editions.length ?? 0);
  const range = page ? `${first}–${last} ${t('library.of')} ${page.total}` : null;
  // In a small library the recent row would show the same books again; it appears only when it adds something.
  const paged = page !== null && page.total > PAGE_LIMIT;
  const shownIds = new Set(editions.map((book) => book.id));
  const recentAddsBooks = home !== null && !activeFilters && home.recent.some((book) => !shownIds.has(book.id));
  const libraryNames = libraries.map((library) => library.name).join(' · ');
  const allFavorite = selectedBooks.length > 0 && selectedBooks.every((book) => book.favorite);

  return (
    <div className="library-page lib-page">
      <header className="lib-header">
        <div className="lib-heading">
          <h1>{t('tabs.library')}</h1>
          <p className="lib-subtitle">
            {libraryNames ? <span>{libraryNames}</span> : null}
            {page ? <span>{fill(t('library.countBooks'), { count: String(page.total) })}</span> : null}
            {home ? <span>{fill(t('library.countShelves'), { count: String(home.shelves.length) })}</span> : null}
          </p>
        </div>
        <Link className="soft-button soft-button-primary" to="/import">
          <Plus size={17} strokeWidth={1.75} aria-hidden="true" />
          {t('home.addBooks')}
        </Link>
      </header>

      <div className="lib-tools">
        <form className="lib-search" role="search" onSubmit={submitSearch}>
          <Search size={18} strokeWidth={1.75} aria-hidden="true" />
          <label className="visually-hidden" htmlFor={searchId}>
            {t('library.search')}
          </label>
          <input
            id={searchId}
            ref={searchRef}
            type="search"
            value={draft}
            placeholder={t('library.searchHint')}
            onChange={(event) => setDraft(event.target.value)}
          />
          <kbd aria-hidden="true">/</kbd>
          <button className="visually-hidden" type="submit">
            {t('library.submit')}
          </button>
        </form>

        <div className="lib-filters">
          {shelves.length > 0 ? (
            <div className="chip-group" role="group" aria-label={t('library.shelves')}>
              <FilterChip
                label={t('library.shelfAny')}
                active={!shelfId}
                onClick={() => {
                  setShelfId('');
                  setOffset(0);
                }}
              >
                {t('library.allBooks')}
              </FilterChip>
              {shelves.map((shelf) => (
                <FilterChip
                  key={shelf.id}
                  label={shelf.name}
                  active={String(shelf.id) === shelfId}
                  onClick={() => {
                    setShelfId(String(shelf.id) === shelfId ? '' : String(shelf.id));
                    setOffset(0);
                  }}
                >
                  {shelf.name}
                  <span className="chip-count num">{shelf.count}</span>
                </FilterChip>
              ))}
            </div>
          ) : null}
          <div className="lib-selects">
            <label className={language ? 'chip-select chip-select-on' : 'chip-select'}>
              <select
                aria-label={t('library.language')}
                value={language}
                onChange={(event) => {
                  setLanguage(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="">{t('library.languageAny')}</option>
                {(page?.languages ?? []).map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label className={format ? 'chip-select chip-select-on' : 'chip-select'}>
              <select
                aria-label={t('library.format')}
                value={format}
                onChange={(event) => {
                  setFormat(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="">{t('library.formatAny')}</option>
                <option value="epub">{t('library.formatEpub')}</option>
                <option value="pdf">{t('library.formatPdf')}</option>
              </select>
            </label>
            <label className={status ? 'chip-select chip-select-on' : 'chip-select'}>
              <select
                aria-label={t('library.status')}
                value={status}
                onChange={(event) => {
                  setStatusFilter(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="">{t('library.statusAny')}</option>
                {STATUSES.map((item) => (
                  <option key={item} value={item}>
                    {t(`reading.${item}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className={identified ? 'chip-select chip-select-on' : 'chip-select'}>
              <select
                aria-label={t('library.identifier')}
                value={identified}
                onChange={(event) => {
                  setIdentified(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="">{t('library.identifierAny')}</option>
                <option value="1">{t('library.identified')}</option>
                <option value="0">{t('library.unidentified')}</option>
              </select>
            </label>
            {activeFilters ? (
              <button type="button" className="chip chip-clear" onClick={clearFilters}>
                <X size={14} strokeWidth={1.75} aria-hidden="true" />
                {t('library.clearFilters')}
              </button>
            ) : null}
          </div>
          <div className="segmented" role="group" aria-label={t('library.results')}>
            <button type="button" aria-pressed={view === 'grid'} title={t('library.grid')} onClick={() => setView('grid')}>
              <LayoutGrid size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="visually-hidden">{t('library.grid')}</span>
            </button>
            <button type="button" aria-pressed={view === 'list'} title={t('library.list')} onClick={() => setView('list')}>
              <List size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="visually-hidden">{t('library.list')}</span>
            </button>
          </div>
        </div>
      </div>

      {page && paged && page.index ? (
        <ThumbIndex
          index={page.index}
          offset={page.offset}
          shown={page.editions.length}
          onJump={(next) => {
            setOffset(next);
            revealCatalogue(catalogueRef, catalogueHeadingRef);
          }}
        />
      ) : null}

      {removal ? <RemovalBand notice={removal} onUndo={() => void undoRemoval()} /> : null}

      {alertCode ? (
        <ErrorNotice
          message={errorText(t, alertCode)}
          onRetry={() => {
            setHomeError(null);
            setPageError(null);
            setGeneration((value) => value + 1);
          }}
        />
      ) : null}
      {actionError ? <ErrorNotice message={errorText(t, actionError)} /> : null}

      {initialLoading ? <SkeletonGrid count={7} /> : null}

      {home && recentAddsBooks ? (
        <section className="lib-section" aria-labelledby="recent-heading">
          <div className="section-head">
            <h2 id="recent-heading">{t('library.recent')}</h2>
          </div>
          <ul className="book-shelf">
            {home.recent.map((book) => (
              <li key={book.id}>
                <Link className="book-shelf-book" to={`/books/${book.id}`}>
                  <BookObject book={book} size="shelf" />
                  <span className="book-shelf-title">{book.title}</span>
                  {book.authors.length > 0 ? <span className="book-shelf-authors">{book.authors.join(', ')}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="lib-section catalogue-entry" aria-labelledby="browse-heading" ref={catalogueRef}>
        <div className="section-head">
          <h2 id="browse-heading" ref={catalogueHeadingRef} tabIndex={-1}>
            {t('library.catalogue')}
          </h2>
          {range ? <p className="section-meta num">{range}</p> : null}
        </div>

        {showPageLoading ? <SkeletonGrid count={7} /> : null}
        {page && !pageLoading && page.editions.length === 0 ? (
          <div className="lib-empty">
            <EmptyState
              title={t('library.empty')}
              description={activeFilters ? t('library.searchHint') : undefined}
              action={
                activeFilters ? (
                  <button type="button" className="soft-button soft-button-quiet" onClick={clearFilters}>
                    {t('library.clearFilters')}
                  </button>
                ) : null
              }
            />
          </div>
        ) : null}
        {editions.length > 0 ? (
          view === 'grid' ? (
            <ul className="lib-grid" aria-label={t('library.results')}>
              {editions.map((book) => (
                <LibraryCard key={book.id} book={book} handlers={handlersFor(book)} />
              ))}
            </ul>
          ) : (
            <ul className="lib-list" aria-label={t('library.results')}>
              {editions.map((book) => (
                <LibraryRow key={book.id} book={book} handlers={handlersFor(book)} />
              ))}
            </ul>
          )
        ) : null}

        {page && !pageLoading && (offset > 0 || offset + page.editions.length < page.total) ? (
          <div className="pagination">
            <span className="pagination-copy num">{range}</span>
            <div className="pagination-actions">
              <button
                type="button"
                className="soft-button soft-button-quiet"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_LIMIT))}
              >
                <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
                {t('library.previous')}
              </button>
              <button
                type="button"
                className="soft-button soft-button-quiet"
                disabled={offset + page.editions.length >= page.total}
                onClick={() => setOffset(offset + PAGE_LIMIT)}
              >
                {t('library.next')}
                <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <CatalogHome />

      {admin && trashCount > 0 ? (
        <p className="trash-link-row">
          <Link className="text-link" to="/trash">
            {t('trash.link')} · <span className="num">{trashCount}</span>
          </Link>
        </p>
      ) : null}

      {selectedBooks.length > 0 ? (
        <div className="selection-bar" role="toolbar" aria-label={t('library.selection')} aria-busy={busy || undefined}>
          <span className="selection-count" aria-live="polite">
            {fill(t('library.selectedCount'), { count: String(selectedBooks.length) })}
          </span>
          <button
            type="button"
            aria-haspopup="menu"
            disabled={busy}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ kind: 'bulk-status', at: { x: rect.left, y: rect.top - 8 }, returnFocus: event.currentTarget });
            }}
          >
            {t('library.status')}
          </button>
          {shelves.length > 0 ? (
            <button
              type="button"
              aria-haspopup="menu"
              disabled={busy}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ kind: 'bulk-shelf', at: { x: rect.left, y: rect.top - 8 }, returnFocus: event.currentTarget });
              }}
            >
              {t('library.menu.addToShelf')}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void runOn(selectedBooks, (book) => setFavorite(book.id, !allFavorite))}
          >
            <Heart size={15} strokeWidth={1.75} fill={allFavorite ? 'currentColor' : 'none'} aria-hidden="true" />
            {allFavorite ? t('library.menu.unfavorite') : t('reading.favorite')}
          </button>
          {admin ? (
            <button type="button" className="selection-danger" disabled={busy} onClick={() => setTrashing(selectedBooks)}>
              <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
              {t('trash.removeAction')}
            </button>
          ) : null}
          <button
            type="button"
            className="selection-close"
            aria-label={t('library.clearSelection')}
            title={t('library.clearSelection')}
            onClick={() => setSelected(new Set())}
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {menu ? (
        <Menu
          label={menu.kind === 'book' ? menu.book.title : menu.kind === 'bulk-status' ? t('library.status') : t('library.menu.addToShelf')}
          items={
            menu.kind === 'book'
              ? bookMenuItems(menu.book, { t, admin, shelves, run: (book, change) => void runOn([book], change), onTrash: (book) => setTrashing([book]) })
              : bulkMenuItems(menu.kind)
          }
          at={menu.at}
          returnFocus={menu.returnFocus}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {trashing ? (
        <ConfirmDialog
          title={t('trash.removeTitle')}
          text={
            trashing.length === 1
              ? fill(t('trash.removeConfirm'), { title: trashing[0]!.title })
              : fill(t('trash.removeManyConfirm'), { count: String(trashing.length) })
          }
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
