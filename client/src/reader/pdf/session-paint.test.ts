import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPdfSession } from './session';
import type { PdfSession } from './types';

const harness = vi.hoisted(() => {
  class RenderingCancelledException extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'RenderingCancelledException';
    }
  }

  interface Handle {
    cancelled: boolean;
    finish: () => void;
    fail: (error: Error) => void;
  }

  const renders: Handle[] = [];
  const inUse = new Set<HTMLCanvasElement>();
  const textLayers: Array<Handle & { container: HTMLElement }> = [];
  const controls = { deferText: false, settleCancellation: true, rotation: 0 };
  const cleanup = vi.fn();
  const destroy = vi.fn(async () => {});
  const getTextContent = vi.fn(async () => ({ items: [] }));
  const getPage = vi.fn(async (_pageNumber: number) => ({
    view: [0, 0, 300, 400],
    getViewport({ scale }: { scale: number }) {
      const rotated = controls.rotation % 180 !== 0;
      return {
        width: (rotated ? 400 : 300) * scale,
        height: (rotated ? 300 : 400) * scale,
        convertToPdfPoint: (x: number, y: number) => [x, y],
        convertToViewportPoint: (x: number, y: number) => [x, y],
      };
    },
    getTextContent,
    cleanup,
    render({ canvas }: { canvas: HTMLCanvasElement }) {
      return startRender(canvas);
    },
  }));

  function startText(container: HTMLElement) {
    let finish = () => {};
    let fail = (_error: Error) => {};
    const promise = controls.deferText ? new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    }) : Promise.resolve();
    const layer = { container, cancelled: false, finish, fail };
    textLayers.push(layer);
    return {
      promise,
      cancel() {
        layer.cancelled = true;
        if (controls.settleCancellation) fail(new RenderingCancelledException('Text cancelled'));
      },
    };
  }

  function startRender(canvas: HTMLCanvasElement) {
    if (inUse.has(canvas)) {
      const error = new Error(
        'Cannot use the same canvas during multiple render() operations. Use different canvas or ensure previous operations were cancelled or completed.',
      );
      return {
        promise: Promise.reject(error),
        cancel() {
          inUse.delete(canvas);
        },
      };
    }
    inUse.add(canvas);
    let settled = false;
    let resolvePromise: () => void = () => {};
    let rejectPromise: (error: Error) => void = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const handle: Handle = {
      cancelled: false,
      finish() {
        if (settled) return;
        settled = true;
        if (!handle.cancelled) inUse.delete(canvas);
        resolvePromise();
      },
      fail(error: Error) {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      },
    };
    const task = {
      promise,
      cancel() {
        inUse.delete(canvas);
        handle.cancelled = true;
        if (settled || !controls.settleCancellation) return;
        settled = true;
        rejectPromise(new RenderingCancelledException('Rendering cancelled, page 1'));
      },
    };
    renders.push(handle);
    return task;
  }

  return { RenderingCancelledException, renders, inUse, textLayers, controls, cleanup, destroy, getPage, getTextContent, startText };
});

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  RenderingCancelledException: harness.RenderingCancelledException,
  TextLayer: class {
    private task: ReturnType<typeof harness.startText>;
    constructor({ container }: { container: HTMLElement }) {
      this.task = harness.startText(container);
    }
    cancel() { this.task.cancel(); }
    render() { return this.task.promise; }
  },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 3,
      getOutline: async () => null,
      getPage: harness.getPage,
    }),
    destroy: harness.destroy,
  }),
}));

const sessions: PdfSession[] = [];

beforeEach(() => {
  harness.renders.length = 0;
  harness.inUse.clear();
  harness.textLayers.length = 0;
  harness.controls.deferText = false;
  harness.controls.settleCancellation = true;
  harness.controls.rotation = 0;
  harness.getPage.mockClear();
  harness.getTextContent.mockClear();
  harness.cleanup.mockClear();
  harness.destroy.mockClear();
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.destroy()));
});

async function openSession() {
  const session = await openPdfSession(new ArrayBuffer(8));
  sessions.push(session);
  return session;
}

async function openedRenders(count: number) {
  for (let attempt = 0; attempt < 10 && harness.renders.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(harness.renders).toHaveLength(count);
}

async function openedTextLayers(count: number) {
  await vi.waitFor(() => expect(harness.textLayers).toHaveLength(count));
}

function paintInput(canvas: HTMLCanvasElement, zoom: number | 'width' = 1) {
  return {
    page: 1,
    zoom,
    containerWidth: zoom === 'width' ? 450 : 300,
    canvas,
    textLayer: document.createElement('div'),
  };
}

describe('pdf canvas renders', () => {
  it('paints neighboring page canvases concurrently without cancelling either', async () => {
    const session = await openSession();
    const left = document.createElement('canvas');
    const right = document.createElement('canvas');
    const first = session.renderPage(paintInput(left));
    const second = session.renderPage({ ...paintInput(right), page: 2 });
    await openedRenders(2);
    expect(harness.renders.every((render) => !render.cancelled)).toBe(true);
    harness.renders[1]?.finish();
    await expect(second).resolves.toMatchObject({ scale: 1 });
    harness.renders[0]?.finish();
    await expect(first).resolves.toMatchObject({ scale: 1 });
    expect(harness.textLayers.every((layer) => !layer.cancelled)).toBe(true);
    expect(harness.cleanup).not.toHaveBeenCalled();
  });

  it('replaces and releases text layers only for the affected canvas', async () => {
    harness.controls.deferText = true;
    const session = await openSession();
    const left = document.createElement('canvas');
    const right = document.createElement('canvas');
    const first = session.renderPage(paintInput(left));
    const neighbor = session.renderPage(paintInput(right));
    await openedRenders(2);
    harness.renders.forEach((render) => render.finish());
    await openedTextLayers(2);
    const replacement = session.renderPage(paintInput(left));
    await openedRenders(3);
    expect(harness.textLayers[0]?.cancelled).toBe(true);
    expect(harness.textLayers[1]?.cancelled).toBe(false);
    await expect(first).resolves.toBeNull();
    harness.renders[2]?.finish();
    await openedTextLayers(3);
    session.releasePage(left);
    session.releasePage(left);
    expect(harness.textLayers[2]?.cancelled).toBe(true);
    expect(harness.textLayers[1]?.cancelled).toBe(false);
    await expect(replacement).resolves.toBeNull();
    harness.textLayers[1]?.finish();
    await expect(neighbor).resolves.toMatchObject({ scale: 1 });
  });

  it('ignores a released raster completion even after the canvas is reused', async () => {
    harness.controls.settleCancellation = false;
    const session = await openSession();
    const canvas = document.createElement('canvas');
    const staleInput = paintInput(canvas);
    const stale = session.renderPage(staleInput);
    await openedRenders(1);
    session.releasePage(canvas);
    expect(harness.renders[0]?.cancelled).toBe(true);
    const current = session.renderPage(paintInput(canvas, 'width'));
    await openedRenders(2);
    harness.renders[0]?.finish();
    await expect(stale).resolves.toBeNull();
    expect(staleInput.textLayer.childNodes).toHaveLength(0);
    expect(harness.textLayers).toHaveLength(0);
    expect(harness.inUse.has(canvas)).toBe(true);
    harness.renders[1]?.finish();
    await expect(current).resolves.toMatchObject({ scale: 1.5 });
    expect(harness.textLayers).toHaveLength(1);
  });

  it('does not revive a released state whose page is still loading', async () => {
    const session = await openSession();
    const canvas = document.createElement('canvas');
    const page = await harness.getPage(1);
    let finishLoading: (value: typeof page) => void = () => {};
    harness.getPage.mockImplementationOnce(() => new Promise((resolve) => { finishLoading = resolve; }));
    const stale = session.renderPage(paintInput(canvas));
    session.releasePage(canvas);
    const current = session.renderPage(paintInput(canvas));
    await openedRenders(1);
    finishLoading(page);
    await expect(stale).resolves.toBeNull();
    expect(harness.renders).toHaveLength(1);
    harness.renders[0]?.finish();
    await expect(current).resolves.toMatchObject({ scale: 1 });
  });

  it('keeps a reused canvas text layer when released text later rejects', async () => {
    harness.controls.deferText = true;
    harness.controls.settleCancellation = false;
    const session = await openSession();
    const canvas = document.createElement('canvas');
    const stale = session.renderPage(paintInput(canvas));
    await openedRenders(1);
    harness.renders[0]?.finish();
    await openedTextLayers(1);
    session.releasePage(canvas);
    const current = session.renderPage(paintInput(canvas));
    await openedRenders(2);
    harness.renders[1]?.finish();
    await openedTextLayers(2);
    harness.textLayers[0]?.fail(new Error('late cancellation'));
    await expect(stale).resolves.toBeNull();
    expect(harness.textLayers[1]?.cancelled).toBe(false);
    harness.textLayers[1]?.finish();
    await expect(current).resolves.toMatchObject({ scale: 1 });
  });

  it('does not cancel a replacement text layer when the previous layer rejects late', async () => {
    harness.controls.deferText = true;
    harness.controls.settleCancellation = false;
    const session = await openSession();
    const canvas = document.createElement('canvas');
    const stale = session.renderPage(paintInput(canvas));
    await openedRenders(1);
    harness.renders[0]?.finish();
    await openedTextLayers(1);
    const current = session.renderPage(paintInput(canvas));
    await openedRenders(2);
    harness.renders[1]?.finish();
    await openedTextLayers(2);
    harness.textLayers[0]?.fail(new Error('late cancellation'));
    await expect(stale).resolves.toBeNull();
    expect(harness.textLayers[1]?.cancelled).toBe(false);
    session.releasePage(canvas);
    expect(harness.textLayers[1]?.cancelled).toBe(true);
    harness.textLayers[1]?.finish();
    await expect(current).resolves.toBeNull();
  });

  it('destroys all page and thumbnail work and prevents new page paints', async () => {
    harness.controls.deferText = true;
    const session = await openSession();
    const textCanvas = document.createElement('canvas');
    const textPaint = session.renderPage(paintInput(textCanvas));
    await openedRenders(1);
    harness.renders[0]?.finish();
    await openedTextLayers(1);
    const raster = session.renderPage(paintInput(document.createElement('canvas')));
    const thumbnail = session.renderThumbnail(1, document.createElement('canvas'), 96);
    await openedRenders(3);
    await session.destroy();
    expect(harness.renders[1]?.cancelled).toBe(true);
    expect(harness.renders[2]?.cancelled).toBe(true);
    expect(harness.textLayers[0]?.cancelled).toBe(true);
    await expect(textPaint).resolves.toBeNull();
    await expect(raster).resolves.toBeNull();
    await expect(thumbnail).resolves.toBe(true);
    expect(harness.destroy).toHaveBeenCalledTimes(1);
    await expect(session.renderPage(paintInput(textCanvas))).resolves.toBeNull();
    expect(harness.renders).toHaveLength(3);
  });

  it('recovers a canvas after a current same-canvas conflict', async () => {
    const session = await openSession();
    const canvas = document.createElement('canvas');
    harness.inUse.add(canvas);
    await expect(session.renderPage(paintInput(canvas))).rejects.toThrow('pdf-render');
    const retry = session.renderPage(paintInput(canvas));
    await openedRenders(1);
    harness.renders[0]?.finish();
    await expect(retry).resolves.toMatchObject({ scale: 1 });
  });

  it('cancels an in-flight page render before painting that canvas again', async () => {
    const session = await openSession();
    const canvas = document.createElement('canvas');
    const first = session.renderPage(paintInput(canvas, 1));
    await openedRenders(1);
    const second = session.renderPage(paintInput(canvas, 'width'));
    await openedRenders(2);
    expect(harness.renders[0]?.cancelled).toBe(true);
    expect(harness.inUse.has(canvas)).toBe(true);
    harness.renders[1]?.finish();
    await expect(first).resolves.toBeNull();
    const painted = await second;
    expect(painted).toMatchObject({ scale: 1.5, cssWidth: 450, cssHeight: 600 });
    expect(painted?.toViewport(12, 34)).toEqual({ x: 12, y: 34 });
    expect(harness.inUse.has(canvas)).toBe(false);
  });

  it('still fails the current page render, then lets the next one claim the canvas', async () => {
    const session = await openSession();
    const canvas = document.createElement('canvas');
    const failed = session.renderPage(paintInput(canvas));
    await openedRenders(1);
    harness.renders[0]?.fail(new Error('decode'));
    await expect(failed).rejects.toThrow('pdf-render');
    expect(harness.inUse.has(canvas)).toBe(true);
    const again = session.renderPage(paintInput(canvas));
    await openedRenders(2);
    expect(harness.renders[0]?.cancelled).toBe(true);
    harness.renders[1]?.finish();
    await expect(again).resolves.toMatchObject({ scale: 1 });
  });

  it('cancels an in-flight thumbnail instead of treating the replacement as missing', async () => {
    const session = await openSession();
    const canvas = document.createElement('canvas');
    const first = session.renderThumbnail(1, canvas, 96);
    await openedRenders(1);
    const second = session.renderThumbnail(1, canvas, 96);
    await openedRenders(2);
    expect(harness.renders[0]?.cancelled).toBe(true);
    harness.renders[1]?.finish();
    await expect(second).resolves.toBe(true);
    await expect(first).resolves.toBe(true);
    expect(harness.inUse.has(canvas)).toBe(false);
  });

  it('omits only the thumbnail render that is still current when it fails', async () => {
    const session = await openSession();
    const canvas = document.createElement('canvas');
    const failed = session.renderThumbnail(2, canvas, 96);
    await openedRenders(1);
    harness.renders[0]?.fail(new Error('decode'));
    await expect(failed).resolves.toBe(false);
    const again = session.renderThumbnail(2, canvas, 96);
    await openedRenders(2);
    expect(harness.renders[0]?.cancelled).toBe(true);
    harness.renders[1]?.finish();
    await expect(again).resolves.toBe(true);
  });

  it('paints two thumbnail canvases at once', async () => {
    const session = await openSession();
    const left = document.createElement('canvas');
    const right = document.createElement('canvas');
    const first = session.renderThumbnail(1, left, 96);
    const second = session.renderThumbnail(2, right, 96);
    await openedRenders(2);
    expect(harness.renders[0]?.cancelled).toBe(false);
    expect(harness.renders[1]?.cancelled).toBe(false);
    harness.renders[0]?.finish();
    harness.renders[1]?.finish();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });
});


describe('pdf page measurement', () => {
  it('measures rotated width-fit geometry without painting or cancelling active work', async () => {
    harness.controls.rotation = 90;
    const session = await openSession();
    const canvas = document.createElement('canvas');
    const paint = session.renderPage(paintInput(canvas, 'width'));
    await openedRenders(1);
    const canvasSize = [canvas.width, canvas.height, canvas.style.cssText];
    await expect(session.pageSize(2, 'width', 450)).resolves.toEqual({
      scale: 1.125, cssWidth: 450, cssHeight: 337.5,
    });
    expect(harness.getPage).toHaveBeenLastCalledWith(2);
    expect(harness.renders).toHaveLength(1);
    expect(harness.renders[0]?.cancelled).toBe(false);
    expect(harness.textLayers).toHaveLength(0);
    expect([canvas.width, canvas.height, canvas.style.cssText]).toEqual(canvasSize);
    expect(harness.cleanup).not.toHaveBeenCalled();
    harness.renders[0]?.finish();
    const painted = await paint;
    expect(painted).toMatchObject(await session.pageSize(1, 'width', 450));
    expect(painted?.toPdf(12, 34)).toEqual({ x: 12, y: 34 });
  });

  it.each([
    { zoom: 0.01, width: 300, scale: 0.1 },
    { zoom: 40, width: 300, scale: 16 },
    { zoom: Number.NaN, width: 300, scale: 1 },
    { zoom: -1, width: 300, scale: 1 },
    { zoom: 'width' as const, width: 0, scale: 0.1 },
    { zoom: 'width' as const, width: 100000, scale: 16 },
  ])('uses the painting scale limits for $zoom at width $width', async ({ zoom, width, scale }) => {
    const session = await openSession();
    const size = await session.pageSize(99, zoom, width);
    expect(size).toEqual({ scale, cssWidth: 300 * scale, cssHeight: 400 * scale });
    expect(harness.getPage).toHaveBeenLastCalledWith(3);
    expect(harness.renders).toHaveLength(0);
    const input = { ...paintInput(document.createElement('canvas'), zoom), containerWidth: width };
    const paint = session.renderPage(input);
    await openedRenders(1);
    harness.renders[0]?.finish();
    await expect(paint).resolves.toMatchObject(size);
    expect(input.textLayer.style.getPropertyValue('--total-scale-factor')).toBe(String(scale));
  });
});
