import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function installFetch(extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | null) {
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
    expect(await screen.findByRole('link', { name: catalogs.en.reader.backToBook })).toHaveAttribute(
      'href',
      '/books/3',
    );
    expect(
      screen.getAllByRole('link', { name: catalogs.en.reader.library }).some((link) => link.getAttribute('href') === '/'),
    ).toBe(true);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

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

  it('polls a lookup job, then shows the preview and apply flow in both locales', async () => {
    const preview: MetadataPreview = {
      previewId: 7,
      fields: [
        { field: 'title', locked: true, status: 'kept', current: 'The Tale', proposed: 'Remote' },
        { field: 'translators', locked: false, status: 'change', current: 'Wang', proposed: 'Wang Wei' },
        { field: 'description', locked: false, status: 'change', current: 'A short book.', proposed: 'A suggestion' },
        { field: 'series', locked: false, status: 'change', current: 'Letters', proposed: 'Letters II' },
        { field: 'seriesOrder', locked: false, status: 'change', current: '1', proposed: '2' },
        { field: 'cover', locked: false, status: 'change', current: null, proposed: 'present' },
      ],
    };
    let releaseLookup: (response: Response) => void = () => {};
    let releaseApply: (response: Response) => void = () => {};
    const lookupJob = new Promise<Response>((resolve) => {
      releaseLookup = resolve;
    });
    const applyJob = new Promise<Response>((resolve) => {
      releaseApply = resolve;
    });
    const bodies: string[] = [];
    let applied = false;
    installFetch((url, init) => {
      if (url === '/api/editions/3/metadata/lookup' && init?.method === 'POST') return json({ job: { id: 11 } }, 202);
      if (url === '/api/editions/3/metadata/apply' && init?.method === 'POST') {
        bodies.push(String(init.body));
        return json({ job: { id: 12 } }, 202);
      }
      if (url === '/api/jobs/11') return lookupJob;
      if (url === '/api/jobs/12') return applyJob;
      if (url === '/api/editions/3' && (!init?.method || init.method === 'GET')) {
        return json({ edition: applied ? { ...edition, description: 'A suggestion' } : edition });
      }
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.book.runAgent }));
    expect(await screen.findByText(catalogs.en.book.lookupRunning)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.shell.language }), {
      target: { value: 'zh-Hans' },
    });
    expect(screen.getByText(catalogs['zh-Hans'].book.lookupRunning)).toBeInTheDocument();
    releaseLookup(
      json({
        job: {
          id: 11,
          status: 'succeeded',
          result: { preview: { ...preview, source: 'assistant', model: 'deepseek-chat' } },
        },
      }),
    );
    expect(await screen.findByText(catalogs['zh-Hans'].book.kept)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(catalogs['zh-Hans'].book.previewSource))).toHaveTextContent(
      'deepseek-chat',
    );
    expect(screen.getByText('A suggestion')).toBeInTheDocument();
    expect(screen.getByText('Wang Wei')).toBeInTheDocument();
    expect(screen.getByText('Letters II')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(catalogs['zh-Hans'].book.coverProposed)).toBeInTheDocument();
    for (const field of ['translators', 'description', 'series', 'seriesOrder', 'cover'] as const) {
      expect(screen.getByRole('checkbox', { name: catalogs['zh-Hans'].book[field] })).toBeChecked();
    }
    expect(screen.queryByRole('checkbox', { name: catalogs['zh-Hans'].book.title })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /合并|merge|删除|delete/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: catalogs['zh-Hans'].book.confirm }));
    expect(await screen.findByText(catalogs['zh-Hans'].book.applyRunning)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: catalogs['zh-Hans'].shell.language }), {
      target: { value: 'en' },
    });
    expect(screen.getByText(catalogs.en.book.applyRunning)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(catalogs.en.book.previewSource))).toHaveTextContent('deepseek-chat');
    const payload = JSON.parse(bodies[0]) as { previewId: number; confirm: string[] };
    expect(payload.previewId).toBe(7);
    expect(payload.confirm).toEqual(
      expect.arrayContaining(['translators', 'description', 'series', 'seriesOrder', 'cover']),
    );
    expect(payload.confirm).not.toContain('title');
    applied = true;
    releaseApply(
      json({
        job: { id: 12, status: 'succeeded', result: { applied: true } },
      }),
    );
    expect(await screen.findByText(catalogs.en.book.saved)).toBeInTheDocument();
    expect(screen.getByLabelText(catalogs.en.book.description)).toHaveValue('A suggestion');
    expect(screen.queryByText(catalogs.en.book.kept)).not.toBeInTheDocument();
  });

  it('polls a queued metadata job past the agent budget and retries failed reads', async () => {
    const preview: MetadataPreview = {
      previewId: 7,
      fields: [
        { field: 'title', locked: true, status: 'kept', current: 'The Tale', proposed: 'Remote' },
        { field: 'description', locked: false, status: 'change', current: 'A short book.', proposed: 'A suggestion' },
      ],
    };
    let lookupPolls = 0;
    let applyPolls = 0;
    let applied = false;
    let editionReloads = 0;
    const saves: string[] = [];
    installFetch((url, init) => {
      if (url === '/api/editions/3/metadata/lookup' && init?.method === 'POST') return json({ job: { id: 11 } }, 202);
      if (url === '/api/editions/3/metadata/apply' && init?.method === 'POST') return json({ job: { id: 12 } }, 202);
      if (url === '/api/jobs/11') {
        lookupPolls += 1;
        if (lookupPolls === 1) return json({ error: 'internal' }, 500);
        if (lookupPolls < 40) return json({ job: { id: 11, status: 'queued', result: null } });
        return json({ job: { id: 11, status: 'succeeded', result: { preview } } });
      }
      if (url === '/api/jobs/12') {
        applyPolls += 1;
        if (applyPolls === 1) return Promise.reject(new Error('offline'));
        if (applyPolls < 40) return json({ job: { id: 12, status: 'running', result: null } });
        applied = true;
        return json({ job: { id: 12, status: 'succeeded', result: { applied: true } } });
      }
      if (url === '/api/editions/3' && init?.method === 'PATCH') {
        saves.push(String(init.body));
        return json({
          edition: { ...edition, title: 'Renamed', sortTitle: 'Renamed', description: 'A suggestion' },
        });
      }
      if (url === '/api/editions/3' && (!init?.method || init.method === 'GET')) {
        if (!applied) return json({ edition });
        editionReloads += 1;
        if (editionReloads === 1) return json({ error: 'network' }, 503);
        return json({ edition: { ...edition, description: 'A suggestion', locks: ['title', 'description'] } });
      }
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    const title = await screen.findByLabelText(catalogs.en.book.title);
    fireEvent.change(title, { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.book.save }));
    expect(screen.getByRole('alert')).toHaveTextContent(catalogs.en.errors.invalid_request);
    fireEvent.change(screen.getByLabelText(catalogs.en.book.title), { target: { value: 'The Tale' } });
    fireEvent.change(screen.getByRole('textbox', { name: catalogs.en.book.description }), {
      target: { value: 'Unsaved note' },
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      async function pump(times: number) {
        for (let i = 0; i < times; i += 1) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(200);
          });
        }
      }

      fireEvent.click(screen.getByRole('button', { name: catalogs.en.book.runAgent }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText(catalogs.en.book.lookupRunning)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: catalogs.en.book.runAgent })).toBeDisabled();

      await pump(34);
      expect(lookupPolls).toBeGreaterThan(30);
      expect(screen.getByText(catalogs.en.book.lookupRunning)).toBeInTheDocument();
      expect(screen.queryByText(catalogs.en.errors.internal)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: catalogs.en.book.save })).toBeDisabled();

      await pump(10);
      expect(screen.getByText(catalogs.en.book.kept)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: catalogs.en.book.description })).toHaveValue('Unsaved note');
      expect(screen.getByRole('button', { name: catalogs.en.book.runAgent })).toBeEnabled();

      fireEvent.click(screen.getByRole('button', { name: catalogs.en.book.confirm }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText(catalogs.en.book.applyRunning)).toBeInTheDocument();
      await pump(34);
      expect(applyPolls).toBeGreaterThan(30);
      expect(screen.getByText(catalogs.en.book.applyRunning)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: catalogs.en.book.save })).toBeDisabled();
      expect(screen.getByRole('textbox', { name: catalogs.en.book.description })).toHaveValue('Unsaved note');

      await pump(10);
      expect(editionReloads).toBeGreaterThan(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText(catalogs.en.book.saved)).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: catalogs.en.book.description })).toHaveValue('A suggestion');
      expect(screen.queryByText(catalogs.en.book.kept)).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText(catalogs.en.book.title), { target: { value: 'Renamed' } });
      fireEvent.click(screen.getByRole('button', { name: catalogs.en.book.save }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(saves).toHaveLength(1);
      expect(saves[0]).toContain('"title":"Renamed"');
      expect(saves[0]).not.toContain('description');
      expect(saves[0]).not.toContain('Unsaved note');
      expect(saves[0]).not.toContain('A short book');
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('does not fail a lookup that is still queued when the book screen is left', async () => {
    let polls = 0;
    installFetch((url, init) => {
      if (url === '/api/editions/3/metadata/lookup' && init?.method === 'POST') return json({ job: { id: 11 } }, 202);
      if (url === '/api/jobs/11') {
        polls += 1;
        if (polls % 5 === 0) return json({ error: 'internal' }, 500);
        return json({ job: { id: 11, status: 'queued', result: null } });
      }
      if (url === '/api/home') return json({ continueReading: [], recent: [], shelves: [] });
      if (url.startsWith('/api/library')) {
        return json({ editions: [], total: 0, limit: 24, offset: 0, languages: [], shelves: [] });
      }
      if (url === '/api/editions') return json({ editions: [] });
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    const lookup = await screen.findByRole('button', { name: catalogs.en.book.runAgent });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      fireEvent.click(lookup);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      for (let i = 0; i < 40; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200);
        });
      }
      expect(polls).toBeGreaterThan(30);
      expect(screen.getByText(catalogs.en.book.lookupRunning)).toBeInTheDocument();
      expect(screen.queryByText(catalogs.en.errors.internal)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: catalogs.en.book.save })).toBeDisabled();

      const beforeLeave = polls;
      fireEvent.click(screen.getByRole('link', { name: catalogs.en.book.back }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.queryByText(catalogs.en.book.lookupRunning)).not.toBeInTheDocument();
      expect(polls).toBe(beforeLeave);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
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
