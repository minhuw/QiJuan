import { useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { PageStream } from './layout';
import { formatPdfSelection, parsePdfSelection, type PdfAnnotationMark, type PdfTextSelection } from './annotations';
import { cleanCopiedText } from './copy-text';
import { readPdfSelection, selectedPages, transformRect } from './selection';
import { spreadOf, spreadPages, type Spread } from './spread';
import type { PdfPageSize, PdfPlace, PdfSession, RenderedPage } from './types';

export interface PdfViewportProps {
  session: PdfSession | null;
  place: PdfPlace | null;
  /** 'spread' shows two pages side by side. */
  flow: 'paginated' | 'spread' | 'continuous';
  scrollerRef: RefObject<HTMLDivElement | null>;
  enterAtBottom?: boolean;
  onPosition: (place: PdfPlace) => void;
  onRendered: (request: PdfPlace, rendered: RenderedPage, actual: PdfPlace) => void;
  onReflow?: (rendered: RenderedPage, actual: PdfPlace) => void;
  onError: (error: unknown) => void;
  annotations?: readonly PdfAnnotationMark[];
  onSelection?: (selection: PdfTextSelection | null) => void;
  onSelectionTooLarge?: () => void;
  /** While on, a drag on a page draws a rectangle instead of selecting text or scrolling. */
  areaMode?: boolean;
  /** A finished area: one rectangle on one page, with no quote. */
  onArea?: (selection: PdfTextSelection) => void;
  /** A drag across a painted page that has no text to select, while the area tool is off. */
  onTextlessDrag?: () => void;
  /** Filled while mounted: hit-testing and the live pinch preview. */
  handleRef?: MutableRefObject<PdfViewportHandle | null>;
}

export interface PdfViewportHandle {
  /** The PDF point under a client coordinate, on the nearest painted page. */
  pointAt(clientX: number, clientY: number): { page: number; x: number; y: number } | null;
  /** Scales the painted pages around a client point until the next paint replaces them. */
  preview(factor: number, clientX: number, clientY: number): void;
}

/** The smallest area, in CSS pixels on each side, that counts as a deliberate drag. */
export const AREA_MIN_PX = 6;

type Callbacks = Pick<PdfViewportProps, 'onPosition' | 'onRendered' | 'onReflow' | 'onError' | 'annotations' | 'onSelection' | 'onSelectionTooLarge' | 'areaMode' | 'onArea' | 'onTextlessDrag'>;
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
    const handle = latest.current.handleRef;
    if (handle) handle.current = mounted.handle;
    return () => {
      controller.current = null;
      if (handle && handle.current === mounted.handle) handle.current = null;
      mounted.destroy();
    };
  }, [session, place, flow, scrollerRef]);

  useLayoutEffect(() => {
    controller.current?.refreshAnnotations();
  }, [props.annotations]);

  useLayoutEffect(() => {
    scrollerRef.current?.classList.toggle('pdf-area-mode', props.areaMode === true);
  }, [props.areaMode, scrollerRef, session, place]);

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
  // Two pages side by side, each fitted to half the width.
  const pair: Spread | null = flow === 'spread' ? spreadOf(requestedPage, session.pageCount) : null;
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
            fragment.className = mark.kind === 'note' ? 'pdf-note-rect' : mark.kind === 'pending' ? 'pdf-area-pending' : 'pdf-highlight-rect';
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

  /** The width one page is fitted to. */
  function areaWidth() {
    return pair ? width / 2 : width;
  }

  /** Where the spine sits in the stream, and the stream's size, with the pair centred on it. */
  function spreadBox(spread: Spread) {
    // An empty side keeps the width of the other, so a lone page stays on its own side.
    const leftWidth = layout.size(spread.left ?? spread.right!).cssWidth;
    const rightWidth = layout.size(spread.right ?? spread.left!).cssWidth;
    const streamWidth = Math.max(width, leftWidth + rightWidth);
    const heights = spreadPages(requestedPage, session.pageCount).map((page) => layout.size(page).cssHeight);
    return { spine: (streamWidth - leftWidth - rightWidth) / 2 + leftWidth, width: streamWidth, height: Math.max(0, ...heights) };
  }

  function pageTop(page: number) {
    return continuous ? layout.offset(page) : 0;
  }

  function pageLeft(page: number) {
    // Paginated mode retains the original reader's page-local scroll coordinates.
    return continuous ? Math.max(0, (layout.width(width) - layout.size(page).cssWidth) / 2) : 0;
  }

  /** Where a page shell sits horizontally in the stream (paginated pages are centred). */
  function shellLeft(page: number) {
    if (pair) {
      const { spine } = spreadBox(pair);
      return page === pair.left ? spine - layout.size(page).cssWidth : spine;
    }
    return continuous ? pageLeft(page) : Math.max(0, (width - layout.size(page).cssWidth) / 2);
  }

  /** The scroll position a pending command asks for, once its page has a transform. */
  function pendingScroll(target: NonNullable<typeof pending>, rendered: RenderedPage | undefined) {
    const page = target.place.page;
    const focus = target.place.focus;
    if (focus && rendered && !target.bottom) {
      const point = rendered.toViewport(focus.x, focus.y);
      return { top: pageTop(page) + point.y - focus.py, left: shellLeft(page) + point.x - focus.px };
    }
    const point = target.bottom && rendered
      ? { x: 0, y: Math.max(0, rendered.cssHeight - height) }
      : target.viewport ?? rendered?.toViewport(target.place.x, target.place.y);
    return { top: pageTop(page) + (point?.y ?? 0), left: pageLeft(page) + (point?.x ?? 0) };
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
    const box = pair ? spreadBox(pair) : null;
    stream.style.width = `${box ? box.width : continuous ? layout.width(width) : Math.max(width, layout.size(requestedPage).cssWidth)}px`;
    stream.style.height = `${box ? box.height : continuous ? layout.height : layout.size(requestedPage).cssHeight}px`;
    for (const [page, entry] of pages) {
      const size = layout.size(page);
      Object.assign(entry.shell.style, {
        position: 'absolute',
        top: `${pageTop(page)}px`,
        left: `${shellLeft(page)}px`,
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
      const target = pendingScroll(pending, pages.get(pending.place.page)?.rendered);
      writeScroll(target.top, target.left);
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
    const target = pendingScroll(restore, rendered);
    writeScroll(target.top, target.left);
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
    const wanted = new Set(
      continuous ? layout.range(root.scrollTop, height) : pair ? spreadPages(requestedPage, session.pageCount) : [requestedPage],
    );
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
      shell.className = pair ? `pdf-page ${page === pair.left ? 'pdf-page-left' : 'pdf-page-right'}` : 'pdf-page';
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
          const size = await session.pageSize(page, request.zoom, areaWidth(), height);
          if (!current()) return;
          recordSize(page, size);
          if (!current()) return;
          const rendered = await session.renderPage({ page, zoom: request.zoom, containerWidth: areaWidth(), containerHeight: height, canvas, textLayer: text });
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
          ? areaWidth() / size.cssWidth
          : request.zoom === 'page'
            ? Math.min(areaWidth() / size.cssWidth, height / size.cssHeight)
            : typeof previous.zoom === 'number' ? request.zoom / previous.zoom : request.zoom / size.scale;
        sizes.set(page, {
          cssWidth: size.cssWidth * scale,
          cssHeight: size.cssHeight * scale,
          scale: size.scale * scale,
        });
      }
    }
    const scale = request.zoom === 'width' ? areaWidth() / 612 : request.zoom === 'page' ? Math.min(areaWidth() / 612, height / 792) : request.zoom;
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

  // Area highlights: a drag on one page draws a rectangle in that page's CSS space.
  let drag: { pointerId: number; page: number; entry: PaintedPage; x: number; y: number; box: HTMLDivElement } | null = null;

  function localPoint(entry: PaintedPage, clientX: number, clientY: number) {
    const rect = entry.shell.getBoundingClientRect();
    const rendered = entry.rendered!;
    return {
      x: Math.max(0, Math.min(rendered.cssWidth, clientX - rect.left)),
      y: Math.max(0, Math.min(rendered.cssHeight, clientY - rect.top)),
    };
  }

  function drawDrag(clientX: number, clientY: number) {
    if (!drag) return;
    const point = localPoint(drag.entry, clientX, clientY);
    Object.assign(drag.box.style, {
      left: `${Math.min(drag.x, point.x)}px`,
      top: `${Math.min(drag.y, point.y)}px`,
      width: `${Math.abs(point.x - drag.x)}px`,
      height: `${Math.abs(point.y - drag.y)}px`,
    });
  }

  function cancelDrag() {
    drag?.box.remove();
    drag = null;
  }

  let textless: { pointerId: number; x: number; y: number } | null = null;

  function onPointerDown(event: PointerEvent) {
    textless = null;
    if (event.button !== 0) return;
    if (!callbacks.current.areaMode) {
      const shell = (event.target as Element | null)?.closest?.('.pdf-page') as HTMLDivElement | null;
      const entry = pages.get(Number(shell?.dataset.page));
      // A scanned page paints no text spans; a drag there selects nothing.
      if (entry?.rendered && entry.shell === shell && !entry.text.querySelector('span')) {
        textless = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      }
      return;
    }
    const shell = (event.target as Element | null)?.closest?.('.pdf-page') as HTMLDivElement | null;
    const page = Number(shell?.dataset.page);
    const entry = pages.get(page);
    if (!shell || !entry?.rendered || entry.shell !== shell) return;
    event.preventDefault();
    cancelDrag();
    const start = localPoint(entry, event.clientX, event.clientY);
    const box = document.createElement('div');
    box.className = 'pdf-area-draft';
    box.setAttribute('aria-hidden', 'true');
    shell.append(box);
    drag = { pointerId: event.pointerId, page, entry, x: start.x, y: start.y, box };
    drawDrag(event.clientX, event.clientY);
    try {
      root.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is a convenience; the document-level listeners still finish the drag.
    }
  }

  function onPointerMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    drawDrag(event.clientX, event.clientY);
  }

  function onPointerUp(event: PointerEvent) {
    if (textless && event.pointerId === textless.pointerId) {
      const moved = Math.abs(event.clientX - textless.x) + Math.abs(event.clientY - textless.y);
      textless = null;
      if (moved > 24 && event.pointerType === 'mouse') callbacks.current.onTextlessDrag?.();
      return;
    }
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { entry, page, box } = drag;
    const end = localPoint(entry, event.clientX, event.clientY);
    const left = Math.min(drag.x, end.x);
    const top = Math.min(drag.y, end.y);
    const right = Math.max(drag.x, end.x);
    const bottom = Math.max(drag.y, end.y);
    const anchor = box.getBoundingClientRect();
    cancelDrag();
    const rendered = entry.rendered;
    if (!rendered || pages.get(page) !== entry || right - left < AREA_MIN_PX || bottom - top < AREA_MIN_PX) return;
    const locator = formatPdfSelection({ pages: [{ page, rects: [transformRect([left, top, right, bottom], rendered.toPdf)] }] });
    if (!locator) return;
    callbacks.current.onArea?.({
      locator,
      quote: '',
      anchor: { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height },
    });
  }

  function onAreaKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && drag) cancelDrag();
  }

  const handle: PdfViewportHandle = {
    pointAt(clientX, clientY) {
      let best: { page: number; x: number; y: number; distance: number } | null = null;
      for (const [page, entry] of pages) {
        if (!entry.rendered) continue;
        const rect = entry.shell.getBoundingClientRect();
        const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
        const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
        const distance = dx + dy;
        if (best && best.distance <= distance) continue;
        const local = localPoint(entry, clientX, clientY);
        best = { page, ...entry.rendered.toPdf(local.x, local.y), distance };
      }
      return best ? { page: best.page, x: best.x, y: best.y } : null;
    },
    preview(factor, clientX, clientY) {
      const rect = root.getBoundingClientRect();
      stream.style.transformOrigin = `${clientX - rect.left + root.scrollLeft}px ${clientY - rect.top + root.scrollTop}px`;
      stream.style.transform = factor === 1 ? '' : `scale(${factor})`;
    },
  };

  // A copy from the text layer would carry its positioned, transparent spans as HTML.
  // Put clean plain text on the clipboard instead.
  function onCopy(event: ClipboardEvent) {
    const selection = root.ownerDocument.getSelection();
    if (!event.clipboardData || !selection || selection.isCollapsed || selectedPages(root, selection, pages).length === 0) return;
    const text = cleanCopiedText(selection.toString());
    if (!text) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  }

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', cancelDrag);
  root.addEventListener('scroll', onScroll, { passive: true });
  const owner = root.ownerDocument;
  owner.addEventListener('keydown', onAreaKey);
  owner.addEventListener('copy', onCopy);
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

  return { refreshAnnotations, handle, destroy: () => {
    alive = false;
    cancelDrag();
    clearSelection();
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('pointermove', onPointerMove);
    root.removeEventListener('pointerup', onPointerUp);
    root.removeEventListener('pointercancel', cancelDrag);
    owner.removeEventListener('keydown', onAreaKey);
    owner.removeEventListener('copy', onCopy);
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
