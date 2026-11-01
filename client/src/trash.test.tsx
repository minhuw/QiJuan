import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { EditionDetail, HomePayload, LibraryPage, TrashListing } from './api';
import { catalogs } from './i18n';

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Strings = Record<string, string>;
const en = catalogs.en!.trash as unknown as Strings;
const zh = catalogs['zh-Hans']!.trash as unknown as Strings;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const admin = {
  user: { id: 1, username: 'ada', role: 'admin' as const },
  libraries: [{ id: 1, name: 'Home', mode: 'managed' as const }],
};
const reader = { ...admin, user: { id: 2, username: 'bea', role: 'reader' as const } };

const asset = (id: number, format: 'epub' | 'pdf') => ({
  id,
  format,
  originalFilename: `tale.${format}`,
  displayFilename: `Lin Qi - The Tale.${format}`,
  bytes: 100,
  availability: 'present' as const,
});

const edition: EditionDetail = {
  id: 3,
  libraryId: 1,
  title: 'The Tale',
  sortTitle: 'The Tale',
  language: 'en',
  publisher: null,
  publishedDate: null,
  description: null,
  series: null,
  seriesOrder: null,
  alternateTitles: [],
  authors: ['Lin Qi'],
  translators: [],
  tags: [],
  identifiers: [],
  locks: [],
  metadataPrivate: false,
  cover: null,
  assets: [asset(9, 'epub'), asset(10, 'pdf')],
  suggestions: [],
};

const emptyHome: HomePayload = { continueReading: [], recent: [], shelves: [] };
const emptyLibrary: LibraryPage = { editions: [], total: 0, limit: 24, offset: 0, languages: [], shelves: [], index: [] };

const trash: TrashListing = {
  editions: [
    {
      id: 5,
      libraryId: 1,
      title: 'Gone Book',
      authors: ['Ada'],
      hasCover: false,
      trashedAt: '2026-10-30T10:00:00.000Z',
      files: [
        { id: 20, format: 'epub', storage: 'managed', originalFilename: 'raw-gone.epub', displayFilename: 'gone.epub', bytes: 10 },
        { id: 21, format: 'pdf', storage: 'indexed', originalFilename: 'raw-gone.pdf', displayFilename: 'gone.pdf', bytes: 10 },
      ],
    },
  ],
  assets: [
    {
      id: 30,
      format: 'pdf',
      storage: 'managed',
      originalFilename: 'raw-extra.pdf',
      displayFilename: 'extra.pdf',
      bytes: 10,
      editionId: 3,
      editionTitle: 'The Tale',
      trashedAt: '2026-10-31T10:00:00.000Z',
    },
  ],
};

type Handler = (url: string, init?: RequestInit) => Response | null;

function installFetch(me: typeof admin | typeof reader, extra?: Handler) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const handled = extra?.(url, init);
    if (handled) return Promise.resolve(handled);
    if (url === '/api/setup') return Promise.resolve(json({ needed: false }));
    if (url === '/api/me') return Promise.resolve(json(me));
    if (url === '/api/editions/3') return Promise.resolve(json({ edition }));
    if (url === '/api/home') return Promise.resolve(json(emptyHome));
    if (url.startsWith('/api/library?')) return Promise.resolve(json(emptyLibrary));
    if (url === '/api/editions') return Promise.resolve(json({ editions: [] }));
    if (url === '/api/trash') return Promise.resolve(json(trash));
    return Promise.resolve(json({ error: 'not_found' }, 404));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function calls(fetchMock: ReturnType<typeof installFetch>, method: string) {
  return fetchMock.mock.calls
    .filter(([, init]) => (init?.method ?? 'GET') === method)
    .map(([input]) => String(input));
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

describe('removing books', () => {
  it('removes a book after a confirm, then Undo on the library restores it', async () => {
    const fetchMock = installFetch(admin, (url, init) => {
      if (url === '/api/editions/3/trash' && init?.method === 'POST') {
        return json({ edition: { id: 3, title: 'The Tale', trashedAt: '2026-11-01T00:00:00.000Z' } });
      }
      if (url === '/api/editions/3/restore' && init?.method === 'POST') return json({ edition });
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    fireEvent.click(await screen.findByRole('tab', { name: catalogs.en!.book.detailsTitle as string }));
    const trigger = screen.getByRole('button', { name: en.removeBook });
    expect(trigger).toHaveClass('link-button-danger');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(trigger);
    const confirm = screen.getByRole('dialog', {
      name: en.removeTitle,
      description: fill(en.removeConfirm, { title: 'The Tale' }),
    });
    expect(confirm).toHaveAttribute('open');
    // The safe choice has focus first.
    expect(within(confirm).getByRole('button', { name: en.cancel })).toHaveFocus();
    expect(calls(fetchMock, 'POST')).toEqual([]);

    // Cancel closes it without a request, and focus goes back to the trigger.
    fireEvent.click(within(confirm).getByRole('button', { name: en.cancel }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();

    // So does Escape, which the dialog reports as `cancel`.
    fireEvent.click(trigger);
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();

    // A reversible action also closes on a press on the backdrop (the dialog element itself).
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.removeAction }));
    const notice = await screen.findByText(fill(en.moved, { title: 'The Tale' }));
    expect(window.location.pathname).toBe('/');
    expect(calls(fetchMock, 'POST')).toEqual(['/api/editions/3/trash']);
    // The Trash link counts what is in trash.
    expect(await screen.findByRole('link', { name: `${en.link} · 2` })).toHaveAttribute('href', '/trash');

    fireEvent.click(within(notice.closest('.removal-notice') as HTMLElement).getByRole('button', { name: en.undo }));
    expect(await screen.findByText(fill(en.restored, { title: 'The Tale' }))).toBeInTheDocument();
    expect(calls(fetchMock, 'POST')).toEqual(['/api/editions/3/trash', '/api/editions/3/restore']);
    expect(screen.getByRole('link', { name: en.open })).toHaveAttribute('href', '/books/3');
  });

  it('removes one file only when the book has more than one', async () => {
    let current = edition;
    const fetchMock = installFetch(admin, (url, init) => {
      if (url === '/api/editions/3') return json({ edition: current });
      if (url === '/api/editions/3/assets/10/trash' && init?.method === 'POST') {
        current = { ...edition, assets: [asset(9, 'epub')] };
        return json({ edition: current });
      }
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    fireEvent.click(await screen.findByRole('tab', { name: catalogs.en!.book.filesExports as string }));
    const removes = screen.getAllByRole('button', { name: new RegExp(`^${en.removeFile}`) });
    expect(removes).toHaveLength(2);
    fireEvent.click(removes[1]!);
    const confirm = screen.getByRole('dialog', {
      name: en.removeFileTitle,
      description: fill(en.removeFileConfirm, { name: 'Lin Qi - The Tale.pdf' }),
    });
    fireEvent.click(within(confirm).getByRole('button', { name: en.removeFile }));
    await waitFor(() => expect(calls(fetchMock, 'POST')).toEqual(['/api/editions/3/assets/10/trash']));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // With one file left there is nothing to remove.
    await waitFor(() => expect(screen.queryByRole('button', { name: new RegExp(`^${en.removeFile}`) })).toBeNull());
  });

  it('shows the server refusing the last file', async () => {
    installFetch(admin, (url, init) => {
      if (url === '/api/editions/3/assets/9/trash' && init?.method === 'POST') return json({ error: 'last_asset' }, 409);
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    fireEvent.click(await screen.findByRole('tab', { name: catalogs.en!.book.filesExports as string }));
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(`^${en.removeFile}`) })[0]!);
    const confirm = screen.getByRole('dialog', { name: en.removeFileTitle });
    fireEvent.click(within(confirm).getByRole('button', { name: en.removeFile }));
    const errors = (catalogs.en!.trash as { errors: Record<string, string> }).errors;
    // The refusal shows inside the dialog, which stays open.
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(errors.last_asset!);
    expect(confirm).toHaveAttribute('open');
  });
});

describe('trash screen', () => {
  it('lists removed books and files, restores, and deletes after a confirm', async () => {
    let listing = trash;
    const fetchMock = installFetch(admin, (url, init) => {
      if (url === '/api/trash') return json(listing);
      if (url === '/api/editions/5/restore' && init?.method === 'POST') {
        listing = { ...trash, editions: [] };
        return json({ edition: { ...edition, id: 5 } });
      }
      if (url === '/api/editions/3/assets/30' && init?.method === 'DELETE') {
        listing = { editions: [], assets: [] };
        return json({ deleted: true });
      }
      return null;
    });
    window.history.pushState({}, '', '/trash');
    render(<App locale="en" />);
    expect(await screen.findByRole('heading', { name: en.title, level: 1 })).toBeInTheDocument();
    const books = await screen.findByRole('region', { name: en.books });
    expect(within(books).getByText('Gone Book', { selector: '.trash-title' })).toBeInTheDocument();
    expect(within(books).getByText('Ada', { selector: '.trash-byline' })).toBeInTheDocument();
    expect(within(books).getByText('gone.epub').parentElement).toHaveTextContent(en.uploaded);
    expect(within(books).getByText('gone.pdf').parentElement).toHaveTextContent(en.folder);
    expect(within(books).getByText(/^Removed /, { selector: 'time' })).toHaveAttribute('datetime', '2026-10-30T10:00:00.000Z');
    const files = screen.getByRole('region', { name: en.files });
    expect(within(files).getByText('extra.pdf')).toBeInTheDocument();
    expect(within(files).getByRole('link', { name: 'The Tale' })).toHaveAttribute('href', '/books/3');

    // Delete permanently asks first and says folder files stay on disk.
    const deleteBook = within(books).getByRole('button', { name: `${en.deleteForever}: Gone Book` });
    fireEvent.click(deleteBook);
    const confirm = screen.getByRole('dialog', {
      name: en.deleteTitle,
      description: fill(en.deleteBookConfirm, { title: 'Gone Book' }),
    });
    expect(confirm).toHaveTextContent('stay on disk');
    // A permanent delete ignores the backdrop; only its buttons or Escape close it.
    fireEvent.click(confirm);
    expect(screen.getByRole('dialog')).toBe(confirm);
    fireEvent.click(within(confirm).getByRole('button', { name: en.cancel }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deleteBook).toHaveFocus();
    expect(calls(fetchMock, 'DELETE')).toEqual([]);

    fireEvent.click(within(books).getByRole('button', { name: `${en.restore}: Gone Book` }));
    expect(await screen.findByText(fill(en.restored, { title: 'Gone Book' }))).toBeInTheDocument();
    expect(calls(fetchMock, 'POST')).toEqual(['/api/editions/5/restore']);
    await waitFor(() => expect(screen.queryByRole('region', { name: en.books })).toBeNull());

    const fileRegion = screen.getByRole('region', { name: en.files });
    fireEvent.click(within(fileRegion).getByRole('button', { name: `${en.deleteForever}: extra.pdf` }));
    const fileConfirm = screen.getByRole('dialog', {
      name: en.deleteTitle,
      description: fill(en.deleteFileConfirm, { name: 'extra.pdf' }),
    });
    fireEvent.click(within(fileConfirm).getByRole('button', { name: en.deleteForever }));
    expect(await screen.findByText(en.empty)).toBeInTheDocument();
    expect(calls(fetchMock, 'DELETE')).toEqual(['/api/editions/3/assets/30']);
  });

  it('hides the Trash link when trash is empty', async () => {
    installFetch(admin, (url) => (url === '/api/trash' ? json({ editions: [], assets: [] }) : null));
    render(<App locale="en" />);
    expect(await screen.findByRole('heading', { name: catalogs.en!.home.title as string })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(catalogs.en!.library.catalogue as string)).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: new RegExp(`^${en.link}`) })).toBeNull();
  });
});

describe('readers', () => {
  it('see no removal, no file removal, no Trash link and no Trash screen', async () => {
    const fetchMock = installFetch(reader);
    window.history.pushState({}, '', '/books/3');
    const { unmount } = render(<App locale="en" />);
    fireEvent.click(await screen.findByRole('tab', { name: catalogs.en!.book.detailsTitle as string }));
    expect(screen.queryByRole('button', { name: en.removeBook })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: catalogs.en!.book.filesExports as string }));
    expect(screen.queryByRole('button', { name: new RegExp(`^${en.removeFile}`) })).toBeNull();
    unmount();

    window.history.pushState({}, '', '/trash');
    render(<App locale="en" />);
    expect(await screen.findByRole('heading', { name: catalogs.en!.home.title as string })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByRole('link', { name: new RegExp(`^${en.link}`) })).toBeNull();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain('/api/trash');
  });
});

describe('zh-Hans', () => {
  it('names the actions and the Trash link in Chinese', async () => {
    installFetch(admin);
    window.history.pushState({}, '', '/books/3');
    const { unmount } = render(<App locale="zh-Hans" />);
    fireEvent.click(await screen.findByRole('tab', { name: catalogs['zh-Hans']!.book.detailsTitle as string }));
    fireEvent.click(screen.getByRole('button', { name: '从书库移除' }));
    expect(screen.getByRole('dialog', { name: zh.removeTitle, description: /^把《The Tale》移到回收站？/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: zh.removeAction })).toBeInTheDocument();
    unmount();

    window.history.pushState({}, '', '/');
    const second = render(<App locale="zh-Hans" />);
    expect(await screen.findByRole('link', { name: '回收站 · 2' })).toHaveAttribute('href', '/trash');
    second.unmount();

    window.history.pushState({}, '', '/trash');
    render(<App locale="zh-Hans" />);
    expect(await screen.findByRole('heading', { name: '回收站', level: 1 })).toBeInTheDocument();
    expect((await screen.findAllByText(zh.folder)).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^永久删除/ }).length).toBe(2);
  });
});
