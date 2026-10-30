import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserRouter } from 'react-router';
import { catalogs } from '../i18n';
import { Shell } from '../shell';
import { parsePdfPlace } from './pdf/locator';
import { openPdfSession } from './pdf/session';
import type { PdfSession, RenderedPage } from './pdf/types';
import { PdfReader } from './pdf-reader';

vi.mock('./pdf/session', () => ({
  openPdfSession: vi.fn(),
}));

const saved = 'pdfpos(page=4;x=15;y=220;zoom=1.5)';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sessionFor(options?: {
  outline?: PdfSession['outline'];
  thumbnailPages?: number[];
  searchable?: boolean;
  hits?: PdfSession extends { search: (...args: never) => Promise<infer R> } ? R : never;
}): PdfSession {
  const outline = options?.outline ?? [{ title: 'Chapter', page: 2, x: 10, y: 350, children: [] }];
  const thumbnailPages = options?.thumbnailPages ?? [1, 2, 3, 4, 5, 6, 7, 8];
  const searchable = options?.searchable ?? true;
  return {
    pageCount: 8,
    outline,
    thumbnailPages,
    searchable: vi.fn(async () => searchable),
    pageBox: vi.fn(async () => ({ xMin: 0, yMin: 0, xMax: 300, yMax: 400 })),
    pageSize: vi.fn(async () => ({ scale: 1.5, cssWidth: 300, cssHeight: 400 })),
    releasePage: vi.fn(),
    renderPage: vi.fn(async () => ({
      scale: 1.5,
      cssWidth: 300,
      cssHeight: 400,
      toViewport: (x: number, y: number) => ({ x, y }),
      toPdf: (x: number, y: number) => ({ x, y }),
    })),
    renderThumbnail: vi.fn(async () => true),
    search: vi.fn(async () =>
      searchable
        ? { searchable: true, hits: [{ page: 2, x: 72, y: 300, excerpt: 'Hello QiJuan' }] }
        : { searchable: false, hits: [{ page: 1, x: 0, y: 0, excerpt: 'pretend' }] },
    ),
    destroy: vi.fn(async () => {}),
  };
}

function install(session: PdfSession) {
  vi.mocked(openPdfSession).mockResolvedValue(session);
  const puts: string[] = [];
  const posts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/file')) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      if (url.endsWith('/reading-place') && (!init?.method || init.method === 'GET')) {
        return json({
          position: { locator: saved, revision: 2, assetId: 10, updatedAt: '2026-01-01T00:00:00.000Z' },
          bookmarks: [],
          highlights: [],
          notes: [],
        });
      }
      if (url.endsWith('/reading-place') && init?.method === 'PUT') {
        const locator = (JSON.parse(String(init.body)) as { locator: string }).locator;
        puts.push(locator);
        return json({ position: { locator, revision: puts.length, assetId: 10, updatedAt: '2026-01-01T00:00:00.000Z' } });
      }
      if (url.endsWith('/bookmarks') && init?.method === 'POST') {
        const locator = (JSON.parse(String(init.body)) as { locator: string }).locator;
        posts.push(locator);
        return json({ bookmark: { id: 4, locator, label: null } }, 201);
      }
      return json({ error: 'not_found' }, 404);
    }),
  );
  return { puts, posts };
}

function renderReader(locale: string) {
  return render(
    <BrowserRouter>
      <Shell locale={locale}>
        <PdfReader editionId={3} assetId={10} title="Scan" />
      </Shell>
    </BrowserRouter>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.removeItem('qijuan.reader.flow');
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('pdf reader', () => {
  it('restores the saved page and shows outline and nearby thumbnails', async () => {
    const session = sessionFor();
    install(session);
    const view = renderReader('en');
    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.reader.outline }));
    expect(screen.getByRole('button', { name: 'Chapter' })).toBeInTheDocument();
    expect(openPdfSession).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    await waitFor(() => expect(session.renderPage).toHaveBeenCalledWith(expect.objectContaining({ page: 4, zoom: 1.5 })));
    expect(session.renderPage).toHaveBeenCalledTimes(1);
    const thumbs = document.querySelectorAll('.pdf-thumb canvas');
    expect(thumbs.length).toBeGreaterThan(0);
    expect(thumbs.length).toBeLessThan(8);
    expect(session.renderThumbnail).not.toHaveBeenCalledWith(1, expect.anything(), expect.anything());
    expect(session.renderThumbnail).not.toHaveBeenCalledWith(8, expect.anything(), expect.anything());
    expect(screen.getByRole('link', { name: catalogs.en.reader.library })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: catalogs.en.reader.backToBook })).toHaveAttribute('href', '/books/3');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(catalogs.en.reader.scanNoText)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.nextPage }));
    await waitFor(() => expect(session.renderPage).toHaveBeenCalledWith(expect.objectContaining({ page: 5, zoom: 1.5 })));
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.options }));
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.fitWidth }));
    await waitFor(() => expect(session.renderPage).toHaveBeenCalledWith(expect.objectContaining({ zoom: 'width' })));
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.zoomIn }));
    expect(session.renderPage).toHaveBeenCalledWith(expect.objectContaining({ zoom: expect.any(Number) }));

    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.search }));
    fireEvent.change(screen.getByRole('textbox', { name: catalogs.en.reader.search }), { target: { value: 'QiJuan' } });
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.searchSubmit }));
    expect(await screen.findByRole('button', { name: 'Hello QiJuan' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hello QiJuan' }));
    await waitFor(() => expect(session.pageBox).toHaveBeenCalledWith(2));

    view.unmount();
    const chinese = sessionFor();
    install(chinese);
    renderReader('zh-Hans');
    expect(await screen.findByRole('button', { name: catalogs['zh-Hans'].reader.outline })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: catalogs['zh-Hans'].reader.library })).toHaveAttribute('href', '/');
    fireEvent.click(screen.getByRole('button', { name: catalogs['zh-Hans'].reader.options }));
    expect(screen.getByRole('button', { name: catalogs['zh-Hans'].reader.fitWidth })).toBeInTheDocument();
  });

  it('starts with panels and advanced tools closed and dismisses options accessibly', async () => {
    const session = sessionFor();
    install(session);
    renderReader('en');
    await waitFor(() => expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false'));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chapter' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: catalogs.en.reader.page })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: catalogs.en.reader.zoomIn })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: catalogs.en.reader.thumbnails })).not.toBeInTheDocument();
    expect(session.renderThumbnail).not.toHaveBeenCalled();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const options = screen.getByRole('button', { name: catalogs.en.reader.options });
    expect(options).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(options);
    expect(screen.getByRole('textbox', { name: catalogs.en.reader.page })).toHaveValue('4');
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.zoomOut }));
    await waitFor(() => expect(session.renderPage).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: 1.25 })));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(options).toHaveFocus();
    fireEvent.click(options);
    fireEvent.pointerDown(document.querySelector('.pdf-stage')!);
    expect(options).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: catalogs.en.reader.previousPage }).closest('footer')).toHaveClass('reader-footer');
    expect(screen.getByRole('button', { name: catalogs.en.reader.nextPage }).closest('footer')).toHaveClass('reader-footer');
    expect(document.querySelector('.reader-footer .reader-page-indicator')).toHaveTextContent('4 / 8');
  });

  it('jumps pages and opens secondary panels from options, dismissing the popup', async () => {
    const session = sessionFor();
    install(session);
    renderReader('en');
    await waitFor(() => expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false'));
    const options = screen.getByRole('button', { name: catalogs.en.reader.options });
    fireEvent.click(options);
    const input = screen.getByRole('textbox', { name: catalogs.en.reader.page });
    fireEvent.change(input, { target: { value: '6' } });
    fireEvent.submit(input.closest('form')!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(options).toHaveFocus();
    await waitFor(() => expect(session.renderPage).toHaveBeenLastCalledWith(expect.objectContaining({ page: 6 })));
    for (const panel of ['bookmarks', 'thumbnails'] as const) {
      fireEvent.click(options);
      expect(screen.getAllByRole('button', { name: catalogs.en.reader[panel] })).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader[panel] }));
      expect(screen.getByRole('complementary', { name: catalogs.en.reader[panel] })).toHaveFocus();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.close }));
      expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
      expect(options).toHaveFocus();
    }
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.outline }));
    expect(screen.getByRole('button', { name: 'Chapter' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.outline }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('uses thumbnails as the only primary navigation action when there is no outline', async () => {
    install(sessionFor({ outline: [] }));
    renderReader('en');
    await waitFor(() => expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false'));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: catalogs.en.reader.outline })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.options }));
    expect(screen.getAllByRole('button', { name: catalogs.en.reader.thumbnails })).toHaveLength(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.thumbnails }));
    expect(screen.getByRole('complementary', { name: catalogs.en.reader.thumbnails })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Page 4' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.reader.mode }), { target: { value: 'continuous' } });
    expect(screen.getByRole('button', { name: catalogs.en.reader.previousPage })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: catalogs.en.reader.nextPage })).toBeInTheDocument();
  });

  it('scrolls within a PDF page, turns at its edges, and enters the previous page at the bottom', async () => {
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const session = sessionFor();
    const { puts } = install(session);
    const view = renderReader('en');
    try {
      const scroller = document.querySelector('.pdf-scroller') as HTMLDivElement;
      Object.defineProperties(scroller, {
        clientHeight: { value: 200 },
        scrollHeight: { value: 1000 },
      });
      await waitFor(() => expect(scroller.scrollTop).toBe(220));
      expect(fireEvent.wheel(scroller, { deltaY: 100 })).toBe(true);
      expect(session.renderPage).toHaveBeenCalledTimes(1);

      scroller.scrollTop = 800;
      expect(fireEvent.wheel(scroller, { deltaY: 100 })).toBe(false);
      await waitFor(() => expect(scroller.scrollTop).toBe(400));
      expect(session.renderPage).toHaveBeenLastCalledWith(expect.objectContaining({ page: 5 }));
      for (let i = 0; i < 8; i++) fireEvent.wheel(scroller, { deltaY: 100 });
      expect(session.renderPage).toHaveBeenCalledTimes(2);

      now += 200;
      scroller.scrollTop = 0;
      fireEvent.wheel(scroller, { deltaY: -100 });
      await waitFor(() => expect(session.renderPage).toHaveBeenLastCalledWith(expect.objectContaining({ page: 4 })));
      await waitFor(() => expect(scroller.scrollTop).toBe(200));
      view.unmount();
      await waitFor(() => expect(puts.at(-1)).toBe('pdfpos(page=4;x=0;y=200;zoom=1.5)'));
    } finally {
      clock.mockRestore();
    }
  });

  it('does not turn again while the requested PDF page is still painting', async () => {
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const session = sessionFor();
    const painted: RenderedPage = {
      scale: 1.5, cssWidth: 300, cssHeight: 400,
      toViewport: (x, y) => ({ x, y }),
      toPdf: (x, y) => ({ x, y }),
    };
    let finish!: (page: RenderedPage) => void;
    vi.mocked(session.renderPage).mockResolvedValueOnce(painted)
      .mockImplementationOnce(() => new Promise<RenderedPage>((resolve) => { finish = resolve; }));
    install(session);
    renderReader('en');
    try {
      const scroller = document.querySelector('.pdf-scroller') as HTMLDivElement;
      Object.defineProperties(scroller, {
        clientHeight: { value: 200 }, scrollHeight: { value: 1000 },
      });
      await waitFor(() => expect(scroller.scrollTop).toBe(220));
      await waitFor(() => expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false'));
      scroller.scrollTop = 800;
      fireEvent.wheel(scroller, { deltaY: 100 });
      await waitFor(() => expect(session.renderPage).toHaveBeenCalledTimes(2));
      expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'true');
      now += 200;
      fireEvent.wheel(scroller, { deltaY: 100 });
      expect(session.pageBox).not.toHaveBeenCalledWith(6);
      finish(painted);
      await waitFor(() => expect(scroller.scrollTop).toBe(400));
      expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false');
      now += 200;
      scroller.scrollTop = 800;
      fireEvent.wheel(scroller, { deltaY: 100 });
      await waitFor(() => expect(session.renderPage).toHaveBeenLastCalledWith(expect.objectContaining({ page: 6 })));
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps adjacent PDF pages mounted during continuous scrolling and preserves the visible place when changing mode', async () => {
    const session = sessionFor();
    const { puts } = install(session);
    const rendered = renderReader('en');
    const scroller = document.querySelector('.pdf-scroller') as HTMLDivElement;
    Object.defineProperties(scroller, { clientHeight: { value: 200 }, clientWidth: { value: 300 } });
    await waitFor(() => expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false'));
    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.reader.mode }), { target: { value: 'continuous' } });
    await waitFor(() => expect(document.querySelector('.pdf-page[data-page="5"][aria-busy="false"]')).toBeInTheDocument());
    expect(document.querySelector('.pdf-page[data-page="4"]')).toBeInTheDocument();
    scroller.scrollTop = 4 * 416 + 20;
    fireEvent.scroll(scroller);
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.options }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: catalogs.en.reader.page })).toHaveValue('5'));
    const streamPosition = scroller.scrollTop;
    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.reader.mode }), { target: { value: 'paginated' } });
    await waitFor(() => expect(document.querySelectorAll('.pdf-page')).toHaveLength(1));
    await waitFor(() => expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false'));
    expect(document.querySelector('.pdf-page[data-page="5"]')).toBeInTheDocument();
    expect(scroller.scrollTop).toBe(20);
    expect(streamPosition).toBeGreaterThan(scroller.scrollTop);
    rendered.unmount();
    await waitFor(() => expect(puts.at(-1)).toBe('pdfpos(page=5;x=0;y=20;zoom=1.5)'));
  });

  it('turns horizontally in Pages mode while continuous mode keeps horizontal input native', async () => {
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const session = sessionFor();
    install(session);
    renderReader('en');
    try {
      const scroller = document.querySelector('.pdf-scroller') as HTMLDivElement;
      Object.defineProperties(scroller, {
        clientHeight: { value: 200 }, clientWidth: { value: 300 }, scrollWidth: { value: 300 }, scrollHeight: { value: 1000 },
      });
      await waitFor(() => expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false'));
      expect(fireEvent.wheel(scroller, { deltaX: 100, deltaY: 0 })).toBe(false);
      await waitFor(() => expect(document.querySelector('.pdf-page[data-page="5"][aria-busy="false"]')).toBeInTheDocument());
      now += 200;
      fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.reader.mode }), { target: { value: 'continuous' } });
      await waitFor(() => expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false'));
      expect(fireEvent.wheel(scroller, { deltaX: 100, deltaY: 0 })).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('preserves an unpainted continuous-scroll destination when the viewport resizes', async () => {
    const observers: Array<{ callback: ResizeObserverCallback; root?: Element }> = [];
    vi.stubGlobal('ResizeObserver', class {
      entry: { callback: ResizeObserverCallback; root?: Element };
      constructor(callback: ResizeObserverCallback) { this.entry = { callback }; observers.push(this.entry); }
      observe(root: Element) { this.entry.root = root; }
      disconnect() {}
    });
    const session = sessionFor();
    const paint = session.renderPage;
    let finish!: (rendered: RenderedPage) => void;
    let waiting = false;
    session.renderPage = vi.fn((input) => {
      if (input.page === 7 && !waiting) {
        waiting = true;
        return new Promise<RenderedPage>((resolve) => { finish = resolve; });
      }
      return paint(input);
    });
    install(session);
    renderReader('en');
    let width = 300;
    const scroller = document.querySelector('.pdf-scroller') as HTMLDivElement;
    Object.defineProperties(scroller, { clientHeight: { value: 200 }, clientWidth: { get: () => width } });
    await waitFor(() => expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false'));
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.options }));
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.fitWidth }));
    await waitFor(() => expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false'));
    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.reader.mode }), { target: { value: 'continuous' } });
    await waitFor(() => expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false'));
    scroller.scrollTop = 6 * 416 + 30;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(waiting).toBe(true));
    width = 450;
    for (const observer of observers) {
      if (observer.root === scroller) observer.callback([], {} as ResizeObserver);
    }
    await waitFor(() => expect(screen.getByRole('textbox', { name: catalogs.en.reader.page })).toHaveValue('7'));
    expect(document.querySelector('.pdf-page[data-page="7"]')).toBeInTheDocument();
    expect(document.querySelector('.pdf-page[data-page="4"]')).not.toBeInTheDocument();
    finish({ scale: 1.5, cssWidth: 300, cssHeight: 400, toPdf: (x, y) => ({ x, y }), toViewport: (x, y) => ({ x, y }) });
  });

  it('discards a delayed backward turn after adopting newer server progress', async () => {
    const session = sessionFor();
    const box = session.pageBox;
    let finish!: (box: Awaited<ReturnType<PdfSession['pageBox']>>) => void;
    session.pageBox = vi.fn((page: number) => page === 3
      ? new Promise<Awaited<ReturnType<PdfSession['pageBox']>>>((resolve) => { finish = resolve; })
      : box(page));
    const { posts } = install(session);
    const fetchOriginal = globalThis.fetch;
    const puts: string[] = [];
    let gets = 0;
    let allowConflict!: () => void;
    const conflictResponse = new Promise<void>((resolve) => { allowConflict = resolve; });
    const newer = 'pdfpos(page=7;x=0;y=200;fit=width)';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/reading-place') && (!init?.method || init.method === 'GET')) {
        gets += 1;
        return json({ position: { locator: gets === 1 ? saved : newer, revision: gets === 1 ? 2 : 6, assetId: 10 }, bookmarks: [] });
      }
      if (url.endsWith('/reading-place') && init?.method === 'PUT') {
        puts.push((JSON.parse(String(init.body)) as { locator: string }).locator);
        await conflictResponse;
        return json({ error: 'conflict' }, 409);
      }
      return fetchOriginal(input, init);
    }));
    renderReader('en');
    const scroller = document.querySelector('.pdf-scroller') as HTMLDivElement;
    Object.defineProperties(scroller, { clientHeight: { value: 200 }, clientWidth: { value: 300 } });
    await waitFor(() => expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false'));
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.options }));
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.fitWidth }));
    await waitFor(() => expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false'));
    scroller.scrollTop = 0;
    fireEvent.wheel(scroller, { deltaY: -100 });
    await waitFor(() => expect(session.pageBox).toHaveBeenCalledWith(3));
    allowConflict();
    expect(await screen.findByText(catalogs.en.reader.newerKept)).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.pdf-page[data-page="7"][aria-busy="false"]')).toBeInTheDocument());
    finish({ xMin: 0, yMin: 0, xMax: 300, yMax: 400 });
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.bookmark }));
    await waitFor(() => expect(posts).toEqual([newer]));
    expect(document.querySelector('.pdf-page[data-page="3"]')).not.toBeInTheDocument();
    expect(puts).toHaveLength(1);
  });

  it('omits a missing outline and missing thumbnails without an error', async () => {
    const session = sessionFor({ outline: [], thumbnailPages: [] });
    install(session);
    renderReader('en');
    expect(await screen.findByRole('button', { name: catalogs.en.reader.search })).toBeEnabled();
    await waitFor(() => expect(session.renderPage).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: catalogs.en.reader.outline })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: catalogs.en.reader.thumbnails })).not.toBeInTheDocument();
    expect(document.querySelector('.pdf-thumb')).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says a scanned PDF is not searchable in both locales and does not invent hits', async () => {
    const session = sessionFor({ outline: [], thumbnailPages: [], searchable: false });
    install(session);
    const view = renderReader('en');
    expect(await screen.findByText(catalogs.en.reader.scanNoText)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.search }));
    fireEvent.change(screen.getByRole('textbox', { name: catalogs.en.reader.search }), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.searchSubmit }));
    await waitFor(() => expect(session.search).toHaveBeenCalledWith('Hello'));
    expect(screen.queryByRole('button', { name: 'pretend' })).not.toBeInTheDocument();
    expect(screen.queryByText(catalogs.en.reader.searchEmpty)).not.toBeInTheDocument();
    expect(screen.getAllByText(catalogs.en.reader.scanNoText).length).toBeGreaterThan(0);

    view.unmount();
    const again = sessionFor({ outline: [], thumbnailPages: [], searchable: false });
    install(again);
    renderReader('zh-Hans');
    expect(await screen.findByText(catalogs['zh-Hans'].reader.scanNoText)).toBeInTheDocument();
  });

  it('saves a page and offset, not a percentage, and flushes it when leaving', async () => {
    const session = sessionFor();
    const { puts, posts } = install(session);
    const view = renderReader('en');
    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.reader.outline }));
    expect(screen.getByRole('button', { name: 'Chapter' })).toBeInTheDocument();
    await waitFor(() => expect(session.renderPage).toHaveBeenCalled());
    expect(puts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.bookmark }));
    await waitFor(() => expect(posts).toEqual([saved]));
    const marked = parsePdfPlace(posts[0]);
    expect(marked).toMatchObject({ page: 4, x: 15, y: 220, zoom: 1.5 });
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.nextPage }));
    expect(puts).toEqual([]);
    await waitFor(() => expect(puts).toEqual(['pdfpos(page=5;x=0;y=400;zoom=1.5)']));
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.options }));
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.fitWidth }));
    view.unmount();
    await waitFor(() => expect(puts.at(-1)).toBe('pdfpos(page=5;x=0;y=400;fit=width)'));
    for (const locator of puts) {
      expect(locator.includes('%')).toBe(false);
      expect(parsePdfPlace(locator)?.page).toBe(5);
    }
  });

  it('drops a render error after a later page paints and ignores a superseded failure', async () => {
    const session = sessionFor();
    let rejectFirst: (error: Error) => void = () => {};
    let calls = 0;
    const painted = {
      scale: 1,
      cssWidth: 300,
      cssHeight: 400,
      toViewport: (x: number, y: number) => ({ x, y }),
      toPdf: (x: number, y: number) => ({ x, y }),
    };
    session.renderPage = vi.fn((): Promise<RenderedPage | null> => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve(painted);
    });
    install(session);
    renderReader('en');
    await waitFor(() => expect(session.renderPage).toHaveBeenCalledTimes(1));
    rejectFirst(new Error('pdf-render'));
    expect(await screen.findByRole('alert')).toHaveTextContent(catalogs.en.errors.internal);

    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.nextPage }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(session.renderPage).toHaveBeenCalledWith(expect.objectContaining({ page: 5 }));
  });

  it('does not hide thumbnails when an older thumbnail render fails', async () => {
    const session = sessionFor();
    const pending: Array<(ok: boolean) => void> = [];
    session.renderThumbnail = vi.fn(() => new Promise<boolean>((resolve) => pending.push(resolve)));
    install(session);
    renderReader('en');
    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.reader.outline }));
    await waitFor(() => expect(session.renderThumbnail).toHaveBeenCalled());
    const firstWave = pending.length;
    expect(firstWave).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.nextPage }));
    await waitFor(() => expect(pending.length).toBeGreaterThan(firstWave));
    for (let index = 0; index < firstWave; index += 1) pending[index]?.(false);
    for (let index = firstWave; index < pending.length; index += 1) pending[index]?.(true);
    await waitFor(() => {
      const canvases = document.querySelectorAll<HTMLCanvasElement>('.pdf-thumb canvas');
      expect(canvases.length).toBeGreaterThan(0);
      for (const canvas of canvases) expect(canvas.hidden).toBe(false);
    });
  });

  it.each([false, true])('keeps a newer pdf position instead of sending the stale page again (continuous=%s)', async (continuous) => {
    const session = sessionFor();
    vi.mocked(openPdfSession).mockResolvedValue(session);
    const puts: Array<{ locator: string; revision: number }> = [];
    let gets = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/file')) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
        if (url.endsWith('/reading-place') && (!init?.method || init.method === 'GET')) {
          gets += 1;
          if (gets > 1) {
            const scroller = document.querySelector('.pdf-scroller');
            if (scroller instanceof HTMLElement) {
              scroller.scrollTop = 80;
              scroller.dispatchEvent(new Event('scroll'));
            }
          }
          return json({
            position: { locator: saved, revision: gets === 1 ? 2 : 6, assetId: 10, updatedAt: '2026-01-01T00:00:00.000Z' },
            bookmarks: [],
            highlights: [],
            notes: [],
          });
        }
        if (url.endsWith('/reading-place') && init?.method === 'PUT') {
          puts.push(JSON.parse(String(init.body)) as { locator: string; revision: number });
          return json({ error: 'conflict', position: { locator: saved, revision: 6, assetId: 10, updatedAt: '2026-01-02T00:00:00.000Z' } }, 409);
        }
        return json({ error: 'not_found' }, 404);
      }),
    );
    renderReader('en');
    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.reader.outline }));
    expect(screen.getByRole('button', { name: 'Chapter' })).toBeInTheDocument();
    await waitFor(() => expect(session.renderPage).toHaveBeenCalled());
    if (continuous) {
      fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.reader.mode }), { target: { value: 'continuous' } });
      await waitFor(() => expect(document.querySelector('.pdf-stage')).toHaveAttribute('aria-busy', 'false'));
    }
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.nextPage }));
    await waitFor(() =>
      expect(puts).toEqual([expect.objectContaining({ locator: 'pdfpos(page=5;x=0;y=400;zoom=1.5)', revision: 2 })]),
    );
    expect(await screen.findByText(catalogs.en.reader.newerKept)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(puts).toHaveLength(1);
    expect(gets).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.nextPage }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toMatchObject({ locator: 'pdfpos(page=5;x=0;y=400;zoom=1.5)', revision: 6 });
  });
});
