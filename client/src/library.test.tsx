import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { thumbBands } from './library';
import type { HomePayload, LibraryPage } from './api';
import { catalogs } from './i18n';

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const admin = {
  user: { id: 1, username: 'ada', role: 'admin' as const },
  libraries: [{ id: 1, name: 'Home', mode: 'managed' as const }],
};

const river = {
  id: 1,
  libraryId: 1,
  title: 'River',
  authors: ['Ada'],
  language: 'en',
  formats: ['epub' as const],
  hasCover: false,
  status: 'reading' as const,
  rating: null,
  favorite: false,
};

const hill = {
  id: 2,
  libraryId: 1,
  title: 'Hill',
  authors: ['Bea'],
  language: 'zh',
  formats: ['pdf' as const],
  hasCover: true,
  status: null,
  rating: 4,
  favorite: true,
};

const home: HomePayload = {
  continueReading: [{ ...river, updatedAt: '2026-01-02T00:00:00.000Z' }],
  recent: [hill],
  shelves: [{ id: 3, name: 'Weekend', count: 1 }],
};

const library: LibraryPage = {
  editions: [river, hill],
  total: 2,
  limit: 24,
  offset: 0,
  languages: ['en', 'zh'],
  shelves: [{ id: 3, name: 'Weekend', count: 1 }],
};

const emptyHome: HomePayload = { continueReading: [], recent: [], shelves: [] };
const emptyLibrary: LibraryPage = {
  editions: [],
  total: 0,
  limit: 24,
  offset: 0,
  languages: [],
  shelves: [],
};

function installFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      const handled = handler(url, init);
      return handled instanceof Promise ? handled : Promise.resolve(handled);
    }),
  );
  return calls;
}

function route(url: string, homeBody: HomePayload, libraryBody: LibraryPage, fail = false): Response {
  if (url === '/api/setup') return json({ needed: false });
  if (url === '/api/me') return json(admin);
  if (url === '/api/editions') return json({ editions: [] });
  if (url === '/api/home') return fail ? json({ error: 'internal' }, 500) : json(homeBody);
  if (url.startsWith('/api/library')) return fail ? json({ error: 'internal' }, 500) : json(libraryBody);
  return json({ error: 'not_found' }, 404);
}

describe('library browser', () => {
  it('shows loading, then empty, error, and retry states', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installFetch(async (url) => {
      await gate;
      return route(url, emptyHome, emptyLibrary);
    });
    render(<App locale="en" />);
    expect(screen.getAllByRole('status').some((item) => item.textContent === catalogs.en.status.loading)).toBe(true);
    release?.();
    expect(await screen.findByRole('heading', { name: catalogs.en.library.continue })).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.library.continueEmpty)).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.library.recentEmpty)).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.library.shelvesEmpty)).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.library.empty)).toBeInTheDocument();

    cleanup();
    let fail = true;
    installFetch((url) => route(url, emptyHome, emptyLibrary, fail));
    render(<App locale="en" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(catalogs.en.errors.internal);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.status.retry }));
    expect(await screen.findByRole('heading', { name: catalogs.en.library.continue })).toBeInTheDocument();
  });

  it('keeps cover ratio, uses one query for both views, and focuses search with slash', async () => {
    const calls = installFetch((url) => route(url, home, library));
    render(<App locale="en" />);
    expect(await screen.findByRole('heading', { name: catalogs.en.library.continue })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: catalogs.en.library.recent })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: catalogs.en.library.shelves })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Weekend' })).toBeInTheDocument();

    const results = screen.getByRole('list', { name: catalogs.en.library.results });
    const riverCard = within(results).getByRole('link', { name: /River/ });
    expect(riverCard.querySelector('img')).toBeNull();
    expect(riverCard.querySelector('.cover-fallback')).not.toBeNull();
    expect(riverCard).toHaveTextContent('Ada');
    const hillCard = within(results).getByRole('link', { name: /Hill/ });
    expect(hillCard.querySelector('img')).toHaveAttribute('src', '/api/editions/2/cover');
    expect(hillCard.querySelector('img')).toHaveClass('cover-image');
    expect(hillCard.querySelector('.cover-fallback')).toBeNull();

    const before = calls.filter((url) => url.startsWith('/api/library')).length;
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.library.list }));
    const list = screen.getByRole('list', { name: catalogs.en.library.results });
    expect(within(list).getByRole('link', { name: 'River' })).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Hill' })).toBeInTheDocument();
    expect(calls.filter((url) => url.startsWith('/api/library')).length).toBe(before);

    const search = screen.getByLabelText(catalogs.en.library.search);
    search.blur();
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(search);
    expect(search).toHaveValue('');

    fireEvent.change(screen.getByLabelText(catalogs.en.library.language), { target: { value: 'zh' } });
    fireEvent.change(screen.getByLabelText(catalogs.en.library.format), { target: { value: 'epub' } });
    fireEvent.change(screen.getByLabelText(catalogs.en.library.status), { target: { value: 'reading' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weekend' }));
    await waitFor(() => {
      const latest = calls.filter((url) => url.startsWith('/api/library')).at(-1) ?? '';
      expect(latest).toContain('language=zh');
      expect(latest).toContain('format=epub');
      expect(latest).toContain('status=reading');
      expect(latest).toContain('shelfId=3');
      expect(latest).toContain('limit=24');
    });

    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.shell.language }), {
      target: { value: 'zh-Hans' },
    });
    expect(screen.getByRole('heading', { name: catalogs['zh-Hans'].library.continue })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: catalogs['zh-Hans'].library.grid })).toBeInTheDocument();
    expect(screen.getAllByText('River').length).toBeGreaterThan(0);
  });

  it('filters by identifier and marks Unidentified books quietly in both views', async () => {
    const unidentified = { ...hill, identified: false };
    const identified = { ...river, identified: true };
    const calls = installFetch((url) =>
      url.startsWith('/api/library')
        ? json({ ...library, editions: [identified, unidentified] })
        : route(url, emptyHome, library),
    );
    render(<App locale="en" />);
    const results = await screen.findByRole('list', { name: catalogs.en.library.results });
    // Grid: a mark under the caption of the Unidentified book only.
    expect(within(within(results).getByRole('link', { name: /Hill/ })).getByText(catalogs.en.library.unidentified)).toBeInTheDocument();
    expect(within(within(results).getByRole('link', { name: /River/ })).queryByText(catalogs.en.library.unidentified)).toBeNull();
    expect(calls.filter((url) => url.startsWith('/api/library')).at(-1)).not.toContain('identified=');

    const filter = screen.getByLabelText(catalogs.en.library.identifier);
    expect(within(filter).getAllByRole('option').map((option) => option.textContent)).toEqual([
      catalogs.en.library.identifierAny,
      catalogs.en.library.identified,
      catalogs.en.library.unidentified,
    ]);
    fireEvent.change(filter, { target: { value: '0' } });
    await waitFor(() => expect(calls.filter((url) => url.startsWith('/api/library')).at(-1)).toContain('identified=0'));
    fireEvent.change(filter, { target: { value: '1' } });
    await waitFor(() => expect(calls.filter((url) => url.startsWith('/api/library')).at(-1)).toContain('identified=1'));

    // List: the same status-mark form, in the status column.
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.library.list }));
    const rows = screen.getByRole('list', { name: catalogs.en.library.results });
    const hillRow = within(rows).getByRole('link', { name: 'Hill' }).closest('li')!;
    expect(hillRow.querySelector('.status-mark-unidentified')).toHaveTextContent(catalogs.en.library.unidentified);
    expect(within(rows).getByRole('link', { name: 'River' }).closest('li')!.querySelector('.status-mark-unidentified')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: catalogs.en.library.clearFilters }));
    await waitFor(() => expect(calls.filter((url) => url.startsWith('/api/library')).at(-1)).not.toContain('identified='));
    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.shell.language }), { target: { value: 'zh-Hans' } });
    expect(screen.getByLabelText(catalogs['zh-Hans'].library.identifier)).toBeInTheDocument();
    expect(screen.getByText(catalogs['zh-Hans'].identifiers.unidentified, { selector: '.status-mark-label' })).toBeInTheDocument();
  });

  it('uses the focus ring tokens and 44px targets without stretching covers', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(path.join(dir, 'styles/app.css'), 'utf8');
    const tokens = readFileSync(path.join(dir, 'styles/tokens.css'), 'utf8');
    expect(tokens).toContain(':focus-visible');
    expect(css).toContain('min-height: 2.75rem');
    expect(css).toMatch(/\.cover-image\s*\{[^}]*height:\s*auto;[^}]*object-fit:\s*contain;/s);
    expect(css).not.toMatch(/\.cover-image\s*\{[^}]*object-fit:\s*(?:cover|fill)/s);
    expect(css).toContain('.cover-fallback');
    expect(css).toMatch(/\.cover-fallback\s*\{[^}]*font-family:\s*var\(--font-serif\)/s);
  });

  it('folds recurring index runs into one band per initial, with CJK as a single band', () => {
    const bands = thumbBands(
      [
        { key: '#', offset: 0, count: 1 },
        { key: 'A', offset: 1, count: 30 },
        { key: 'W', offset: 31, count: 2 },
        { key: 'A', offset: 33, count: 1 },
        { key: 'cjk', offset: 34, count: 20 },
      ],
      24,
      24,
    );
    expect(bands.map((band) => band.key)).toEqual(['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'cjk']);
    const byKey = new Map(bands.map((band) => [band.key, band]));
    expect(byKey.get('A')).toEqual({ key: 'A', target: 1, inView: true, current: true });
    expect(byKey.get('W')).toMatchObject({ target: 31, inView: true, current: false });
    expect(byKey.get('cjk')).toMatchObject({ target: 34, inView: true, current: false });
    expect(byKey.get('#')).toMatchObject({ target: 0, inView: false, current: false });
    expect(byKey.get('B')).toEqual({ key: 'B', target: null, inView: false, current: false });
  });

  it('renders the thumb index as letter bands that jump to the page holding their first book', async () => {
    const indexed: LibraryPage = {
      ...library,
      total: 60,
      index: [
        { key: '#', offset: 0, count: 2 },
        { key: 'A', offset: 2, count: 30 },
        { key: 'R', offset: 32, count: 10 },
        { key: 'cjk', offset: 42, count: 18 },
      ],
    };
    const calls = installFetch((url) => route(url, home, indexed));
    render(<App locale="en" />);
    const nav = await screen.findByRole('navigation', { name: catalogs.en.library.thumbIndex });
    const other = within(nav).getByRole('button', { name: catalogs.en.library.indexOther });
    expect(other).toHaveAttribute('aria-current', 'location');
    expect(other).toHaveClass('thumb-tab-current', 'thumb-tab-in');
    expect(within(nav).getByRole('button', { name: 'A' })).not.toHaveAttribute('aria-current');
    expect(within(nav).getByRole('button', { name: 'B' })).toBeDisabled();
    expect(within(nav).getByRole('button', { name: 'Z' })).toBeDisabled();
    const cjk = within(nav).getByRole('button', { name: catalogs.en.library.indexCjk });
    expect(cjk).toBeEnabled();
    expect(within(nav).getAllByRole('button').at(-1)).toBe(cjk);

    fireEvent.click(within(nav).getByRole('button', { name: 'R' }));
    await waitFor(() => {
      expect(calls.filter((url) => url.startsWith('/api/library')).at(-1)).toContain('offset=24');
    });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: catalogs.en.library.catalogue }));
    fireEvent.click(within(nav).getByRole('button', { name: 'B' }));
    expect(calls.filter((url) => url.startsWith('/api/library')).at(-1)).toContain('offset=24');

    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.shell.language }), {
      target: { value: 'zh-Hans' },
    });
    expect(
      within(screen.getByRole('navigation', { name: catalogs['zh-Hans'].library.thumbIndex })).getByRole('button', {
        name: catalogs['zh-Hans'].library.indexCjk,
      }),
    ).toBeEnabled();
  });

  it('omits the thumb index when the server sends no index', async () => {
    installFetch((url) => route(url, home, library));
    render(<App locale="en" />);
    expect(await screen.findByRole('heading', { name: catalogs.en.library.catalogue })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: catalogs.en.library.thumbIndex })).not.toBeInTheDocument();
  });
});
