import { useLayoutEffect, useRef, type RefObject } from 'react';
import { PageStream } from './layout';
import { parsePdfSelection, type PdfAnnotationMark, type PdfTextSelection } from './annotations';
import { readPdfSelection, selectedPages, transformRect } from './selection';
import type { PdfPageSize, PdfPlace, PdfSession, RenderedPage } from './types';

export interface PdfViewportProps {
  session: PdfSession | null;
  place: PdfPlace | null;
  flow: 'paginated' | 'continuous';
  scrollerRef: RefObject<HTMLDivElement | null>;
  enterAtBottom?: boolean;
  onPosition: (place: PdfPlace) => void;
  onRendered: (request: PdfPlace, rendered: RenderedPage, actual: PdfPlace) => void;
  onReflow?: (rendered: RenderedPage, actual: PdfPlace) => void;
  onError: (error: unknown) => void;
  annotations?: readonly PdfAnnotationMark[];
  onSelection?: (selection: PdfTextSelection | null) => void;
  onSelectionTooLarge?: () => void;
}

type Callbacks = Pick<PdfViewportProps, 'onPosition' | 'onRendered' | 'onReflow' | 'onError' | 'annotations' | 'onSelection' | 'onSelectionTooLarge'>;
interface GeometryCache {
  session: PdfSession;
  zoom: PdfPlace['zoom'];
  sizes: Map<number, PdfPageSize>;
}
interface PaintedPage {
  shell: HTMLDivElement;
  canvas: HTMLCanvasElement;
  text: HTMLDivElement;
  overlay: HTMLDivElement;
  rendered?: RenderedPage;
}
interface Anchor {
  page: number;
  x: number;
  y: number;
  pdf?: PdfPlace;
}

/** A new place object is a command. Native scrolling is reported without changing it. */
export function PdfViewport(props: PdfViewportProps) {
  const { session, place, flow, scrollerRef } = props;
  const latest = useRef(props);
  latest.current = props;
  const geometry = useRef<GeometryCache | null>(null);
  const controller = useRef<ReturnType<typeof mountViewport> | null>(null);

  useLayoutEffect(() => {
    const root = scrollerRef.current;
    if (!root || !session || !place || session.pageCount < 1) return;
    const mounted = mountViewport(root, session, place, flow, latest.current.enterAtBottom ?? false, latest, geometry);
    controller.current = mounted;
    return () => {
      controller.current = null;
      mounted.destroy();
    };
  }, [session, place, flow, scrollerRef]);

  useLayoutEffect(() => {
    controller.current?.refreshAnnotations();
  }, [props.annotations]);

  return <div ref={scrollerRef} className="pdf-scroller" style={{ overflowAnchor: 'none' }} />;
}

// The controller owns only the children of the scroller. Page nodes have independent
// paint lifetimes, so releasing an overscan page cannot cancel its visible neighbour.
function mountViewport(
  root: HTMLDivElement,
  session: PdfSession,
  request: PdfPlace,
  flow: PdfViewportProps['flow'],
  enterAtBottom: boolean,
  callbacks: { current: Callbacks },
  cache: { current: GeometryCache | null },
) {
  const continuous = flow === 'continuous';
  const requestedPage = Math.max(1, Math.min(session.pageCount, request.page));
  const command = { ...request, page: requestedPage };
  const stream = document.createElement('div');
  stream.style.position = 'relative';
  stream.style.overflowAnchor = 'none';
  root.append(stream);
  let width = root.clientWidth || 640;
  let height = root.clientHeight || 480;
  let alive = true;
  let generation = 0;
  let layout: PageStream;
  let pages = new Map<number, PaintedPage>();
  let pending: { place: PdfPlace; bottom: boolean; notify: boolean; viewport?: { x: number; y: number } } | null = null;
  let nativePositionPending = false;
  let lastTop = root.scrollTop;
  let lastLeft = root.scrollLeft;
  let selectionFrame: number | null = null;
  let selectionKey: string | null = null;
  let selectionWasTooLarge = false;
  let selectionWasEmitted = false;

  function refreshAnnotations() {
    const marks = (callbacks.current.annotations ?? []).map((mark) => ({ mark, selection: parsePdfSelection(mark.locator) }));
    for (const [page, entry] of pages) {
      const fragments = document.createDocumentFragment();
      const rendered = entry.rendered;
      if (rendered) {
        for (const { mark, selection } of marks) {
          for (const rect of selection?.pages.find((item) => item.page === page)?.rects ?? []) {
            const projected = transformRect(rect, (x, y) => rendered.toViewport(x, y));
            const left = Math.max(0, projected[0]);
            const top = Math.max(0, projected[1]);
            const right = Math.min(rendered.cssWidth, projected[2]);
            const bottom = Math.min(rendered.cssHeight, projected[3]);
            if (right <= left || bottom <= top) continue;
            const fragment = document.createElement('div');
            fragment.className = mark.kind === 'note' ? 'pdf-note-rect' : 'pdf-highlight-rect';
            fragment.dataset.annotationId = mark.id;
            Object.assign(fragment.style, { position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
            fragments.append(fragment);
          }
        }
      }
      entry.overlay.replaceChildren(fragments);
    }
  }

  function clearSelection() {
    if (selectionFrame !== null) cancelAnimationFrame(selectionFrame);
    selectionFrame = null;
    const native = root.ownerDocument.getSelection();
    if (selectedPages(root, native, pages).length) native?.removeAllRanges();
    selectionKey = null;
    selectionWasTooLarge = false;
    if (selectionWasEmitted) {
      selectionWasEmitted = false;
      callbacks.current.onSelection?.(null);
    }
  }

  function scheduleSelection() {
    if (!alive || selectionFrame !== null) return;
    selectionFrame = requestAnimationFrame(() => {
      selectionFrame = null;
      if (!alive) return;
      const result = readPdfSelection(root, root.ownerDocument.getSelection(), pages);
      const key = result.kind === 'selected' ? JSON.stringify(result.value) : null;
      if (key !== selectionKey) {
        selectionKey = key;
        selectionWasEmitted = key !== null;
        callbacks.current.onSelection?.(result.kind === 'selected' ? result.value : null);
      }
      if (result.kind === 'too-large' && !selectionWasTooLarge) callbacks.current.onSelectionTooLarge?.();
      selectionWasTooLarge = result.kind === 'too-large';
      reconcile();
    });
  }

  function pageTop(page: number) {
    return continuous ? layout.offset(page) : 0;
  }

  function pageLeft(page: number) {
    // Paginated mode retains the original reader's page-local scroll coordinates.
    return continuous ? Math.max(0, (layout.width(width) - layout.size(page).cssWidth) / 2) : 0;
  }

  function visiblePage() {
    return continuous ? layout.pageAt(root.scrollTop) : requestedPage;
  }

  function readPosition(): PdfPlace | null {
    const page = visiblePage();
    const rendered = pages.get(page)?.rendered;
    if (!rendered) return null;
    const point = rendered.toPdf(
      Math.max(0, root.scrollLeft - pageLeft(page)),
      Math.max(0, Math.min(rendered.cssHeight, root.scrollTop - pageTop(page))),
    );
    return { page, ...point, zoom: request.zoom };
  }

  function capture(): Anchor {
    const page = visiblePage();
    return {
      page,
      x: Math.max(0, root.scrollLeft - pageLeft(page)),
      y: Math.max(0, root.scrollTop - pageTop(page)),
      pdf: readPosition() ?? undefined,
    };
  }

  function writeScroll(top: number, left: number) {
    root.scrollTop = continuous ? Math.max(0, Math.min(top, Math.max(0, layout.height - height))) : Math.max(0, top);
    root.scrollLeft = continuous ? Math.max(0, Math.min(left, layout.width(width) - width)) : Math.max(0, left);
    // Native scroll events arrive asynchronously. Comparing the resulting coordinates
    // suppresses those echoes without dropping a user's next, different scroll.
    lastTop = root.scrollTop;
    lastLeft = root.scrollLeft;
  }

  function positionAnchor(anchor: Anchor) {
    const rendered = pages.get(anchor.page)?.rendered;
    const point = anchor.pdf && rendered ? rendered.toViewport(anchor.pdf.x, anchor.pdf.y) : anchor;
    writeScroll(pageTop(anchor.page) + point.y, pageLeft(anchor.page) + point.x);
  }

  function arrange() {
    stream.style.width = `${continuous ? layout.width(width) : Math.max(width, layout.size(requestedPage).cssWidth)}px`;
    stream.style.height = `${continuous ? layout.height : layout.size(requestedPage).cssHeight}px`;
    for (const [page, entry] of pages) {
      const size = layout.size(page);
      Object.assign(entry.shell.style, {
        position: 'absolute',
        top: `${pageTop(page)}px`,
        left: `${continuous ? pageLeft(page) : Math.max(0, (width - size.cssWidth) / 2)}px`,
        margin: '0',
        width: `${size.cssWidth}px`,
        height: `${size.cssHeight}px`,
      });
    }
  }

  function recordSize(page: number, size: PdfPageSize) {
    const previous = layout.size(page);
    if (layout.sizes.has(page) && previous.cssHeight === size.cssHeight && previous.cssWidth === size.cssWidth && previous.scale === size.scale) return;
    const anchor = capture();
    // Once a real size is known, it is a better estimate for unseen pages too.
    if (layout.sizes.size === 0) layout.estimate = size;
    layout.sizes.set(page, size);
    arrange();
    if (pending) {
      const target = pending.place;
      const rendered = pages.get(target.page)?.rendered;
      const point = pending.viewport ?? rendered?.toViewport(target.x, target.y);
      writeScroll(pageTop(target.page) + (point?.y ?? 0), pageLeft(target.page) + (point?.x ?? 0));
    } else {
      positionAnchor(anchor);
    }
    reconcile();
  }

  function reportNativePosition() {
    if (pending || !nativePositionPending) return;
    const position = readPosition();
    if (!position) return;
    nativePositionPending = false;
    callbacks.current.onPosition(position);
  }

  function finishRestore() {
    if (!pending) return;
    const restore = pending;
    const page = restore.place.page;
    const rendered = pages.get(page)?.rendered;
    if (!rendered) return;
    const point = restore.bottom
      ? { x: 0, y: Math.max(0, rendered.cssHeight - height) }
      : restore.viewport ?? rendered.toViewport(restore.place.x, restore.place.y);
    writeScroll(pageTop(page) + point.y, pageLeft(page) + point.x);
    const actual = readPosition();
    // At the end of a short final page, native clamping can leave the viewport
    // starting on its predecessor. Wait for that page's transform as well.
    if (!actual) {
      reconcile();
      return;
    }
    pending = null;
    nativePositionPending = false;
    if (restore.notify) callbacks.current.onRendered(request, rendered, actual);
    else callbacks.current.onReflow?.(pages.get(actual.page)!.rendered!, actual);
    reconcile();
  }

  function release(entry: PaintedPage) {
    session.releasePage(entry.canvas);
    entry.shell.remove();
  }

  function reconcile() {
    if (!alive) return;
    const wanted = new Set(continuous ? layout.range(root.scrollTop, height) : [requestedPage]);
    if (pending) wanted.add(pending.place.page);
    for (const page of selectedPages(root, root.ownerDocument.getSelection(), pages)) wanted.add(page);
    for (const [page, entry] of pages) {
      if (!wanted.has(page)) {
        pages.delete(page);
        release(entry);
      }
    }
    for (const page of wanted) {
      if (pages.has(page)) continue;
      const shell = document.createElement('div');
      shell.className = 'pdf-page';
      shell.dataset.page = String(page);
      shell.setAttribute('aria-busy', 'true');
      const canvas = document.createElement('canvas');
      const overlay = document.createElement('div');
      overlay.className = 'pdf-annotation-layer';
      overlay.setAttribute('aria-hidden', 'true');
      Object.assign(overlay.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none', userSelect: 'none' });
      const text = document.createElement('div');
      text.className = 'textLayer';
      shell.append(canvas, overlay, text);
      const next = [...stream.children].find((node) => Number((node as HTMLElement).dataset.page) > page);
      stream.insertBefore(shell, next ?? null);
      const entry: PaintedPage = { shell, canvas, text, overlay };
      pages.set(page, entry);
      const ticket = generation;
      const current = () => alive && generation === ticket && pages.get(page) === entry;
      void (async () => {
        try {
          const size = await session.pageSize(page, request.zoom, width);
          if (!current()) return;
          recordSize(page, size);
          if (!current()) return;
          const rendered = await session.renderPage({ page, zoom: request.zoom, containerWidth: width, canvas, textLayer: text });
          if (!current() || !rendered) return;
          // Keep the old transform while capturing an anchor if paint and measurement
          // disagree. The session normally supplies exactly the same viewport for both.
          recordSize(page, rendered);
          if (!current()) return;
          entry.rendered = rendered;
          shell.setAttribute('aria-busy', 'false');
          refreshAnnotations();
          if (root.ownerDocument.getSelection()?.rangeCount) scheduleSelection();
          finishRestore();
          reportNativePosition();
        } catch (error) {
          if (current()) {
            shell.setAttribute('aria-busy', 'false');
            callbacks.current.onError(error);
          }
        }
      })();
    }
    arrange();
  }

  function start(place: PdfPlace, bottom: boolean, notify: boolean, viewport?: { x: number; y: number }) {
    clearSelection();
    generation += 1;
    for (const entry of pages.values()) release(entry);
    pages = new Map();
    const previous = cache.current;
    const sizes = new Map<number, PdfPageSize>();
    if (previous?.session === session) {
      for (const [page, size] of previous.sizes) {
        const scale = request.zoom === 'width'
          ? width / size.cssWidth
          : typeof previous.zoom === 'number' ? request.zoom / previous.zoom : request.zoom / size.scale;
        sizes.set(page, {
          cssWidth: size.cssWidth * scale,
          cssHeight: size.cssHeight * scale,
          scale: size.scale * scale,
        });
      }
    }
    const scale = request.zoom === 'width' ? width / 612 : request.zoom;
    layout = new PageStream(session.pageCount, sizes.values().next().value ?? { cssWidth: 612 * scale, cssHeight: 792 * scale, scale }, sizes);
    cache.current = { session, zoom: request.zoom, sizes };
    pending = { place, bottom: bottom && !continuous, notify, viewport };
    nativePositionPending = false;
    arrange();
    writeScroll(pageTop(place.page), 0);
    reconcile();
  }

  function onScroll() {
    scheduleSelection();
    if (root.scrollTop === lastTop && root.scrollLeft === lastLeft) return;
    lastTop = root.scrollTop;
    lastLeft = root.scrollLeft;
    if (pending) return;
    nativePositionPending = true;
    reconcile();
    reportNativePosition();
  }

  root.addEventListener('scroll', onScroll, { passive: true });
  const owner = root.ownerDocument;
  owner.addEventListener('selectionchange', scheduleSelection);
  owner.addEventListener('pointerup', scheduleSelection);
  owner.addEventListener('keyup', scheduleSelection);
  // Capture ancestor scrolling as well, since toolbar anchors use client coordinates.
  owner.addEventListener('scroll', scheduleSelection, true);
  start(command, enterAtBottom, true);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (!alive) return;
    const nextWidth = root.clientWidth || 640;
    const nextHeight = root.clientHeight || 480;
    if (nextWidth === width && nextHeight === height) return;
    const anchor = capture();
    const place = pending?.place ?? anchor.pdf ?? { ...command, page: anchor.page };
    const bottom = pending?.bottom ?? false;
    const notify = pending?.notify ?? false;
    const viewport = pending?.viewport ?? (!pending && !anchor.pdf ? anchor : undefined);
    const factor = request.zoom === 'width' ? nextWidth / width : 1;
    width = nextWidth;
    height = nextHeight;
    // Even an as-yet unpainted native-scroll destination must invalidate old work.
    // Until its transform arrives, preserve its local viewport coordinate instead.
    start(place, bottom, notify, viewport ? { x: viewport.x * factor, y: viewport.y * factor } : undefined);
  });
  observer?.observe(root);

  return { refreshAnnotations, destroy: () => {
    alive = false;
    clearSelection();
    generation += 1;
    observer?.disconnect();
    root.removeEventListener('scroll', onScroll);
    owner.removeEventListener('selectionchange', scheduleSelection);
    owner.removeEventListener('pointerup', scheduleSelection);
    owner.removeEventListener('keyup', scheduleSelection);
    owner.removeEventListener('scroll', scheduleSelection, true);
    for (const entry of pages.values()) release(entry);
    pages.clear();
    stream.remove();
  } };
}
