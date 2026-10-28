import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  BookMarked,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  Library,
  List,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  X,
} from 'lucide-react';
import { api, type HomePayload, type LibraryEdition, type LibraryInfo, type LibraryPage, type ReadingStatus } from './api';
import { CatalogHome } from './catalog-home';
import { CoverArt } from './components/ui/cover-art';
import { PageHeader } from './components/ui/page-header';
import { EmptyState, ErrorNotice, SkeletonGrid } from './components/ui/states';
import { useLocale } from './shell';

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
  return `/api/library?${params.toString()}`;
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="stars" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => (
        <Star key={index} size={12} className={index < rating ? 'star-filled' : 'star-empty'} />
      ))}
    </span>
  );
}

function BookCard({ book }: { book: LibraryEdition }) {
  const { t } = useLocale();
  const authors = book.authors.join(', ');
  return (
    <li className="book-card">
      <Link className="cover-card" to={`/books/${book.id}`}>
        <span className="cover-frame">
          <CoverArt
            editionId={book.id}
            title={book.title}
            author={book.authors[0]}
            hasCover={book.hasCover}
          />
          <span className="cover-sheen" aria-hidden="true" />
          {book.status ? (
            <span className={`status-pill status-pill-${book.status} cover-status`}>
              <span className="status-dot" aria-hidden="true" />
              {t(`reading.${book.status}`)}
            </span>
          ) : null}
          {book.favorite ? (
            <span className="cover-favorite" aria-hidden="true">
              <Star size={12} fill="currentColor" />
            </span>
          ) : null}
        </span>
        <span className="book-card-copy">
          <span className="cover-caption">{book.title}</span>
          {authors ? <span className="cover-byline">{authors}</span> : null}
          <span className="book-card-signals">
            <span className="format-row">
              {book.formats.map((format) => (
                <span key={format} className={`format-badge format-${format}`}>
                  {format.toUpperCase()}
                </span>
              ))}
            </span>
            {book.rating ? <Stars rating={book.rating} /> : null}
          </span>
        </span>
      </Link>
    </li>
  );
}

function ContinueCard({ book }: { book: LibraryEdition }) {
  const { t } = useLocale();
  return (
    <li className="continue-item">
      <Link className="continue-card" to={`/books/${book.id}`}>
        <CoverArt
          editionId={book.id}
          title={book.title}
          author={book.authors[0]}
          hasCover={book.hasCover}
          variant="thumb"
        />
        <span className="continue-copy">
          <span className="continue-kicker">
            <BookOpen size={13} aria-hidden="true" />
            {t('reading.reading')}
          </span>
          <span className="continue-title">{book.title}</span>
          {book.authors.length > 0 ? <span className="continue-author">{book.authors.join(', ')}</span> : null}
          <span className="continue-cta">
            {t('library.resume')}
            <ArrowRight size={14} aria-hidden="true" />
          </span>
        </span>
      </Link>
    </li>
  );
}

function StatCard({
  icon,
  value,
  label,
}: {
  icon: ReactNode;
  value: string;
  label: string;
}) {
  return (
    <div className="stat-card">
      <span className="stat-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

export function LibraryBrowser({ libraries = [] }: { libraries?: LibraryInfo[] }) {
  const { t } = useLocale();
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [language, setLanguage] = useState('');
  const [format, setFormat] = useState('');
  const [status, setStatus] = useState('');
  const [shelfId, setShelfId] = useState('');
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [generation, setGeneration] = useState(0);
  const [home, setHome] = useState<HomePayload | null>(null);
  const [homeError, setHomeError] = useState<string | null>(null);
  const [homeLoading, setHomeLoading] = useState(true);
  const [page, setPage] = useState<LibraryPage | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(true);

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
    void api<LibraryPage>(libraryPath({ q, language, format, status, shelfId, offset })).then((result) => {
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
  }, [q, language, format, status, shelfId, offset, generation]);

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
    setOffset(0);
  }

  const initialLoading = homeLoading && !home;
  const showPageLoading = pageLoading && !initialLoading;
  const alertCode = homeError ?? pageError;
  const activeFilters = Boolean(q || language || format || status || shelfId);
  const total = page?.total ?? 0;
  const first = total === 0 ? 0 : offset + 1;
  const last = offset + (page?.editions.length ?? 0);

  return (
    <div className="library-page">
      <PageHeader
        eyebrow={
          <span className="eyebrow">
            <Sparkles size={13} aria-hidden="true" />
            {t('brand.tagline')}
          </span>
        }
        title={t('home.title')}
        description={t('home.subtitle')}
        meta={
          <div className="library-context">
            <span className="context-label">{t('home.libraries')}</span>
            {libraries.length === 0 ? (
              <span className="context-empty">{t('home.noAccess')}</span>
            ) : (
              libraries.map((library) => (
                <span className="context-chip" key={library.id}>
                  <Library size={13} aria-hidden="true" />
                  <span>{library.name}</span>
                </span>
              ))
            )}
          </div>
        }
        actions={
          <Link className="btn btn-primary" to="/import">
            <Plus size={16} aria-hidden="true" />
            {t('home.addBooks')}
          </Link>
        }
      />

      <section className="stat-row" aria-label={t('home.libraries')}>
        <StatCard
          icon={<BookOpen size={18} />}
          value={page ? String(page.total) : '—'}
          label={t('home.books')}
        />
        <StatCard
          icon={<BookMarked size={18} />}
          value={home ? String(home.continueReading.length) : '—'}
          label={t('home.inProgress')}
        />
        <StatCard
          icon={<Library size={18} />}
          value={home ? String(home.shelves.length) : '—'}
          label={t('home.shelvesCount')}
        />
      </section>

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

      {initialLoading ? <SkeletonGrid count={6} /> : null}

      {home ? (
        <>
          <section className="content-section" aria-labelledby="continue-heading">
            <div className="section-heading">
              <div>
                <p className="section-kicker">{t('home.inProgress')}</p>
                <h2 id="continue-heading">{t('library.continue')}</h2>
              </div>
              <span className="section-count">{home.continueReading.length}</span>
            </div>
            {home.continueReading.length === 0 ? (
              <EmptyState
                compact
                icon={<BookOpen size={20} />}
                title={t('library.continueEmpty')}
                description={t('home.subtitle')}
                action={
                  <Link className="btn btn-secondary btn-sm" to="/import">
                    <Plus size={14} aria-hidden="true" />
                    {t('home.addBooks')}
                  </Link>
                }
              />
            ) : (
              <ul className="continue-grid">
                {home.continueReading.map((book) => (
                  <ContinueCard key={book.id} book={book} />
                ))}
              </ul>
            )}
          </section>

          <div className="dashboard-split">
            <section className="content-section" aria-labelledby="recent-heading">
              <div className="section-heading">
                <div>
                  <p className="section-kicker">{t('home.books')}</p>
                  <h2 id="recent-heading">{t('library.recent')}</h2>
                </div>
                <span className="section-count">{home.recent.length}</span>
              </div>
              {home.recent.length === 0 ? (
                <EmptyState compact icon={<Sparkles size={20} />} title={t('library.recentEmpty')} />
              ) : (
                <ul className="book-grid book-grid-recent">
                  {home.recent.map((book) => (
                    <BookCard key={book.id} book={book} />
                  ))}
                </ul>
              )}
            </section>

            <section className="content-section shelves-section" aria-labelledby="shelves-heading">
              <div className="section-heading">
                <div>
                  <p className="section-kicker">{t('home.libraries')}</p>
                  <h2 id="shelves-heading">{t('library.shelves')}</h2>
                </div>
                <span className="section-count">{home.shelves.length}</span>
              </div>
              {home.shelves.length === 0 ? (
                <EmptyState compact icon={<BookMarked size={20} />} title={t('library.shelvesEmpty')} />
              ) : (
                <ul className="shelf-list">
                  {home.shelves.map((shelf) => (
                    <li key={shelf.id}>
                      <button
                        type="button"
                        className={String(shelf.id) === shelfId ? 'shelf-card shelf-card-active' : 'shelf-card'}
                        aria-label={shelf.name}
                        aria-pressed={String(shelf.id) === shelfId}
                        onClick={() => {
                          setShelfId(String(shelf.id));
                          setOffset(0);
                        }}
                      >
                        <span className="shelf-icon" aria-hidden="true">
                          <BookMarked size={17} />
                        </span>
                        <span className="shelf-name">{shelf.name}</span>
                        <span className="shelf-count">{shelf.count}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      ) : null}

      <section className="browse-panel" aria-labelledby="browse-heading">
        <div className="browse-head">
          <div>
            <p className="section-kicker">{t('library.results')}</p>
            <h2 id="browse-heading">{t('home.allBooks')}</h2>
          </div>
          {page ? (
            <span className="browse-count">
              {first}–{last} {t('library.of')} {page.total}
            </span>
          ) : null}
        </div>

        <form className="search-form" role="search" onSubmit={submitSearch}>
          <div className="search-field">
            <Search size={18} aria-hidden="true" />
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
          <button className="btn btn-primary" type="submit">
            {t('library.submit')}
          </button>
        </form>

        <div className="filter-bar">
          <span className="filter-caption">
            <SlidersHorizontal size={14} aria-hidden="true" />
            {t('library.filters')}
          </span>
          <label className="filter-field">
            <span>{t('library.language')}</span>
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
            <span>{t('library.format')}</span>
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
            <span>{t('library.status')}</span>
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
            <span>{t('library.shelf')}</span>
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
          {activeFilters ? (
            <button type="button" className="btn btn-ghost btn-sm clear-filters" onClick={clearFilters}>
              <X size={14} aria-hidden="true" />
              {t('library.clearFilters')}
            </button>
          ) : null}
          <div className="view-switch" role="group" aria-label={t('library.results')}>
            <button
              type="button"
              className="view-button"
              aria-pressed={view === 'grid'}
              onClick={() => setView('grid')}
            >
              <LayoutGrid size={15} aria-hidden="true" />
              {t('library.grid')}
            </button>
            <button
              type="button"
              className="view-button"
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              <List size={15} aria-hidden="true" />
              {t('library.list')}
            </button>
          </div>
        </div>

        {showPageLoading ? <SkeletonGrid count={8} /> : null}
        {page && !pageLoading && page.editions.length === 0 ? (
          <EmptyState
            icon={<Search size={22} />}
            title={t('library.empty')}
            description={activeFilters ? t('library.searchHint') : undefined}
            action={
              activeFilters ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={clearFilters}>
                  {t('library.clearFilters')}
                </button>
              ) : null
            }
          />
        ) : null}
        {page && !pageLoading && page.editions.length > 0 ? (
          view === 'grid' ? (
            <ul className="book-grid" aria-label={t('library.results')}>
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
                  {book.language ? <span className="book-row-lang">{book.language}</span> : null}
                  <span className="book-row-formats">
                    {book.formats.map((item) => (
                      <span key={item} className={`format-badge format-${item}`}>
                        {item.toUpperCase()}
                      </span>
                    ))}
                  </span>
                  {book.status ? (
                    <span className={`status-pill status-pill-${book.status}`}>
                      <span className="status-dot" aria-hidden="true" />
                      {t(`reading.${book.status}`)}
                    </span>
                  ) : null}
                  {book.rating ? <Stars rating={book.rating} /> : null}
                </li>
              ))}
            </ul>
          )
        ) : null}

        {page && !pageLoading && (offset > 0 || offset + page.editions.length < page.total) ? (
          <div className="pagination">
            <span className="pagination-copy">
              {first}–{last} {t('library.of')} {page.total}
            </span>
            <div className="pagination-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_LIMIT))}
              >
                <ChevronLeft size={15} aria-hidden="true" />
                {t('library.previous')}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={offset + page.editions.length >= page.total}
                onClick={() => setOffset(offset + PAGE_LIMIT)}
              >
                {t('library.next')}
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <CatalogHome />
    </div>
  );
}
