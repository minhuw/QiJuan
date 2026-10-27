import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
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
});
