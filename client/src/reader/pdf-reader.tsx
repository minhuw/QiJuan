import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  AlertCircle,
  ArrowLeft,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Highlighter,
  StickyNote,
  LayoutPanelLeft,
  Library,
  ListTree,
  Loader2,
  MoveHorizontal,
  RefreshCw,
  ScanText,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { api, type ApiResult } from '../api';
import { createDebouncedSave, POSITION_SAVE_DELAY_MS } from './epub/debounce';
import { onReaderKey } from './epub/keys';
import type { ReaderFlow } from './epub/settings';
import { readReaderFlow, saveReaderFlow } from './flow';
import { createPageScroll } from './page-scroll';
import { formatPdfLocator, parsePdfPlace, type PdfPlace } from './pdf/locator';
import { openPdfSession } from './pdf/session';
import { PdfViewport } from './pdf/viewport';
import { PdfAnnotationPanel, PdfSelectionToolbar, pdfAnnotationPoint, usePdfAnnotations, type PdfHighlight, type PdfNote } from './pdf/annotation-tools';
import { nearbyPages, THUMBNAIL_CSS_WIDTH, THUMBNAIL_RADIUS } from './pdf/thumbs';
import type { PdfOutlineItem, PdfSearchHit, PdfSession, RenderedPage } from './pdf/types';
import { useLocale } from '../shell';
import { ReaderOptions, useReaderPanelFocus } from './reader-options';
import { ReaderFlowSelect } from './flow-select';

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

interface ReadingPlace {
  position: { locator: string; revision: number; assetId: number | null; updatedAt: string } | null;
  bookmarks: Bookmark[];
  highlights: PdfHighlight[];
  notes: PdfNote[];
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

export function PdfReader(props: { editionId: number; assetId: number; title: string }) {
  return <PdfReaderDocument key={`${props.editionId}:${props.assetId}`} {...props} />;
}

function PdfReaderDocument({ editionId, assetId, title }: { editionId: number; assetId: number; title: string }) {
  const { t } = useLocale();
  const searchId = useId();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<PdfSession | null>(null);
  const placeRef = useRef<PdfPlace | null>(null);
  const savedRef = useRef<string | null>(null);
  const saverRef = useRef<{ push: (locator: string) => void; flush: () => void; cancel: () => void } | null>(null);
  const revisionRef = useRef(0);
  const generationRef = useRef(0);
  const navigationRef = useRef(0);
  const restoreCommandRef = useRef<PdfPlace | null>(null);
  const chainRef = useRef(Promise.resolve());
  const chainIdle = useRef(true);
  const renderedRef = useRef<RenderedPage | null>(null);
  const bottomEntryRef = useRef<PdfPlace | null>(null);
  const holdRef = useRef(false);
  const echoEpoch = useRef(0);
  const heldEcho = useRef<{ token: number; epoch: number } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbs = useRef(new Map<number, HTMLCanvasElement>());
  const thumbTickets = useRef(new Map<number, number>());
  const [error, setError] = useState<string | null>(null);
  const [keptNewer, setKeptNewer] = useState(false);
  const [ready, setReady] = useState(false);
  const [painting, setPainting] = useState(false);
  const [flow, setFlow] = useState<ReaderFlow>(readReaderFlow);
  const [currentPage, setCurrentPage] = useState(1);
  const [view, setView] = useState<PdfPlace | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [outline, setOutline] = useState<PdfOutlineItem[]>([]);
  const [thumbnailPages, setThumbnailPages] = useState<number[]>([]);
  const [searchable, setSearchable] = useState<boolean | null>(null);
  const [panel, setPanel] = useState<'outline' | 'thumbnails' | 'search' | 'bookmarks' | 'highlights' | 'notes' | null>(null);
  const panelRef = useReaderPanelFocus(panel);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PdfSearchHit[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'empty' | 'hits' | 'unsearchable'>('idle');
  const [searching, setSearching] = useState(false);
  const [scaleLabel, setScaleLabel] = useState<number | null>(null);
  const [pageDraft, setPageDraft] = useState('1');
  const [selectionTooLarge, setSelectionTooLarge] = useState(false);
  const annotations = usePdfAnnotations({ editionId, assetId, settle, onOpen: setPanel });

  function remember(place: PdfPlace) {
    if (holdRef.current) return;
    const locator = formatPdfLocator(place);
    if (!locator) return;
    if (placeRef.current?.page !== place.page) setPageDraft(String(place.page));
    placeRef.current = place;
    setCurrentPage(place.page);
    if (locator === savedRef.current) return;
    savedRef.current = locator;
    saverRef.current?.push(locator);
  }

  function releaseHeldEcho(token: number) {
    const held = heldEcho.current;
    if (!held || held.token !== token) return;
    heldEcho.current = null;
    restoreCommandRef.current = null;
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    // The restore sets scrollTop, and the scroll event can land on a later frame.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (generationRef.current !== token) return;
        holdRef.current = false;
      });
    });
  }

  function settleHeldEcho(epoch: number, request: PdfPlace) {
    const held = heldEcho.current;
    if (!held || held.epoch !== epoch || restoreCommandRef.current !== request) return;
    releaseHeldEcho(held.token);
  }

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
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
      if (place.data) {
        setBookmarks(place.data.bookmarks);
        annotations.load(place.data);
        revisionRef.current = place.data.position?.revision ?? 0;
      }
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
        setPanel(null);
        setPageDraft(String(initial.page));
        setCurrentPage(initial.page);
        setPainting(true);
        setView(initial);
        setReady(true);
      } catch {
        if (alive) setError('internal');
      }
    })();

    return () => {
      alive = false;
      if (holdTimer.current !== null) {
        clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }
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
    const scroller = scrollerRef.current;
    if (!ready || !scroller) return;
    let gestureAxis = 'vertical';
    const pageScroll = createPageScroll({
      horizontal: true,
      enabled: () => flow === 'paginated' && !holdRef.current && renderedRef.current !== null,
      canTurn: (turn, _target, axis) => {
        gestureAxis = axis;
        const current = placeRef.current;
        if (!current || scroller.clientHeight <= 0) return false;
        const atStart = axis === 'horizontal' ? scroller.scrollLeft <= 2 : scroller.scrollTop <= 2;
        const atEnd = axis === 'horizontal'
          ? scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 2
          : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
        return turn === 'next' ? current.page < pageCount && atEnd : current.page > 1 && atStart;
      },
      turn: (turn) => {
        const current = placeRef.current;
        if (!current) return;
        return goTo(current.page + (turn === 'next' ? 1 : -1), undefined, turn === 'prev' && gestureAxis === 'vertical');
      },
      onError: () => setError('internal'),
    });
    pageScroll.attach(scroller);
    return pageScroll.destroy;
  }, [ready, pageCount, flow]);

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
    const pages = nearbyPages(thumbnailPages, currentPage, THUMBNAIL_RADIUS);
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
        if (!current || current.page !== currentPage || current.zoom !== view.zoom) return;
        canvas.hidden = true;
      });
    }
    return () => {
      cancel = true;
    };
  }, [panel, ready, thumbnailPages, view, currentPage]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (flow === 'continuous' && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) return;
      onReaderKey(event, {
        enabled: ready,
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
  }, [pageCount, flow, ready]);

  async function goTo(page: number, point?: { x: number | null; y: number | null }, enterAtBottom = false) {
    const session = sessionRef.current;
    const current = placeRef.current;
    if (!session || !current || session.pageCount < 1 || holdRef.current) return;
    const navigation = ++navigationRef.current;
    const generation = generationRef.current;
    const clamped = Math.min(session.pageCount, Math.max(1, page));
    const box = await session.pageBox(clamped);
    if (sessionRef.current !== session || navigationRef.current !== navigation
      || generationRef.current !== generation || holdRef.current) return;
    const next: PdfPlace = {
      page: clamped,
      x: point && point.x != null ? point.x : box.xMin,
      y: point && point.y != null ? point.y : box.yMax,
      zoom: current.zoom,
    };
    renderedRef.current = null;
    setPainting(true);
    bottomEntryRef.current = enterAtBottom ? next : null;
    if (enterAtBottom) placeRef.current = next;
    else remember(next);
    setPageDraft(String(clamped));
    setCurrentPage(clamped);
    setView(next);
  }

  function changeFlow(next: ReaderFlow) {
    const current = placeRef.current;
    if (!current || next === flow || holdRef.current) return;
    navigationRef.current += 1;
    renderedRef.current = null;
    bottomEntryRef.current = null;
    setPainting(true);
    saveReaderFlow(next);
    setFlow(next);
    setView({ ...current });
  }

  function setZoom(zoom: PdfPlace['zoom']) {
    bottomEntryRef.current = null;
    const current = placeRef.current;
    if (!current || holdRef.current) return;
    navigationRef.current += 1;
    setPainting(true);
    remember({ ...current, zoom });
    setView({ ...current, zoom });
  }

  async function reloadReading(adoptPosition: boolean): Promise<boolean> {
    generationRef.current += 1;
    navigationRef.current += 1;
    restoreCommandRef.current = null;
    const token = generationRef.current;
    saverRef.current?.cancel();
    holdRef.current = true;
    heldEcho.current = null;
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    let handed = false;
    try {
      const place = await api<ReadingPlace>(`/api/editions/${editionId}/reading-place`);
      if (place.error || !place.data) {
        setError(place.error ?? 'network');
        return false;
      }
      setBookmarks(place.data.bookmarks);
      annotations.load(place.data);
      const position = place.data.position;
      revisionRef.current = position?.revision ?? 0;
      if (adoptPosition && position) {
        const parsed = parsePdfPlace(position.locator);
        if (parsed) {
          const canonical = formatPdfLocator(parsed);
          if (canonical) savedRef.current = canonical;
          placeRef.current = parsed;
          setPageDraft(String(parsed.page));
          setCurrentPage(parsed.page);
          // Ignore scroll and remember until this restore has been painted.
          // A scroll during the GET would otherwise be written with this revision.
          echoEpoch.current += 1;
          heldEcho.current = { token, epoch: echoEpoch.current };
          restoreCommandRef.current = parsed;
          holdTimer.current = setTimeout(() => releaseHeldEcho(token), 5000);
          handed = true;
          setView(parsed);
        }
      }
      return true;
    } finally {
      if (!handed) {
        holdRef.current = false;
        heldEcho.current = null;
      }
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

  async function addBookmark() {
    const place = placeRef.current;
    if (!place) return;
    const locator = formatPdfLocator(place);
    if (!locator) return;
    const result = await api<{ bookmark: Bookmark }>(`/api/editions/${editionId}/bookmarks`, {
      method: 'POST',
      body: { locator, assetId, revision: 0 },
    });
    const data = await settle(result);
    if (!data?.bookmark) return;
    setBookmarks((items) => [...items, data.bookmark]);
    setPanel('bookmarks');
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

  const nearby = view ? nearbyPages(thumbnailPages, currentPage, THUMBNAIL_RADIUS) : [];
  const viewportEpoch = echoEpoch.current;
  const showOutline = outline.length > 0;
  const showThumbs = thumbnailPages.length > 0;

  return (
    <div className="reader-page reader-page-pdf">
      <header className="reader-header">
        <div className="reader-header-top">
          <Link className="reader-back" to={`/books/${editionId}`} title={t('reader.backToBook')} onClick={() => saverRef.current?.flush()}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span className="visually-hidden">{t('reader.backToBook')}</span>
          </Link>
          <h1 className="reader-title">{title}</h1>
          <Link className="reader-library-link" to="/" title={t('reader.library')} onClick={() => saverRef.current?.flush()}>
            <Library size={18} aria-hidden="true" />
            <span className="visually-hidden">{t('reader.library')}</span>
          </Link>
        </div>
        {error ? (
          <div className="alert alert-error" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            {errorText(t, error)}
          </div>
        ) : null}
        {searchable === false ? (
          <p className="notice" role="status">
            <ScanText size={15} aria-hidden="true" />
            {t('reader.scanNoText')}
          </p>
        ) : null}
        {selectionTooLarge ? <p className="notice" role="status">{t('reader.selectionTooLarge')}</p> : null}
        {keptNewer ? (
          <p className="notice" role="status">
            <RefreshCw size={15} aria-hidden="true" />
            {t('reader.newerKept')}
          </p>
        ) : null}
      </header>

      <div className="reader-toolbar">
        <ReaderFlowSelect value={flow} disabled={!ready} onChange={changeFlow} />
        <div className="reader-main-actions">
          {showOutline ? (
            <button
              type="button"
              className="reader-tool reader-tool-icon"
              aria-label={t('reader.outline')}
              title={t('reader.outline')}
              aria-pressed={panel === 'outline'}
              onClick={() => toggle('outline')}
            >
              <ListTree size={16} aria-hidden="true" />
            </button>
          ) : showThumbs ? (
            <button
              type="button"
              className="reader-tool reader-tool-icon"
              aria-label={t('reader.thumbnails')}
              title={t('reader.thumbnails')}
              aria-pressed={panel === 'thumbnails'}
              onClick={() => toggle('thumbnails')}
            >
              <LayoutPanelLeft size={16} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="reader-tool reader-tool-icon"
            aria-label={t('reader.search')}
            title={t('reader.search')}
            aria-pressed={panel === 'search'}
            onClick={() => toggle('search')}
          >
            <Search size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="reader-tool reader-tool-icon"
            aria-label={t('reader.bookmark')}
            title={t('reader.bookmark')}
            disabled={!ready}
            onClick={() => void addBookmark()}
          >
            <Bookmark size={16} aria-hidden="true" />
          </button>
          <ReaderOptions>
            <form
              className="reader-page-form"
              onSubmit={(event) => {
                event.preventDefault();
                const parsed = Number(pageDraft);
                if (Number.isInteger(parsed)) void goTo(parsed);
              }}
            >
              <label className="reader-page-input">
                <span>{t('reader.page')}</span>
                <input
                  inputMode="numeric"
                  value={pageDraft}
                  disabled={!ready}
                  onChange={(event) => setPageDraft(event.target.value)}
                />
              </label>
            </form>

            <div className="reader-zoom-controls">
              <button type="button" className="reader-tool reader-tool-icon" aria-label={t('reader.zoomOut')} title={t('reader.zoomOut')} disabled={!ready} onClick={() => setZoom(stepZoom(scaleLabel ?? 1, -1))}>
                <ZoomOut size={16} aria-hidden="true" />
              </button>
              <span className="reader-zoom-label">
                {t('reader.zoom')}
                {scaleLabel == null ? '' : ` ${scaleLabel.toFixed(2)}`}
              </span>
              <button type="button" className="reader-tool reader-tool-icon" aria-label={t('reader.zoomIn')} title={t('reader.zoomIn')} disabled={!ready} onClick={() => setZoom(stepZoom(scaleLabel ?? 1, 1))}>
                <ZoomIn size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="reader-tool reader-tool-icon"
                aria-label={t('reader.fitWidth')}
                title={t('reader.fitWidth')}
                aria-pressed={view?.zoom === 'width'}
                disabled={!ready}
                onClick={() => setZoom('width')}
              >
                <MoveHorizontal size={15} aria-hidden="true" />
              </button>
            </div>
            <div className="reader-option-actions">
              <button type="button" className="reader-tool reader-tool-icon" aria-pressed={panel === 'highlights'} data-dismiss-options onClick={() => toggle('highlights')}>
                <Highlighter size={16} aria-hidden="true" /><span>{t('reader.highlights')}</span>
              </button>
              <button type="button" className="reader-tool reader-tool-icon" aria-pressed={panel === 'notes'} data-dismiss-options onClick={() => toggle('notes')}>
                <StickyNote size={16} aria-hidden="true" /><span>{t('reader.notes')}</span>
              </button>
              <button
                type="button"
                className="reader-tool reader-tool-icon"
                aria-label={t('reader.bookmarks')}
                title={t('reader.bookmarks')}
                aria-pressed={panel === 'bookmarks'}
                data-dismiss-options
                onClick={() => toggle('bookmarks')}
              >
                <Bookmark size={16} aria-hidden="true" />
                <span>{t('reader.bookmarks')}</span>
              </button>
              {showOutline && showThumbs ? (
                <button
                  type="button"
                  className="reader-tool reader-tool-icon"
                  aria-label={t('reader.thumbnails')}
                  title={t('reader.thumbnails')}
                  aria-pressed={panel === 'thumbnails'}
                  data-dismiss-options
                  onClick={() => toggle('thumbnails')}
                >
                  <LayoutPanelLeft size={16} aria-hidden="true" />
                  <span>{t('reader.thumbnails')}</span>
                </button>
              ) : null}
            </div>
          </ReaderOptions>
        </div>
      </div>

      <div className={panel ? 'reader-layout' : 'reader-layout reader-layout-solo'}>
        {panel ? (
          <aside
            ref={panelRef}
            tabIndex={-1}
            className="reader-panel"
            aria-label={
              panel === 'outline'
                ? t('reader.outline')
                : panel === 'thumbnails'
                  ? t('reader.thumbnails')
                  : t(`reader.${panel}`)
            }
          >
            <div className="reader-panel-head">
              <h2>
                {panel === 'outline'
                  ? t('reader.outline')
                  : panel === 'thumbnails'
                    ? t('reader.thumbnails')
                    : t(`reader.${panel}`)}
              </h2>
              <span>
                {panel === 'notes' ? annotations.notes.length : panel === 'highlights' ? annotations.highlights.length : panel === 'bookmarks' ? bookmarks.length : panel === 'thumbnails' ? nearby.length : panel === 'search' ? hits.length : outline.length}
              </span>
              <button
                type="button"
                className="reader-tool reader-tool-icon"
                aria-label={t('reader.close')}
                title={t('reader.close')}
                onClick={() => setPanel(null)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
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
                      aria-current={currentPage === page ? 'page' : undefined}
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
                  <label className="visually-hidden" htmlFor={searchId}>
                    {t('reader.search')}
                  </label>
                  <div className="input-with-icon">
                    <span className="input-icon" aria-hidden="true">
                      <Search size={15} />
                    </span>
                    <input
                      id={searchId}
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
                {searchState === 'unsearchable' || searchable === false ? (
                  <p className="notice" role="status">
                    {t('reader.scanNoText')}
                  </p>
                ) : null}
                {searchState === 'empty' && searchable !== false ? (
                  <p className="placeholder">{t('reader.searchEmpty')}</p>
                ) : null}
                {searchState === 'hits' ? (
                  <ul className="reader-list">
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
            {panel === 'highlights' || panel === 'notes' ? (
              <PdfAnnotationPanel kind={panel} tools={annotations} ready={ready}
                onPageNote={() => {
                  const locator = placeRef.current && formatPdfLocator(placeRef.current);
                  if (locator) annotations.startNote(locator);
                }}
                onNavigate={(locator) => {
                  const point = pdfAnnotationPoint(locator);
                  if (point) void goTo(point.page, point);
                }} />
            ) : null}
            {panel === 'bookmarks' ? (
              bookmarks.length === 0 ? (
                <p className="placeholder">{t('reader.noBookmarks')}</p>
              ) : (
                <ul className="reader-list">
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
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void removeBookmark(item)}>
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
        <div className="reader-stage-wrap">
          <div className="reader-stage pdf-stage" aria-busy={!ready || painting}>
            <PdfViewport
              session={ready ? sessionRef.current : null}
              place={view}
              flow={flow}
              scrollerRef={scrollerRef}
              enterAtBottom={view !== null && bottomEntryRef.current === view}
              annotations={annotations.marks}
              onSelection={(selection) => {
                annotations.setSelection(selection);
                if (selection) setSelectionTooLarge(false);
              }}
              onSelectionTooLarge={() => setSelectionTooLarge(true)}
              onPosition={remember}
              onRendered={(request, rendered, actual) => {
                if (request !== view) return;
                renderedRef.current = rendered;
                bottomEntryRef.current = null;
                setScaleLabel(rendered.scale);
                setPainting(false);
                setCurrentPage(actual.page);
                setPageDraft(String(actual.page));
                remember(actual);
                settleHeldEcho(viewportEpoch, request);
                setError((previous) => previous === 'internal' ? null : previous);
              }}
              onReflow={(rendered, actual) => {
                renderedRef.current = rendered;
                setScaleLabel(rendered.scale);
                remember(actual);
              }}
              onError={() => {
                setPainting(false);
                setError('internal');
              }}
            />
            {ready ? null : (
              <div className="reader-stage-loading" role="status">
                <Loader2 className="spin" size={20} aria-hidden="true" />
                {t('status.loading')}
              </div>
            )}
          </div>
        </div>
      </div>
      <PdfSelectionToolbar tools={annotations} />
      <footer className="reader-footer">
          <button
            type="button"
            className="reader-tool reader-tool-icon"
            aria-label={t('reader.previousPage')}
            title={t('reader.previousPage')}
            disabled={!ready || currentPage <= 1}
            onClick={() => void goTo(currentPage - 1)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
        <span className="reader-page-indicator">
          {ready ? currentPage : '–'} <span aria-hidden="true">/</span> {pageCount || '–'}
        </span>
          <button
            type="button"
            className="reader-tool reader-tool-icon"
            aria-label={t('reader.nextPage')}
            title={t('reader.nextPage')}
            disabled={!ready || !view || currentPage >= pageCount}
            onClick={() => void goTo(currentPage + 1)}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
      </footer>
    </div>
  );
}
