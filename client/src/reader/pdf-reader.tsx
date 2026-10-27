import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { createDebouncedSave, POSITION_SAVE_DELAY_MS } from './epub/debounce';
import { onReaderKey } from './epub/keys';
import { formatPdfLocator, parsePdfPlace, type PdfPlace } from './pdf/locator';
import { openPdfSession } from './pdf/session';
import { nearbyPages, THUMBNAIL_CSS_WIDTH, THUMBNAIL_RADIUS } from './pdf/thumbs';
import type { PdfOutlineItem, PdfSearchHit, PdfSession, RenderedPage } from './pdf/types';
import { useLocale } from '../shell';

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

interface ReadingPlace {
  position: { locator: string; revision: number; assetId: number | null; updatedAt: string } | null;
  bookmarks: Bookmark[];
}

function errorText(t: (key: string) => string, code: string | null): string {
  const known = code && ERROR_CODES.has(code) ? code : 'internal';
  return t(`errors.${known}`);
}

function stepZoom(scale: number, direction: 1 | -1): number {
  const steps = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  if (direction > 0) return steps.find((value) => value > scale + 0.01) ?? Math.min(4, Math.round(scale * 125) / 100);
  return [...steps].reverse().find((value) => value < scale - 0.01) ?? Math.max(0.5, Math.round((scale / 1.25) * 100) / 100);
}

function OutlineTree({ items, onOpen }: { items: PdfOutlineItem[]; onOpen: (item: PdfOutlineItem) => void }) {
  return (
    <ul className="plain-list">
      {items.map((item, index) => (
        <li key={`${item.title}:${item.page ?? 'x'}:${index}`}>
          <button type="button" className="reader-toc-button" disabled={item.page == null} onClick={() => onOpen(item)}>
            {item.title}
          </button>
          {item.children.length > 0 ? <OutlineTree items={item.children} onOpen={onOpen} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function PdfReader({ editionId, assetId, title }: { editionId: number; assetId: number; title: string }) {
  const { t } = useLocale();
  const searchId = useId();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<PdfSession | null>(null);
  const placeRef = useRef<PdfPlace | null>(null);
  const savedRef = useRef<string | null>(null);
  const saverRef = useRef<{ push: (locator: string) => void; flush: () => void } | null>(null);
  const renderedRef = useRef<RenderedPage | null>(null);
  const suppressScroll = useRef(false);
  const widthRef = useRef(0);
  const thumbs = useRef(new Map<number, HTMLCanvasElement>());
  const thumbTickets = useRef(new Map<number, number>());
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<PdfPlace | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [outline, setOutline] = useState<PdfOutlineItem[]>([]);
  const [thumbnailPages, setThumbnailPages] = useState<number[]>([]);
  const [searchable, setSearchable] = useState<boolean | null>(null);
  const [panel, setPanel] = useState<'outline' | 'thumbnails' | 'search' | 'bookmarks' | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PdfSearchHit[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'empty' | 'hits' | 'unsearchable'>('idle');
  const [searching, setSearching] = useState(false);
  const [scaleLabel, setScaleLabel] = useState<number | null>(null);
  const [pageDraft, setPageDraft] = useState('1');

  function remember(place: PdfPlace) {
    const locator = formatPdfLocator(place);
    if (!locator) return;
    placeRef.current = place;
    if (locator === savedRef.current) return;
    savedRef.current = locator;
    saverRef.current?.push(locator);
  }

  useEffect(() => {
    const scroller = scrollerRef.current;
    const canvas = canvasRef.current;
    const textLayer = textRef.current;
    if (!scroller || !canvas || !textLayer) return;
    let alive = true;
    const saver = createDebouncedSave(POSITION_SAVE_DELAY_MS, (locator) => {
      void api(`/api/editions/${editionId}/reading-place`, {
        method: 'PUT',
        body: { locator, assetId },
      });
    });
    saverRef.current = saver;

    void (async () => {
      const [fileResponse, place] = await Promise.all([
        fetch(`/api/editions/${editionId}/assets/${assetId}/file`, { credentials: 'same-origin' }).catch(() => null),
        api<ReadingPlace>(`/api/editions/${editionId}/reading-place`),
      ]);
      if (!alive) return;
      if (!fileResponse || !fileResponse.ok) {
        const status = fileResponse?.status;
        setError(!fileResponse ? 'network' : status === 404 ? 'not_found' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'internal');
        return;
      }
      const bytes = await fileResponse.arrayBuffer();
      if (!alive) return;
      if (place.data) setBookmarks(place.data.bookmarks);
      try {
        const session = await openPdfSession(bytes);
        if (!alive) {
          await session.destroy();
          return;
        }
        sessionRef.current = session;
        const saved = parsePdfPlace(place.data?.position?.locator);
        const box = await session.pageBox(saved?.page ?? 1);
        const initial: PdfPlace = saved
          ? {
              page: Math.min(saved.page, session.pageCount),
              x: saved.page > session.pageCount ? box.xMin : saved.x,
              y: saved.page > session.pageCount ? box.yMax : saved.y,
              zoom: saved.zoom,
            }
          : { page: 1, x: box.xMin, y: box.yMax, zoom: 'width' };
        savedRef.current = saved ? formatPdfLocator(initial) : null;
        placeRef.current = initial;
        setPageCount(session.pageCount);
        setOutline(session.outline);
        setThumbnailPages(session.thumbnailPages);
        setPanel(session.outline.length > 0 ? 'outline' : session.thumbnailPages.length > 0 ? 'thumbnails' : null);
        setPageDraft(String(initial.page));
        setView(initial);
        setReady(true);
      } catch {
        if (alive) setError('internal');
      }
    })();

    return () => {
      alive = false;
      saver.flush();
      saverRef.current = null;
      void sessionRef.current?.destroy();
      sessionRef.current = null;
    };
  }, [assetId, editionId]);

  useEffect(() => {
    const flush = () => saverRef.current?.flush();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  useEffect(() => {
    const session = sessionRef.current;
    const place = view;
    const canvas = canvasRef.current;
    const textLayer = textRef.current;
    const scroller = scrollerRef.current;
    const shell = pageRef.current;
    if (!ready || !session || !place || !canvas || !textLayer || !scroller || !shell) return;
    let cancel = false;
    const width = scroller.clientWidth || 640;
    void session
      .renderPage({ page: place.page, zoom: place.zoom, containerWidth: width, canvas, textLayer })
      .then((rendered) => {
        if (cancel || !rendered) return;
        const current = placeRef.current;
        if (!current || current.page !== place.page || current.zoom !== place.zoom) return;
        renderedRef.current = rendered;
        shell.style.width = `${rendered.cssWidth}px`;
        shell.style.height = `${rendered.cssHeight}px`;
        setScaleLabel(rendered.scale);
        const point = rendered.toViewport(current.x, current.y);
        suppressScroll.current = true;
        scroller.scrollLeft = point.x;
        scroller.scrollTop = point.y;
        suppressScroll.current = false;
        remember(current);
        setError((previous) => (previous === 'internal' ? null : previous));
      })
      .catch(() => {
        if (cancel) return;
        const current = placeRef.current;
        if (!current || current.page !== place.page || current.zoom !== place.zoom) return;
        setError('internal');
      });
    return () => {
      cancel = true;
    };
  }, [ready, view]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!ready || !scroller) return;
    const node: HTMLDivElement = scroller;
    function onScroll() {
      if (suppressScroll.current) return;
      const rendered = renderedRef.current;
      const place = placeRef.current;
      if (!rendered || !place) return;
      const point = rendered.toPdf(node.scrollLeft, node.scrollTop);
      remember({ ...place, x: point.x, y: point.y });
    }
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [ready]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!ready || !scroller || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const width = scroller.clientWidth;
      if (width === widthRef.current) return;
      widthRef.current = width;
      const place = placeRef.current;
      if (!place || place.zoom !== 'width') return;
      setView({ ...place });
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!ready || !session) return;
    let cancel = false;
    void session.searchable().then((value) => {
      if (!cancel) setSearchable(value);
    });
    return () => {
      cancel = true;
    };
  }, [ready]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!ready || !session || !view || (panel !== 'thumbnails' && panel !== 'outline')) return;
    const pages = nearbyPages(thumbnailPages, view.page, THUMBNAIL_RADIUS);
    let cancel = false;
    for (const page of pages) {
      const canvas = thumbs.current.get(page);
      if (!canvas) continue;
      const ticket = (thumbTickets.current.get(page) ?? 0) + 1;
      thumbTickets.current.set(page, ticket);
      canvas.hidden = false;
      void session.renderThumbnail(page, canvas, THUMBNAIL_CSS_WIDTH).then((ok) => {
        if (cancel || thumbTickets.current.get(page) !== ticket || ok) return;
        const current = placeRef.current;
        if (!current || current.page !== view.page || current.zoom !== view.zoom) return;
        canvas.hidden = true;
      });
    }
    return () => {
      cancel = true;
    };
  }, [panel, ready, thumbnailPages, view]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      onReaderKey(event, {
        enabled: true,
        direction: 'ltr',
        next: () => {
          const place = placeRef.current;
          if (place) void goTo(place.page + 1);
        },
        prev: () => {
          const place = placeRef.current;
          if (place) void goTo(place.page - 1);
        },
      });
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pageCount]);

  async function goTo(page: number, point?: { x: number | null; y: number | null }) {
    const session = sessionRef.current;
    const current = placeRef.current;
    if (!session || !current || session.pageCount < 1) return;
    const clamped = Math.min(session.pageCount, Math.max(1, page));
    const box = await session.pageBox(clamped);
    const next: PdfPlace = {
      page: clamped,
      x: point && point.x != null ? point.x : box.xMin,
      y: point && point.y != null ? point.y : box.yMax,
      zoom: current.zoom,
    };
    remember(next);
    setPageDraft(String(clamped));
    setView(next);
  }

  function setZoom(zoom: PdfPlace['zoom']) {
    const current = placeRef.current;
    if (!current) return;
    remember({ ...current, zoom });
    setView({ ...current, zoom });
  }

  async function addBookmark() {
    const place = placeRef.current;
    if (!place) return;
    const locator = formatPdfLocator(place);
    if (!locator) return;
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

  async function removeBookmark(id: number) {
    const result = await api(`/api/editions/${editionId}/bookmarks/${id}`, { method: 'DELETE' });
    if (result.error) {
      setError(result.error);
      return;
    }
    setBookmarks((items) => items.filter((item) => item.id !== id));
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    const needle = query.trim();
    const session = sessionRef.current;
    if (!needle || !session) return;
    setSearching(true);
    try {
      const result = await session.search(needle);
      if (!result.searchable) {
        setSearchable(false);
        setHits([]);
        setSearchState('unsearchable');
        return;
      }
      setSearchable(true);
      setHits(result.hits);
      setSearchState(result.hits.length === 0 ? 'empty' : 'hits');
    } finally {
      setSearching(false);
    }
  }

  function toggle(next: typeof panel) {
    setPanel((current) => (current === next ? null : next));
  }

  const nearby = view ? nearbyPages(thumbnailPages, view.page, THUMBNAIL_RADIUS) : [];
  const showOutline = outline.length > 0;
  const showThumbs = thumbnailPages.length > 0;

  return (
    <div className="reader-page">
      <div className="toolbar">
        <Link className="text-link" to={`/books/${editionId}`} onClick={() => saverRef.current?.flush()}>
          {t('reader.backToBook')}
        </Link>
        <Link className="text-link" to="/" onClick={() => saverRef.current?.flush()}>
          {t('reader.library')}
        </Link>
      </div>
      <h1>{title}</h1>
      {error ? (
        <p className="alert" role="alert">
          {errorText(t, error)}
        </p>
      ) : null}
      {searchable === false ? (
        <p className="notice" role="status">
          {t('reader.scanNoText')}
        </p>
      ) : null}
      <div className="reader-controls">
        <form
          className="reader-search"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = Number(pageDraft);
            if (Number.isInteger(parsed)) void goTo(parsed);
          }}
        >
          <label>
            {t('reader.page')}
            <input
              inputMode="numeric"
              value={pageDraft}
              disabled={!ready}
              onChange={(event) => setPageDraft(event.target.value)}
            />
          </label>
          <span>
            {view?.page ?? '–'} / {pageCount || '–'}
          </span>
        </form>
        <button type="button" className="button" disabled={!ready} onClick={() => setZoom(stepZoom(scaleLabel ?? 1, -1))}>
          {t('reader.zoomOut')}
        </button>
        <button type="button" className="button" disabled={!ready} onClick={() => setZoom(stepZoom(scaleLabel ?? 1, 1))}>
          {t('reader.zoomIn')}
        </button>
        <button
          type="button"
          className="button"
          aria-pressed={view?.zoom === 'width'}
          disabled={!ready}
          onClick={() => setZoom('width')}
        >
          {t('reader.fitWidth')}
        </button>
        <span className="hint">
          {t('reader.zoom')}
          {scaleLabel == null ? '' : ` ${scaleLabel.toFixed(2)}`}
        </span>
        <button type="button" className="button" disabled={!ready} onClick={() => void addBookmark()}>
          {t('reader.bookmark')}
        </button>
      </div>
      <div className="toolbar" role="toolbar" aria-label={title}>
        {showOutline ? (
          <button type="button" className="button button-secondary" aria-pressed={panel === 'outline'} onClick={() => toggle('outline')}>
            {t('reader.outline')}
          </button>
        ) : null}
        {showThumbs ? (
          <button
            type="button"
            className="button button-secondary"
            aria-pressed={panel === 'thumbnails'}
            onClick={() => toggle('thumbnails')}
          >
            {t('reader.thumbnails')}
          </button>
        ) : null}
        <button type="button" className="button button-secondary" aria-pressed={panel === 'search'} onClick={() => toggle('search')}>
          {t('reader.search')}
        </button>
        <button type="button" className="button button-secondary" aria-pressed={panel === 'bookmarks'} onClick={() => toggle('bookmarks')}>
          {t('reader.bookmarks')}
        </button>
        <button type="button" className="button" disabled={!ready || (view?.page ?? 1) <= 1} onClick={() => void goTo((view?.page ?? 1) - 1)}>
          {t('reader.previousPage')}
        </button>
        <button
          type="button"
          className="button"
          disabled={!ready || !view || view.page >= pageCount}
          onClick={() => {
            if (view) void goTo(view.page + 1);
          }}
        >
          {t('reader.nextPage')}
        </button>
      </div>
      <div className={panel ? 'reader-layout' : 'reader-layout reader-layout-solo'}>
        {panel ? (
          <aside className="reader-panel" aria-label={panel === 'outline' ? t('reader.outline') : panel === 'thumbnails' ? t('reader.thumbnails') : t(`reader.${panel}`)}>
            {(panel === 'outline' || panel === 'thumbnails') && showOutline ? (
              <OutlineTree items={outline} onOpen={(item) => void goTo(item.page ?? 1, item)} />
            ) : null}
            {(panel === 'outline' || panel === 'thumbnails') && showThumbs ? (
              <ul className="plain-list pdf-thumbs">
                {nearby.map((page) => (
                  <li key={page}>
                    <button
                      type="button"
                      className="pdf-thumb"
                      aria-current={view?.page === page ? 'page' : undefined}
                      aria-label={`${t('reader.page')} ${page}`}
                      onClick={() => void goTo(page)}
                    >
                      <canvas
                        ref={(node) => {
                          if (node) thumbs.current.set(page, node);
                          else thumbs.current.delete(page);
                        }}
                      />
                      <span>{page}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {panel === 'search' ? (
              <>
                <form className="reader-search" onSubmit={(event) => void runSearch(event)}>
                  <label htmlFor={searchId}>{t('reader.search')}</label>
                  <input id={searchId} value={query} onChange={(event) => setQuery(event.target.value)} />
                  <button type="submit" className="button" disabled={!ready || searching}>
                    {t('reader.searchSubmit')}
                  </button>
                </form>
                {searchState === 'unsearchable' || searchable === false ? (
                  <p className="notice" role="status">
                    {t('reader.scanNoText')}
                  </p>
                ) : null}
                {searchState === 'empty' && searchable !== false ? <p className="placeholder">{t('reader.searchEmpty')}</p> : null}
                {searchState === 'hits' ? (
                  <ul className="plain-list">
                    {hits.map((hit, index) => (
                      <li key={`${hit.page}:${hit.x}:${hit.y}:${index}`}>
                        <button type="button" className="reader-toc-button" onClick={() => void goTo(hit.page, hit)}>
                          {hit.excerpt || `${t('reader.page')} ${hit.page}`}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
            {panel === 'bookmarks' ? (
              bookmarks.length === 0 ? (
                <p className="placeholder">{t('reader.noBookmarks')}</p>
              ) : (
                <ul className="plain-list">
                  {bookmarks.map((item) => {
                    const place = parsePdfPlace(item.locator);
                    const label = place ? `${t('reader.page')} ${place.page}` : item.label || item.locator;
                    return (
                      <li key={item.id} className="reader-row-line">
                        <button
                          type="button"
                          className="reader-toc-button"
                          onClick={() => {
                            if (place) void goTo(place.page, place);
                          }}
                        >
                          {label}
                        </button>
                        <button type="button" className="button button-secondary" onClick={() => void removeBookmark(item.id)}>
                          {t('reader.remove')}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )
            ) : null}
          </aside>
        ) : null}
        <div className="reader-stage pdf-stage" aria-busy={!ready}>
          <div ref={scrollerRef} className="pdf-scroller">
            <div ref={pageRef} className="pdf-page">
              <canvas ref={canvasRef} />
              <div ref={textRef} className="textLayer" />
            </div>
          </div>
          {ready ? null : <p role="status">{t('status.loading')}</p>}
        </div>
      </div>
    </div>
  );
}
