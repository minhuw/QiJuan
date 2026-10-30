import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfPageSize, PdfPlace, PdfSession, RenderedPage } from './types';
import { PdfViewport, type PdfViewportProps } from './viewport';
import { formatPdfSelection, parsePdfSelection, type PdfAnnotationMark } from './annotations';

let width = 640;
let height = 480;
let resize: () => void;

beforeEach(() => {
  width = 640;
  height = 480;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function geometry(page: number, zoom: PdfPlace['zoom'], containerWidth: number): RenderedPage {
  void page;
  const scale = zoom === 'width' ? containerWidth / 400 : zoom;
  return {
    cssWidth: 400 * scale,
    cssHeight: 1000 * scale,
    scale,
    toViewport: (x, y) => ({ x: (x - 10) * scale, y: (1000 - y) * scale }),
    toPdf: (x, y) => ({ x: 10 + x / scale, y: 1000 - y / scale }),
  };
}

function sessionFor(count = 20, viewport = geometry): PdfSession {
  return {
    pageCount: count,
    outline: [],
    thumbnailPages: [],
    searchable: vi.fn(async () => true),
    pageBox: vi.fn(async () => ({ xMin: 10, yMin: 0, xMax: 410, yMax: 1000 })),
    pageSize: vi.fn(async (page, zoom, containerWidth) => viewport(page, zoom, containerWidth)),
    renderPage: vi.fn(async ({ page, zoom, containerWidth }) => viewport(page, zoom, containerWidth)),
    releasePage: vi.fn(),
    renderThumbnail: vi.fn(async () => true),
    search: vi.fn(async () => ({ searchable: true, hits: [] })),
    destroy: vi.fn(async () => {}),
  };
}

function setup(overrides: Partial<PdfViewportProps> = {}) {
  const props: PdfViewportProps = {
    session: sessionFor(),
    place: { page: 1, x: 10, y: 1000, zoom: 1 },
    flow: 'continuous',
    scrollerRef: createRef<HTMLDivElement>(),
    onPosition: vi.fn(),
    onRendered: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  const view = render(<PdfViewport {...props} />);
  const root = props.scrollerRef.current!;
  return { props, root, ...view, update: (changes: Partial<PdfViewportProps>) => {
    Object.assign(props, changes);
    view.rerender(<PdfViewport {...props} />);
  } };
}

function scroll(root: HTMLDivElement, top: number, left = root.scrollLeft) {
  root.scrollTop = top;
  root.scrollLeft = left;
  fireEvent.scroll(root);
}

async function settled(props: PdfViewportProps, count = 1) {
  await waitFor(() => expect(props.onRendered).toHaveBeenCalledTimes(count));
}

describe('PdfViewport', () => {
  it('keeps the scroller ref available before a session or place exists', async () => {
    const view = setup({ session: null, place: null });
    expect(view.root).toHaveClass('pdf-scroller');
    expect(view.root.children).toHaveLength(0);
    view.update({ session: sessionFor(), place: { page: 1, x: 10, y: 1000, zoom: 1 } });
    await settled(view.props);
    expect(view.props.scrollerRef.current).toBe(view.root);
    view.update({ session: null, place: null });
    expect(view.root.children).toHaveLength(0);
  });

  it('keeps adjacent pages visible across a boundary and saves page-local PDF coordinates', async () => {
    const view = setup();
    await settled(view.props);
    expect(view.props.onRendered).toHaveBeenCalledWith(view.props.place, expect.anything(), view.props.place);
    expect(vi.mocked(view.props.onRendered).mock.calls[0][0]).toBe(view.props.place);
    scroll(view.root, 850);
    await waitFor(() => expect(view.root.querySelector('[data-page="2"]')).toHaveAttribute('aria-busy', 'false'));
    const first = view.root.querySelector<HTMLElement>('[data-page="1"]')!;
    const second = view.root.querySelector<HTMLElement>('[data-page="2"]')!;
    expect(first.style.top).toBe('0px');
    expect(second.style.top).toBe('1016px');
    expect(first.querySelector('canvas')).not.toBeNull();
    expect(second.querySelector('.textLayer')).not.toBeNull();
    expect(Number.parseFloat(first.style.top) + Number.parseFloat(first.style.height)).toBeGreaterThan(view.root.scrollTop);
    expect(Number.parseFloat(second.style.top)).toBeLessThan(view.root.scrollTop + height);
    scroll(view.root, 1100);
    expect(view.props.onPosition).toHaveBeenLastCalledWith({ page: 2, x: 10, y: 916, zoom: 1 });
    expect(view.props.onRendered).toHaveBeenCalledTimes(1);
  });

  it('bounds DOM, measurement and rasterization in a ten-thousand-page book', async () => {
    const session = sessionFor(10000);
    const view = setup({ session, place: { page: 5000, x: 10, y: 900, zoom: 1 } });
    await settled(view.props);
    expect(view.root.scrollTop).toBe(4999 * 1016 + 100);
    expect(view.root.querySelectorAll('canvas').length).toBeLessThan(8);
    expect(vi.mocked(session.renderPage).mock.calls.length).toBeLessThan(8);
    expect(vi.mocked(session.pageSize).mock.calls.length).toBeLessThan(8);
    expect(view.root.querySelector('canvas')).not.toBeNull();
    scroll(view.root, 8000 * 1016 + 40);
    await waitFor(() => expect(view.props.onPosition).toHaveBeenLastCalledWith({ page: 8001, x: 10, y: 960, zoom: 1 }));
    expect(view.root.querySelectorAll('canvas').length).toBeLessThan(8);
    expect(session.releasePage).toHaveBeenCalled();
  });

  it('applies rotations, mixed page offsets and horizontal centering in both directions', async () => {
    const viewport = (page: number, zoom: PdfPlace['zoom'], containerWidth: number): RenderedPage => page === 2 ? {
      scale: 1,
      cssWidth: 1200,
      cssHeight: 600,
      // A rotated/cropped page: PDF x controls viewport y.
      toViewport: (x, y) => ({ x: 900 - y, y: x - 20 }),
      toPdf: (x, y) => ({ x: y + 20, y: 900 - x }),
    } : geometry(page, zoom, containerWidth);
    const view = setup({ session: sessionFor(5, viewport), place: { page: 2, x: 120, y: 600, zoom: 1 } });
    await settled(view.props);
    expect(view.root.scrollTop).toBe(1116);
    expect(view.root.scrollLeft).toBe(300);
    expect(view.root.querySelector<HTMLElement>('[data-page="3"]')?.style.top).toBe('1632px');
    expect(view.props.onRendered).toHaveBeenLastCalledWith(view.props.place, expect.anything(), view.props.place);
    scroll(view.root, 1216, 400);
    expect(view.props.onPosition).toHaveBeenLastCalledWith({ page: 2, x: 220, y: 500, zoom: 1 });
    // Narrow page is centered at x=400 within the 1200px stream.
    scroll(view.root, 1732, 500);
    await waitFor(() => expect(view.props.onPosition).toHaveBeenLastCalledWith({ page: 3, x: 110, y: 900, zoom: 1 }));
    view.update({ place: { page: 3, x: 110, y: 900, zoom: 1 } });
    await settled(view.props, 2);
    expect(view.root.scrollLeft).toBe(500);
    expect(view.root.scrollTop).toBe(1732);
  });

  it('treats new place identities as commands and uses fresh callbacks without restarting work', async () => {
    const session = sessionFor();
    const view = setup({ session });
    await settled(view.props);
    scroll(view.root, 90);
    const paints = vi.mocked(session.renderPage).mock.calls.length;
    const onPosition = vi.fn();
    const onRendered = vi.fn();
    view.update({ onPosition, onRendered });
    expect(session.renderPage).toHaveBeenCalledTimes(paints);
    scroll(view.root, 130);
    expect(onPosition).toHaveBeenCalledWith({ page: 1, x: 10, y: 870, zoom: 1 });
    const request = { page: 4, x: 10, y: 750, zoom: 1 } as const;
    view.update({ place: request });
    await waitFor(() => expect(onRendered).toHaveBeenCalledTimes(1));
    expect(onRendered.mock.calls[0][0]).toBe(request);
    expect(view.root.scrollTop).toBe(3 * 1016 + 250);
    fireEvent.scroll(view.root); // delayed programmatic echo
    expect(onPosition).toHaveBeenCalledTimes(1);
    view.update({ place: { ...request } });
    await waitFor(() => expect(onRendered).toHaveBeenCalledTimes(2));
  });

  it('preserves a visible PDF anchor when a late measurement changes heights above it', async () => {
    const session = sessionFor(20, (page, zoom, containerWidth) => {
      const rendered = geometry(page, zoom, containerWidth);
      return page === 1 ? { ...rendered, cssHeight: 1400 } : rendered;
    });
    const firstSize = deferred<PdfPageSize>();
    vi.mocked(session.pageSize).mockImplementation(async (page, zoom, containerWidth) => page === 1 ? firstSize.promise : geometry(page, zoom, containerWidth));
    const view = setup({ session, place: { page: 2, x: 10, y: 800, zoom: 1 } });
    await settled(view.props);
    const before = view.root.scrollTop;
    await act(async () => { firstSize.resolve({ cssWidth: 400, cssHeight: 1400, scale: 1 }); });
    await waitFor(() => expect(view.root.querySelector('[data-page="1"]')).toHaveAttribute('aria-busy', 'false'));
    expect(view.root.scrollTop).toBe(before + 400);
    expect(view.root.querySelector<HTMLElement>('[data-page="2"]')?.style.top).toBe('1416px');
    expect(view.props.onPosition).not.toHaveBeenCalled();
    expect(view.props.onRendered).toHaveBeenCalledTimes(1);
    scroll(view.root, view.root.scrollTop + 30);
    expect(view.props.onPosition).toHaveBeenLastCalledWith({ page: 2, x: 10, y: 770, zoom: 1 });
  });

  it('preserves the current native-scroll anchor on fit-width resize and subsequent zoom', async () => {
    const session = sessionFor(20, (page, zoom, containerWidth) => {
      if (page !== 1) return geometry(page, zoom, containerWidth);
      const scale = zoom === 'width' ? containerWidth / 1000 : zoom;
      return {
        scale, cssWidth: 1000 * scale, cssHeight: 600 * scale,
        toViewport: (x, y) => ({ x: (x - 10) * scale, y: (600 - y) * scale }),
        toPdf: (x, y) => ({ x: 10 + x / scale, y: 600 - y / scale }),
      };
    });
    const view = setup({ session, place: { page: 1, x: 10, y: 600, zoom: 'width' } });
    await settled(view.props);
    await waitFor(() => expect(view.root.querySelector('[data-page="2"]')).toHaveAttribute('aria-busy', 'false'));
    scroll(view.root, 1500);
    await waitFor(() => expect(view.root.querySelector('[data-page="3"]')).toHaveAttribute('aria-busy', 'false'));
    vi.mocked(view.props.onPosition).mockClear();
    scroll(view.root, 2016 + 480);
    await waitFor(() => expect(view.props.onPosition).toHaveBeenLastCalledWith({ page: 3, x: 10, y: 700, zoom: 'width' }));
    width = 800;
    act(() => resize());
    await waitFor(() => expect(view.root.scrollTop).toBe(2512 + 600));
    await waitFor(() => expect(view.root.querySelector('[data-page="3"]')).toHaveAttribute('aria-busy', 'false'));
    expect(view.props.onRendered).toHaveBeenCalledTimes(1);
    expect(view.props.onPosition).toHaveBeenCalledTimes(1);
    view.update({ place: { page: 3, x: 10, y: 700, zoom: 3 } });
    await settled(view.props, 2);
    expect(view.root.scrollTop).toBe(4832 + 900);
    expect(view.props.onRendered).toHaveBeenLastCalledWith(view.props.place, expect.anything(), view.props.place);
  });

  it('renders only one paginated page at offset zero and computes bottom entry through its transform', async () => {
    const view = setup({ flow: 'paginated', enterAtBottom: true, place: { page: 4, x: 10, y: 1000, zoom: 1 } });
    await settled(view.props);
    expect(view.root.querySelectorAll('.pdf-page')).toHaveLength(1);
    expect(view.root.querySelector<HTMLElement>('.pdf-page')?.style.top).toBe('0px');
    expect(view.root.scrollTop).toBe(520);
    expect(view.props.onRendered).toHaveBeenLastCalledWith(view.props.place, expect.anything(), { page: 4, x: 10, y: 480, zoom: 1 });
    scroll(view.root, 100, 30);
    expect(view.props.onPosition).toHaveBeenLastCalledWith({ page: 4, x: 40, y: 900, zoom: 1 });
    view.update({ flow: 'continuous', place: { page: 4, x: 10, y: 1000, zoom: 1 } });
    await settled(view.props, 2);
    expect(view.root.scrollTop).toBe(3 * 1016);
  });

  it('uses the 640 by 480 fallback for unmeasurable scrollers', async () => {
    width = 0;
    height = 0;
    const session = sessionFor();
    const view = setup({ session, flow: 'paginated', enterAtBottom: true, place: { page: 1, x: 10, y: 1000, zoom: 'width' } });
    await settled(view.props);
    expect(session.renderPage).toHaveBeenCalledWith(expect.objectContaining({ containerWidth: 640 }));
    expect(view.root.scrollTop).toBe(1120);
    expect(view.props.onRendered).toHaveBeenLastCalledWith(view.props.place, expect.anything(), { page: 1, x: 10, y: 300, zoom: 'width' });
  });

  it('waits for the actual visible page transform when the end of the stream clamps a restore', async () => {
    const session = sessionFor(2, (page, zoom, containerWidth) => {
      const rendered = geometry(page, zoom, containerWidth);
      return page === 2 ? { ...rendered, cssHeight: 200 } : rendered;
    });
    const view = setup({ session, place: { page: 2, x: 10, y: 1000, zoom: 1 } });
    await settled(view.props);
    expect(view.root.scrollTop).toBe(736);
    expect(view.props.onRendered).toHaveBeenLastCalledWith(view.props.place, expect.anything(), { page: 1, x: 10, y: 264, zoom: 1 });
  });

  it('releases superseded canvases and ignores old paint, size and error promises', async () => {
    const session = sessionFor();
    const oldPaint = deferred<RenderedPage | null>();
    const oldSize = deferred<PdfPageSize>();
    vi.mocked(session.renderPage).mockImplementationOnce(() => oldPaint.promise);
    vi.mocked(session.pageSize).mockImplementation(async (page, zoom, containerWidth) => page === 2 ? oldSize.promise : geometry(page, zoom, containerWidth));
    const view = setup({ session });
    await waitFor(() => expect(session.renderPage).toHaveBeenCalledTimes(1));
    const oldCanvas = view.root.querySelector('canvas');
    scroll(view.root, 900); // ignored while restore is pending
    expect(view.props.onPosition).not.toHaveBeenCalled();
    view.update({ place: { page: 8, x: 10, y: 900, zoom: 1 } });
    await settled(view.props);
    expect(session.releasePage).toHaveBeenCalledWith(oldCanvas);
    const top = view.root.scrollTop;
    await act(async () => {
      oldPaint.reject(new Error('superseded'));
      oldSize.resolve({ cssWidth: 9999, cssHeight: 9999, scale: 1 });
    });
    expect(view.props.onError).not.toHaveBeenCalled();
    expect(view.props.onRendered).toHaveBeenCalledTimes(1);
    expect(view.root.scrollTop).toBe(top);
    const canvases = [...view.root.querySelectorAll('canvas')];
    view.unmount();
    for (const canvas of canvases) expect(session.releasePage).toHaveBeenCalledWith(canvas);
  });

  it('cancels old work when flow or session changes', async () => {
    const first = sessionFor();
    const paint = deferred<RenderedPage | null>();
    vi.mocked(first.renderPage).mockReturnValueOnce(paint.promise);
    const view = setup({ session: first, flow: 'paginated' });
    await waitFor(() => expect(first.renderPage).toHaveBeenCalledTimes(1));
    const canvas = view.root.querySelector('canvas');
    view.update({ flow: 'continuous' });
    await settled(view.props);
    expect(first.releasePage).toHaveBeenCalledWith(canvas);
    await act(async () => { paint.resolve(geometry(1, 1, 640)); });
    expect(view.props.onRendered).toHaveBeenCalledTimes(1);

    const size = deferred<PdfPageSize>();
    vi.mocked(first.pageSize).mockReturnValue(size.promise);
    view.update({ place: { page: 6, x: 10, y: 900, zoom: 1 } });
    const second = sessionFor();
    view.update({ session: second });
    await settled(view.props, 2);
    await act(async () => { size.reject(new Error('old session')); });
    expect(view.props.onRendered).toHaveBeenCalledTimes(2);
    expect(view.props.onError).not.toHaveBeenCalled();
  });

  it('invalidates pending paints when resized at an unpainted native-scroll destination', async () => {
    const session = sessionFor();
    const paint = deferred<RenderedPage | null>();
    vi.mocked(session.renderPage).mockImplementation(async ({ page, zoom, containerWidth }) => {
      if (page === 8 && containerWidth === 640) return paint.promise;
      return geometry(page, zoom, containerWidth);
    });
    const view = setup({ session, place: { page: 1, x: 10, y: 1000, zoom: 'width' } });
    await settled(view.props);
    scroll(view.root, 7 * 1616 + 160);
    await waitFor(() => expect(session.renderPage).toHaveBeenCalledWith(expect.objectContaining({ page: 8, containerWidth: 640 })));
    const canvas = view.root.querySelector('[data-page="8"] canvas');
    width = 800;
    act(() => resize());
    await waitFor(() => expect(view.root.querySelector('[data-page="8"]')).toHaveAttribute('aria-busy', 'false'));
    expect(session.releasePage).toHaveBeenCalledWith(canvas);
    expect(view.root.scrollTop).toBe(7 * 2016 + 200);
    await act(async () => { paint.resolve(geometry(8, 'width', 640)); });
    expect(view.root.scrollTop).toBe(7 * 2016 + 200);
    expect(view.props.onRendered).toHaveBeenCalledTimes(1);
    expect(view.props.onPosition).not.toHaveBeenCalled();
    scroll(view.root, view.root.scrollTop + 20);
    expect(view.props.onPosition).toHaveBeenLastCalledWith({ page: 8, x: 10, y: 890, zoom: 'width' });
  });

  it('ignores late work after unmount and reports current failures', async () => {
    const paint = deferred<RenderedPage | null>();
    const session = sessionFor();
    vi.mocked(session.renderPage).mockReturnValue(paint.promise);
    const view = setup({ session });
    await waitFor(() => expect(session.renderPage).toHaveBeenCalled());
    view.unmount();
    await act(async () => { paint.resolve(geometry(1, 1, 640)); });
    expect(view.props.onRendered).not.toHaveBeenCalled();
    const failed = sessionFor();
    const error = new Error('pdf-render');
    vi.mocked(failed.pageSize).mockRejectedValue(error);
    const next = setup({ session: failed });
    await waitFor(() => expect(next.props.onError).toHaveBeenCalledWith(error));
    expect(next.root.querySelector('.pdf-page')).toHaveAttribute('aria-busy', 'false');
  });
});

function clientBox(left: number, top: number, boxWidth: number, boxHeight: number) {
  return { left, top, right: left + boxWidth, bottom: top + boxHeight, width: boxWidth, height: boxHeight, x: left, y: top, toJSON() {} };
}

function textSession(count = 100, viewport = geometry) {
  const session = sessionFor(count, viewport);
  vi.mocked(session.renderPage).mockImplementation(async ({ page, zoom, containerWidth, textLayer }) => {
    textLayer.innerHTML = `<span>page ${page} example</span>`;
    const shell = textLayer.parentElement!;
    shell.getBoundingClientRect = () => {
      const root = shell.closest<HTMLDivElement>('.pdf-scroller')!;
      return clientBox(10 + Number.parseFloat(shell.style.left || '0') - root.scrollLeft,
        20 + Number.parseFloat(shell.style.top || '0') - root.scrollTop,
        Number.parseFloat(shell.style.width), Number.parseFloat(shell.style.height));
    };
    return viewport(page, zoom, containerWidth);
  });
  return session;
}

function textNode(root: HTMLElement, page: number) {
  return root.querySelector(`[data-page="${page}"] .textLayer span`)!.firstChild!;
}

function nativeRange(start: Node, startOffset: number, end = start, endOffset = start.textContent!.length) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function mark(id = 'highlight', kind: PdfAnnotationMark['kind'] = 'highlight', page = 1): PdfAnnotationMark {
  return { id, kind, locator: formatPdfSelection({ pages: [{ page, rects: [[20, 900, 50, 950]] }] })! };
}

async function allPainted(root: HTMLElement) {
  await waitFor(() => expect(root.querySelectorAll('[aria-busy="true"]')).toHaveLength(0));
}

describe('PdfViewport selection and overlays', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  const rectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');

  function flushSelection() {
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(performance.now());
    });
  }

  function selectionEvent(type = 'selectionchange') {
    fireEvent(document, new Event(type));
    flushSelection();
  }

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((frame: number) => { frames.delete(frame); }));
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: function (this: Range) {
      const parent = this.startContainer.parentElement;
      if (this.startContainer.nodeType !== Node.TEXT_NODE || this.startContainer !== this.endContainer) return [clientBox(0, 0, 9999, 9999)];
      const shell = parent?.closest('.pdf-page');
      if (!shell) return [];
      const bounds = shell.getBoundingClientRect();
      return [clientBox(bounds.left + 20 + this.startOffset * 8, bounds.top + 40, (this.endOffset - this.startOffset) * 8, 16)];
    } });
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    if (rectDescriptor) Object.defineProperty(Range.prototype, 'getClientRects', rectDescriptor);
    else Reflect.deleteProperty(Range.prototype, 'getClientRects');
  });

  it('updates and removes overlays without repainting canvases or changing native scroll', async () => {
    const session = textSession();
    const view = setup({ session });
    await settled(view.props);
    await allPainted(view.root);
    scroll(view.root, 20);
    const canvas = view.root.querySelector('canvas');
    const paints = vi.mocked(session.renderPage).mock.calls.length;
    const renders = vi.mocked(view.props.onRendered).mock.calls.length;
    const onSelection = vi.fn();
    view.update({ annotations: [mark(), mark('note', 'note'), { id: 'page-note', kind: 'note', locator: 'pdfpos(1,10,900)' }], onSelection });
    expect(view.root.scrollTop).toBe(20);
    expect(view.root.querySelector('canvas')).toBe(canvas);
    expect(session.renderPage).toHaveBeenCalledTimes(paints);
    expect(view.props.onRendered).toHaveBeenCalledTimes(renders);
    const layer = view.root.querySelector<HTMLElement>('.pdf-annotation-layer')!;
    expect([...layer.parentElement!.children].map((node) => node.tagName === 'CANVAS' ? 'canvas' : node.className)).toEqual(['canvas', 'pdf-annotation-layer', 'textLayer']);
    expect(layer).toHaveAttribute('aria-hidden', 'true');
    expect(layer.style.pointerEvents).toBe('none');
    expect(layer.style.userSelect).toBe('none');
    expect(layer.querySelectorAll('.pdf-highlight-rect')).toHaveLength(1);
    expect(layer.querySelectorAll('.pdf-note-rect')).toHaveLength(1);
    expect(layer.querySelector<HTMLElement>('.pdf-highlight-rect')!.style.cssText).toContain('left: 10px');
    view.update({ annotations: [mark()] });
    expect(layer.children).toHaveLength(1);
    view.update({ annotations: [] });
    expect(layer.children).toHaveLength(0);
    expect(session.renderPage).toHaveBeenCalledTimes(paints);
    expect(onSelection).not.toHaveBeenCalled();
  });

  it('clips out-of-page marks and discards rectangles wholly outside the page', async () => {
    const view = setup({ session: textSession(), annotations: [{
      id: 'oversized', kind: 'highlight', locator: formatPdfSelection({ pages: [{ page: 1, rects: [
        [-1000000, -1000000, 1000000, 1000000], [900000, 900000, 1000000, 1000000],
      ] }] })!,
    }] });
    await settled(view.props);
    const layer = view.root.querySelector<HTMLElement>('.pdf-annotation-layer')!;
    expect(layer.style.overflow).toBe('hidden');
    expect(layer.children).toHaveLength(1);
    const rect = layer.firstElementChild as HTMLElement;
    const page = layer.parentElement!;
    expect([rect.style.left, rect.style.top, rect.style.width, rect.style.height]).toEqual(['0px', '0px', page.style.width, page.style.height]);
  });

  it('reprojects marks after zoom and eviction/remount with no duplicate accumulation', async () => {
    const view = setup({ session: textSession(), annotations: [mark()] });
    await settled(view.props);
    expect(view.root.querySelector<HTMLElement>('.pdf-highlight-rect')!.style.width).toBe('30px');
    view.update({ place: { page: 1, x: 10, y: 1000, zoom: 2 } });
    await settled(view.props, 2);
    let rect = view.root.querySelector<HTMLElement>('.pdf-highlight-rect')!;
    expect([rect.style.left, rect.style.top, rect.style.width, rect.style.height]).toEqual(['20px', '100px', '60px', '100px']);
    const oldShell = view.root.querySelector('[data-page="1"]');
    scroll(view.root, 10 * 2016);
    await allPainted(view.root);
    expect(oldShell).not.toBeInTheDocument();
    scroll(view.root, 0);
    await allPainted(view.root);
    rect = view.root.querySelector<HTMLElement>('.pdf-highlight-rect')!;
    expect(rect.style.width).toBe('60px');
    expect(view.root.querySelectorAll('.pdf-highlight-rect')).toHaveLength(1);
    expect(view.root.querySelector('[data-page="1"]')).not.toBe(oldShell);
    view.update({ annotations: [] });
    expect(view.root.querySelectorAll('.pdf-highlight-rect')).toHaveLength(0);
  });

  it('projects rotated PDF rectangles through all viewport corners', async () => {
    const viewport = (): RenderedPage => ({
      cssWidth: 600, cssHeight: 400, scale: 1,
      toViewport: (x, y) => ({ x: 900 - y, y: x - 20 }),
      toPdf: (x, y) => ({ x: y + 20, y: 900 - x }),
    });
    const view = setup({ session: textSession(1, viewport), flow: 'paginated', annotations: [{
      id: 'rotated', kind: 'note', locator: formatPdfSelection({ pages: [{ page: 1, rects: [[30, 840, 60, 880]] }] })!,
    }] });
    await settled(view.props);
    const rect = view.root.querySelector<HTMLElement>('.pdf-note-rect')!;
    expect([rect.style.left, rect.style.top, rect.style.width, rect.style.height]).toEqual(['20px', '10px', '40px', '30px']);
  });

  it('uses fresh callbacks for pointer, mobile selectionchange, keyboard and scrolling anchors', async () => {
    const oldSelection = vi.fn();
    const view = setup({ session: textSession(), onSelection: oldSelection });
    view.root.getBoundingClientRect = () => clientBox(10, 20, width, height);
    await settled(view.props);
    nativeRange(textNode(view.root, 1), 7, textNode(view.root, 1), 11);
    fireEvent(document, new Event('pointerup'));
    const onSelection = vi.fn();
    view.update({ onSelection });
    flushSelection();
    expect(oldSelection).not.toHaveBeenCalled();
    expect(onSelection).toHaveBeenCalledTimes(1);
    const selected = onSelection.mock.calls[0][0];
    expect(selected.quote).toBe('exam');
    expect(parsePdfSelection(selected.locator)).toEqual({ pages: [{ page: 1, rects: [[86, 944, 118, 960]] }] });
    expect(selected.anchor).toEqual({ left: 206, top: 60, width: 32, height: 16 });
    scroll(view.root, 10);
    flushSelection();
    expect(onSelection.mock.lastCall![0].anchor.top).toBe(50);
    expect(onSelection.mock.lastCall![0].locator).toBe(selected.locator);
    nativeRange(textNode(view.root, 1), 0, textNode(view.root, 1), 4);
    selectionEvent();
    expect(onSelection.mock.lastCall![0].quote).toBe('page');
    nativeRange(textNode(view.root, 1), 1, textNode(view.root, 1), 4);
    selectionEvent('keyup');
    expect(onSelection.mock.lastCall![0].quote).toBe('age');
    document.getSelection()!.removeAllRanges();
    selectionEvent();
    expect(onSelection).toHaveBeenLastCalledWith(null);
  });

  it('ignores outside/control selections and releases the current toolbar when selection moves out', async () => {
    const onSelection = vi.fn();
    const view = setup({ session: textSession(), onSelection });
    await settled(view.props);
    const control = document.createElement('button');
    control.textContent = 'toolbar';
    view.root.append(control);
    nativeRange(control.firstChild!, 0);
    selectionEvent();
    expect(onSelection).not.toHaveBeenCalled();
    nativeRange(textNode(view.root, 1), 0);
    selectionEvent();
    expect(onSelection.mock.lastCall![0].quote).toBe('page 1 example');
    nativeRange(textNode(view.root, 1), 0, control.firstChild!, 3);
    selectionEvent();
    expect(onSelection).toHaveBeenLastCalledWith(null);
    control.remove();
  });

  it('inserts backwards-mounted pages in DOM reading order and retains selected nodes until collapse', async () => {
    const onSelection = vi.fn();
    const view = setup({ session: textSession(), place: { page: 3, x: 10, y: 1000, zoom: 1 }, onSelection });
    await settled(view.props);
    await allPainted(view.root);
    const second = textNode(view.root, 2);
    const third = textNode(view.root, 3);
    const selection = nativeRange(second, 5, third, 6);
    selectionEvent();
    expect(parsePdfSelection(onSelection.mock.lastCall![0].locator)?.pages.map((page) => page.page)).toEqual([2, 3]);
    scroll(view.root, 0);
    await allPainted(view.root);
    expect([...view.root.querySelectorAll<HTMLElement>('.pdf-page')].map((page) => Number(page.dataset.page))).toEqual([1, 2, 3]);
    expect(textNode(view.root, 2)).toBe(second);
    expect(textNode(view.root, 3)).toBe(third);
    expect(selection.anchorNode).toBe(second);
    scroll(view.root, 20 * 1016);
    await allPainted(view.root);
    expect(second.isConnected && third.isConnected).toBe(true);
    expect(view.root.querySelectorAll('canvas').length).toBeLessThanOrEqual(6);
    selection.collapse(third, 1);
    selectionEvent();
    expect(second.isConnected || third.isConnected).toBe(false);
    expect(view.root.querySelectorAll('canvas').length).toBeLessThanOrEqual(4);
    expect(onSelection).toHaveBeenLastCalledWith(null);
  });

  it('pins at most eight selected pages and reports excessive selections without truncating', async () => {
    const onSelection = vi.fn();
    const onSelectionTooLarge = vi.fn();
    const view = setup({ session: textSession(), onSelection, onSelectionTooLarge });
    await settled(view.props);
    const first = textNode(view.root, 1);
    const selection = nativeRange(first, 0, first, 4);
    selectionEvent();
    for (const target of [3, 5, 7, 8]) {
      scroll(view.root, (target - 1) * 1016);
      await allPainted(view.root);
      selection.extend(textNode(view.root, target), 4);
      selectionEvent();
    }
    expect(parsePdfSelection(onSelection.mock.lastCall![0].locator)?.pages).toHaveLength(8);
    scroll(view.root, 9 * 1016);
    await allPainted(view.root);
    selection.extend(textNode(view.root, 10), 4);
    selectionEvent();
    expect(onSelectionTooLarge).toHaveBeenCalledTimes(1);
    expect(onSelection).toHaveBeenLastCalledWith(null);
    scroll(view.root, 50 * 1016);
    await allPainted(view.root);
    flushSelection();
    expect(first.isConnected).toBe(true);
    expect(selection.focusNode).toBe(textNode(view.root, 10));
    expect(view.root.querySelectorAll('canvas').length).toBeLessThanOrEqual(12);
    expect(onSelectionTooLarge).toHaveBeenCalledTimes(1);
    selection.collapse(first, 1);
    selectionEvent();
    expect(first.isConnected).toBe(false);
    expect(view.root.querySelectorAll('canvas').length).toBeLessThanOrEqual(4);
  });

  it('cancels pending selection emissions on commands, resize, session changes and unmount', async () => {
    const onSelection = vi.fn();
    const view = setup({ session: textSession(), onSelection });
    await settled(view.props);
    nativeRange(textNode(view.root, 1), 0);
    fireEvent(document, new Event('selectionchange'));
    expect(frames.size).toBe(1);
    view.update({ place: { page: 2, x: 10, y: 1000, zoom: 1 } });
    await settled(view.props, 2);
    flushSelection();
    expect(onSelection).not.toHaveBeenCalled();
    expect(document.getSelection()!.rangeCount).toBe(0);
    nativeRange(textNode(view.root, 2), 0);
    selectionEvent();
    expect(onSelection).toHaveBeenCalledTimes(1);
    width = 800;
    act(() => resize());
    await allPainted(view.root);
    expect(onSelection).toHaveBeenLastCalledWith(null);
    nativeRange(textNode(view.root, 2), 0);
    fireEvent(document, new Event('selectionchange'));
    const paints = vi.mocked(view.props.session!.renderPage).mock.calls.length;
    view.update({ session: textSession() });
    await settled(view.props, 3);
    flushSelection();
    expect(onSelection).toHaveBeenCalledTimes(2);
    expect(vi.mocked(view.props.session!.renderPage).mock.calls.length).toBeLessThanOrEqual(paints);
    nativeRange(textNode(view.root, 2), 0);
    fireEvent(document, new Event('pointerup'));
    view.unmount();
    flushSelection();
    fireEvent(document, new Event('selectionchange'));
    expect(frames.size).toBe(0);
    expect(onSelection).toHaveBeenCalledTimes(2);
  });
});
