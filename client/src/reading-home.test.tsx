import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { ContinueBook, HomePayload, LibraryEdition, LibraryPage } from './api';
import { catalogs } from './i18n';

const t = catalogs.en.readingTab;
const admin = { user: { id: 1, username: 'ada', role: 'admin' }, libraries: [{ id: 1, name: 'Home', mode: 'managed' }] };
const reader = { ...admin, user: { id: 2, username: 'bea', role: 'reader' } };

const base: LibraryEdition = {
  id: 1, libraryId: 1, title: 'A Quiet Index', authors: ['Ada Lovelace'], language: 'en', formats: ['pdf'],
  hasCover: false, status: 'reading', rating: null, favorite: false,
};
const last: ContinueBook = {
  ...base, updatedAt: new Date().toISOString(), assetId: 7, progress: { fraction: 0.337, page: 212, pageCount: 629 },
};
const other: ContinueBook = {
  ...base, id: 2, title: '艺术与视知觉', formats: ['epub'], updatedAt: '2026-10-01T00:00:00.000Z', assetId: 9, progress: { fraction: 0.5, page: null, pageCount: null },
};
const wanted: LibraryEdition = { ...base, id: 3, title: 'The Waves', status: 'want' };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function install(home: HomePayload, want: LibraryEdition[] = [], me: typeof admin = admin) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(init?.method && init.method !== 'GET' ? `${init.method} ${url}` : url);
    if (url === '/api/setup') return json({ needed: false });
    if (url === '/api/me') return json(me);
    if (url === '/api/home') return json(home);
    if (/\/api\/editions\/\d+\/reading$/.test(url)) {
      return json({ edition: { id: 1, reading: { status: 'finished', rating: null, favorite: false, queued: false, shelves: [] } } });
    }
    if (/\/api\/editions\/\d+\/trash$/.test(url)) return json({ edition: { id: 1, title: 'A Quiet Index', trashedAt: 'now' } });
    if (url.startsWith('/api/library')) {
      const page: LibraryPage = { editions: want, total: want.length, limit: 12, offset: 0, languages: [], shelves: [], index: [] };
      return json(page);
    }
    return json({ error: 'not_found' }, 404);
  }));
  return calls;
}

beforeEach(() => window.history.pushState({}, '', '/'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Reading tab', () => {
  it('puts the last book first with its progress and a Continue that opens the reader', async () => {
    const calls = install({ continueReading: [last, other], recent: [], shelves: [] }, [wanted]);
    render(<App locale="en" />);
    const hero = (await screen.findByRole('heading', { name: 'A Quiet Index', level: 2 })).closest('section')!;
    expect(within(hero).getByText('34%').tagName).toBe('STRONG');
    expect(within(hero).getByText('p. 212 of 629')).toBeInTheDocument();
    expect(within(hero).getByRole('link', { name: `${t.continue}: A Quiet Index` })).toHaveAttribute('href', '/books/1/read/7');
    expect(within(hero).getByRole('link', { name: t.details })).toHaveAttribute('href', '/books/1');

    const also = screen.getByRole('region', { name: t.alsoReading });
    expect(within(also).getByRole('link', { name: /艺术与视知觉/ })).toHaveAttribute('href', '/books/2/read/9');
    expect(within(also).getByText('50% read')).toBeInTheDocument();
    const want = screen.getByRole('region', { name: catalogs.en.reading.want });
    expect(within(want).getByRole('link', { name: /The Waves/ })).toHaveAttribute('href', '/books/3');
    expect(calls).toContain('/api/library?status=want&limit=12&offset=0');

    // The Reading tab is current; the Library tab leads to the catalogue.
    expect(screen.getByRole('link', { name: catalogs.en.tabs.reading })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: catalogs.en.tabs.library })).toHaveAttribute('href', '/library');
  });

  it('shows Want to read as a shelf of book pages with a way into the library', async () => {
    install({ continueReading: [last], recent: [], shelves: [] }, [wanted]);
    render(<App locale="en" />);
    const shelf = await screen.findByRole('region', { name: catalogs.en.reading.want });
    expect(within(shelf).getByRole('link', { name: /The Waves/ })).toHaveAttribute('href', '/books/3');
    expect(within(shelf).getByRole('link', { name: t.seeLibrary })).toHaveAttribute('href', '/library');
    expect(screen.queryByRole('region', { name: t.alsoReading })).toBeNull();
  });

  it('invites to the library when nothing is in progress, and hides empty sections', async () => {
    install({ continueReading: [], recent: [], shelves: [] });
    render(<App locale="en" />);
    expect(await screen.findByText(t.empty)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t.browse })).toHaveAttribute('href', '/library');
    expect(screen.queryByRole('region', { name: t.alsoReading })).toBeNull();
    expect(screen.queryByRole('region', { name: catalogs.en.reading.want })).toBeNull();
  });

  it('shows progress in Chinese and leaves it out until a reader reports it', async () => {
    install({ continueReading: [{ ...last, progress: null, assetId: null }], recent: [], shelves: [] });
    render(<App locale="zh-Hans" />);
    const hero = (await screen.findByRole('heading', { name: 'A Quiet Index', level: 2 })).closest('section')!;
    expect(hero.querySelector('.progress-line')).toBeNull();
    // Without a known file, Continue opens the book page.
    expect(within(hero).getByRole('link', { name: `${catalogs['zh-Hans'].readingTab.continue}: A Quiet Index` })).toHaveAttribute('href', '/books/1');
  });
});

describe('account menu', () => {
  it('holds Settings, Backup and Trash for admins and only Sign out for readers', async () => {
    install({ continueReading: [], recent: [], shelves: [] });
    const view = render(<App locale="en" />);
    const button = await screen.findByRole('button', { name: `${catalogs.en.account.menu}: ada` });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    for (const [name, href] of [['Settings', '/settings'], ['Backup', '/backup'], ['Trash', '/trash']]) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
    }
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
    expect(button).toHaveFocus();
    view.unmount();

    install({ continueReading: [], recent: [], shelves: [] }, [], reader);
    render(<App locale="en" />);
    fireEvent.click(await screen.findByRole('button', { name: `${catalogs.en.account.menu}: bea` }));
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.getByRole('button', { name: catalogs.en.account.signOut })).toBeInTheDocument();
  });
});

describe('Reading tab book menu', () => {
  it('opens on the hero by right-click and ⋯, and sets a status', async () => {
    const calls = install({ continueReading: [{ ...last, readAssetId: 7, shelfIds: [] }], recent: [], shelves: [{ id: 4, name: 'Weekend', count: 0 }] }, [wanted]);
    render(<App locale="en" />);
    const hero = (await screen.findByRole('heading', { name: 'A Quiet Index', level: 2 })).closest('section')!;
    fireEvent.contextMenu(hero, { clientX: 100, clientY: 100 });
    const menu = screen.getByRole('menu', { name: 'A Quiet Index' });
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Weekend' })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: catalogs.en.reading.finished }));
    await waitFor(() => expect(calls).toContain('PATCH /api/editions/1/reading'));

    const more = within(hero).getByRole('button', { name: 'More actions for A Quiet Index' });
    fireEvent.click(more);
    expect(screen.getByRole('menu', { name: 'A Quiet Index' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(more).toHaveFocus();
  });

  it('opens on a Want to read book, and lets an admin move it to Trash with Undo', async () => {
    const calls = install({ continueReading: [last], recent: [], shelves: [] }, [wanted]);
    render(<App locale="en" />);
    const shelf = await screen.findByRole('region', { name: catalogs.en.reading.want });
    fireEvent.contextMenu(within(shelf).getByRole('link', { name: /The Waves/ }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'The Waves' })).getByRole('menuitem', { name: catalogs.en.trash.removeAction }));
    fireEvent.click(within(screen.getByRole('dialog', { name: catalogs.en.trash.removeTitle })).getByRole('button', { name: catalogs.en.trash.removeAction }));
    expect(await screen.findByText('Moved “The Waves” to Trash.')).toBeInTheDocument();
    expect(calls).toContain('POST /api/editions/3/trash');
  });

  it('gives readers no Trash action', async () => {
    install({ continueReading: [last], recent: [], shelves: [] }, [], reader);
    render(<App locale="en" />);
    const hero = (await screen.findByRole('heading', { name: 'A Quiet Index', level: 2 })).closest('section')!;
    fireEvent.contextMenu(hero);
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: catalogs.en.trash.removeAction })).toBeNull();
  });
});
