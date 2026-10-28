import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  AlertCircle,
  AlignLeft,
  ArrowLeft,
  BookOpen,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Highlighter,
  ListTree,
  Loader2,
  NotebookPen,
  RefreshCw,
  Search,
  Type,
} from 'lucide-react';
import { api, type ApiResult } from '../api';
import { isSavedEpubLocator } from './epub/cfi';
import { createDebouncedSave, POSITION_SAVE_DELAY_MS } from './epub/debounce';
import { onReaderKey } from './epub/keys';
import { openEpubSession } from './epub/session';
import { fontStack, type ReaderFlow, type ReaderFont, type ReaderTheme } from './epub/settings';
import type { BookFacts, EpubSession, SearchHit, TocItem, Typography } from './epub/types';
import { useLocale } from '../shell';

const FONT_SIZES = ['100%', '112%', '125%', '150%', '175%'];
const LINE_HEIGHTS = ['1.45', '1.6', '1.8', '2'];
const MARGINS = ['0.75rem', '1.5rem', '2.5rem', '4rem'];
const ERROR_CODES = new Set([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'required',
  'network',
  'internal',
]);

interface Bookmark {
  id: number;
  locator: string;
  label: string | null;
  revision: number;
}

interface Highlight {
  id: number;
  locator: string;
  quote: string | null;
  revision: number;
}

interface Note {
  id: number;
  locator: string | null;
  body: string;
  revision: number;
}

interface ReadingPlace {
  position: { locator: string; revision: number; assetId: number | null; updatedAt: string } | null;
  bookmarks: Bookmark[];
  highlights: Highlight[];
  notes: Note[];
}

const INITIAL_TYPE: Typography = {
  font: 'serif',
  fontSize: '112%',
  lineHeight: '1.6',
  margin: '1.5rem',
  theme: 'paper',
};

/**
 * epub.js resolves display(), then runs reportLocation on a later queue frame
 * and emits relocated on the animation frame after that. The caller resumes
 * before that queue frame is scheduled, so ignore moves for one frame past the
 * echo. The event carries the visible page start, not the CFI passed to display().
 */
function afterRelocatedEcho(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  });
}

function errorText(t: (key: string) => string, code: string | null): string {
  const known = code && ERROR_CODES.has(code) ? code : 'internal';
  return t(`errors.${known}`);
}

function TocTree({ items, onOpen }: { items: TocItem[]; onOpen: (href: string) => void }) {
  return (
    <ul className="plain-list">
      {items.map((item, index) => (
        <li key={`${item.href}:${index}`}>
          <button type="button" className="reader-toc-button" onClick={() => onOpen(item.href)}>
            {item.label}
          </button>
          {item.children.length > 0 ? <TocTree items={item.children} onOpen={onOpen} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function EpubReader({ editionId, assetId, title }: { editionId: number; assetId: number; title: string }) {
  const { t } = useLocale();
  const noteId = useId();
  const searchInputId = useId();
  const stageRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<EpubSession | null>(null);
  const cfiRef = useRef<string | null>(null);
  const savedRef = useRef<string | null>(null);
  const typeRef = useRef<Typography>(INITIAL_TYPE);
  const saverRef = useRef<{ flush: () => void; cancel: () => void } | null>(null);
  const revisionRef = useRef(0);
  const generationRef = useRef(0);
  const chainRef = useRef(Promise.resolve());
  const chainIdle = useRef(true);
  const holdRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [keptNewer, setKeptNewer] = useState(false);
  const [ready, setReady] = useState(false);
  const [flow, setFlow] = useState<ReaderFlow>('paginated');
  const [font, setFont] = useState<ReaderFont>(INITIAL_TYPE.font);
  const [fontSize, setFontSize] = useState(INITIAL_TYPE.fontSize);
  const [lineHeight, setLineHeight] = useState(INITIAL_TYPE.lineHeight);
  const [margin, setMargin] = useState(INITIAL_TYPE.margin);
  const [theme, setTheme] = useState<ReaderTheme>(INITIAL_TYPE.theme);
  const [panel, setPanel] = useState<'contents' | 'search' | 'bookmarks' | 'highlights' | 'notes' | null>(null);
  const [displayOpen, setDisplayOpen] = useState(false);
  const displayPanelId = useId();
  const [toc, setToc] = useState<TocItem[]>([]);
  const [facts, setFacts] = useState<BookFacts>({ language: null, direction: 'ltr' });
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selection, setSelection] = useState<{ cfi: string; quote: string } | null>(null);
  const [noteBody, setNoteBody] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  async function reloadReading(adoptPosition: boolean): Promise<boolean> {
    generationRef.current += 1;
    saverRef.current?.cancel();
    // Cover the GET as well as display(): a relocated event in that gap would
    // otherwise be sent with the revision this reload is about to adopt.
    holdRef.current = true;
    try {
      const place = await api<ReadingPlace>(`/api/editions/${editionId}/reading-place`);
      if (place.error || !place.data) {
        setError(place.error ?? 'network');
        return false;
      }
      setBookmarks(place.data.bookmarks);
      setHighlights(place.data.highlights);
      setNotes(place.data.notes);
      const position = place.data.position;
      revisionRef.current = position?.revision ?? 0;
      if (adoptPosition && position && isSavedEpubLocator(position.locator)) {
        savedRef.current = position.locator;
        cfiRef.current = position.locator;
        try {
          await sessionRef.current?.display(position.locator);
        } catch {
          // The kept place stays; a failed display must not write a local CFI.
        }
      }
      await afterRelocatedEcho();
      return true;
    } finally {
      holdRef.current = false;
    }
  }

  async function settle<T>(result: ApiResult<T>): Promise<T | null | undefined> {
    if (result.status === 409) {
      const reloaded = await reloadReading(true);
      if (reloaded) {
        setKeptNewer(true);
        setError(null);
      }
      return undefined;
    }
    if (result.error) {
      setError(result.error);
      return null;
    }
    setError(null);
    setKeptNewer(false);
    return result.data;
  }

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let alive = true;
    const saver = createDebouncedSave(POSITION_SAVE_DELAY_MS, (locator) => {
      const ticket = generationRef.current;
      const run = async () => {
        if (ticket !== generationRef.current) return;
        const result = await api<{ position: { locator: string; revision: number } }>(
          `/api/editions/${editionId}/reading-place`,
          { method: 'PUT', body: { locator, assetId, revision: revisionRef.current } },
        );
        if (!alive || ticket !== generationRef.current) return;
        if (result.status === 409) {
          const reloaded = await reloadReading(true);
          if (!alive) return;
          if (reloaded) {
            setKeptNewer(true);
            setError(null);
          }
          return;
        }
        if (result.error || !result.data?.position) {
          setError(result.error ?? 'internal');
          return;
        }
        revisionRef.current = result.data.position.revision;
        savedRef.current = result.data.position.locator;
      };
      if (chainIdle.current) {
        chainIdle.current = false;
        const promise = run().finally(() => {
          if (chainRef.current === promise) chainIdle.current = true;
        });
        chainRef.current = promise;
        return;
      }
      const promise = chainRef.current.then(run, run).finally(() => {
        if (chainRef.current === promise) chainIdle.current = true;
      });
      chainRef.current = promise;
    });
    saverRef.current = saver;
    let offRelocated = () => {};
    let offSelected = () => {};

    void (async () => {
      const [fileResponse, place] = await Promise.all([
        fetch(`/api/editions/${editionId}/assets/${assetId}/file`, { credentials: 'same-origin' }).catch(() => null),
        api<ReadingPlace>(`/api/editions/${editionId}/reading-place`),
      ]);
      if (!alive) return;
      if (!fileResponse || !fileResponse.ok) {
        setError(!fileResponse ? 'network' : fileResponse.status === 404 ? 'not_found' : 'internal');
        return;
      }
      const bytes = await fileResponse.arrayBuffer();
      if (!alive) return;
      const initial = place.data?.position?.locator;
      const initialCfi = isSavedEpubLocator(initial) ? initial : null;
      cfiRef.current = initialCfi;
      savedRef.current = initialCfi;
      revisionRef.current = place.data?.position?.revision ?? 0;
      if (place.data) {
        setBookmarks(place.data.bookmarks);
        setHighlights(place.data.highlights);
        setNotes(place.data.notes);
      }
      try {
        const session = await openEpubSession(bytes, stage, {
          initialCfi,
          flow: 'paginated',
          typography: typeRef.current,
        });
        if (!alive) {
          session.destroy();
          return;
        }
        sessionRef.current = session;
        setToc(session.toc);
        setPanel(session.toc.length > 0 ? 'contents' : null);
        setFacts(session.facts);
        for (const mark of place.data?.highlights ?? []) {
          if (isSavedEpubLocator(mark.locator)) session.highlight(mark.locator);
        }
        for (const note of place.data?.notes ?? []) {
          if (isSavedEpubLocator(note.locator)) session.underline(note.locator);
        }
        offRelocated = session.onRelocated((locator) => {
          if (holdRef.current) return;
          if (!isSavedEpubLocator(locator)) return;
          cfiRef.current = locator;
          if (locator === savedRef.current) return;
          savedRef.current = locator;
          saver.push(locator);
        });
        offSelected = session.onSelected((locator, quote) => {
          if (!isSavedEpubLocator(locator)) return;
          setSelection({ cfi: locator, quote });
        });
        setReady(true);
      } catch {
        if (alive) setError('internal');
      }
    })();

    return () => {
      alive = false;
      saver.flush();
      saverRef.current = null;
      offRelocated();
      offSelected();
      sessionRef.current?.destroy();
      sessionRef.current = null;
    };
  }, [assetId, editionId]);

  useEffect(() => {
    const flush = () => saverRef.current?.flush();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    const session = sessionRef.current;
    if (!ready || !stage || !session || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      session.resize(stage.clientWidth, stage.clientHeight, cfiRef.current);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      onReaderKey(event, {
        enabled: flow === 'paginated',
        direction: facts.direction,
        next: () => {
          void sessionRef.current?.next();
        },
        prev: () => {
          void sessionRef.current?.prev();
        },
      });
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [facts.direction, flow]);

  function paint(next: Typography) {
    typeRef.current = next;
    void sessionRef.current?.applyTypography(next, cfiRef.current);
  }

  function go(target: string) {
    if (isSavedEpubLocator(target)) cfiRef.current = target;
    void sessionRef.current?.display(target);
  }

  async function addBookmark() {
    const locator = cfiRef.current;
    if (!isSavedEpubLocator(locator)) return;
    const result = await api<{ bookmark: Bookmark }>(`/api/editions/${editionId}/bookmarks`, {
      method: 'POST',
      body: { locator, assetId, revision: 0 },
    });
    const data = await settle(result);
    if (!data?.bookmark) return;
    setBookmarks((items) => [...items, data.bookmark]);
    setPanel('bookmarks');
  }

  async function addHighlight() {
    if (!selection) return;
    const result = await api<{ highlight: Highlight }>(`/api/editions/${editionId}/highlights`, {
      method: 'POST',
      body: { locator: selection.cfi, assetId, quote: selection.quote || null, revision: 0 },
    });
    const data = await settle(result);
    if (!data?.highlight) return;
    sessionRef.current?.highlight(data.highlight.locator);
    setHighlights((items) => [...items, data.highlight]);
    setSelection(null);
    setPanel('highlights');
  }

  async function saveNote(event: FormEvent) {
    event.preventDefault();
    if (!selection) return;
    const body = noteBody.trim();
    if (!body) {
      setError('required');
      return;
    }
    const result = await api<{ note: Note }>(`/api/editions/${editionId}/notes`, {
      method: 'POST',
      body: { locator: selection.cfi, assetId, body, revision: 0 },
    });
    const data = await settle(result);
    if (!data?.note) return;
    if (isSavedEpubLocator(data.note.locator)) sessionRef.current?.underline(data.note.locator);
    setNotes((items) => [...items, data.note]);
    setNoteBody('');
    setSelection(null);
    setPanel('notes');
  }

  async function removeBookmark(item: Bookmark) {
    const result = await api(`/api/editions/${editionId}/bookmarks/${item.id}`, {
      method: 'DELETE',
      body: { revision: item.revision },
    });
    const data = await settle(result);
    if (data === undefined || result.error) return;
    setBookmarks((items) => items.filter((mark) => mark.id !== item.id));
  }

  async function removeHighlight(mark: Highlight) {
    const result = await api(`/api/editions/${editionId}/highlights/${mark.id}`, {
      method: 'DELETE',
      body: { revision: mark.revision },
    });
    const data = await settle(result);
    if (data === undefined || result.error) return;
    sessionRef.current?.removeMark(mark.locator, 'highlight');
    setHighlights((items) => items.filter((item) => item.id !== mark.id));
  }

  async function removeNote(note: Note) {
    const result = await api(`/api/editions/${editionId}/notes/${note.id}`, {
      method: 'DELETE',
      body: { revision: note.revision },
    });
    const data = await settle(result);
    if (data === undefined || result.error) return;
    if (isSavedEpubLocator(note.locator)) sessionRef.current?.removeMark(note.locator, 'underline');
    setNotes((items) => items.filter((item) => item.id !== note.id));
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    const needle = query.trim();
    if (!needle || !sessionRef.current) return;
    setSearching(true);
    try {
      setHits(await sessionRef.current.search(needle));
    } finally {
      setSearching(false);
    }
  }

  function toggle(next: typeof panel) {
    setPanel((current) => (current === next ? null : next));
  }

  return (
    <div className={`reader-page theme-${theme}`}>
      <header className="reader-header">
        <div className="reader-header-top">
          <div className="reader-breadcrumb">
            <Link className="back-link" to={`/books/${editionId}`}>
              <ArrowLeft size={15} aria-hidden="true" />
              {t('reader.backToBook')}
            </Link>
            <span className="reader-separator" aria-hidden="true">
              /
            </span>
            <Link className="text-link" to="/">
              {t('reader.library')}
            </Link>
          </div>
          <span className="reader-format-chip">{t('library.formatEpub')}</span>
        </div>
        <h1 className="reader-title">{title}</h1>
        {error ? (
          <div className="alert alert-error" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            {errorText(t, error)}
          </div>
        ) : null}
        {keptNewer ? (
          <p className="notice" role="status">
            <RefreshCw size={15} aria-hidden="true" />
            {t('reader.newerKept')}
          </p>
        ) : null}
      </header>

      <div className="reader-toolbar">
        <div className="reader-group" role="group" aria-label={t('reader.paginated')}>
          <button
            type="button"
            className="reader-tool"
            aria-pressed={flow === 'paginated'}
            disabled={!ready}
            onClick={() => {
              setFlow('paginated');
              void sessionRef.current?.setFlow('paginated');
            }}
          >
            <BookOpen size={15} aria-hidden="true" />
            {t('reader.paginated')}
          </button>
          <button
            type="button"
            className="reader-tool"
            aria-pressed={flow === 'continuous'}
            disabled={!ready}
            onClick={() => {
              setFlow('continuous');
              void sessionRef.current?.setFlow('continuous');
            }}
          >
            <AlignLeft size={15} aria-hidden="true" />
            {t('reader.scrolled')}
          </button>
        </div>

        <button
          type="button"
          className="reader-tool reader-display-toggle"
          aria-expanded={displayOpen}
          aria-controls={displayPanelId}
          onClick={() => setDisplayOpen((value) => !value)}
        >
          <Type size={15} aria-hidden="true" />
          {t('reader.display')}
        </button>
        <div id={displayPanelId} className={displayOpen ? 'reader-group reader-display-group is-open' : 'reader-group reader-display-group'}>
          <span className="reader-group-label">
            <Type size={14} aria-hidden="true" />
            {t('reader.display')}
          </span>
          <label className="reader-select">
            <span>{t('reader.font')}</span>
            <select
              value={font}
              disabled={!ready}
              onChange={(event) => {
                const next = event.target.value === 'sans' ? 'sans' : 'serif';
                setFont(next);
                paint({ ...typeRef.current, font: next });
              }}
            >
              <option value="serif">{t('reader.fontSerif')}</option>
              <option value="sans">{t('reader.fontSans')}</option>
            </select>
          </label>
          <label className="reader-select">
            <span>{t('reader.fontSize')}</span>
            <select
              value={fontSize}
              disabled={!ready}
              onChange={(event) => {
                setFontSize(event.target.value);
                paint({ ...typeRef.current, fontSize: event.target.value });
              }}
            >
              {FONT_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <label className="reader-select">
            <span>{t('reader.lineHeight')}</span>
            <select
              value={lineHeight}
              disabled={!ready}
              onChange={(event) => {
                setLineHeight(event.target.value);
                paint({ ...typeRef.current, lineHeight: event.target.value });
              }}
            >
              {LINE_HEIGHTS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <label className="reader-select">
            <span>{t('reader.margins')}</span>
            <select
              value={margin}
              disabled={!ready}
              onChange={(event) => {
                setMargin(event.target.value);
                paint({ ...typeRef.current, margin: event.target.value });
              }}
            >
              {MARGINS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <label className="reader-select">
            <span>{t('reader.theme')}</span>
            <select
              value={theme}
              disabled={!ready}
              onChange={(event) => {
                const next = event.target.value === 'ink' ? 'ink' : 'paper';
                setTheme(next);
                paint({ ...typeRef.current, theme: next });
              }}
            >
              <option value="paper">{t('reader.themePaper')}</option>
              <option value="ink">{t('reader.themeInk')}</option>
            </select>
          </label>
        </div>

        <div className="reader-toolbar-end">
          <button type="button" className="reader-tool" disabled={!ready} onClick={() => void addBookmark()}>
            <Bookmark size={15} aria-hidden="true" />
            {t('reader.bookmark')}
          </button>
        </div>
      </div>

      <div className="reader-panel-bar" role="toolbar" aria-label={t('reader.contents')}>
        <div className="reader-group">
          <button
            type="button"
            className="reader-tool"
            aria-pressed={panel === 'contents'}
            onClick={() => toggle('contents')}
          >
            <ListTree size={15} aria-hidden="true" />
            {t('reader.contents')}
          </button>
          <button
            type="button"
            className="reader-tool"
            aria-pressed={panel === 'search'}
            onClick={() => toggle('search')}
          >
            <Search size={15} aria-hidden="true" />
            {t('reader.search')}
          </button>
          <button
            type="button"
            className="reader-tool"
            aria-pressed={panel === 'bookmarks'}
            onClick={() => toggle('bookmarks')}
          >
            <Bookmark size={15} aria-hidden="true" />
            {t('reader.bookmarks')}
          </button>
          <button
            type="button"
            className="reader-tool"
            aria-pressed={panel === 'highlights'}
            onClick={() => toggle('highlights')}
          >
            <Highlighter size={15} aria-hidden="true" />
            {t('reader.highlights')}
          </button>
          <button
            type="button"
            className="reader-tool"
            aria-pressed={panel === 'notes'}
            onClick={() => toggle('notes')}
          >
            <NotebookPen size={15} aria-hidden="true" />
            {t('reader.notes')}
          </button>
        </div>
        {flow === 'paginated' ? (
          <div className="reader-group reader-page-turn">
            <button type="button" className="reader-tool" disabled={!ready} onClick={() => void sessionRef.current?.prev()}>
              <ChevronLeft size={15} aria-hidden="true" />
              {t('reader.previousPage')}
            </button>
            <button type="button" className="reader-tool" disabled={!ready} onClick={() => void sessionRef.current?.next()}>
              {t('reader.nextPage')}
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>

      {selection ? (
        <div className="reader-selection" role="region" aria-label={t('reader.selection')}>
          {selection.quote ? <p className="reader-selection-quote">{selection.quote}</p> : null}
          <div className="reader-selection-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void addHighlight()}>
              <Highlighter size={15} aria-hidden="true" />
              {t('reader.highlight')}
            </button>
            <form className="reader-note-form" onSubmit={(event) => void saveNote(event)}>
              <label className="visually-hidden" htmlFor={noteId}>
                {t('reader.noteBody')}
              </label>
              <textarea
                id={noteId}
                value={noteBody}
                placeholder={t('reader.noteBody')}
                onChange={(event) => setNoteBody(event.target.value)}
              />
              <button type="submit" className="btn btn-primary btn-sm">
                {t('reader.saveNote')}
              </button>
            </form>
          </div>
        </div>
      ) : null}

      <div className={panel ? 'reader-layout' : 'reader-layout reader-layout-solo'}>
        {panel ? (
          <aside className="reader-panel" aria-label={t(`reader.${panel === 'contents' ? 'contents' : panel}`)}>
            <div className="reader-panel-head">
              <h2>{t(`reader.${panel === 'contents' ? 'contents' : panel}`)}</h2>
              <span className="section-count">
                {panel === 'contents' ? toc.length : panel === 'bookmarks' ? bookmarks.length : panel === 'highlights' ? highlights.length : panel === 'notes' ? notes.length : hits.length}
              </span>
            </div>
            {panel === 'contents' ? <TocTree items={toc} onOpen={go} /> : null}
            {panel === 'search' ? (
              <>
                <form className="reader-search" onSubmit={(event) => void runSearch(event)}>
                  <label className="visually-hidden" htmlFor={searchInputId}>
                    {t('reader.search')}
                  </label>
                  <div className="input-with-icon">
                    <span className="input-icon" aria-hidden="true">
                      <Search size={15} />
                    </span>
                    <input
                      id={searchInputId}
                      value={query}
                      placeholder={t('reader.search')}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                  <button type="submit" className="btn btn-primary btn-sm" disabled={!ready || searching}>
                    {searching ? <Loader2 className="spin" size={14} aria-hidden="true" /> : null}
                    {t('reader.searchSubmit')}
                  </button>
                </form>
                {hits.length === 0 ? <p className="placeholder">{t('reader.searchEmpty')}</p> : null}
                <ul className="reader-list">
                  {hits.map((hit, index) => (
                    <li key={`${hit.cfi}:${index}`}>
                      <button type="button" className="reader-toc-button" onClick={() => go(hit.cfi)}>
                        {hit.excerpt || hit.cfi}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {panel === 'bookmarks' ? (
              bookmarks.length === 0 ? (
                <p className="placeholder">{t('reader.noBookmarks')}</p>
              ) : (
                <ul className="reader-list">
                  {bookmarks.map((item) => (
                    <li key={item.id} className="reader-row-line">
                      <button type="button" className="reader-toc-button" onClick={() => go(item.locator)}>
                        {item.label || item.locator}
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void removeBookmark(item)}>
                        {t('reader.remove')}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
            {panel === 'highlights' ? (
              highlights.length === 0 ? (
                <p className="placeholder">{t('reader.noHighlights')}</p>
              ) : (
                <ul className="reader-list">
                  {highlights.map((item) => (
                    <li key={item.id} className="reader-row-line">
                      <button type="button" className="reader-toc-button" onClick={() => go(item.locator)}>
                        {item.quote || item.locator}
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void removeHighlight(item)}>
                        {t('reader.remove')}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
            {panel === 'notes' ? (
              notes.length === 0 ? (
                <p className="placeholder">{t('reader.noNotes')}</p>
              ) : (
                <ul className="reader-list">
                  {notes.map((item) => (
                    <li key={item.id} className="reader-row-line">
                      <button
                        type="button"
                        className="reader-toc-button"
                        onClick={() => {
                          if (isSavedEpubLocator(item.locator)) go(item.locator);
                        }}
                      >
                        {item.body}
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void removeNote(item)}>
                        {t('reader.remove')}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </aside>
        ) : null}
        <div className="reader-stage-wrap">
          {!ready && !error ? (
            <div className="reader-stage-loading" role="status">
              <Loader2 className="spin" size={20} aria-hidden="true" />
              {t('status.loading')}
            </div>
          ) : null}
          <div
            ref={stageRef}
            className="reader-stage"
            lang={facts.language ?? undefined}
            dir={facts.direction}
            style={{ fontFamily: fontStack(font) }}
          />
        </div>
      </div>
    </div>
  );
}
