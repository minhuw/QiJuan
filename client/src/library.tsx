import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ChevronLeft, ChevronRight, Heart, LayoutGrid, List, Plus, Search, Star, X } from 'lucide-react';
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
import { CatalogHome } from './catalog-home';
import { CoverArt } from './components/ui/cover-art';
import { UnidentifiedMark } from './components/ui/identifiers';
import { EmptyState, ErrorNotice, SkeletonGrid } from './components/ui/states';
import { StatusMark } from './components/ui/status-mark';
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
/** Catalogue order: digits and marks, Latin initials, then CJK titles (sort_title has no pinyin). */
const BAND_KEYS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'cjk'];

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


function shortAuthor(name: string | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  if (/\p{Script=Han}/u.test(trimmed)) return trimmed;
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1] ?? trimmed;
}

function lastReadText(value: string, locale: string): string | null {
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

function Formats({ formats }: { formats: LibraryEdition['formats'] }) {
  if (formats.length === 0) return null;
  return <span className="format-text">{formats.map((format) => format.toUpperCase()).join(' · ')}</span>;
}

function Rating({ rating }: { rating: number }) {
  const { t } = useLocale();
  return (
    <span className="rating-meta">
      <Star size={11} strokeWidth={1.5} aria-hidden="true" />
      <span className="visually-hidden">{t('reading.rating')} </span>
      {rating}
    </span>
  );
}

function BookCard({ book }: { book: LibraryEdition }) {
  const { t } = useLocale();
  const authors = book.authors.join(', ');
  return (
    <li className="book-card">
      <Link className="book-card-link" to={`/books/${book.id}`}>
        <CoverArt editionId={book.id} title={book.title} author={book.authors[0]} hasCover={book.hasCover} />
        <span className="book-card-caption">
          <span className="book-card-title">{book.title}</span>
          <span className="book-card-meta">
            {authors ? <span className="book-card-author">{authors}</span> : null}
            <Formats formats={book.formats} />
          </span>
          {book.status || book.favorite || book.rating ? (
            <span className="book-card-signals">
              {book.status ? <StatusMark status={book.status} /> : null}
              {book.favorite ? (
                <span className="favorite-meta">
                  <Heart size={11} strokeWidth={1.5} fill="currentColor" aria-hidden="true" />
                  <span className="visually-hidden">{t('reading.favorite')}</span>
                </span>
              ) : null}
              {book.rating ? <Rating rating={book.rating} /> : null}
            </span>
          ) : null}
          {book.identified === false ? (
            <span className="book-card-identity">
              <UnidentifiedMark />
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

function ContinueItem({ book }: { book: LibraryEdition & { updatedAt: string } }) {
  const { t, locale } = useLocale();
  const read = lastReadText(book.updatedAt, locale);
  return (
    <li className="continue-item">
      <CoverArt editionId={book.id} title={book.title} author={book.authors[0]} hasCover={book.hasCover} variant="thumb" />
      <div className="continue-copy">
        <p className="continue-title">{book.title}</p>
        <p className="continue-meta">
          {book.authors.length > 0 ? <span>{book.authors.join(', ')}</span> : null}
          <Formats formats={book.formats} />
        </p>
        {read ? (
          <p className="continue-read">
            {t('library.lastRead')} <time dateTime={book.updatedAt}>{read}</time>
          </p>
        ) : null}
        <Link className="btn btn-sm continue-resume" to={`/books/${book.id}`}>
          {t('library.resume')}
          <span className="visually-hidden">: {book.title}</span>
        </Link>
      </div>
    </li>
  );
}

function GuideBand({
  editions,
  libraries,
  total,
  shelves,
}: {
  editions: LibraryEdition[];
  libraries: LibraryInfo[];
  total: number | null;
  shelves: number | null;
}) {
  const { t } = useLocale();
  const first = editions[0];
  const last = editions.length > 1 ? editions[editions.length - 1] : undefined;
  return (
    <div className="guide-band">
      <span className="guide guide-first" aria-hidden="true">
        {first ? (
          <>
            <span className="guide-word">{first.title}</span>
            {shortAuthor(first.authors[0]) ? <span className="guide-author">{shortAuthor(first.authors[0])}</span> : null}
          </>
        ) : null}
      </span>
      <p className="guide-meta">
        <span className="visually-hidden">{t('home.libraries')}: </span>
        {libraries.length === 0 ? (
          <span>{t('home.noAccess')}</span>
        ) : (
          libraries.map((library) => (
            <span className="guide-library" key={library.id}>
              {library.name}
            </span>
          ))
        )}
        {total !== null ? (
          <span className="guide-count">
            {t('home.books')} <span className="num">{total}</span>
          </span>
        ) : null}
        {shelves !== null ? (
          <span className="guide-count">
            {t('home.shelvesCount')} <span className="num">{shelves}</span>
          </span>
        ) : null}
      </p>
      <span className="guide guide-last" aria-hidden="true">
        {last ? (
          <>
            <span className="guide-word">{last.title}</span>
            {shortAuthor(last.authors[0]) ? <span className="guide-author">{shortAuthor(last.authors[0])}</span> : null}
          </>
        ) : null}
      </span>
    </div>
  );
}

interface Band {
  key: string;
  target: number | null;
  inView: boolean;
  current: boolean;
}

/** Folds the server's runs into one band per key; a key can recur because sort_title orders by code point. */
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
          const label = band.key === 'cjk' ? t('library.indexCjk') : band.key;
          const className = [
            'thumb-tab',
            band.key === 'cjk' ? 'thumb-tab-cjk' : '',
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

type RemovalNotice = { id: number; title: string; phase: 'moved' | 'undoing' | 'restored' | 'failed' };

function RemovalBand({ notice, onUndo }: { notice: RemovalNotice; onUndo: () => void }) {
  const { t } = useLocale();
  if (notice.phase === 'restored') {
    return (
      <p className="alert alert-success removal-notice" role="status">
        <span>{fill(t('trash.restored'), { title: notice.title })}</span>
        <Link className="text-link" to={`/books/${notice.id}`}>
          {t('trash.open')}
        </Link>
      </p>
    );
  }
  return (
    <p className={notice.phase === 'failed' ? 'alert alert-error removal-notice' : 'alert alert-info removal-notice'} role="status">
      <span>{notice.phase === 'failed' ? t('trash.errors.failed') : fill(t('trash.moved'), { title: notice.title })}</span>
      <span aria-hidden="true">·</span>
      <button type="button" className="link-button" disabled={notice.phase === 'undoing'} onClick={onUndo}>
        {t('trash.undo')}
      </button>
    </p>
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
  const [removal, setRemoval] = useState<RemovalNotice | null>(() => {
    const trashed = trashedFrom(location.state);
    return trashed ? { ...trashed, phase: 'moved' } : null;
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
  const [status, setStatus] = useState('');
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

  // The notice is shown once: a reload or Back does not bring it again.
  useEffect(() => {
    if (trashedFrom(location.state)) navigate(location.pathname + location.search, { replace: true, state: null });
  }, [location.state, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (role !== 'admin') return;
    let active = true;
    void api<TrashListing>('/api/trash').then((result) => {
      if (!active || !result.data) return;
      setTrashCount(result.data.editions.length + result.data.assets.length);
    });
    return () => {
      active = false;
    };
  }, [role, generation]);

  async function undoRemoval() {
    if (!removal) return;
    setRemoval({ ...removal, phase: 'undoing' });
    const result = await api(`/api/editions/${removal.id}/restore`, { method: 'POST' });
    setRemoval({ ...removal, phase: result.error ? 'failed' : 'restored' });
    if (!result.error) setGeneration((value) => value + 1);
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

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    setStatus('');
    setShelfId('');
    setIdentified('');
    setOffset(0);
  }

  const initialLoading = homeLoading && !home;
  const showPageLoading = pageLoading && !initialLoading;
  const alertCode = homeError ?? pageError;
  const activeFilters = Boolean(q || language || format || status || shelfId || identified);
  const total = page?.total ?? 0;
  const first = total === 0 ? 0 : offset + 1;
  const last = offset + (page?.editions.length ?? 0);
  const range = page ? `${first}–${last} ${t('library.of')} ${page.total}` : null;

  return (
    <div className="library-page">
      <GuideBand
        editions={page && !pageLoading ? page.editions : []}
        libraries={libraries}
        total={page ? page.total : null}
        shelves={home ? home.shelves.length : null}
      />

      {page && page.total > 0 && page.index ? (
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

      <div className="library-toolbar">
        <h1 className="toolbar-title">{t('home.title')}</h1>
        <Link className="btn btn-primary" to="/import">
          <Plus size={15} strokeWidth={1.5} aria-hidden="true" />
          {t('home.addBooks')}
        </Link>
        <form className="search-form" role="search" onSubmit={submitSearch}>
          <div className="search-field">
            <Search size={15} strokeWidth={1.5} aria-hidden="true" />
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
          </div>
          <button className="btn" type="submit">
            {t('library.submit')}
          </button>
        </form>

        <div className="filter-bar">
          <span className="toolbar-label">{t('library.filters')}</span>
          <label className="filter-field">
            <span className="visually-hidden">{t('library.language')}</span>
            <select
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
          <label className="filter-field">
            <span className="visually-hidden">{t('library.format')}</span>
            <select
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
          <label className="filter-field">
            <span className="visually-hidden">{t('library.status')}</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
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
          <label className="filter-field">
            <span className="visually-hidden">{t('library.shelf')}</span>
            <select
              value={shelfId}
              onChange={(event) => {
                setShelfId(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">{t('library.shelfAny')}</option>
              {(page?.shelves ?? home?.shelves ?? []).map((shelf) => (
                <option key={shelf.id} value={shelf.id}>
                  {shelf.name}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span className="visually-hidden">{t('library.identifier')}</span>
            <select
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
            <button type="button" className="btn btn-ghost btn-sm clear-filters" onClick={clearFilters}>
              <X size={14} strokeWidth={1.5} aria-hidden="true" />
              {t('library.clearFilters')}
            </button>
          ) : null}
        </div>

        <div className="view-switch" role="group" aria-label={t('library.results')}>
          <button
            type="button"
            className="view-button"
            aria-pressed={view === 'grid'}
            title={t('library.grid')}
            onClick={() => setView('grid')}
          >
            <LayoutGrid size={15} strokeWidth={1.5} aria-hidden="true" />
            <span className="visually-hidden">{t('library.grid')}</span>
          </button>
          <button
            type="button"
            className="view-button"
            aria-pressed={view === 'list'}
            title={t('library.list')}
            onClick={() => setView('list')}
          >
            <List size={15} strokeWidth={1.5} aria-hidden="true" />
            <span className="visually-hidden">{t('library.list')}</span>
          </button>
        </div>
      </div>

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

      {initialLoading ? <SkeletonGrid count={7} /> : null}

      {home ? (
        <>
          <section className="entry" aria-labelledby="continue-heading">
            <div className="entry-head">
              <h2 id="continue-heading">{t('library.continue')}</h2>
              <p className="entry-meta">
                {t('home.inProgress')} · <span className="num">{home.continueReading.length}</span>
              </p>
            </div>
            <div className="entry-body">
              {home.continueReading.length === 0 ? (
                <EmptyState
                  compact
                  title={t('library.continueEmpty')}
                  action={
                    <Link className="btn btn-sm" to="/import">
                      <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
                      {t('home.addBooks')}
                    </Link>
                  }
                />
              ) : (
                <ul className="continue-list">
                  {home.continueReading.map((book) => (
                    <ContinueItem key={book.id} book={book} />
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="entry" aria-labelledby="recent-heading">
            <div className="entry-head">
              <h2 id="recent-heading">{t('library.recent')}</h2>
              <p className="entry-meta">
                {t('home.books')} · <span className="num">{home.recent.length}</span>
              </p>
            </div>
            <div className="entry-body">
              {home.recent.length === 0 ? (
                <EmptyState compact title={t('library.recentEmpty')} />
              ) : (
                <ul className="plate-grid plate-grid-recent">
                  {home.recent.map((book) => (
                    <BookCard key={book.id} book={book} />
                  ))}
                </ul>
              )}
            </div>
          </section>
        </>
      ) : null}

      <section className="entry catalogue-entry" aria-labelledby="browse-heading" ref={catalogueRef}>
        <div className="entry-head">
          <h2 id="browse-heading" ref={catalogueHeadingRef} tabIndex={-1}>
            {t('library.catalogue')}
          </h2>
          {range ? <p className="entry-meta num">{range}</p> : null}
          {home ? (
            <div className="shelf-index">
              <h3>{t('library.shelves')}</h3>
              {home.shelves.length === 0 ? (
                <p className="entry-meta">{t('library.shelvesEmpty')}</p>
              ) : (
                <ul className="shelf-list">
                  {home.shelves.map((shelf) => {
                    const on = String(shelf.id) === shelfId;
                    return (
                      <li key={shelf.id}>
                        <button
                          type="button"
                          className={on ? 'shelf-button shelf-button-active' : 'shelf-button'}
                          aria-label={shelf.name}
                          aria-pressed={on}
                          onClick={() => {
                            setShelfId(String(shelf.id));
                            setOffset(0);
                          }}
                        >
                          <span className="shelf-name">{shelf.name}</span>
                          <span className="shelf-count num">{shelf.count}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}
        </div>

        <div className="entry-body">
          {showPageLoading ? <SkeletonGrid count={7} /> : null}
          {page && !pageLoading && page.editions.length === 0 ? (
            <EmptyState
              title={t('library.empty')}
              description={activeFilters ? t('library.searchHint') : undefined}
              action={
                activeFilters ? (
                  <button type="button" className="btn btn-sm" onClick={clearFilters}>
                    {t('library.clearFilters')}
                  </button>
                ) : null
              }
            />
          ) : null}
          {page && !pageLoading && page.editions.length > 0 ? (
            view === 'grid' ? (
              <ul className="plate-grid" aria-label={t('library.results')}>
                {page.editions.map((book) => (
                  <BookCard key={book.id} book={book} />
                ))}
              </ul>
            ) : (
              <ul className="book-table" aria-label={t('library.results')}>
                {page.editions.map((book) => (
                  <li key={book.id} className="book-row">
                    <Link className="book-row-cover" to={`/books/${book.id}`} tabIndex={-1} aria-hidden="true">
                      <CoverArt
                        editionId={book.id}
                        title={book.title}
                        author={book.authors[0]}
                        hasCover={book.hasCover}
                        variant="thumb"
                      />
                    </Link>
                    <div className="book-row-main">
                      <Link className="book-row-title" to={`/books/${book.id}`}>
                        {book.title}
                      </Link>
                      {book.authors.length > 0 ? (
                        <span className="book-row-author">{book.authors.join(', ')}</span>
                      ) : null}
                    </div>
                    <span className="book-row-lang">{book.language ?? ''}</span>
                    <span className="book-row-formats">
                      <Formats formats={book.formats} />
                    </span>
                    <span className="book-row-status">
                      {book.status ? <StatusMark status={book.status} /> : null}
                      {book.identified === false ? <UnidentifiedMark /> : null}
                    </span>
                    <span className="book-row-rating">{book.rating ? <Rating rating={book.rating} /> : null}</span>
                  </li>
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
                  className="btn"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_LIMIT))}
                >
                  <ChevronLeft size={15} strokeWidth={1.5} aria-hidden="true" />
                  {t('library.previous')}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={offset + page.editions.length >= page.total}
                  onClick={() => setOffset(offset + PAGE_LIMIT)}
                >
                  {t('library.next')}
                  <ChevronRight size={15} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <CatalogHome />

      {role === 'admin' && trashCount > 0 ? (
        <p className="trash-link-row">
          <Link className="text-link" to="/trash">
            {t('trash.link')} · <span className="num">{trashCount}</span>
          </Link>
        </p>
      ) : null}
    </div>
  );
}
