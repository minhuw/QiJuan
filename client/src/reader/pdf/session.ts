import { mapOutline } from './outline';
import { hasSearchableText, runsFromTextItems, searchRuns, type PdfTextRun } from './search';
import { pdfWorkerUrl } from './worker';
import type { PdfPageBox, PdfPageSize, PdfSearchResult, PdfSession, RenderedPage, RenderPageInput } from './types';

type Pdfjs = typeof import('pdfjs-dist');
type PdfDocument = import('pdfjs-dist').PDFDocumentProxy;
type PdfPage = import('pdfjs-dist').PDFPageProxy;

const MAX_CANVAS_PIXELS = 4_000_000;

interface LiveRender {
  cancel: () => void;
  promise: Promise<void>;
}

interface PageRenderState {
  generation: number;
  task: LiveRender | null;
  text: { cancel: () => void } | null;
}

function cancelRender(task: { cancel: () => void } | null | undefined) {
  if (!task) return;
  try {
    task.cancel();
  } catch {
    // A task that already settled has nothing left to cancel.
  }
}

function isRenderingCancelled(error: unknown, pdfjs: Pdfjs): boolean {
  if (error instanceof pdfjs.RenderingCancelledException) return true;
  return error instanceof Error && error.name === 'RenderingCancelledException';
}

/** pdf.js 6 throws this while an older render still has the canvas in its in-use set. */
function isCanvasConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Cannot use the same canvas during multiple render() operations');
}

/**
 * Opens PDF bytes with pdfjs-dist. Callers outside `client/src/reader/pdf`
 * use this instead of importing the library themselves.
 * Only the requested page is painted. Thumbnails are a separate, smaller draw.
 */
export async function openPdfSession(data: ArrayBuffer, options?: { workerSrc?: string }): Promise<PdfSession> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = options?.workerSrc ?? pdfWorkerUrl();
  const bytes = new Uint8Array(data.slice(0));
  const base = import.meta.env.BASE_URL || '/';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const task = pdfjs.getDocument({
    data: bytes,
    verbosity: 0,
    enableXfa: false,
    cMapUrl: `${prefix}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${prefix}pdfjs/standard_fonts/`,
    wasmUrl: `${prefix}pdfjs/wasm/`,
    useSystemFonts: true,
  });
  const doc = await task.promise;
  const outline = await mapOutline(await doc.getOutline().catch(() => null), doc).catch(() => []);
  const pageCount = doc.numPages;
  const runs = new Map<number, PdfTextRun[]>();
  let textKnown: boolean | null = null;
  let textProbe: Promise<boolean> | null = null;
  let destroyed = false;
  const pageRenders = new Map<HTMLCanvasElement, PageRenderState>();
  const thumbRenders = new Map<HTMLCanvasElement, { generation: number; task: LiveRender | null }>();

  async function loadRuns(pageNumber: number): Promise<PdfTextRun[]> {
    const cached = runs.get(pageNumber);
    if (cached) return cached;
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const next = runsFromTextItems(content.items);
    runs.set(pageNumber, next);
    return next;
  }

  function probeText(): Promise<boolean> {
    if (textKnown !== null) return Promise.resolve(textKnown);
    if (!textProbe) {
      textProbe = (async () => {
        for (let page = 1; page <= pageCount; page += 1) {
          if (destroyed) return false;
          const pageRuns = await loadRuns(page);
          if (hasSearchableText(pageRuns)) {
            textKnown = true;
            return true;
          }
        }
        textKnown = false;
        return false;
      })().catch(() => {
        textKnown = false;
        return false;
      });
    }
    return textProbe;
  }

  return {
    pageCount,
    outline,
    thumbnailPages: pageCount > 0 ? Array.from({ length: pageCount }, (_, index) => index + 1) : [],
    searchable: probeText,
    async pageBox(pageNumber: number): Promise<PdfPageBox> {
      const page = await doc.getPage(clampPage(pageNumber, pageCount));
      const [xMin, yMin, xMax, yMax] = page.view;
      return { xMin, yMin, xMax, yMax };
    },
    async pageSize(pageNumber, zoom, containerWidth): Promise<PdfPageSize> {
      const page = await doc.getPage(clampPage(pageNumber, pageCount));
      const { scale, viewport } = pageGeometry(page, zoom, containerWidth);
      return { scale, cssWidth: viewport.width, cssHeight: viewport.height };
    },
    renderPage(input) {
      if (destroyed) return Promise.resolve(null);
      const state = pageRenders.get(input.canvas) ?? { generation: 0, task: null, text: null };
      pageRenders.set(input.canvas, state);
      invalidatePage(state);
      const generation = state.generation;
      return paintPage(pdfjs, doc, input, state, () => !destroyed && state.generation === generation);
    },
    releasePage(canvas) {
      const state = pageRenders.get(canvas);
      if (!state) return;
      invalidatePage(state);
      pageRenders.delete(canvas);
    },
    async renderThumbnail(pageNumber, canvas, maxWidth) {
      if (destroyed || pageNumber < 1 || pageNumber > pageCount) return false;
      const state = thumbRenders.get(canvas) ?? { generation: 0, task: null };
      state.generation += 1;
      const generation = state.generation;
      thumbRenders.set(canvas, state);
      try {
        const page = await doc.getPage(pageNumber);
        if (destroyed || state.generation !== generation) return true;
        cancelRender(state.task);
        state.task = null;
        const baseViewport = page.getViewport({ scale: 1 });
        const width = baseViewport.width || 1;
        const scale = Math.min(Math.max(maxWidth, 1) / width, 0.5);
        const viewport = page.getViewport({ scale });
        const transform = prepareCanvas(canvas, viewport.width, viewport.height);
        const task = page.render({ canvas, viewport, transform });
        state.task = task;
        try {
          await task.promise;
        } catch (error) {
          // Keep the failed task so the next draw can cancel it and release the canvas.
          if (renderWasReplaced(error, pdfjs, destroyed || state.generation !== generation)) return true;
          return false;
        }
        if (state.task === task) state.task = null;
        if (destroyed || state.generation !== generation) return true;
        return true;
      } catch (error) {
        if (renderWasReplaced(error, pdfjs, destroyed || state.generation !== generation)) return true;
        return false;
      }
    },
    async search(query: string): Promise<PdfSearchResult> {
      const searchable = await probeText();
      if (!searchable) return { searchable: false, hits: [] };
      const pages: Array<{ page: number; runs: PdfTextRun[] }> = [];
      for (let page = 1; page <= pageCount; page += 1) {
        if (destroyed) return { searchable: true, hits: [] };
        pages.push({ page, runs: await loadRuns(page) });
      }
      return { searchable: true, hits: searchRuns(pages, query) };
    },
    async destroy() {
      destroyed = true;
      for (const state of pageRenders.values()) invalidatePage(state);
      pageRenders.clear();
      for (const state of thumbRenders.values()) {
        state.generation += 1;
        cancelRender(state.task);
        state.task = null;
      }
      thumbRenders.clear();
      runs.clear();
      await task.destroy().catch(() => undefined);
    },
  };
}

function renderWasReplaced(error: unknown, pdfjs: Pdfjs, replaced: boolean): boolean {
  if (isRenderingCancelled(error, pdfjs)) return true;
  if (replaced && isCanvasConflict(error)) return true;
  return replaced;
}

function invalidatePage(state: PageRenderState) {
  state.generation += 1;
  cancelRender(state.task);
  state.task = null;
  cancelRender(state.text);
  state.text = null;
}

function pageGeometry(page: PdfPage, zoom: RenderPageInput['zoom'], containerWidth: number) {
  const base = page.getViewport({ scale: 1 });
  const fitted = base.width > 0 ? Math.max(containerWidth, 1) / base.width : 1;
  const scale = clampScale(zoom === 'width' ? fitted : zoom);
  return { scale, viewport: page.getViewport({ scale }) };
}

async function paintPage(
  pdfjs: Pdfjs,
  doc: PdfDocument,
  input: RenderPageInput,
  state: PageRenderState,
  isCurrent: () => boolean,
): Promise<RenderedPage | null> {
  let page: PdfPage;
  let geometry: ReturnType<typeof pageGeometry>;
  try {
    page = await doc.getPage(clampPage(input.page, doc.numPages));
    if (!isCurrent()) return null;
    geometry = pageGeometry(page, input.zoom, input.containerWidth);
    const { viewport } = geometry;
    const transform = prepareCanvas(input.canvas, viewport.width, viewport.height);
    const task = page.render({ canvas: input.canvas, viewport, transform });
    state.task = task;
    await task.promise;
    if (state.task === task) state.task = null;
  } catch (error) {
    // Keep a failed task so a replacement can cancel it and release the canvas lock.
    if (renderWasReplaced(error, pdfjs, !isCurrent())) return null;
    throw new Error('pdf-render');
  }
  if (!isCurrent()) return null;
  const { scale, viewport } = geometry;
  // PDF.js 6 positions text with CSS variables, including the PDF's user unit.
  input.textLayer.style.setProperty('--total-scale-factor', String(scale * (viewport.userUnit ?? 1)));
  input.textLayer.replaceChildren();
  let layer: InstanceType<Pdfjs['TextLayer']> | null = null;
  try {
    const content = await page.getTextContent();
    if (!isCurrent()) return null;
    layer = new pdfjs.TextLayer({
      textContentSource: content,
      container: input.textLayer,
      viewport,
    });
    state.text = layer;
    await layer.render();
  } catch {
    // A cancelled older layer must never clear or cancel its replacement.
    if (layer && state.text === layer) {
      cancelRender(layer);
      state.text = null;
    }
  }
  if (!isCurrent()) return null;
  return {
    scale,
    cssWidth: viewport.width,
    cssHeight: viewport.height,
    toPdf(x, y) {
      const [pdfX, pdfY] = viewport.convertToPdfPoint(x, y);
      return { x: pdfX, y: pdfY };
    },
    toViewport(x, y) {
      const [px, py] = viewport.convertToViewportPoint(x, y);
      return { x: px, y: py };
    },
  };
}

function prepareCanvas(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): number[] | undefined {
  const width = Math.max(1, cssWidth);
  const height = Math.max(1, cssHeight);
  let dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  while (width * dpr * height * dpr > MAX_CANVAS_PIXELS && dpr > 1) dpr /= 2;
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  return dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0];
}

function clampPage(page: number, pageCount: number): number {
  if (!Number.isInteger(page) || page < 1) return 1;
  if (page > pageCount) return pageCount;
  return page;
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(16, Math.max(0.1, scale));
}
