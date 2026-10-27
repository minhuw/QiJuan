import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
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
}

interface Highlight {
  id: number;
  locator: string;
  quote: string | null;
}

interface Note {
  id: number;
  locator: string | null;
  body: string;
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
  const stageRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<EpubSession | null>(null);
  const cfiRef = useRef<string | null>(null);
  const savedRef = useRef<string | null>(null);
  const typeRef = useRef<Typography>(INITIAL_TYPE);
  const saverRef = useRef<{ flush: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [flow, setFlow] = useState<ReaderFlow>('paginated');
  const [font, setFont] = useState<ReaderFont>(INITIAL_TYPE.font);
  const [fontSize, setFontSize] = useState(INITIAL_TYPE.fontSize);
  const [lineHeight, setLineHeight] = useState(INITIAL_TYPE.lineHeight);
  const [margin, setMargin] = useState(INITIAL_TYPE.margin);
  const [theme, setTheme] = useState<ReaderTheme>(INITIAL_TYPE.theme);
  const [panel, setPanel] = useState<'contents' | 'search' | 'bookmarks' | 'highlights' | 'notes' | null>('contents');
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

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let alive = true;
    const saver = createDebouncedSave(POSITION_SAVE_DELAY_MS, (locator) => {
      void api(`/api/editions/${editionId}/reading-place`, {
        method: 'PUT',
        body: { locator, assetId },
      });
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
        setFacts(session.facts);
        for (const mark of place.data?.highlights ?? []) {
          if (isSavedEpubLocator(mark.locator)) session.highlight(mark.locator);
        }
        for (const note of place.data?.notes ?? []) {
          if (isSavedEpubLocator(note.locator)) session.underline(note.locator);
        }
        offRelocated = session.onRelocated((locator) => {
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
      body: { locator, assetId },
    });
    if (result.error || !result.data?.bookmark) {
      setError(result.error ?? 'internal');
      return;
    }
    setError(null);
    setBookmarks((items) => [...items, result.data!.bookmark]);
    setPanel('bookmarks');
  }

  async function addHighlight() {
    if (!selection) return;
    const result = await api<{ highlight: Highlight }>(`/api/editions/${editionId}/highlights`, {
      method: 'POST',
      body: { locator: selection.cfi, assetId, quote: selection.quote || null },
    });
    if (result.error || !result.data?.highlight) {
      setError(result.error ?? 'internal');
      return;
    }
    setError(null);
    sessionRef.current?.highlight(result.data.highlight.locator);
    setHighlights((items) => [...items, result.data!.highlight]);
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
      body: { locator: selection.cfi, assetId, body },
    });
    if (result.error || !result.data?.note) {
      setError(result.error ?? 'internal');
      return;
    }
    setError(null);
    if (isSavedEpubLocator(result.data.note.locator)) sessionRef.current?.underline(result.data.note.locator);
    setNotes((items) => [...items, result.data!.note]);
    setNoteBody('');
    setSelection(null);
    setPanel('notes');
  }

  async function removeBookmark(id: number) {
    const result = await api(`/api/editions/${editionId}/bookmarks/${id}`, { method: 'DELETE' });
    if (result.error) {
      setError(result.error);
      return;
    }
    setBookmarks((items) => items.filter((item) => item.id !== id));
  }

  async function removeHighlight(mark: Highlight) {
    const result = await api(`/api/editions/${editionId}/highlights/${mark.id}`, { method: 'DELETE' });
    if (result.error) {
      setError(result.error);
      return;
    }
    sessionRef.current?.removeMark(mark.locator, 'highlight');
    setHighlights((items) => items.filter((item) => item.id !== mark.id));
  }

  async function removeNote(note: Note) {
    const result = await api(`/api/editions/${editionId}/notes/${note.id}`, { method: 'DELETE' });
    if (result.error) {
      setError(result.error);
      return;
    }
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
      <div className="toolbar">
        <Link className="text-link" to={`/books/${editionId}`}>
          {t('reader.backToBook')}
        </Link>
        <Link className="text-link" to="/">
          {t('reader.library')}
        </Link>
      </div>
      <h1>{title}</h1>
      {error ? (
        <p className="alert" role="alert">
          {errorText(t, error)}
        </p>
      ) : null}
      <div className="reader-controls">
        <div className="toolbar" role="group" aria-label={t('reader.paginated')}>
          <button
            type="button"
            className="button"
            aria-pressed={flow === 'paginated'}
            disabled={!ready}
            onClick={() => {
              setFlow('paginated');
              void sessionRef.current?.setFlow('paginated');
            }}
          >
            {t('reader.paginated')}
          </button>
          <button
            type="button"
            className="button"
            aria-pressed={flow === 'continuous'}
            disabled={!ready}
            onClick={() => {
              setFlow('continuous');
              void sessionRef.current?.setFlow('continuous');
            }}
          >
            {t('reader.scrolled')}
          </button>
        </div>
        <label>
          {t('reader.font')}
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
        <label>
          {t('reader.fontSize')}
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
        <label>
          {t('reader.lineHeight')}
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
        <label>
          {t('reader.margins')}
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
        <label>
          {t('reader.theme')}
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
        <button type="button" className="button" disabled={!ready} onClick={() => void addBookmark()}>
          {t('reader.bookmark')}
        </button>
      </div>
      <div className="toolbar" role="toolbar" aria-label={t('reader.contents')}>
        <button type="button" className="button button-secondary" aria-pressed={panel === 'contents'} onClick={() => toggle('contents')}>
          {t('reader.contents')}
        </button>
        <button type="button" className="button button-secondary" aria-pressed={panel === 'search'} onClick={() => toggle('search')}>
          {t('reader.search')}
        </button>
        <button type="button" className="button button-secondary" aria-pressed={panel === 'bookmarks'} onClick={() => toggle('bookmarks')}>
          {t('reader.bookmarks')}
        </button>
        <button type="button" className="button button-secondary" aria-pressed={panel === 'highlights'} onClick={() => toggle('highlights')}>
          {t('reader.highlights')}
        </button>
        <button type="button" className="button button-secondary" aria-pressed={panel === 'notes'} onClick={() => toggle('notes')}>
          {t('reader.notes')}
        </button>
        {flow === 'paginated' ? (
          <>
            <button type="button" className="button" disabled={!ready} onClick={() => void sessionRef.current?.prev()}>
              {t('reader.previousPage')}
            </button>
            <button type="button" className="button" disabled={!ready} onClick={() => void sessionRef.current?.next()}>
              {t('reader.nextPage')}
            </button>
          </>
        ) : null}
      </div>
      {selection ? (
        <div className="toolbar" role="region" aria-label={t('reader.selection')}>
          {selection.quote ? <p className="hint">{selection.quote}</p> : null}
          <button type="button" className="button" onClick={() => void addHighlight()}>
            {t('reader.highlight')}
          </button>
          <form className="reader-note-form" onSubmit={(event) => void saveNote(event)}>
            <label htmlFor={noteId}>{t('reader.noteBody')}</label>
            <textarea id={noteId} value={noteBody} onChange={(event) => setNoteBody(event.target.value)} />
            <button type="submit" className="button">
              {t('reader.saveNote')}
            </button>
          </form>
        </div>
      ) : null}
      <div className={panel ? 'reader-layout' : 'reader-layout reader-layout-solo'}>
        {panel ? (
          <aside className="reader-panel" aria-label={t(`reader.${panel === 'contents' ? 'contents' : panel}`)}>
            {panel === 'contents' ? <TocTree items={toc} onOpen={go} /> : null}
            {panel === 'search' ? (
              <>
                <form className="reader-search" onSubmit={(event) => void runSearch(event)}>
                  <label>
                    {t('reader.search')}
                    <input value={query} onChange={(event) => setQuery(event.target.value)} />
                  </label>
                  <button type="submit" className="button" disabled={!ready || searching}>
                    {t('reader.searchSubmit')}
                  </button>
                </form>
                {hits.length === 0 ? <p className="placeholder">{t('reader.searchEmpty')}</p> : null}
                <ul className="plain-list">
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
                <ul className="plain-list">
                  {bookmarks.map((item) => (
                    <li key={item.id} className="reader-row-line">
                      <button type="button" className="reader-toc-button" onClick={() => go(item.locator)}>
                        {item.label || item.locator}
                      </button>
                      <button type="button" className="button button-secondary" onClick={() => void removeBookmark(item.id)}>
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
                <ul className="plain-list">
                  {highlights.map((item) => (
                    <li key={item.id} className="reader-row-line">
                      <button type="button" className="reader-toc-button" onClick={() => go(item.locator)}>
                        {item.quote || item.locator}
                      </button>
                      <button type="button" className="button button-secondary" onClick={() => void removeHighlight(item)}>
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
                <ul className="plain-list">
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
                      <button type="button" className="button button-secondary" onClick={() => void removeNote(item)}>
                        {t('reader.remove')}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </aside>
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
  );
}
