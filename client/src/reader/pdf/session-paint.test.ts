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
        inUse.delete(canvas);
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
        if (settled) return;
        settled = true;
        rejectPromise(new RenderingCancelledException('Rendering cancelled, page 1'));
      },
    };
    renders.push(handle);
    return task;
  }

  return { RenderingCancelledException, renders, inUse, startRender };
});

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  RenderingCancelledException: harness.RenderingCancelledException,
  TextLayer: class {
    cancel() {}
    render() {
      return Promise.resolve();
    }
  },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 3,
      getOutline: async () => null,
      getPage: async () => ({
        view: [0, 0, 300, 400],
        getViewport({ scale }: { scale: number }) {
          return {
            width: 300 * scale,
            height: 400 * scale,
            convertToPdfPoint: (x: number, y: number) => [x, y],
            convertToViewportPoint: (x: number, y: number) => [x, y],
          };
        },
        getTextContent: async () => ({ items: [] }),
        cleanup() {},
        render({ canvas }: { canvas: HTMLCanvasElement }) {
          return harness.startRender(canvas);
        },
      }),
    }),
    destroy: async () => {},
  }),
}));

const sessions: PdfSession[] = [];

beforeEach(() => {
  harness.renders.length = 0;
  harness.inUse.clear();
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
