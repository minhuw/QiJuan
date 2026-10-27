import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, type HomePayload, type LibraryEdition, type LibraryPage, type ReadingStatus } from './api';
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

export function LibraryBrowser() {
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

  const initialLoading = homeLoading && !home;
  const showPageLoading = pageLoading && !initialLoading;
  const alertCode = homeError ?? pageError;

  return (
    <div className="library-block">
      {initialLoading ? <p role="status">{t('status.loading')}</p> : null}
      {alertCode ? (
        <p className="alert" role="alert">
          {errorText(t, alertCode)}
        </p>
      ) : null}
      {homeError || pageError ? (
        <button type="button" className="button" onClick={() => setGeneration((value) => value + 1)}>
          {t('status.retry')}
        </button>
      ) : null}
      {home ? (
        <>
          <section className="import-block">
            <h2>{t('library.continue')}</h2>
            {home.continueReading.length === 0 ? <p className="placeholder">{t('library.continueEmpty')}</p> : null}
            {home.continueReading.length > 0 ? (
              <ul className="cover-grid">
                {home.continueReading.map((book) => (
                  <BookCard key={book.id} book={book} />
                ))}
              </ul>
            ) : null}
          </section>
          <section className="import-block">
            <h2>{t('library.recent')}</h2>
            {home.recent.length === 0 ? <p className="placeholder">{t('library.recentEmpty')}</p> : null}
            {home.recent.length > 0 ? (
              <ul className="cover-grid">
                {home.recent.map((book) => (
                  <BookCard key={book.id} book={book} />
                ))}
              </ul>
            ) : null}
          </section>
          <section className="import-block">
            <h2>{t('library.shelves')}</h2>
            {home.shelves.length === 0 ? <p className="placeholder">{t('library.shelvesEmpty')}</p> : null}
            {home.shelves.length > 0 ? (
              <ul className="plain-list">
                {home.shelves.map((shelf) => (
                  <li key={shelf.id} className="book-row">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => {
                        setShelfId(String(shelf.id));
                        setOffset(0);
                      }}
                    >
                      {shelf.name}
                    </button>
                    <span className="hint-inline">{shelf.count}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </>
      ) : null}

      <form className="library-search-form" onSubmit={submitSearch}>
        <label className="field library-search-field" htmlFor={searchId}>
          {t('library.search')}
          <input
            id={searchId}
            ref={searchRef}
            className="library-search"
            type="search"
            value={draft}
            placeholder={t('library.searchHint')}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button className="button" type="submit">
          {t('library.submit')}
        </button>
      </form>

      <div className="library-toolbar">
        <label>
          {t('library.language')}
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
        <label>
          {t('library.format')}
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
        <label>
          {t('library.status')}
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
        <label>
          {t('library.shelf')}
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
        <div className="view-switch" role="group" aria-label={t('library.results')}>
          <button type="button" className="button" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>
            {t('library.grid')}
          </button>
          <button type="button" className="button button-secondary" aria-pressed={view === 'list'} onClick={() => setView('list')}>
            {t('library.list')}
          </button>
        </div>
      </div>

      {showPageLoading ? <p role="status">{t('status.loading')}</p> : null}
      {page && !pageLoading && page.editions.length === 0 ? <p className="placeholder">{t('library.empty')}</p> : null}
      {page && !pageLoading && page.editions.length > 0 ? (
        <ul className={view === 'grid' ? 'cover-grid' : 'compact-list'} aria-label={t('library.results')}>
          {page.editions.map((book) =>
            view === 'grid' ? (
              <BookCard key={book.id} book={book} />
            ) : (
              <li key={book.id} className="book-row">
                <Link to={`/books/${book.id}`}>{book.title}</Link>
                {book.authors.length > 0 ? <span>{book.authors.join(', ')}</span> : null}
                {book.language ? <span className="hint-inline">{book.language}</span> : null}
                {book.formats.map((item) => (
                  <span key={item}>{item.toUpperCase()}</span>
                ))}
                {book.status ? <span>{t(`reading.${book.status}`)}</span> : null}
              </li>
            ),
          )}
        </ul>
      ) : null}
      {page && !pageLoading && (offset > 0 || offset + page.editions.length < page.total) ? (
        <div className="toolbar">
          <button
            type="button"
            className="button button-secondary"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_LIMIT))}
          >
            {t('library.previous')}
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={offset + page.editions.length >= page.total}
            onClick={() => setOffset(offset + PAGE_LIMIT)}
          >
            {t('library.next')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function BookCard({ book }: { book: LibraryEdition }) {
  const authors = book.authors.join(', ');
  return (
    <li>
      <Link className="cover-card" to={`/books/${book.id}`}>
        {book.hasCover ? (
          <img className="cover-image" alt="" src={`/api/editions/${book.id}/cover`} />
        ) : (
          <span className="cover-fallback">
            <span className="cover-fallback-title">{book.title}</span>
            {book.authors[0] ? <span className="cover-fallback-author">{book.authors[0]}</span> : null}
          </span>
        )}
        <span className="cover-caption">{book.title}</span>
        {authors ? <span className="cover-byline">{authors}</span> : null}
      </Link>
    </li>
  );
}
