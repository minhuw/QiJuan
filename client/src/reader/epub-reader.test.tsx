import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserRouter } from 'react-router';
import { catalogs } from '../i18n';
import { Shell } from '../shell';
import { EpubReader } from './epub-reader';
import { openEpubSession } from './epub/session';
import type { EpubSession } from './epub/types';

vi.mock('./epub/session', () => ({
  openEpubSession: vi.fn(),
}));

const savedCfi = 'epubcfi(/6/4!/4/1:0)';
const movedCfi = 'epubcfi(/6/10!/4/2:1)';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function install() {
  let relocated: (cfi: string) => void = () => {};
  const session = {
    facts: { language: 'zh-Hans', direction: 'ltr' as const },
    toc: [{ label: 'Chapter', href: 'chapter.xhtml', children: [] }],
    display: vi.fn(async () => {}),
    next: vi.fn(async () => {}),
    prev: vi.fn(async () => {}),
    setFlow: vi.fn(async () => {}),
    applyTypography: vi.fn(async () => {}),
    resize: vi.fn(),
    highlight: vi.fn(),
    underline: vi.fn(),
    removeMark: vi.fn(),
    onRelocated: vi.fn((listener: (cfi: string) => void) => {
      relocated = listener;
      return () => {};
    }),
    onSelected: vi.fn(() => () => {}),
    search: vi.fn(async () => [{ cfi: 'epubcfi(/6/8!/4/2:3)', excerpt: 'quiet' }]),
    destroy: vi.fn(),
  } satisfies EpubSession;
  vi.mocked(openEpubSession).mockResolvedValue(session);
  const puts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/file')) return new Response(new Uint8Array([1, 2, 3, 4]));
      if (url.endsWith('/reading-place') && (!init?.method || init.method === 'GET')) {
        return json({
          position: { locator: savedCfi, revision: 3, assetId: 9, updatedAt: '2026-01-01T00:00:00.000Z' },
          bookmarks: [],
          highlights: [],
          notes: [],
        });
      }
      if (url.endsWith('/reading-place') && init?.method === 'PUT') {
        const locator = (JSON.parse(String(init.body)) as { locator: string }).locator;
        puts.push(locator);
        return json({
          position: { locator, revision: puts.length, assetId: 9, updatedAt: '2026-01-01T00:00:00.000Z' },
        });
      }
      return json({ error: 'not_found' }, 404);
    }),
  );
  return {
    session,
    puts,
    emit(cfi: string) {
      relocated(cfi);
    },
  };
}

function renderReader(locale: string) {
  return render(
    <BrowserRouter>
      <Shell locale={locale}>
        <EpubReader editionId={3} assetId={9} title="The Tale" />
      </Shell>
    </BrowserRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('epub reader', () => {
  it('shows the chrome in both locales and asks the rendition for the saved cfi', async () => {
    const english = install();
    const view = renderReader('en');
    expect(await screen.findByRole('combobox', { name: catalogs.en.reader.fontSize })).toBeEnabled();
    expect(openEpubSession).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      expect.any(HTMLElement),
      expect.objectContaining({ initialCfi: savedCfi, flow: 'paginated' }),
    );
    const passed = vi.mocked(openEpubSession).mock.calls[0]?.[2];
    expect(passed?.initialCfi?.startsWith('epubcfi(')).toBe(true);
    expect(screen.getByRole('combobox', { name: catalogs.en.reader.font })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: catalogs.en.reader.lineHeight })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: catalogs.en.reader.margins })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: catalogs.en.reader.theme })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: catalogs.en.reader.paginated })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Chapter' })).toBeInTheDocument();
    expect(document.querySelector('.reader-stage')).toHaveAttribute('lang', 'zh-Hans');
    expect(document.querySelector('.reader-stage')).toHaveAttribute('dir', 'ltr');
    expect(document.querySelector('.reader-stage')?.getAttribute('style')).toContain('Noto Serif CJK SC');

    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.reader.fontSize }), { target: { value: '150%' } });
    await waitFor(() => {
      expect(english.session.applyTypography).toHaveBeenCalledWith(expect.objectContaining({ fontSize: '150%' }), savedCfi);
    });

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(english.session.next).toHaveBeenCalledTimes(1);
    expect(english.session.prev).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.scrolled }));
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(english.session.next).toHaveBeenCalledTimes(1);
    expect(english.session.setFlow).toHaveBeenCalledWith('continuous');

    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.search }));
    fireEvent.change(screen.getByRole('textbox', { name: catalogs.en.reader.search }), { target: { value: 'quiet' } });
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reader.searchSubmit }));
    expect(await screen.findByRole('button', { name: 'quiet' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'quiet' }));
    expect(english.session.display).toHaveBeenCalledWith('epubcfi(/6/8!/4/2:3)');

    view.unmount();
    install();
    renderReader('zh-Hans');
    expect(await screen.findByRole('button', { name: catalogs['zh-Hans'].reader.contents })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: catalogs['zh-Hans'].reader.backToBook })).toHaveAttribute('href', '/books/3');
    expect(screen.getByRole('link', { name: catalogs['zh-Hans'].reader.library })).toHaveAttribute('href', '/');
    expect(screen.getByRole('combobox', { name: catalogs['zh-Hans'].reader.theme })).toBeInTheDocument();
  });

  it('debounces relocation and still sends the last cfi when leaving', async () => {
    const { emit, puts } = install();
    const view = renderReader('en');
    expect(await screen.findByRole('combobox', { name: catalogs.en.reader.fontSize })).toBeEnabled();
    emit('epubcfi(/6/2!/4/1:0)');
    emit(movedCfi);
    expect(puts).toEqual([]);
    await waitFor(() => expect(puts).toEqual([movedCfi]));
    emit('epubcfi(/6/12!/4/1:0)');
    view.unmount();
    expect(puts).toEqual([movedCfi, 'epubcfi(/6/12!/4/1:0)']);
    for (const locator of puts) {
      expect(locator.startsWith('epubcfi(')).toBe(true);
      expect(locator.endsWith('%')).toBe(false);
    }
  });
});
