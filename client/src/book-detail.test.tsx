import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { EditionDetail, MetadataPreview } from './api';
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

const edition: EditionDetail = {
  id: 3,
  libraryId: 1,
  title: 'The Tale',
  sortTitle: 'The Tale',
  language: 'en',
  publisher: 'Home Press',
  publishedDate: '2020',
  description: 'A short book.',
  series: { id: 1, name: 'Letters' },
  seriesOrder: 1,
  alternateTitles: [{ title: 'Story', sortTitle: null }],
  authors: ['Lin Qi'],
  translators: ['Wang'],
  tags: ['essay'],
  identifiers: [{ scheme: 'isbn', value: '9780000000002' }],
  locks: ['title'],
  cover: null,
  assets: [
    { id: 9, format: 'epub', originalFilename: 'tale.epub', bytes: 120, availability: 'present' },
    { id: 10, format: 'pdf', originalFilename: 'tale.pdf', bytes: 80, availability: 'present' },
  ],
  suggestions: [{ id: 4, otherEditionId: 8, otherTitle: 'Other tale' }],
};

const admin = {
  user: { id: 1, username: 'ada', role: 'admin' as const },
  libraries: [{ id: 1, name: 'Home', mode: 'managed' as const }],
};

function installFetch(extra?: (url: string, init?: RequestInit) => Response | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const handled = extra?.(url, init);
      if (handled) return Promise.resolve(handled);
      if (url === '/api/setup') return Promise.resolve(json({ needed: false }));
      if (url === '/api/me') return Promise.resolve(json(admin));
      if (url === '/api/editions/3') return Promise.resolve(json({ edition }));
      return Promise.resolve(json({ error: 'not_found' }, 404));
    }),
  );
}

describe('book detail', () => {
  it('shows editable fields, formats, and a read link without merge or delete', async () => {
    installFetch();
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);

    expect(await screen.findByRole('heading', { name: 'The Tale' })).toBeInTheDocument();
    expect(screen.getByLabelText(catalogs.en.book.title)).toHaveValue('The Tale');
    expect(screen.getByLabelText(catalogs.en.book.sortTitle)).toHaveValue('The Tale');
    expect(screen.getByLabelText(catalogs.en.book.alternateTitles)).toHaveValue('Story');
    expect(screen.getByLabelText(catalogs.en.book.authors)).toHaveValue('Lin Qi');
    expect(screen.getByLabelText(catalogs.en.book.translators)).toHaveValue('Wang');
    expect(screen.getByLabelText(catalogs.en.book.description)).toHaveValue('A short book.');
    expect(screen.getByLabelText(catalogs.en.book.series)).toHaveValue('Letters');
    expect(screen.getByLabelText(catalogs.en.book.seriesOrder)).toHaveValue('1');
    expect(screen.getByLabelText(catalogs.en.book.publisher)).toHaveValue('Home Press');
    expect(screen.getByLabelText(catalogs.en.book.publishedDate)).toHaveValue('2020');
    expect(screen.getByRole('textbox', { name: catalogs.en.book.language })).toHaveValue('en');
    expect(screen.getByLabelText(catalogs.en.book.identifiers)).toHaveValue('isbn|9780000000002');
    expect(screen.getByLabelText(catalogs.en.book.tags)).toHaveValue('essay');
    expect(screen.getByText(catalogs.en.book.locked)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: catalogs.en.book.formats })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `${catalogs.en.book.read} EPUB` })).toHaveAttribute('href', '/books/3/read/9');
    expect(screen.getByRole('link', { name: `${catalogs.en.book.read} PDF` })).toHaveAttribute('href', '/books/3/read/10');
    expect(screen.getByText(catalogs.en.book.suggestionNote)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: catalogs.en.book.dismiss })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /merge/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: `${catalogs.en.book.read} EPUB` }));
    expect(await screen.findByText(catalogs.en.book.readPlaceholder)).toBeInTheDocument();

    window.history.pushState({}, '', '/books/3');
    cleanup();
    render(<App locale="en" />);
    expect(await screen.findByLabelText(catalogs.en.book.title)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.shell.language }), {
      target: { value: 'zh-Hans' },
    });
    expect(screen.getByLabelText(catalogs['zh-Hans'].book.title)).toHaveValue('The Tale');
    expect(screen.getByRole('textbox', { name: catalogs['zh-Hans'].book.language })).toHaveValue('en');
    expect(screen.getByRole('link', { name: `${catalogs['zh-Hans'].book.read} PDF` })).toBeInTheDocument();
    expect(screen.getByText(catalogs['zh-Hans'].book.suggestionNote)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /合并|merge/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /删除|delete/i })).not.toBeInTheDocument();
  });

  it('shows a locked Open Library field as kept', async () => {
    const preview: MetadataPreview = {
      previewId: 7,
      fields: [
        { field: 'title', locked: true, status: 'kept', current: 'The Tale', proposed: 'Remote' },
        { field: 'description', locked: false, status: 'change', current: 'A short book.', proposed: 'A suggestion' },
      ],
    };
    installFetch((url, init) => {
      if (url === '/api/editions/3/metadata/lookup' && init?.method === 'POST') return json(preview);
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.book.lookup }));
    expect(await screen.findByText(catalogs.en.book.kept)).toBeInTheDocument();
    expect(screen.getByText('A suggestion')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: catalogs.en.book.description })).toBeChecked();
    expect(screen.queryByRole('button', { name: /merge|delete/i })).not.toBeInTheDocument();
  });

  it('shows metadata, formats, series neighbors, and reading actions in both locales', async () => {
    const rich = {
      ...edition,
      cover: null,
      reading: {
        status: null,
        rating: null,
        favorite: false,
        queued: false,
        shelves: [{ id: 4, name: 'Weekend', included: false }],
      },
      neighbors: {
        previous: { id: 2, title: 'Earlier', seriesOrder: 1 },
        next: { id: 8, title: 'Later', seriesOrder: 3 },
        series: [],
      },
    };
    const bodies: string[] = [];
    installFetch((url, init) => {
      if (url === '/api/editions/3' && (!init?.method || init.method === 'GET')) return json({ edition: rich });
      if (url === '/api/editions/3/reading' && init?.method === 'PATCH') {
        bodies.push(String(init.body));
        return json({ edition: { ...rich, reading: { ...rich.reading, status: 'want' } } });
      }
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    const view = render(<App locale="en" />);
    expect(await screen.findByRole('heading', { name: 'The Tale' })).toBeInTheDocument();
    expect(screen.getAllByText('Lin Qi').length).toBeGreaterThan(0);
    expect(screen.getAllByText('A short book.').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: catalogs.en.book.formats })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `${catalogs.en.book.read} EPUB` })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'Previous: Earlier' })).toHaveAttribute('href', '/books/2');
    expect(screen.getByRole('link', { name: 'Next: Later' })).toHaveAttribute('href', '/books/8');
    expect(screen.getByRole('button', { name: 'Add Weekend' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: catalogs.en.reading.favorite })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `${catalogs.en.reading.rating} 5` })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reading.want }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: catalogs.en.reading.want })).toHaveAttribute('aria-pressed', 'true');
    });
    expect(bodies[0]).toContain('"status":"want"');

    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.shell.language }), {
      target: { value: 'zh-Hans' },
    });
    expect(screen.getByRole('button', { name: catalogs['zh-Hans'].reading.want })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `${catalogs['zh-Hans'].reading.next}: Later` })).toBeInTheDocument();
    view.unmount();
  });
});
