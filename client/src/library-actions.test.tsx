import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { HomePayload, LibraryEdition, LibraryPage } from './api';
import { catalogs } from './i18n';

const en = catalogs.en;
const admin = { user: { id: 1, username: 'ada', role: 'admin' }, libraries: [{ id: 1, name: 'Home', mode: 'managed' }] };
const reader = { ...admin, user: { id: 2, username: 'bea', role: 'reader' } };

const book = (id: number, title: string, extra: Partial<LibraryEdition> = {}): LibraryEdition => ({
  id, libraryId: 1, title, authors: ['Ada'], language: 'en', formats: ['epub'], hasCover: false,
  status: null, rating: null, favorite: false, identified: true, readAssetId: id * 10, shelfIds: [], ...extra,
});
const books = [book(1, 'River'), book(2, 'Hill', { status: 'reading' }), book(3, 'Lake')];
const home: HomePayload = { continueReading: [], recent: [], shelves: [{ id: 7, name: 'Weekend', count: 0 }] };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

type Call = { method: string; url: string; body: unknown };

function install(me: typeof admin = admin) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (method !== 'GET') calls.push({ method, url, body });
    if (url === '/api/setup') return json({ needed: false });
    if (url === '/api/me') return json(me);
    if (url === '/api/home') return json(home);
    if (url === '/api/trash') return json({ editions: [], assets: [] });
    if (url === '/api/editions') return json({ editions: [] });
    if (url.startsWith('/api/library')) {
      const page: LibraryPage = { editions: books, total: 3, limit: 24, offset: 0, languages: ['en'], shelves: home.shelves, index: [] };
      return json(page);
    }
    const reading = /^\/api\/editions\/(\d+)\/reading$/.exec(url);
    if (reading && method === 'PATCH') {
      const b = body as { status?: string | null; favorite?: boolean };
      return json({ edition: { id: Number(reading[1]), reading: { status: b.status ?? null, rating: null, favorite: b.favorite ?? false, queued: false, shelves: [] } } });
    }
    const shelf = /^\/api\/shelves\/7\/items$/.exec(url);
    if (shelf && method === 'POST') {
      return json({ edition: { id: (body as { editionId: number }).editionId, reading: { status: null, rating: null, favorite: false, queued: false, shelves: [{ id: 7, name: 'Weekend', included: true }] } } });
    }
    if (/^\/api\/editions\/\d+\/trash$/.test(url)) return json({ edition: { id: 1, title: 'x', trashedAt: 'now' } });
    return json({ error: 'not_found' }, 404);
  }));
  return calls;
}

async function results() {
  return screen.findByRole('list', { name: en.library.results });
}

beforeEach(() => window.history.pushState({}, '', '/library'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('book menu', () => {
  it('opens on right-click with Open, Read, status, favourite and shelves, and sets a status', async () => {
    const calls = install();
    render(<App locale="en" />);
    const river = within(await results()).getByRole('link', { name: /River/ });
    fireEvent.contextMenu(river, { clientX: 120, clientY: 200 });
    const menu = screen.getByRole('menu', { name: 'River' });
    expect(within(menu).getByRole('menuitem', { name: en.library.menu.open })).toHaveAttribute('href', '/books/1');
    expect(within(menu).getByRole('menuitem', { name: en.library.menu.read })).toHaveAttribute('href', '/books/1/read/10');
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Weekend' })).toHaveAttribute('aria-checked', 'false');
    expect(within(menu).getByRole('menuitem', { name: en.trash.removeAction })).toBeInTheDocument();
    // Focus starts on the first item and the arrow keys move.
    expect(within(menu).getByRole('menuitem', { name: en.library.menu.open })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(within(menu).getByRole('menuitem', { name: en.library.menu.read })).toHaveFocus();

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: en.reading.want }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', url: '/api/editions/1/reading', body: { status: 'want' } }));
    expect(screen.queryByRole('menu')).toBeNull();
    // The card shows the new status without reloading the page.
    await waitFor(() => expect(river.querySelector('.status-mark')).not.toBeNull());
  });

  it('opens from the ⋯ button and the keyboard, closes with Escape, and adds to a shelf', async () => {
    const calls = install();
    render(<App locale="en" />);
    const list = await results();
    const more = within(list).getByRole('button', { name: 'More actions for Hill' });
    fireEvent.click(more);
    const menu = screen.getByRole('menu', { name: 'Hill' });
    expect(within(menu).getByRole('menuitemradio', { name: en.reading.reading })).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByRole('menuitem', { name: en.readingTab.continue })).toBeInTheDocument();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(more).toHaveFocus();

    fireEvent.keyDown(within(list).getByRole('link', { name: /Lake/ }), { key: 'F10', shiftKey: true });
    fireEvent.click(within(screen.getByRole('menu', { name: 'Lake' })).getByRole('menuitemcheckbox', { name: 'Weekend' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', url: '/api/shelves/7/items', body: { editionId: 3 } }));
  });

  it('confirms before moving a book to Trash and offers Undo', async () => {
    const calls = install();
    render(<App locale="en" />);
    fireEvent.contextMenu(within(await results()).getByRole('link', { name: /River/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: en.trash.removeAction }));
    const dialog = screen.getByRole('dialog', { name: en.trash.removeTitle });
    expect(calls).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: en.trash.removeAction }));
    expect(await screen.findByText('Moved “River” to Trash.')).toBeInTheDocument();
    expect(calls).toEqual([{ method: 'POST', url: '/api/editions/1/trash', body: null }]);
  });

  it('gives readers no edit or Trash actions', async () => {
    install(reader);
    render(<App locale="en" />);
    fireEvent.contextMenu(within(await results()).getByRole('link', { name: /River/ }));
    const menu = screen.getByRole('menu', { name: 'River' });
    expect(within(menu).queryByRole('menuitem', { name: en.trash.removeAction })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: en.library.menu.edit })).toBeNull();
  });
});

describe('selecting books', () => {
  it('selects with ⌘-click, Shift-click and the select box, then applies a status to all', async () => {
    const calls = install();
    render(<App locale="en" />);
    const list = await results();
    fireEvent.click(within(list).getByRole('link', { name: /River/ }), { metaKey: true });
    const bar = screen.getByRole('toolbar', { name: en.library.selection });
    expect(bar).toHaveTextContent('1 selected');
    fireEvent.click(within(list).getByRole('link', { name: /Lake/ }), { shiftKey: true });
    expect(bar).toHaveTextContent('3 selected');
    // While selecting, a plain click toggles instead of opening the book.
    fireEvent.click(within(list).getByRole('link', { name: /Hill/ }));
    expect(bar).toHaveTextContent('2 selected');
    expect(within(list).getByRole('checkbox', { name: 'Select Hill' })).toHaveAttribute('aria-checked', 'false');
    expect(window.location.pathname).toBe('/library');

    fireEvent.click(within(bar).getByRole('button', { name: en.library.status }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: en.reading.finished }));
    await waitFor(() =>
      expect(calls.filter((call) => call.method === 'PATCH').map((call) => call.url)).toEqual([
        '/api/editions/1/reading',
        '/api/editions/3/reading',
      ]),
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('toolbar', { name: en.library.selection })).toBeNull();
  });

  it('moves several books to Trash after one confirm', async () => {
    const calls = install();
    render(<App locale="en" />);
    const list = await results();
    fireEvent.click(within(list).getByRole('checkbox', { name: 'Select River' }));
    fireEvent.click(within(list).getByRole('checkbox', { name: 'Select Hill' }));
    fireEvent.click(within(screen.getByRole('toolbar', { name: en.library.selection })).getByRole('button', { name: en.trash.removeAction }));
    const dialog = screen.getByRole('dialog', { name: en.trash.removeTitle });
    expect(dialog).toHaveTextContent('Move 2 books to Trash?');
    fireEvent.click(within(dialog).getByRole('button', { name: en.trash.removeAction }));
    expect(await screen.findByText('Moved 2 books to Trash.')).toBeInTheDocument();
    expect(calls.map((call) => call.url)).toEqual(['/api/editions/1/trash', '/api/editions/2/trash']);
  });
});
