import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { EditionDetail, MetadataPreview, ReadingStatus } from './api';
import { catalogs } from './i18n';

const nativeScrollIntoView = Element.prototype.scrollIntoView;

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = nativeScrollIntoView;
});

/** Records the elements scrolled into view (jsdom has no scrolling). */
function recordScrolls(): Element[] {
  const scrolled: Element[] = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this);
  });
  return scrolled;
}

/** Moves fake timers on, letting the requests and renders they start settle. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

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
  identifiers: [
    {
      scheme: 'isbn',
      value: '9780000000002',
      url: null,
      source: 'embedded',
      sourceUrl: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  locks: ['title'],
  metadataPrivate: false,
  cover: null,
  assets: [
    { id: 9, format: 'epub', originalFilename: 'tale.epub', displayFilename: 'Ada Lovelace - The Tale (2020).epub', bytes: 120, availability: 'present' },
    { id: 10, format: 'pdf', originalFilename: 'tale.pdf', displayFilename: 'Ada Lovelace - The Tale (2020).pdf', bytes: 80, availability: 'present' },
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

/** Switches to a tab of the card by its visible name. */
function openTab(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

/** Switches to Details and opens its Edit details disclosure. */
async function openEditor() {
  fireEvent.click(await screen.findByRole('tab', { name: catalogs.en.book.detailsTitle }));
  fireEvent.click(screen.getByText(catalogs.en.book.editDetails));
}

/** Switches to Details and opens the admin's metadata agent disclosure. */
async function openLookup() {
  fireEvent.click(await screen.findByRole('tab', { name: catalogs.en.book.detailsTitle }));
  fireEvent.click(screen.getByText(catalogs.en.book.metadataAgent, { selector: 'summary' }));
}

/** A tab panel of the card's right column, by its tab id. */
function panel(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[role="tabpanel"][data-tab="${id}"]`)!;
}

/** The tab names in the card's right column, in order. */
function tabNames(): string[] {
  return screen.queryAllByRole('tab').map((tab) => tab.textContent ?? '');
}

/** The jacket card in the band. */
function jacket(): HTMLElement {
  return document.querySelector<HTMLElement>('.book-jacket')!;
}

/** The card's left column: the cover, Read and the reader's controls. */
function side(): HTMLElement {
  return document.querySelector<HTMLElement>('.book-jacket-side')!;
}

/** The card's at-a-glance list as [label, value] pairs, or none when it is left out. */
function glanceRows(): [string, string][] {
  const list = jacket().querySelector('.book-glance');
  if (!list) return [];
  return [...list.querySelectorAll('.book-glance-row')].map((row) => [
    row.querySelector('dt')!.textContent ?? '',
    row.querySelector('dd')!.textContent ?? '',
  ]);
}

describe('book detail', () => {
  it('keeps the editors closed until opened, with files, editable fields and read links in both locales', async () => {
    installFetch();
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);

    expect(await screen.findByRole('heading', { name: 'The Tale' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: catalogs.en.book.title, hidden: true })).not.toBeVisible();
    expect(screen.getByRole('button', { name: catalogs.en.book.runAgent, hidden: true })).not.toBeVisible();
    // Files and exports is a tab, always there.
    openTab(catalogs.en.book.filesExports);
    expect(within(panel('files')).getByRole('link', { name: `${catalogs.en.book.read} PDF` })).toBeVisible();
    // One Read button per format in the card's left column, the first one primary.
    const reads = within(side()).getAllByRole('link', { name: new RegExp(`^${catalogs.en.book.read} `) });
    expect(reads.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      [`${catalogs.en.book.read} EPUB`, '/books/3/read/9'],
      [`${catalogs.en.book.read} PDF`, '/books/3/read/10'],
    ]);
    expect(reads[0]).toHaveClass('btn-primary');
    expect(reads[1]).not.toHaveClass('btn-primary');
    await openEditor();
    expect(screen.getByRole('textbox', { name: catalogs.en.book.title })).toBeVisible();
    // The metadata agent has its own disclosure, closed until opened.
    expect(screen.getByRole('button', { name: catalogs.en.book.runAgent, hidden: true })).not.toBeVisible();
    await openLookup();
    expect(screen.getByRole('button', { name: catalogs.en.book.runAgent })).toBeVisible();
    expect(screen.getByLabelText(catalogs.en.book.title)).toHaveValue('The Tale');
    expect(screen.getByLabelText(catalogs.en.book.sortTitle)).toHaveValue('The Tale');
    expect(screen.getByLabelText(catalogs.en.book.alternateTitles)).toHaveValue('Story');
    expect(screen.getByLabelText(catalogs.en.book.authors)).toHaveValue('Lin Qi');
    expect(screen.getByLabelText(catalogs.en.book.translators)).toHaveValue('Wang');
    expect(screen.getByRole('textbox', { name: catalogs.en.book.description })).toHaveValue('A short book.');
    expect(screen.getByRole('textbox', { name: catalogs.en.book.series })).toHaveValue('Letters');
    expect(screen.getByLabelText(catalogs.en.book.seriesOrder)).toHaveValue('1');
    expect(screen.getByLabelText(catalogs.en.book.publisher)).toHaveValue('Home Press');
    expect(screen.getByLabelText(catalogs.en.book.publishedDate)).toHaveValue('2020');
    expect(screen.getByRole('textbox', { name: catalogs.en.book.language })).toHaveValue('en');
    expect(screen.getByRole('textbox', { name: 'ISBN · Value' })).toHaveValue('9780000000002');
    expect(screen.getByRole('group', { name: catalogs.en.book.identifiers })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: catalogs.en.book.tags })).toHaveValue('essay');
    expect(screen.getByText(catalogs.en.book.locked)).toBeInTheDocument();
    openTab(catalogs.en.book.filesExports);
    const files = panel('files');
    expect(files).toHaveAccessibleName(catalogs.en.book.filesExports);
    expect(within(files).getByRole('link', { name: `${catalogs.en.book.read} EPUB` })).toHaveAttribute('href', '/books/3/read/9');
    expect(within(files).getByRole('link', { name: `${catalogs.en.book.read} PDF` })).toHaveAttribute('href', '/books/3/read/10');
    openTab(catalogs.en.book.suggestions);
    expect(within(panel('similar')).getByText(catalogs.en.book.suggestionNote)).toBeVisible();
    expect(screen.getByRole('button', { name: catalogs.en.book.dismiss })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /merge/i, hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i, hidden: true })).not.toBeInTheDocument();

    openTab(catalogs.en.book.filesExports);
    fireEvent.click(within(files).getByRole('link', { name: `${catalogs.en.book.read} EPUB` }));
    expect(await screen.findByRole('link', { name: catalogs.en.reader.backToBook })).toHaveAttribute(
      'href',
      '/books/3',
    );
    expect(
      screen.getAllByRole('link', { name: catalogs.en.reader.library }).some((link) => link.getAttribute('href') === '/library'),
    ).toBe(true);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    window.history.pushState({}, '', '/books/3');
    cleanup();
    render(<App locale="en" />);
    await openEditor();
    expect(screen.getByLabelText(catalogs.en.book.title)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.shell.language }), {
      target: { value: 'zh-Hans' },
    });
    // The open editor stays open across the switch.
    expect(screen.getByText(catalogs['zh-Hans'].book.editDetails).closest('details')).toHaveAttribute('open');
    expect(screen.getByLabelText(catalogs['zh-Hans'].book.title)).toHaveValue('The Tale');
    expect(screen.getByRole('textbox', { name: catalogs['zh-Hans'].book.language })).toHaveValue('en');
    expect(within(side()).getByRole('link', { name: `${catalogs['zh-Hans'].book.read} PDF` })).toBeInTheDocument();
    openTab(catalogs['zh-Hans'].book.filesExports);
    expect(within(panel('files')).getByRole('link', { name: `${catalogs['zh-Hans'].book.read} PDF` })).toBeVisible();
    expect(screen.getByText(catalogs['zh-Hans'].book.suggestionNote)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /合并|merge/i, hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /删除|delete/i, hidden: true })).not.toBeInTheDocument();
  });

  it('names each file by its display name only and links a download', async () => {
    const files: EditionDetail['assets'] = [
      ...edition.assets,
      {
        id: 11,
        format: 'pdf',
        originalFilename: 'scan.pdf',
        displayFilename: 'Ada Lovelace - The Tale (2020) (2).pdf',
        bytes: 80,
        availability: 'missing',
      },
      { id: 12, format: 'epub', originalFilename: 'Same.epub', displayFilename: 'Same.epub', bytes: 9, availability: 'present' },
    ];
    installFetch((url) => (url === '/api/editions/3' ? json({ edition: { ...edition, assets: files } }) : null));
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    expect(await screen.findByRole('heading', { name: 'The Tale' })).toBeInTheDocument();
    openTab(catalogs.en.book.filesExports);
    const list = within(panel('files')).getByRole('list', { name: catalogs.en.book.formats });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(4);

    const first = within(rows[0]!);
    expect(rows[0]!.querySelector('.format-name')).toHaveTextContent('Ada Lovelace - The Tale (2020).epub');
    // The raw upload name stays on the server (a lookup hint) and is not shown.
    expect(first.queryByText('tale.epub')).toBeNull();
    const download = first.getByRole('link', { name: `${catalogs.en.book.download} Ada Lovelace - The Tale (2020).epub` });
    expect(download).toHaveAttribute('href', '/api/editions/3/assets/9/file?download=1');
    expect(download).toHaveAttribute('download', 'Ada Lovelace - The Tale (2020).epub');
    expect(download).toHaveTextContent(catalogs.en.book.download);
    expect(first.getByRole('link', { name: `${catalogs.en.book.read} EPUB` })).toHaveAttribute('href', '/books/3/read/9');

    expect(within(rows[1]!).getByRole('link', { name: new RegExp(`^${catalogs.en.book.download} `) })).toHaveAttribute(
      'href',
      '/api/editions/3/assets/10/file?download=1',
    );
    // A missing file has no download link.
    expect(within(rows[2]!).getByText('Ada Lovelace - The Tale (2020) (2).pdf')).toBeInTheDocument();
    expect(within(rows[2]!).queryByText('scan.pdf')).toBeNull();
    expect(within(rows[2]!).queryByRole('link', { name: new RegExp(`^${catalogs.en.book.download}`) })).toBeNull();
    expect(within(rows[3]!).getAllByText('Same.epub')).toHaveLength(1);
  });

  it('labels the download link in Chinese', async () => {
    installFetch();
    window.history.pushState({}, '', '/books/3');
    render(<App locale="zh-Hans" />);
    await screen.findByRole('heading', { name: 'The Tale' });
    openTab(catalogs['zh-Hans'].book.filesExports);
    expect(
      within(panel('files')).getByRole('link', { name: `${catalogs['zh-Hans'].book.download} Ada Lovelace - The Tale (2020).pdf` }),
    ).toHaveAttribute('href', '/api/editions/3/assets/10/file?download=1');
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
        {
          field: 'cover',
          locked: false,
          status: 'change',
          current: { url: '/api/editions/3/cover?v=abc', width: 300, height: 450, sourceUrl: null, host: null },
          proposed: {
            url: '/api/editions/3/metadata/previews/7/cover',
            width: 357,
            height: 500,
            sourceUrl: 'https://book.douban.com/subject/25869109/',
            host: 'book.douban.com',
          },
        },
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
    await openLookup();
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.book.runAgent }));
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
    // Current and proposed covers sit side by side as plates, with the source and pixel size.
    expect(screen.getByText(catalogs['zh-Hans'].book.coverCurrent)).toBeInTheDocument();
    expect(screen.getByText(catalogs['zh-Hans'].book.coverFound)).toBeInTheDocument();
    const images = document.querySelectorAll('.preview-cover img');
    expect([...images].map((image) => image.getAttribute('src'))).toEqual([
      '/api/editions/3/cover?v=abc',
      '/api/editions/3/metadata/previews/7/cover',
    ]);
    expect(screen.getByRole('link', { name: 'book.douban.com' })).toHaveAttribute(
      'href',
      'https://book.douban.com/subject/25869109/',
    );
    expect(screen.getByText('357 × 500 px')).toBeInTheDocument();
    expect(screen.getByText('300 × 450 px')).toBeInTheDocument();
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
    expect(screen.getByRole('textbox', { name: catalogs.en.book.description })).toHaveValue('A suggestion');
    expect(screen.queryByText(catalogs.en.book.kept)).not.toBeInTheDocument();
  });

  it('tells admins a lookup is ready, opens it with Review, and clears after discard or apply', async () => {
    const pendingLookup = {
      previewId: 7,
      createdAt: '2026-10-31T08:43:12.928Z',
      changedFields: ['description', 'publisher', 'series', 'seriesOrder'],
    };
    const preview: MetadataPreview & { source: string; model: string } = {
      previewId: 7,
      source: 'assistant',
      model: 'deepseek-flash',
      fields: [
        { field: 'description', locked: false, status: 'change', current: 'A short book.', proposed: 'A found summary' },
        { field: 'publisher', locked: false, status: 'change', current: 'Home Press', proposed: 'Found Press' },
        { field: 'series', locked: false, status: 'change', current: 'Letters', proposed: 'Letters II' },
        { field: 'seriesOrder', locked: false, status: 'change', current: '1', proposed: '2' },
        {
          field: 'cover',
          locked: false,
          status: 'unchanged',
          current: { url: '/api/editions/3/cover?v=dc03', width: 357, height: 500, sourceUrl: null, host: null },
          proposed: {
            url: '/api/editions/3/metadata/previews/7/cover',
            width: 357,
            height: 500,
            sourceUrl: 'https://book.douban.com/subject/25869109/',
            host: 'book.douban.com',
          },
        },
      ],
    };
    let pending: typeof pendingLookup | null = pendingLookup;
    const calls: string[] = [];
    installFetch((url, init) => {
      const method = init?.method ?? 'GET';
      if (url === '/api/editions/3' && method === 'GET') return json({ edition: { ...edition, pendingLookup: pending } });
      if (url === '/api/editions/3/metadata/previews/7' && method === 'GET') {
        calls.push('review');
        return json({ preview });
      }
      if (url === '/api/editions/3/metadata/previews/7' && method === 'DELETE') {
        calls.push('discard');
        pending = null;
        return json({ edition: { ...edition, pendingLookup: null } });
      }
      if (url === '/api/editions/3/metadata/apply' && method === 'POST') return json({ job: { id: 12 } }, 202);
      if (url === '/api/jobs/12') {
        pending = null;
        return json({ job: { id: 12, status: 'succeeded', result: { applied: true } } });
      }
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);

    const notice = (await screen.findByText('A metadata lookup found 4 changes')).closest('.lookup-notice') as HTMLElement;
    expect(notice).toBeInTheDocument();
    // The notice sits in the fixed head directly under the title and authors.
    expect(notice.previousElementSibling).toHaveClass('book-translators');
    expect(notice.parentElement).toHaveClass('book-hero');
    const disclosure = document.querySelector<HTMLDetailsElement>('.book-lookup')!;
    expect(panel('details')).toContainElement(disclosure);
    expect(panel('details')).not.toBeVisible();
    expect(disclosure).not.toHaveAttribute('open');
    expect(screen.getByRole('button', { name: catalogs.en.book.runAgent, hidden: true })).not.toBeVisible();
    const scrolled = recordScrolls();
    fireEvent.click(within(notice).getByRole('button', { name: catalogs.en.book.lookupReview }));

    // Review switches to Details and opens the lookup disclosure at once, scrolls to it and focuses it.
    expect(screen.getByRole('tab', { name: catalogs.en.book.detailsTitle })).toHaveAttribute('aria-selected', 'true');
    expect(panel('details')).toBeVisible();
    expect(disclosure).toHaveAttribute('open');
    expect(scrolled[0]).toBe(disclosure);
    expect(disclosure.querySelector('summary')).toHaveFocus();
    expect(window.location.hash).toBe('#details');
    // Once the stored preview loads inside it, focus moves on to the preview.
    const heading = await screen.findByRole('heading', { name: catalogs.en.book.preview });
    expect(heading).toBeVisible();
    expect(disclosure).toContainElement(heading);
    await waitFor(() => expect(heading).toHaveFocus());
    expect(calls).toEqual(['review']);
    expect(screen.getByText('A found summary')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(catalogs.en.book.previewSource))).toHaveTextContent('deepseek-flash');
    expect(screen.queryByRole('checkbox', { name: catalogs.en.book.cover })).not.toBeInTheDocument();
    for (const field of ['description', 'publisher', 'series', 'seriesOrder'] as const) {
      expect(screen.getByRole('checkbox', { name: catalogs.en.book[field] })).toBeChecked();
    }
    // The notice steps aside while its preview is open.
    expect(screen.queryByText('A metadata lookup found 4 changes')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: catalogs.en.book.discardPreview }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: catalogs.en.book.preview })).not.toBeInTheDocument());
    expect(calls).toEqual(['review', 'discard']);
    expect(screen.queryByText('A metadata lookup found 4 changes')).not.toBeInTheDocument();
    expect(document.querySelector('.lookup-notice')).toBeNull();

    // Applying clears it too.
    cleanup();
    pending = pendingLookup;
    render(<App locale="en" />);
    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.book.lookupReview }));
    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.book.confirm }));
    expect(await screen.findByText(catalogs.en.book.saved)).toBeInTheDocument();
    expect(document.querySelector('.lookup-notice')).toBeNull();

    // Chinese labels, and the singular form.
    cleanup();
    pending = { ...pendingLookup, changedFields: ['description'] };
    render(<App locale="en" />);
    expect(await screen.findByText('A metadata lookup found 1 change')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.shell.language }), { target: { value: 'zh-Hans' } });
    expect(screen.getByText('元数据查找发现 1 处修改')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看' })).toBeInTheDocument();
    cleanup();
    pending = pendingLookup;
    render(<App locale="zh-Hans" />);
    expect(await screen.findByText('元数据查找发现 4 处修改')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: catalogs['zh-Hans'].book.lookupReview }));
    expect(await screen.findByRole('button', { name: '放弃这些建议' })).toBeInTheDocument();
  });

  it('keeps a book private from the metadata agent from Details: saves, drops the notice, and disables lookup', async () => {
    let current: EditionDetail = {
      ...edition,
      pendingLookup: { previewId: 7, createdAt: '2026-10-31T00:00:00.000Z', changedFields: ['title'] },
    };
    const patches: unknown[] = [];
    installFetch((url, init) => {
      if (url === '/api/editions/3' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { metadataPrivate: boolean };
        patches.push(body);
        current = { ...current, metadataPrivate: body.metadataPrivate, pendingLookup: null };
        return json({ edition: current });
      }
      if (url === '/api/editions/3') return json({ edition: current });
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    expect(await screen.findByRole('heading', { name: 'The Tale' })).toBeInTheDocument();
    expect(document.querySelector('.lookup-notice')).not.toBeNull();
    expect(document.querySelector('.book-private-mark')).toBeNull();

    await openLookup();
    const toggle = screen.getByRole('checkbox', { name: catalogs.en.metadataPrivate.label });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(catalogs.en.metadataPrivate.hint);
    expect(screen.getByRole('button', { name: catalogs.en.book.runAgent })).toBeEnabled();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(patches).toEqual([{ metadataPrivate: true }]);
    const run = screen.getByRole('button', { name: catalogs.en.book.runAgent });
    expect(run).toBeDisabled();
    expect(run).toHaveAccessibleDescription(catalogs.en.metadataPrivate.lookupOff);
    expect(document.querySelector('.lookup-notice')).toBeNull();
    const mark = document.querySelector('.book-hero .book-private-mark');
    expect(mark?.textContent).toContain(catalogs.en.metadataPrivate.mark);
    expect(mark?.querySelector('svg')).not.toBeNull();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(patches).toEqual([{ metadataPrivate: true }, { metadataPrivate: false }]);
    expect(screen.getByRole('button', { name: catalogs.en.book.runAgent })).toBeEnabled();
    expect(document.querySelector('.book-private-mark')).toBeNull();
  });

  it('shows readers the private marker in Chinese without the setting', async () => {
    installFetch((url) => {
      if (url === '/api/me') return json({ user: { id: 2, username: 'bea', role: 'reader' }, libraries: admin.libraries });
      if (url === '/api/editions/3') return json({ edition: { ...edition, metadataPrivate: true } });
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="zh-Hans" />);
    expect(await screen.findByRole('heading', { name: 'The Tale' })).toBeInTheDocument();
    expect(document.querySelector('.book-private-mark')?.textContent).toContain(catalogs['zh-Hans'].metadataPrivate.mark);
    fireEvent.click(screen.getByRole('tab', { name: catalogs['zh-Hans'].book.detailsTitle }));
    expect(screen.queryByRole('checkbox', { name: catalogs['zh-Hans'].metadataPrivate.label })).not.toBeInTheDocument();
  });

  it('never shows the lookup notice to readers', async () => {
    installFetch((url) => {
      if (url === '/api/me') return json({ user: { id: 2, username: 'bea', role: 'reader' }, libraries: admin.libraries });
      if (url === '/api/editions/3') {
        return json({
          edition: { ...edition, pendingLookup: { previewId: 7, createdAt: '2026-10-31T00:00:00.000Z', changedFields: ['title'] } },
        });
      }
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    expect(await screen.findByRole('heading', { name: 'The Tale' })).toBeInTheDocument();
    expect(screen.queryByText(/A metadata lookup found/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: catalogs.en.book.lookupReview })).not.toBeInTheDocument();
    expect(document.querySelector('.lookup-notice')).toBeNull();
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
    await openEditor();
    await openLookup();
    const title = screen.getByLabelText(catalogs.en.book.title);
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
      // The identifier payload carries url and provenance; an untouched list is not resent (or locked).
      expect(saves[0]).not.toContain('identifiers');
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('shows the lookup trajectory collapsed, live while the job runs, and never to readers', async () => {
    const steps = [
      { seq: 1, kind: 'input', at: '2026-01-01T00:00:01.000Z', data: { model: 'scripted-model', input: { filename: 'tale.epub', format: 'epub' } } },
      {
        seq: 2,
        kind: 'tool_call',
        at: '2026-01-01T00:00:02.000Z',
        data: { turn: 1, callId: 'c1', name: 'get_open_library_record', args: { key: '/works/OL7W' } },
      },
      {
        seq: 3,
        kind: 'tool_result',
        at: '2026-01-01T00:00:03.000Z',
        data: { callId: 'c1', name: 'get_open_library_record', summary: { key: '/works/OL7W', title: 'The Tale' }, result: '{}', durationMs: 1250 },
      },
      {
        seq: 4,
        kind: 'submit',
        at: '2026-01-01T00:00:04.000Z',
        data: { turn: 2, callId: 'c2', accepted: true, proposal: { title: 'The Tale', authors: ['Lin Qi'] } },
      },
      { seq: 5, kind: 'end', at: '2026-01-01T00:00:04.000Z', data: { outcome: 'accepted', error: null, turns: 2, toolCalls: 2, totalMs: 3100 } },
    ];
    let polls = 0;
    let finished = false;
    const counts = () => (finished ? 5 : polls < 3 ? 1 : 3);
    const fetchMock = vi.fn();
    installFetch((url, init) => {
      fetchMock(url);
      if (url === '/api/editions/3/metadata/lookup' && init?.method === 'POST') return json({ job: { id: 11 } }, 202);
      if (url === '/api/jobs/11') {
        polls += 1;
        return json({
          job: {
            id: 11,
            status: finished ? 'succeeded' : 'running',
            result: finished ? { preview: null } : null,
            trajectoryId: 31,
            trajectoryStepCount: counts(),
          },
        });
      }
      if (url === '/api/metadata/trajectories/31') {
        return json({
          trajectory: { id: 31, outcome: finished ? 'accepted' : null, truncated: false, stepCount: counts(), steps: steps.slice(0, counts()) },
        });
      }
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    await openLookup();
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.book.runAgent }));
    const toggle = await screen.findByRole('button', { name: catalogs.en.trajectory.title });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(catalogs.en.trajectory.step.input)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(await screen.findByText(catalogs.en.trajectory.step.input)).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.trajectory.working)).toBeInTheDocument();

    expect(await screen.findByText(catalogs.en.trajectory.step.record, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '/works/OL7W' })).toHaveAttribute('href', 'https://openlibrary.org/works/OL7W');
    expect(screen.getByText('1.3 s')).toBeInTheDocument();
    finished = true;
    expect(await screen.findByText(catalogs.en.trajectory.outcome.accepted, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.trajectory.step.submitted)).toBeInTheDocument();
    expect(screen.getByText('The Tale · Lin Qi')).toBeInTheDocument();
    expect(screen.queryByText(catalogs.en.trajectory.working)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/metadata/trajectories/31').length).toBeGreaterThanOrEqual(3);
    cleanup();

    installFetch((url) =>
      url === '/api/me'
        ? json({ user: { id: 2, username: 'bea', role: 'reader' }, libraries: admin.libraries })
        : null,
    );
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    await openEditor();
    expect(screen.queryByText(catalogs.en.book.metadataAgent, { selector: 'summary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: catalogs.en.book.runAgent })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: catalogs.en.trajectory.title })).not.toBeInTheDocument();
  });

  it('says no cover was found and labels page_images and cover notes in the trajectory', async () => {
    const preview: MetadataPreview = {
      previewId: 8,
      fields: [
        { field: 'description', locked: false, status: 'change', current: 'A short book.', proposed: 'A suggestion' },
        { field: 'cover', locked: false, status: 'unchanged', current: null, proposed: null },
      ],
    };
    const steps = [
      { seq: 1, kind: 'input', at: '2026-01-01T00:00:01.000Z', data: { model: 'scripted-model', input: { filename: 'tale.epub', format: 'epub' } } },
      {
        seq: 2,
        kind: 'tool_call',
        at: '2026-01-01T00:00:02.000Z',
        data: { turn: 1, callId: 'c1', name: 'page_images', args: { url: 'https://book.douban.com/subject/25869109/' } },
      },
      {
        seq: 3,
        kind: 'tool_result',
        at: '2026-01-01T00:00:03.000Z',
        data: {
          callId: 'c1',
          name: 'page_images',
          summary: { count: 3, host: 'book.douban.com', url: 'https://book.douban.com/subject/25869109/' },
          result: JSON.stringify({
            url: 'https://book.douban.com/subject/25869109/',
            host: 'book.douban.com',
            images: [{ url: 'https://img3.doubanio.com/view/subject/l/public/s28305968.jpg', kind: 'og:image' }],
          }),
          durationMs: 400,
        },
      },
      { seq: 4, kind: 'end', at: '2026-01-01T00:00:04.000Z', data: { outcome: 'accepted', error: null, turns: 1, toolCalls: 2, totalMs: 900 } },
      {
        seq: 5,
        kind: 'note',
        at: '2026-01-01T00:00:05.000Z',
        data: { message: 'Cover rejected from img3.doubanio.com: http_error (HTTP 418)', cover: { status: 'rejected' } },
      },
    ];
    installFetch((url, init) => {
      if (url === '/api/editions/3/metadata/lookup' && init?.method === 'POST') return json({ job: { id: 11 } }, 202);
      if (url === '/api/jobs/11') {
        return json({ job: { id: 11, status: 'succeeded', result: { preview }, trajectoryId: 32, trajectoryStepCount: 5 } });
      }
      if (url === '/api/metadata/trajectories/32') {
        return json({ trajectory: { id: 32, outcome: 'accepted', truncated: false, stepCount: 5, steps } });
      }
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    await openLookup();
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.book.runAgent }));
    expect(await screen.findByText(catalogs.en.book.noCoverFound)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: catalogs.en.book.cover })).not.toBeInTheDocument();
    expect(document.querySelectorAll('.preview-cover img')).toHaveLength(0);

    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.trajectory.title }));
    expect(await screen.findByText(catalogs.en.trajectory.step.pageImages)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'book.douban.com' })).toHaveAttribute('href', 'https://book.douban.com/subject/25869109/');
    expect(screen.getByText('3 images')).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.trajectory.step.cover)).toBeInTheDocument();
    expect(screen.getByText('Cover rejected from img3.doubanio.com: http_error (HTTP 418)')).toBeInTheDocument();
    const raws = screen.getAllByRole('button', { name: catalogs.en.trajectory.raw });
    fireEvent.click(raws[1]!);
    expect(screen.getByRole('link', { name: 'https://img3.doubanio.com/view/subject/l/public/s28305968.jpg' })).toBeInTheDocument();
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
    await openLookup();
    const lookup = screen.getByRole('button', { name: catalogs.en.book.runAgent });

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
    expect(screen.queryByRole('button', { name: 'Add Weekend' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reading.shelves }));
    openTab(catalogs.en.book.filesExports);
    expect(within(panel('files')).getByRole('link', { name: `${catalogs.en.book.read} EPUB` })).toBeVisible();
    // No cover image; the only pictures are the ratings' site icons.
    expect(document.querySelector('img:not(.provider-icon)')).toBeNull();
    openTab(catalogs.en.book.series);
    expect(within(panel('series')).getByRole('link', { name: 'Previous: Earlier' })).toHaveAttribute('href', '/books/2');
    expect(screen.getByRole('link', { name: 'Next: Later' })).toHaveAttribute('href', '/books/8');
    expect(screen.getByRole('button', { name: 'Add Weekend' })).toBeVisible();
    expect(screen.getByRole('button', { name: catalogs.en.reading.favorite })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `${catalogs.en.reading.rating} 5` })).toBeInTheDocument();

    const stepper = screen.getByRole('group', { name: catalogs.en.reading.statusGroup });
    fireEvent.click(within(stepper).getByRole('button', { name: 'Next status: Want to read' }));
    expect(within(stepper).getByRole('status')).toHaveTextContent(catalogs.en.reading.want);
    // The save waits for the steps to stop.
    expect(bodies).toEqual([]);

    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.shell.language }), {
      target: { value: 'zh-Hans' },
    });
    expect(stepper).toHaveAccessibleName('阅读状态');
    expect(within(stepper).getByRole('status')).toHaveTextContent('想读');
    expect(within(stepper).getByRole('button', { name: '上一个状态：未设置状态' })).toBeInTheDocument();
    expect(within(stepper).getByRole('button', { name: '下一个状态：在读' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `${catalogs['zh-Hans'].reading.next}: Later` })).toBeInTheDocument();
    // Leaving the book sends the waiting step at once.
    view.unmount();
    expect(bodies).toEqual(['{"status":"want"}']);
  });

  it('saves and clears status, toggles favorite, queue and rating, and manages shelves through the disclosure', async () => {
    let current: EditionDetail = {
      ...edition,
      reading: {
        status: null,
        rating: null,
        favorite: false,
        queued: false,
        shelves: [{ id: 4, name: 'Weekend', included: false }],
      },
    };
    const requests: { url: string; method: string; body?: unknown }[] = [];
    let releaseStatus: (response: Response) => void = () => {};
    installFetch((url, init) => {
      if (url === '/api/editions/3' && (!init?.method || init.method === 'GET')) return json({ edition: current });
      if (!init?.method || init.method === 'GET') return null;
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ url, method: init.method, body });
      if (url === '/api/editions/3/reading') {
        current = { ...current, reading: { ...current.reading!, ...body } };
        if (body?.status === 'want') return new Promise<Response>((resolve) => { releaseStatus = resolve; });
        return json({ edition: current });
      }
      if (url === '/api/shelves/4/items' || url === '/api/shelves/4/items/3') {
        current = {
          ...current,
          reading: { ...current.reading!, shelves: [{ id: 4, name: 'Weekend', included: init.method === 'POST' }] },
        };
        return json({ edition: current });
      }
      if (url === '/api/shelves') {
        current = {
          ...current,
          reading: { ...current.reading!, shelves: [...current.reading!.shelves, { id: 5, name: String(body?.name), included: true }] },
        };
        return json({ edition: current });
      }
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    const stepper = await screen.findByRole('group', { name: catalogs.en.reading.statusGroup });
    const [previous, next] = within(stepper).getAllByRole('button');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(next!);
      await advance(500);
      // While the save is pending the other controls are disabled; the stepper is not.
      expect(requests).toHaveLength(1);
      expect(screen.getByRole('button', { name: catalogs.en.reading.favorite })).toBeDisabled();
      expect(next).not.toHaveAttribute('aria-disabled');
      releaseStatus(json({ edition: current }));
      await advance(0);
      expect(within(stepper).getByRole('status')).toHaveTextContent(catalogs.en.reading.want);
      expect(screen.getByRole('button', { name: catalogs.en.reading.favorite })).toBeEnabled();
      fireEvent.click(previous!);
      await advance(500);
      expect(within(stepper).getByRole('status')).toHaveTextContent(catalogs.en.reading.noStatus);
    } finally {
      vi.useRealTimers();
    }
    expect(requests.slice(0, 2)).toEqual([
      { url: '/api/editions/3/reading', method: 'PATCH', body: { status: 'want' } },
      { url: '/api/editions/3/reading', method: 'PATCH', body: { status: null } },
    ]);

    for (const [off, on] of [
      [catalogs.en.reading.favorite, catalogs.en.reading.unfavorite],
      [catalogs.en.reading.addQueue, catalogs.en.reading.removeQueue],
    ]) {
      fireEvent.click(screen.getByRole('button', { name: off }));
      const active = await screen.findByRole('button', { name: on });
      expect(active).toHaveAttribute('aria-pressed', 'true');
      expect(active).toHaveAttribute('title', on);
      fireEvent.click(active);
      expect(await screen.findByRole('button', { name: off })).toHaveAttribute('aria-pressed', 'false');
    }
    const rating = screen.getByRole('button', { name: `${catalogs.en.reading.rating} 5` });
    fireEvent.click(rating);
    await waitFor(() => expect(rating).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(rating);
    await waitFor(() => expect(rating).toHaveAttribute('aria-pressed', 'false'));
    expect(requests.slice(-2).map((request) => request.body)).toEqual([{ rating: 5 }, { rating: null }]);

    expect(screen.queryByRole('button', { name: 'Add Weekend' })).not.toBeInTheDocument();
    const shelvesButton = screen.getByRole('button', { name: catalogs.en.reading.shelves });
    fireEvent.click(shelvesButton);
    fireEvent.click(screen.getByRole('button', { name: 'Add Weekend' }));
    const remove = await screen.findByRole('button', { name: 'Remove Weekend' });
    expect(remove).toHaveAttribute('aria-pressed', 'true');
    // The button now names the one shelf holding the book.
    expect(shelvesButton).toHaveAccessibleName('Shelves: Weekend');
    fireEvent.click(remove);
    expect(await screen.findByRole('button', { name: 'Add Weekend' })).toHaveAttribute('aria-pressed', 'false');
    expect(shelvesButton).toHaveAccessibleName(catalogs.en.reading.shelves);
    fireEvent.change(screen.getByLabelText(catalogs.en.reading.newShelf), { target: { value: '  Travel  ' } });
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.reading.createShelf }));
    expect(await screen.findByRole('button', { name: 'Remove Travel' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText(catalogs.en.reading.newShelf)).toHaveValue('');
    // The panel stays open through toggles and creation.
    expect(shelvesButton).toHaveAttribute('aria-expanded', 'true');
    expect(requests.slice(-3)).toEqual([
      { url: '/api/shelves/4/items', method: 'POST', body: { editionId: 3 } },
      { url: '/api/shelves/4/items/3', method: 'DELETE', body: undefined },
      { url: '/api/shelves', method: 'POST', body: { name: 'Travel', editionId: 3 } },
    ]);
  });

  it('lists identifiers with provenance for admins, scheme, value and link for readers, and Unidentified when none', async () => {
    const identified: EditionDetail = {
      ...edition,
      locks: ['identifiers'],
      identifiers: [
        { scheme: 'isbn', value: '9780140328721', url: 'https://openlibrary.org/isbn/9780140328721', source: 'embedded', sourceUrl: null },
        { scheme: 'douban', value: '1084336', url: 'https://book.douban.com/subject/1084336/', source: 'agent', sourceUrl: 'https://www.douban.com/search?q=tale' },
        { scheme: 'doi', value: '10.1000/182', url: 'https://doi.org/10.1000/182', source: 'manual', sourceUrl: null },
      ],
    };
    const readerShape = identified.identifiers.map(({ scheme, value, url }) => ({ scheme, value, url }));
    let role: 'admin' | 'reader' = 'admin';
    let current: EditionDetail = identified;
    installFetch((url) => {
      if (url === '/api/me') return json({ ...admin, user: { ...admin.user, role } });
      if (url === '/api/editions/3') return json({ edition: current });
      return null;
    });
    window.history.pushState({}, '', '/books/3#details');
    render(<App locale="en" />);
    const list = (await screen.findByText(catalogs.en.book.identifiers, { selector: '.identifier-caption > span' })).closest(
      '.identifier-block',
    ) as HTMLElement;
    const rows = within(list).getAllByRole('term').map((term) => term.textContent);
    expect(rows).toEqual(['ISBN', 'Douban', 'DOI']);
    expect(within(list).getByRole('link', { name: '9780140328721' })).toHaveAttribute('href', 'https://openlibrary.org/isbn/9780140328721');
    expect(within(list).getByRole('link', { name: '9780140328721' })).toHaveClass('num');
    // Provenance stays out of the list, for admins too.
    expect(list.querySelector('.identifier-source')).toBeNull();
    expect(within(list).queryByRole('link', { name: 'douban.com' })).not.toBeInTheDocument();
    expect(within(list).getByText(catalogs.en.identifiers.locked)).toBeInTheDocument();
    expect(screen.queryByText(catalogs.en.identifiers.unidentified)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.shell.language }), { target: { value: 'zh-Hans' } });
    expect(within(list).getByText(catalogs['zh-Hans'].identifiers.scheme.douban, { selector: 'dt' })).toBeInTheDocument();
    cleanup();

    // Readers get scheme, value and link only.
    role = 'reader';
    current = { ...identified, identifiers: readerShape };
    window.history.pushState({}, '', '/books/3#details');
    render(<App locale="en" />);
    const readerList = (await screen.findByText(catalogs.en.book.identifiers, { selector: '.identifier-caption > span' })).closest(
      '.identifier-block',
    ) as HTMLElement;
    expect(within(readerList).getByRole('link', { name: '1084336' })).toHaveAttribute('href', 'https://book.douban.com/subject/1084336/');
    expect(within(readerList).getByText('10.1000/182')).toBeInTheDocument();
    expect(readerList.querySelector('.identifier-source')).toBeNull();
    expect(within(readerList).queryByRole('link', { name: 'douban.com' })).not.toBeInTheDocument();
    cleanup();

    current = { ...edition, identifiers: [] };
    window.history.pushState({}, '', '/books/3#details');
    render(<App locale="en" />);
    expect(await screen.findByText(catalogs.en.identifiers.unidentified, { selector: '.status-mark-label' })).toBeInTheDocument();
  });

  it('edits identifier rows and shows the rejected row with its error inline', async () => {
    const patches: unknown[] = [];
    let current: EditionDetail = edition;
    installFetch((url, init) => {
      if (url === '/api/editions/3' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { identifiers?: Array<{ scheme: string; value: string }> };
        patches.push(body);
        if (body.identifiers?.some((item) => item.value === 'not-a-doi')) return json({ error: 'invalid_identifier', index: 1 }, 400);
        current = { ...current, identifiers: (body.identifiers ?? []).map((item) => ({ ...item, url: null, source: 'manual' as const, sourceUrl: null })) };
        return json({ edition: current });
      }
      if (url === '/api/editions/3') return json({ edition: current });
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    await openEditor();
    const group = screen.getByRole('group', { name: catalogs.en.book.identifiers });

    fireEvent.click(within(group).getByRole('button', { name: catalogs.en.identifiers.add }));
    const schemes = within(group).getAllByRole('combobox', { name: catalogs.en.identifiers.schemeField });
    expect(schemes).toHaveLength(2);
    expect(within(schemes[0]!).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'ISBN', 'ISSN', 'DOI', 'OCLC', 'LCCN', 'Open Library', 'Google Books', 'Douban',
    ]);
    fireEvent.change(schemes[1]!, { target: { value: 'doi' } });
    fireEvent.change(within(group).getByRole('textbox', { name: 'DOI · Value' }), { target: { value: 'not-a-doi' } });
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.book.save }));

    const invalid = await within(group).findByRole('textbox', { name: 'DOI · Value' });
    await waitFor(() => expect(invalid).toHaveAttribute('aria-invalid', 'true'));
    expect(invalid).toHaveAccessibleDescription(catalogs.en.identifiers.invalid.replace('{scheme}', 'DOI'));
    expect(document.activeElement).toBe(invalid);
    expect(within(group).getByRole('textbox', { name: 'ISBN · Value' })).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(catalogs.en.errors.invalid_identifier)).not.toBeInTheDocument();
    expect(patches.at(-1)).toEqual({
      identifiers: [
        { scheme: 'isbn', value: '9780000000002' },
        { scheme: 'doi', value: 'not-a-doi' },
      ],
    });

    // Fixing the row clears its error; removing it and saving sends the rest.
    fireEvent.change(invalid, { target: { value: '10.1000/182' } });
    expect(invalid).not.toHaveAttribute('aria-invalid');
    fireEvent.click(within(group).getByRole('button', { name: catalogs.en.identifiers.remove.replace('{scheme}', 'ISBN') }));
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.book.save }));
    expect(await screen.findByText(catalogs.en.book.saved)).toBeInTheDocument();
    expect(patches.at(-1)).toEqual({ identifiers: [{ scheme: 'doi', value: '10.1000/182' }] });

    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.shell.language }), { target: { value: 'zh-Hans' } });
    expect(screen.getByRole('button', { name: catalogs['zh-Hans'].identifiers.add })).toBeInTheDocument();
  });

  it('says why each similar edition was suggested', async () => {
    const current: EditionDetail = {
      ...edition,
      suggestions: [
        { id: 4, otherEditionId: 8, otherTitle: 'Other tale', reasons: ['identifier'], identifier: { scheme: 'isbn', value: '9780140328721' } },
        { id: 5, otherEditionId: 9, otherTitle: 'The Tale, again', reasons: ['title_author'] },
        { id: 6, otherEditionId: 10, otherTitle: 'Tale (both)', reasons: ['title_author', 'identifier'], identifier: { scheme: 'douban', value: '1084336' } },
      ],
    };
    installFetch((url) => (url === '/api/editions/3' ? json({ edition: current }) : null));
    window.history.pushState({}, '', '/books/3#similar');
    render(<App locale="en" />);
    const row = async (title: string) => (await screen.findByRole('link', { name: title })).closest('li') as HTMLElement;
    expect(await row('Other tale')).toHaveTextContent('Same identifier: ISBN 9780140328721');
    expect(await row('The Tale, again')).toHaveTextContent(catalogs.en.book.suggestionReason.title_author);
    expect(await row('Tale (both)')).toHaveTextContent('Similar title and author · Same identifier: Douban 1084336');

    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.shell.language }), { target: { value: 'zh-Hans' } });
    expect(await row('Other tale')).toHaveTextContent('标识相同：ISBN 9780140328721');
    expect(await row('Tale (both)')).toHaveTextContent('书名与作者相近 · 标识相同：豆瓣 1084336');
  });

  it('keeps cover replacement and exports available to readers, and hides empty related sections', async () => {
    let current = { ...edition, suggestions: [] };
    let uploaded: FormData | null = null;
    installFetch((url, init) => {
      if (url === '/api/me') return json({ ...admin, user: { ...admin.user, role: 'reader' } });
      if (url === '/api/editions/3' && (!init?.method || init.method === 'GET')) return json({ edition: current });
      if (url === '/api/editions/3/cover' && init?.method === 'POST') {
        uploaded = init.body as FormData;
        current = { ...current, cover: { mediaType: 'image/png' } };
        return json({ edition: current });
      }
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    render(<App locale="en" />);
    expect(await screen.findByRole('heading', { name: 'The Tale' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: catalogs.en.book.suggestions })).not.toBeInTheDocument();
    expect(document.querySelector('.suggestion-list')).toBeNull();
    await openEditor();
    expect(screen.queryByRole('button', { name: catalogs.en.book.runAgent })).not.toBeInTheDocument();
    const cover = new File(['cover'], 'cover.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText(catalogs.en.book.replaceCover), { target: { files: [cover] } });
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.book.replaceCover }));
    expect(await screen.findByText(catalogs.en.book.saved)).toBeInTheDocument();
    expect(uploaded!.get('cover')).toEqual(cover);
    openTab(catalogs.en.book.filesExports);
    expect(within(panel('files')).getByRole('link', { name: catalogs.en.book.exportMarkdown })).toHaveAttribute('href', '/api/editions/3/annotations?format=markdown');
    expect(screen.getByRole('link', { name: catalogs.en.book.exportJson })).toHaveAttribute('href', '/api/editions/3/annotations?format=json');
  });

});

describe('external ratings', () => {
  const at = '2026-10-01T08:00:00.000Z';
  const rated: EditionDetail = {
    ...edition,
    identifiers: [
      { scheme: 'isbn', value: '9787010134185', url: 'https://book.douban.com/isbn/9787010134185/' },
    ],
    ratings: [
      // Deliberately out of order: the page sorts by provider.
      { provider: 'open_library', url: 'https://openlibrary.org/works/OL45804W', rating: 3.95, scale: 5, count: 121, fetchedAt: at },
      { provider: 'goodreads', url: 'https://www.goodreads.com/book/show/99329011', rating: null, scale: 5, count: null, fetchedAt: at },
      { provider: 'douban', url: 'https://book.douban.com/subject/25869109/', rating: 9.3, scale: 10, count: 1209, fetchedAt: at },
      { provider: 'google_books', url: null, rating: null, scale: 5, count: null, fetchedAt: at, status: 'error', error: 'rate_limited' },
    ],
    ratingsPending: false,
  };

  function serve(role: 'admin' | 'reader', current: () => EditionDetail, extra?: (url: string, init?: RequestInit) => Response | null) {
    installFetch((url, init) => {
      if (url === '/api/me') return json({ ...admin, user: { ...admin.user, role } });
      if (url === '/api/editions/3') return json({ edition: current() });
      return extra?.(url, init) ?? null;
    });
    window.history.pushState({}, '', '/books/3');
  }

  /** The "Also on" line's links, by visible name. */
  function alsoOn(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.book-ratings-elsewhere');
  }

  it('shows a card per scored provider in order, each one link with its own scale and count', async () => {
    serve('admin', () => rated);
    render(<App locale="en" />);
    const cards = await screen.findByRole('list', { name: catalogs.en.ratings.label });
    const links = within(cards).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Douban9.3/101,209 ratings', 'Open Library3.95/5121 ratings']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://book.douban.com/subject/25869109/',
      'https://openlibrary.org/works/OL45804W',
    ]);
    // The whole card is the link: name, score, scale, and count are all inside it.
    const douban = links[0]!;
    expect(douban).toHaveAttribute('target', '_blank');
    expect(within(douban).getByText('9.3')).toHaveClass('rating-card-value');
    expect(within(douban).getByText('/10')).toHaveClass('rating-card-scale');
    expect(within(links[1]!).getByText('/5')).toBeInTheDocument();
    expect(within(douban).getByText('1,209 ratings')).toBeInTheDocument();
    expect(douban).toHaveAttribute('data-provider', 'douban');
    // The ratings sit in the fixed head, after the title and authors and before the tabs.
    expect(cards.closest('.book-hero')).not.toBeNull();
    const following = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(document.querySelector('.book-byline')!.compareDocumentPosition(cards) & following).toBeTruthy();
    expect(cards.compareDocumentPosition(screen.getByRole('tablist')) & following).toBeTruthy();
    // An error without a page shows nowhere.
    expect(document.querySelector('.book-ratings')).not.toHaveTextContent('Google Books');
  });

  it('sets the ratings as one compact row: icon, name, score, scale and muted count per provider, then "Also on" and refresh', async () => {
    serve('admin', () => rated);
    render(<App locale="en" />);
    const cards = await screen.findByRole('list', { name: catalogs.en.ratings.label });
    // One row: the scored providers, then the "Also on" part with the admin refresh, no stacked blocks.
    const ratings = cards.closest<HTMLElement>('.book-ratings')!;
    expect([...ratings.children].map((child) => child.className)).toEqual(['rating-cards', 'book-ratings-also']);
    expect(ratings.parentElement).toHaveClass('book-hero');
    // Each entry reads inline: the icon and name, the score on its own scale, then the count.
    const douban = within(cards).getByRole('link', { name: /^Douban/ });
    expect([...douban.children].map((child) => child.className)).toEqual(['rating-card-source', 'rating-card-score', 'rating-card-count']);
    expect(douban.querySelector('.rating-card-source')!.children[0]).toHaveClass('provider-icon');
    expect(douban.querySelector('.rating-card-source')).toHaveTextContent(/^Douban$/);
    expect([...douban.querySelector('.rating-card-score')!.children].map((child) => child.textContent)).toEqual(['9.3', '/10']);
    expect(douban.querySelector('.rating-card-count')).toHaveTextContent('1,209 ratings');
    // The provider's accent comes from its data attribute.
    expect(within(cards).getAllByRole('link').map((link) => link.dataset.provider)).toEqual(['douban', 'open_library']);
    // No headings or other block structure inside the row.
    expect(within(ratings).queryAllByRole('heading')).toHaveLength(0);
    const also = ratings.querySelector<HTMLElement>('.book-ratings-also')!;
    expect(also).toContainElement(screen.getByRole('button', { name: catalogs.en.ratings.refresh }));
    expect(also).toHaveTextContent(/^Also on Goodreads · WorldCatUpdated /);
  });

  it('shows each site icon from the server and hides one that fails to load', async () => {
    serve('reader', () => rated);
    render(<App locale="en" />);
    const cards = await screen.findByRole('list', { name: catalogs.en.ratings.label });
    const icon = cards.querySelector<HTMLImageElement>('[data-provider="douban"] img')!;
    expect(icon).toHaveAttribute('src', '/api/providers/douban/icon');
    expect(icon).toHaveAttribute('alt', '');
    const elsewhereIcons = [...alsoOn()!.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(elsewhereIcons).toEqual(['/api/providers/goodreads/icon', '/api/providers/worldcat/icon']);

    fireEvent.error(icon);
    expect(cards.querySelector('[data-provider="douban"] img')).toBeNull();
    // The name stays.
    expect(within(cards).getByRole('link', { name: /^Douban/ })).toBeInTheDocument();
  });

  it('lists providers without a score and WorldCat on one "Also on" line', async () => {
    serve('reader', () => rated);
    render(<App locale="en" />);
    await screen.findByRole('list', { name: catalogs.en.ratings.label });
    const line = alsoOn()!;
    expect(line).toHaveTextContent('Also on Goodreads · WorldCat');
    expect(within(line).getByRole('link', { name: 'Goodreads' })).toHaveAttribute('href', 'https://www.goodreads.com/book/show/99329011');
    expect(within(line).getByRole('link', { name: 'WorldCat' })).toHaveAttribute(
      'href',
      'https://search.worldcat.org/search?q=bn:9787010134185',
    );
    cleanup();

    // With no scores at all, only the line shows.
    serve('reader', () => ({ ...rated, ratings: rated.ratings!.filter((rating) => rating.provider === 'goodreads') }));
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale' });
    await waitFor(() => expect(alsoOn()).not.toBeNull());
    expect(screen.queryByRole('list', { name: catalogs.en.ratings.label })).not.toBeInTheDocument();
    expect(alsoOn()).toHaveTextContent('Also on Goodreads · WorldCat');
  });

  it('labels the cards in Chinese', async () => {
    serve('admin', () => ({ ...rated, ratings: [...rated.ratings!, { provider: 'google_books' as const, url: 'https://books.google.com/books?id=x', rating: 4, scale: 5, count: 12, fetchedAt: at }].filter((rating) => rating.url) }));
    render(<App locale="en" />);
    await screen.findByRole('list', { name: catalogs.en.ratings.label });
    fireEvent.change(screen.getByRole('combobox', { name: catalogs.en.shell.language }), { target: { value: 'zh-Hans' } });
    const zh = screen.getByRole('list', { name: catalogs['zh-Hans'].ratings.label });
    expect(within(zh).getAllByRole('link').map((link) => link.textContent)).toEqual([
      '豆瓣9.3/101,209 人评价',
      'Open Library3.95/5121 人评价',
      'Google 图书4.0/512 人评价',
    ]);
    expect(alsoOn()).toHaveTextContent('另见 Goodreads · WorldCat');
    expect(screen.getByRole('button', { name: catalogs['zh-Hans'].ratings.refresh })).toBeInTheDocument();
  });

  it('skips WorldCat when an identifier already links there', async () => {
    serve('reader', () => ({
      ...rated,
      identifiers: [{ scheme: 'isbn', value: '9780140328721', url: 'https://search.worldcat.org/search?q=bn:9780140328721' }],
    }));
    render(<App locale="en" />);
    await screen.findByRole('list', { name: catalogs.en.ratings.label });
    expect(within(alsoOn()!).queryByRole('link', { name: 'WorldCat' })).not.toBeInTheDocument();
  });

  it('gives readers no refresh control and renders nothing when there is nothing to show', async () => {
    let current: EditionDetail = { ...rated, ratings: rated.ratings!.slice(0, 3) };
    serve('reader', () => current);
    render(<App locale="en" />);
    expect(await screen.findByRole('list', { name: catalogs.en.ratings.label })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: catalogs.en.ratings.refresh })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Updated /)).not.toBeInTheDocument();
    cleanup();

    current = { ...edition, identifiers: [], ratings: [], ratingsPending: false };
    serve('reader', () => current);
    render(<App locale="en" />);
    expect(await screen.findByRole('heading', { name: 'The Tale' })).toBeInTheDocument();
    expect(document.querySelector('.book-ratings')).toBeNull();
    cleanup();

    // A first fetch still running shows nothing, not even the WorldCat link.
    current = { ...rated, ratings: [], ratingsPending: true };
    serve('reader', () => current);
    render(<App locale="en" />);
    expect(await screen.findByRole('heading', { name: 'The Tale' })).toBeInTheDocument();
    expect(document.querySelector('.book-ratings')).toBeNull();
  });

  it('gives an admin an icon refresh button and the update date on the "Also on" line', async () => {
    serve('admin', () => rated);
    render(<App locale="en" />);
    await screen.findByRole('list', { name: catalogs.en.ratings.label });
    const button = screen.getByRole('button', { name: catalogs.en.ratings.refresh });
    expect(button).toHaveTextContent('');
    expect(button.closest('.book-ratings-also')).toBe(alsoOn()!.parentElement);
    expect(screen.getByText(/^Updated /).closest('.book-ratings-also')).not.toBeNull();
  });

  it('lets an admin refresh, showing the pending state', async () => {
    const posts: string[] = [];
    serve('admin', () => rated, (url, init) => {
      if (url === '/api/editions/3/ratings/refresh' && init?.method === 'POST') {
        posts.push(url);
        return json({ edition: { ...rated, ratingsPending: true } }, 202);
      }
      return null;
    });
    render(<App locale="en" />);
    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.ratings.refresh }));
    const busy = await screen.findByRole('button', { name: catalogs.en.ratings.refreshing });
    expect(busy).toBeDisabled();
    expect(busy.querySelector('svg')).toHaveClass('spin');
    expect(posts).toEqual(['/api/editions/3/ratings/refresh']);
    // Scores already shown stay while the refresh runs.
    expect(screen.getByRole('link', { name: /^Douban/ })).toBeInTheDocument();
  });
});

describe('book page tabs', () => {
  const en = catalogs.en.book;
  const allTabs = [en.overview, en.series, en.filesExports, en.detailsTitle, en.suggestions];

  function serveEdition(current: EditionDetail, role: 'admin' | 'reader' = 'admin', path = '/books/3') {
    installFetch((url) => {
      if (url === '/api/me') return json({ ...admin, user: { ...admin.user, role } });
      if (url === '/api/editions/3') return json({ edition: current });
      return null;
    });
    window.history.pushState({}, '', path);
  }

  const withSeries: EditionDetail = {
    ...edition,
    neighbors: {
      previous: { id: 2, title: 'Earlier', seriesOrder: 0 },
      next: { id: 8, title: 'Later', seriesOrder: 2 },
      series: [
        { id: 2, title: 'Earlier', seriesOrder: 0 },
        { id: 3, title: 'The Tale', seriesOrder: 1 },
        { id: 8, title: 'Later', seriesOrder: 2 },
      ],
    },
  };

  /** The selected tab's name. */
  const selected = () => screen.getAllByRole('tab').filter((tab) => tab.getAttribute('aria-selected') === 'true').map((tab) => tab.textContent);

  it('puts the details into tabs right of the cover: Overview, Series, Files and exports, Details, Similar editions', async () => {
    serveEdition(withSeries);
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    // The card holds the whole page: the left column and the right column.
    expect([...jacket().children].map((child) => child.className)).toEqual(['book-jacket-side', 'book-jacket-body']);
    const tablist = screen.getByRole('tablist', { name: en.tabsLabel });
    expect(tabNames()).toEqual(allTabs);
    // The fixed head comes first, then the tab row, then the panels.
    const body = jacket().querySelector('.book-jacket-body')!;
    expect([...body.children].map((child) => child.getAttribute('role') ?? child.className)).toEqual([
      'book-hero',
      'tablist',
      'tabpanel',
      'tabpanel',
      'tabpanel',
      'tabpanel',
      'tabpanel',
    ]);
    expect(body.firstElementChild!.querySelector('h1')).toHaveTextContent('The Tale');
    // Each tab controls its panel, and each panel is labelled by its tab.
    for (const tab of within(tablist).getAllByRole('tab')) {
      const controlled = document.getElementById(tab.getAttribute('aria-controls')!)!;
      expect(controlled).toHaveAttribute('role', 'tabpanel');
      expect(controlled).toHaveAttribute('aria-labelledby', tab.id);
    }
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(en.overview);
    // Overview is selected and the only tab in the tab order; only its panel shows.
    expect(selected()).toEqual([en.overview]);
    expect(screen.getAllByRole('tab').map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    expect(panel('overview')).toBeVisible();
    for (const id of ['series', 'files', 'details', 'similar']) expect(panel(id)).not.toBeVisible();
    expect(window.location.hash).toBe('');
    // Overview: the quick facts, then the full description, with no teaser or More.
    const overview = panel('overview');
    expect(overview.querySelector('.book-glance')).not.toBeNull();
    expect(within(overview).getByText('A short book.')).toHaveClass('book-description');
    expect(within(overview).getByRole('heading', { name: en.description })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    // Series: the volumes, this one marked.
    openTab(en.series);
    const rows = within(within(panel('series')).getByRole('list', { name: catalogs.en.reading.neighbors })).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual(['0Earlier', '1The Tale', '2Later']);
    expect(within(rows[1]!).getByText('The Tale')).toHaveAttribute('aria-current', 'page');
    expect(within(rows[2]!).getByRole('link', { name: 'Later' })).toHaveAttribute('href', '/books/8');
    // Details: the full record, the identifiers and the closed editor.
    openTab(en.detailsTitle);
    const details = panel('details');
    expect(details.querySelector('.book-facts')).not.toBeNull();
    expect(details.querySelector('.identifier-block')).not.toBeNull();
    expect(within(details).getByText(en.editDetails).closest('details')).not.toHaveAttribute('open');
    expect(within(details).getByText(en.metadataAgent).closest('details')).not.toHaveAttribute('open');
  });

  it('rules off the foot of a panel only while its content is taller than the panel', async () => {
    // jsdom lays nothing out: each panel reports the content height set here over a 300px box.
    const contentHeights: Record<string, number> = {};
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tabpanel' ? 300 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tabpanel' ? (contentHeights[this.dataset.tab ?? ''] ?? 300) : 0;
    });
    const observers: { callback: () => void; targets: Element[] }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        record: { callback: () => void; targets: Element[] };
        constructor(callback: () => void) {
          this.record = { callback, targets: [] };
          observers.push(this.record);
        }
        observe(target: Element) {
          this.record.targets.push(target);
        }
        disconnect() {
          this.record.targets = [];
        }
      },
    );
    /** Reports a resize of the given panel to whoever watches it. */
    const resize = (id: string) =>
      act(() => {
        for (const observer of observers) if (observer.targets.includes(panel(id))) observer.callback();
      });
    contentHeights.overview = 200;
    contentHeights.details = 900;
    serveEdition(withSeries);
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });

    // A short panel has no rule at its foot.
    expect(panel('overview')).not.toHaveClass('book-tabpanel-overflow');
    // A panel that scrolls does, and the hidden ones never do.
    openTab(en.detailsTitle);
    expect(panel('details')).toHaveClass('book-tabpanel-overflow');
    expect(panel('overview')).not.toHaveClass('book-tabpanel-overflow');
    // The rule follows the content as it grows and shrinks.
    contentHeights.details = 280;
    resize('details');
    expect(panel('details')).not.toHaveClass('book-tabpanel-overflow');
    contentHeights.details = 640;
    resize('details');
    expect(panel('details')).toHaveClass('book-tabpanel-overflow');
    // Back on a short tab, it goes.
    openTab(en.overview);
    expect(panel('overview')).not.toHaveClass('book-tabpanel-overflow');
    expect(panel('details')).not.toHaveClass('book-tabpanel-overflow');
  });

  it('switches tabs on click and mirrors the active tab in the URL hash', async () => {
    serveEdition(withSeries);
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    const historyLength = window.history.length;
    openTab(en.filesExports);
    expect(selected()).toEqual([en.filesExports]);
    expect(panel('files')).toBeVisible();
    expect(panel('overview')).not.toBeVisible();
    expect(window.location.hash).toBe('#files');
    expect(window.location.pathname).toBe('/books/3');
    openTab(en.suggestions);
    expect(window.location.hash).toBe('#similar');
    // The hash is replaced in place, so the tabs do not pile up in the history.
    expect(window.history.length).toBe(historyLength);
    // A changed hash selects its tab.
    act(() => {
      window.history.replaceState(null, '', '#details');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(selected()).toEqual([en.detailsTitle]);
    expect(panel('details')).toBeVisible();
    cleanup();

    // The hash picks the tab on load.
    serveEdition(withSeries, 'admin', '/books/3#series');
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    expect(selected()).toEqual([en.series]);
    expect(panel('series')).toBeVisible();
    cleanup();

    // An unknown hash, or one naming a hidden tab, falls back to the first tab.
    for (const hash of ['#nothing', '#similar']) {
      serveEdition({ ...edition, suggestions: [] }, 'admin', `/books/3${hash}`);
      render(<App locale="en" />);
      await screen.findByRole('heading', { name: 'The Tale', level: 1 });
      expect(selected()).toEqual([en.overview]);
      cleanup();
    }
  });

  it('moves between the tabs with the arrow keys, Home and End, with a roving tabindex', async () => {
    serveEdition(withSeries);
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    const tab = (name: string) => screen.getByRole('tab', { name });
    const key = (name: string) => fireEvent.keyDown(document.activeElement!, { key: name });
    tab(en.overview).focus();
    key('ArrowRight');
    expect(tab(en.series)).toHaveFocus();
    expect(selected()).toEqual([en.series]);
    expect(panel('series')).toBeVisible();
    expect(screen.getAllByRole('tab').map((item) => item.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    expect(window.location.hash).toBe('#series');
    key('End');
    expect(tab(en.suggestions)).toHaveFocus();
    expect(selected()).toEqual([en.suggestions]);
    // The arrows wrap at both ends.
    key('ArrowRight');
    expect(tab(en.overview)).toHaveFocus();
    key('ArrowLeft');
    expect(tab(en.suggestions)).toHaveFocus();
    key('Home');
    expect(tab(en.overview)).toHaveFocus();
    expect(selected()).toEqual([en.overview]);
    key('ArrowLeft');
    key('ArrowLeft');
    expect(tab(en.detailsTitle)).toHaveFocus();
    expect(panel('details')).toBeVisible();
    // Other keys do nothing.
    key('ArrowDown');
    expect(tab(en.detailsTitle)).toHaveFocus();
    expect(selected()).toEqual([en.detailsTitle]);
  });

  it('hides tabs with nothing in them', async () => {
    serveEdition({
      ...edition,
      series: null,
      seriesOrder: null,
      description: null,
      suggestions: [],
      neighbors: { previous: null, next: null, series: [] },
    });
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    expect(tabNames()).toEqual([en.overview, en.filesExports, en.detailsTitle]);
    expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(3);
    // No filler for a missing description.
    expect(screen.queryByRole('heading', { name: en.description })).not.toBeInTheDocument();
    expect(screen.queryByText('No description yet.')).not.toBeInTheDocument();
    cleanup();

    // Nothing at a glance and no description: no Overview, and Files and exports comes first.
    serveEdition({
      ...edition,
      series: null,
      seriesOrder: null,
      description: null,
      publisher: null,
      publishedDate: null,
      language: null,
      assets: [],
      identifiers: [],
      suggestions: [],
      neighbors: { previous: null, next: null, series: [] },
    });
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    expect(tabNames()).toEqual([en.filesExports, en.detailsTitle]);
    expect(selected()).toEqual([en.filesExports]);
    expect(panel('files')).toBeVisible();
    cleanup();

    // A book in a series alone still has its Series tab, saying so.
    serveEdition({ ...edition, suggestions: [], neighbors: { previous: null, next: null, series: [] } });
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    expect(tabNames()).toEqual([en.overview, en.series, en.filesExports, en.detailsTitle]);
    openTab(en.series);
    expect(within(panel('series')).getByText(catalogs.en.reading.noNeighbors)).toBeVisible();
    expect(within(panel('series')).queryByRole('list')).not.toBeInTheDocument();
  });

  it('sets the Series tab under the series name with previous and next as small links beside it', async () => {
    serveEdition(withSeries);
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    openTab(en.series);
    const series = panel('series');
    const head = series.querySelector<HTMLElement>('.book-series-head')!;
    expect(within(head).getByRole('heading', { name: 'Letters' })).toBeInTheDocument();
    const previous = within(head).getByRole('link', { name: 'Previous: Earlier' });
    expect(previous).toHaveAttribute('href', '/books/2');
    expect(previous).toHaveAttribute('title', 'Earlier');
    expect(within(head).getByRole('link', { name: 'Next: Later' })).toHaveAttribute('href', '/books/8');
    // No separate previous/next box.
    expect(series.querySelector('.neighbor-grid, .neighbor-card')).toBeNull();
    cleanup();

    // Only the neighbour there is.
    serveEdition({ ...withSeries, neighbors: { ...withSeries.neighbors!, previous: null } });
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    openTab(en.series);
    expect(within(panel('series')).queryByRole('link', { name: /^Previous/ })).not.toBeInTheDocument();
    expect(within(panel('series')).getByRole('link', { name: 'Next: Later' })).toBeInTheDocument();
  });

  it('keeps each panel mounted with its state and its scroll position across switches', async () => {
    serveEdition(withSeries);
    render(<App locale="en" />);
    await openEditor();
    fireEvent.change(screen.getByLabelText(en.publisher), { target: { value: 'Unsaved Press' } });
    // jsdom has no layout; give the Details panel a scroll position of its own.
    const details = panel('details');
    let top = 0;
    Object.defineProperty(details, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });
    details.scrollTop = 240;
    fireEvent.scroll(details);
    openTab(en.filesExports);
    top = 0; // Hiding the panel drops its scroll position.
    openTab(en.detailsTitle);
    expect(details.scrollTop).toBe(240);
    expect(screen.getByText(en.editDetails).closest('details')).toHaveAttribute('open');
    expect(screen.getByLabelText(en.publisher)).toHaveValue('Unsaved Press');
  });

  it('switches to Details from Review on the lookup notice, opens the agent disclosure and focuses it', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    installFetch((url) => {
      if (url === '/api/editions/3') {
        return json({ edition: { ...edition, pendingLookup: { previewId: 7, createdAt: '2026-10-31T00:00:00.000Z', changedFields: ['publisher'] } } });
      }
      // The preview stays in flight until the end, so what Review does at once is what is checked.
      if (url === '/api/editions/3/metadata/previews/7') return held.then(() => json({ error: 'internal' }, 500));
      return null;
    });
    window.history.pushState({}, '', '/books/3#files');
    render(<App locale="en" />);
    fireEvent.click(await screen.findByRole('button', { name: en.lookupReview }));
    // At once, before the preview loads: Details, the open disclosure, focus on its summary.
    expect(selected()).toEqual([en.detailsTitle]);
    expect(window.location.hash).toBe('#details');
    const disclosure = document.querySelector<HTMLDetailsElement>('.book-lookup')!;
    expect(panel('details')).toContainElement(disclosure);
    expect(panel('details')).toBeVisible();
    expect(panel('files')).not.toBeVisible();
    expect(disclosure).toHaveAttribute('open');
    expect(disclosure.querySelector('summary')).toHaveFocus();
    expect(screen.getByRole('button', { name: en.runAgent })).toBeVisible();
    await act(async () => release());
  });

  it('keeps the full identifiers list only in Details; the overview shows just the first one', async () => {
    serveEdition({
      ...edition,
      identifiers: [
        { ...edition.identifiers[0]!, scheme: 'douban', value: '25869109' },
        { ...edition.identifiers[0]!, value: '9780000000002' },
      ],
    });
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    expect(jacket().querySelectorAll('.identifier-block')).toHaveLength(1);
    expect(panel('details')).toContainElement(jacket().querySelector('.identifier-block') as HTMLElement);
    expect(glanceRows().filter(([term]) => term === 'ISBN' || term === 'Douban')).toEqual([['ISBN', '9780000000002']]);
    expect(panel('overview')).not.toHaveTextContent('25869109');
  });

  it('tints the page ground from the cover, by day and by night, and falls back to stock without one', async () => {
    serveEdition({ ...edition, cover: { mediaType: 'image/jpeg' }, coverTint: { light: '#e6e7f3', dark: '#15151b' } });
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    const page = document.querySelector<HTMLElement>('.book-page')!;
    expect(page).toHaveAttribute('data-tint', 'cover');
    expect(page.style.getPropertyValue('--tint-day')).toBe('#e6e7f3');
    expect(page.style.getPropertyValue('--tint-night')).toBe('#15151b');
    // The ground holds the back link and the card; the card holds the cover plate.
    expect(within(page).getByRole('link', { name: catalogs.en.book.back })).toHaveAttribute('href', '/library');
    expect(page.querySelector('.book-jacket .cover-image')).toHaveAttribute('src', '/api/editions/3/cover');
    expect(page.querySelector('.book-band')).toBeNull();
    cleanup();

    for (const fallback of [{ cover: null, coverTint: null }, { cover: { mediaType: 'image/jpeg' }, coverTint: null }, { cover: null }]) {
      serveEdition({ ...edition, ...fallback });
      render(<App locale="en" />);
      await screen.findByRole('heading', { name: 'The Tale', level: 1 });
      const plain = document.querySelector<HTMLElement>('.book-page')!;
      expect(plain).toHaveAttribute('data-tint', 'stock');
      expect(plain.style.getPropertyValue('--tint-day')).toBe('');
      cleanup();
    }
  });

  it('lays out the card: title, authors, translators, ratings, tags, quick facts, Read buttons and reading controls', async () => {
    serveEdition({
      ...edition,
      title: 'A Very Long Title That Runs On',
      ratings: [
        { provider: 'douban', rating: 9.3, scale: 10, count: 209, url: 'https://book.douban.com/subject/25869109/', fetchedAt: '2026-10-31T00:00:00.000Z' },
        { provider: 'goodreads', rating: null, scale: 5, count: null, url: 'https://www.goodreads.com/book/show/1', fetchedAt: '2026-10-31T00:00:00.000Z' },
      ],
    } as EditionDetail);
    render(<App locale="en" />);
    const title = await screen.findByRole('heading', { name: 'A Very Long Title That Runs On', level: 1 });
    // The title is clamped on screen; the full title stays in its title attribute.
    expect(title).toHaveAttribute('title', 'A Very Long Title That Runs On');
    const card = jacket();
    const hero = card.querySelector<HTMLElement>('.book-hero')!;
    expect(hero.querySelector('.book-byline')).toHaveTextContent(/^Lin Qi$/);
    expect(within(hero).getByText('Translated by Wang')).toHaveClass('book-translators');
    expect(within(hero).getByRole('list', { name: catalogs.en.book.tags })).toHaveTextContent('essay');
    expect(within(hero).getByRole('list', { name: catalogs.en.ratings.label })).toBeInTheDocument();
    expect(within(hero).getByRole('link', { name: /Goodreads/ })).toHaveAttribute('href', 'https://www.goodreads.com/book/show/1');
    expect(panel('overview').querySelector('.book-glance')).toHaveAttribute('aria-label', catalogs.en.book.atAGlance);
    expect(glanceRows()).toEqual([
      ['Series', 'Letters · #1'],
      ['Publisher', 'Home Press'],
      ['Published', '2020'],
      ['Formats', 'EPUB · PDF'],
      ['Language', 'en'],
      ['ISBN', '9780000000002'],
    ]);
    expect(within(card).getByRole('group', { name: catalogs.en.reading.statusGroup })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: catalogs.en.reading.favorite })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: catalogs.en.reading.addQueue })).toBeInTheDocument();
    expect(within(card).getByRole('group', { name: catalogs.en.reading.rating })).toBeInTheDocument();
    // The reader's controls sit in the left column under the cover and Read; the right column holds none of them.
    expect(card.querySelector('.book-jacket-side .reading-panel')).not.toBeNull();
    expect(card.querySelector('.book-jacket-body .reading-panel')).toBeNull();
    // The status stepper, then favourite, queue and the stars on one row; Shelves is not here.
    const readingPanel = card.querySelector('.reading-panel')!;
    expect([...readingPanel.children].map((child) => child.className.split(' ')[0])).toEqual([
      'status-stepper',
      'reading-actions',
    ]);
    expect(within(side()).queryByRole('button', { name: catalogs.en.reading.shelves })).not.toBeInTheDocument();
    const row = readingPanel.querySelector<HTMLElement>('.reading-actions')!;
    expect(within(row).getByRole('button', { name: catalogs.en.reading.favorite })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: catalogs.en.reading.addQueue })).toBeInTheDocument();
    expect(within(row).getByRole('group', { name: catalogs.en.reading.rating })).toBeInTheDocument();
    // The states are not listed on the page; the stepper shows only the current one.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(within(card).queryByText(catalogs.en.reading.want)).not.toBeInTheDocument();
    expect(within(card).getByText(catalogs.en.reading.noStatus)).toBeInTheDocument();
    // Shelves is a closed panel button in the head, right after the title (the title row on desktop).
    const shelves = within(hero).getByRole('button', { name: catalogs.en.reading.shelves });
    expect(shelves.closest('.shelf-menu-root')!.previousElementSibling).toBe(title);
    expect(shelves).toHaveAttribute('aria-expanded', 'false');
    const shelfPanel = document.getElementById(shelves.getAttribute('aria-controls')!)!;
    expect(shelfPanel).not.toBeVisible();
    fireEvent.click(shelves);
    expect(shelves).toHaveAttribute('aria-expanded', 'true');
    expect(shelfPanel).toBeVisible();
    // Escape folds it and returns focus to the button.
    const newShelf = within(shelfPanel).getByRole('textbox', { name: catalogs.en.reading.newShelf });
    newShelf.focus();
    fireEvent.keyDown(newShelf, { key: 'Escape' });
    expect(shelves).toHaveAttribute('aria-expanded', 'false');
    expect(shelfPanel).not.toBeVisible();
    expect(shelves).toHaveFocus();
    // A press outside folds it too; a press inside does not.
    fireEvent.click(shelves);
    fireEvent.pointerDown(shelfPanel);
    expect(shelves).toHaveAttribute('aria-expanded', 'true');
    fireEvent.pointerDown(title);
    expect(shelves).toHaveAttribute('aria-expanded', 'false');

    // The cover opens the first readable file; it is a pointer shortcut for the Read button, out of the tab order.
    const coverLink = card.querySelector<HTMLAnchorElement>('.book-cover-link')!;
    expect(coverLink).toHaveAttribute('href', '/books/3/read/9');
    expect(coverLink).toHaveAttribute('tabindex', '-1');
    expect(coverLink).toHaveAttribute('aria-hidden', 'true');
    cleanup();

    // No readable file: no Read button and a plain cover.
    serveEdition({ ...edition, assets: edition.assets.map((asset) => ({ ...asset, availability: 'missing' as const })) });
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    expect(jacket().querySelector('.book-cover-link')).toBeNull();
    expect(within(side()).queryByRole('link', { name: /^Read / })).not.toBeInTheDocument();
  });

  it('labels Shelves with the one shelf holding the book, or counts several, in both locales', async () => {
    const onShelves = (included: number[]) => ({
      ...edition,
      reading: {
        status: null,
        rating: null,
        favorite: false,
        queued: false,
        shelves: [
          { id: 4, name: 'Weekend', included: included.includes(4) },
          { id: 5, name: 'Travel', included: included.includes(5) },
          { id: 6, name: 'Gifts', included: included.includes(6) },
        ],
      },
    });
    const trigger = () => within(jacket().querySelector<HTMLElement>('.book-hero')!).getByRole('button', { expanded: false });

    serveEdition(onShelves([]));
    let view = render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    expect(trigger()).toHaveAccessibleName(catalogs.en.reading.shelves);
    expect(trigger()).toHaveTextContent(/^Shelves$/);
    view.unmount();

    serveEdition(onShelves([5]));
    view = render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    expect(trigger()).toHaveTextContent(/^Travel$/);
    expect(trigger()).toHaveAccessibleName('Shelves: Travel');
    view.unmount();

    serveEdition(onShelves([4, 5, 6]));
    view = render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    expect(trigger()).toHaveTextContent(/^Shelves · 3$/);
    expect(trigger()).toHaveAccessibleName('Shelves: 3');
    view.unmount();

    serveEdition(onShelves([4, 6]));
    render(<App locale="zh-Hans" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    expect(trigger()).toHaveTextContent(/^书架 · 2$/);
    expect(trigger()).toHaveAccessibleName('书架：2 个');
  });

  it('gives readers the card and tabs without any admin-only item', async () => {
    serveEdition(
      {
        ...edition,
        pendingLookup: { previewId: 7, createdAt: '2026-10-31T08:43:12.928Z', changedFields: ['description'] },
        ratings: [
          { provider: 'douban', rating: 9.3, scale: 10, count: 209, url: 'https://book.douban.com/subject/25869109/', fetchedAt: '2026-10-31T00:00:00.000Z' },
        ],
      } as EditionDetail,
      'reader',
    );
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    expect(tabNames()).toEqual([en.overview, en.series, en.filesExports, en.detailsTitle, en.suggestions]);
    expect(within(side()).getByRole('link', { name: `${catalogs.en.book.read} EPUB` })).toBeInTheDocument();
    expect(document.querySelector('.book-lookup')).toBeNull();
    expect(document.querySelector('.lookup-notice')).toBeNull();
    expect(screen.queryByRole('button', { name: catalogs.en.book.lookupReview, hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: catalogs.en.book.runAgent, hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: catalogs.en.book.metadataAgent, hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: catalogs.en.ratings.refresh, hidden: true })).not.toBeInTheDocument();
    // Readers keep what they had: details, files and the editor.
    await openEditor();
    expect(screen.getByRole('textbox', { name: catalogs.en.book.title })).toBeVisible();
    expect(screen.queryByRole('button', { name: catalogs.en.book.runAgent, hidden: true })).not.toBeInTheDocument();
  });

  it('puts the Read button in the left column right after the cover, with further formats as outline buttons', async () => {
    serveEdition(edition);
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    const card = jacket();
    // The left column comes first in the card: the cover, then the Read buttons.
    const left = card.firstElementChild!;
    expect(left).toHaveClass('book-jacket-side');
    expect(left.firstElementChild).toHaveClass('book-jacket-cover');
    const reads = left.firstElementChild!.nextElementSibling!;
    expect(reads).toHaveClass('book-read-actions');
    const links = within(reads as HTMLElement).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([`${catalogs.en.book.read} EPUB`, `${catalogs.en.book.read} PDF`]);
    expect(links[0]).toHaveClass('btn-primary');
    expect(links[1]).not.toHaveClass('btn-primary');
    // The cover, Read and the reader's controls come before the title block and tabs in reading order.
    expect([...card.children].map((child) => child.className)).toEqual(['book-jacket-side', 'book-jacket-body']);
    expect(reads.nextElementSibling).toHaveClass('reading-panel');
  });

  it('shows only the quick facts that have values, and leaves the list out when none do', async () => {
    serveEdition({
      ...edition,
      series: null,
      seriesOrder: null,
      publisher: null,
      assets: [edition.assets[1]!],
      identifiers: [{ ...edition.identifiers[0]!, scheme: 'douban', value: '25869109', url: 'https://book.douban.com/subject/25869109/' }],
    });
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    expect(glanceRows()).toEqual([
      ['Published', '2020'],
      ['Format', 'PDF'],
      ['Language', 'en'],
      ['Douban', '25869109'],
    ]);
    // The first identifier is linked to its record when it has one.
    const glance = () => jacket().querySelector<HTMLElement>('.book-glance')!;
    expect(within(glance()).getByRole('link', { name: '25869109' })).toHaveAttribute('href', 'https://book.douban.com/subject/25869109/');
    cleanup();

    // An ISBN wins over an earlier identifier of another scheme.
    serveEdition({
      ...edition,
      identifiers: [
        { ...edition.identifiers[0]!, scheme: 'douban', value: '25869109' },
        { ...edition.identifiers[0]!, url: 'https://openlibrary.org/isbn/9780000000002' },
      ],
    });
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    expect(glanceRows().at(-1)).toEqual(['ISBN', '9780000000002']);
    expect(within(glance()).getByRole('link', { name: '9780000000002' })).toHaveAttribute('href', 'https://openlibrary.org/isbn/9780000000002');
    cleanup();

    serveEdition({
      ...edition,
      series: null,
      seriesOrder: null,
      publisher: null,
      publishedDate: null,
      language: null,
      assets: [],
      identifiers: [],
      tags: [],
    });
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    expect(jacket().querySelector('.book-glance')).toBeNull();
    expect(within(jacket()).queryByRole('list', { name: catalogs.en.book.tags })).not.toBeInTheDocument();
  });

  it('switches to the Series tab from the series quick fact and focuses its heading', async () => {
    serveEdition(withSeries);
    render(<App locale="en" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    const link = within(panel('overview')).getByRole('link', { name: 'Letters · #1' });
    expect(link).toHaveAttribute('href', '#series');
    fireEvent.click(link);
    expect(selected()).toEqual([en.series]);
    expect(panel('series')).toBeVisible();
    expect(within(panel('series')).getByRole('heading', { name: 'Letters' })).toHaveFocus();
    expect(window.location.hash).toBe('#series');
  });

  it('labels the tabs in Chinese', async () => {
    serveEdition(withSeries);
    render(<App locale="zh-Hans" />);
    await screen.findByRole('heading', { name: 'The Tale', level: 1 });
    const zh = catalogs['zh-Hans'].book;
    expect(screen.getByRole('tablist', { name: zh.tabsLabel })).toBeInTheDocument();
    expect(tabNames()).toEqual([zh.overview, zh.series, zh.filesExports, zh.detailsTitle, zh.suggestions]);
    expect(within(jacket()).getByText('Wang 译')).toBeInTheDocument();
  });
});

describe('reading status stepper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Serves the book with a status; `respond` can hold or fail a status save. */
  function serveStatus(
    status: ReadingStatus | null,
    options: { role?: 'admin' | 'reader'; respond?: (body: Record<string, unknown>) => Response | Promise<Response> | null } = {},
  ) {
    const requests: { body: unknown; keepalive?: boolean }[] = [];
    let current: EditionDetail = {
      ...edition,
      reading: { status, rating: null, favorite: false, queued: false, shelves: [] },
    };
    installFetch((url, init) => {
      if (url === '/api/me' && options.role === 'reader') {
        return json({ user: { id: 2, username: 'bea', role: 'reader' }, libraries: admin.libraries });
      }
      if (url === '/api/editions/3' && (!init?.method || init.method === 'GET')) return json({ edition: current });
      if (url === '/api/editions/3/reading' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push(init.keepalive ? { body, keepalive: true } : { body });
        const held = options.respond?.(body);
        if (held) return held;
        current = { ...current, reading: { ...current.reading!, ...body } };
        return json({ edition: current });
      }
      return null;
    });
    window.history.pushState({}, '', '/books/3');
    return requests;
  }

  /** Renders the page, waits for the stepper and then fakes the timers for the debounce. */
  async function renderStepper(locale: 'en' | 'zh-Hans' = 'en') {
    const view = render(<App locale={locale} />);
    const group = await screen.findByRole('group', { name: catalogs[locale].reading.statusGroup });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const [previous, next] = within(group).getAllByRole('button');
    return { view, group, previous: previous!, next: next!, shown: () => within(group).getByRole('status') };
  }

  /** The progress line's state: the status it shows, each segment's fill, the current stage and the names. */
  function progress(group: HTMLElement) {
    const line = group.querySelector<HTMLElement>('.status-progress')!;
    const stages = [...line.querySelectorAll<HTMLElement>('.status-progress-stage')];
    return {
      status: line.dataset.status,
      fills: stages.map((stage) => stage.dataset.fill),
      current: stages.findIndex((stage) => stage.hasAttribute('data-current')),
      names: stages.map((stage) => stage.textContent),
    };
  }

  it('steps through none, want, reading, on hold and finished, with the chevron disabled at each end', async () => {
    const requests = serveStatus(null);
    const { group, previous, next, shown } = await renderStepper();
    expect(group.querySelector('.status-progress')).toHaveAttribute('aria-hidden', 'true');
    expect(shown()).toHaveAttribute('aria-live', 'polite');
    expect(shown()).toHaveTextContent(catalogs.en.reading.noStatus);
    expect(progress(group).status).toBe('none');
    expect(previous).toHaveAttribute('aria-disabled', 'true');
    expect(previous).toHaveAccessibleName('Previous status');
    expect(next).not.toHaveAttribute('aria-disabled');
    expect(next).toHaveAccessibleName('Next status: Want to read');
    // The disabled chevron does nothing.
    fireEvent.click(previous);
    expect(shown()).toHaveTextContent(catalogs.en.reading.noStatus);

    const seen: (string | null)[] = [];
    for (let step = 0; step < 4; step += 1) {
      fireEvent.click(next);
      seen.push(shown().querySelector('.status-mark')!.className);
    }
    expect(seen).toEqual([
      'status-mark status-mark-want',
      'status-mark status-mark-reading',
      'status-mark status-mark-on_hold',
      'status-mark status-mark-finished',
    ]);
    expect(progress(group).status).toBe('finished');
    expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(next).toHaveAccessibleName('Next status');
    expect(previous).not.toHaveAttribute('aria-disabled');
    expect(previous).toHaveAccessibleName('Previous status: On hold');
    // No wrapping past the end.
    fireEvent.click(next);
    expect(shown()).toHaveTextContent(catalogs.en.reading.finished);
    // The label slides in from the side it came from.
    expect(shown().firstElementChild).toHaveClass('status-stepper-from-previous');
    fireEvent.click(previous);
    expect(shown().firstElementChild).toHaveClass('status-stepper-from-next');
    expect(shown()).toHaveTextContent(catalogs.en.reading.on_hold);
    expect(previous).toHaveAccessibleName('Previous status: Reading');
    expect(next).toHaveAccessibleName('Next status: Finished');

    await advance(500);
    expect(requests).toEqual([{ body: { status: 'on_hold' } }]);
  });

  it('fills the progress line by stage: hairlines for none, ink up to the current stage, dashed while on hold', async () => {
    serveStatus(null);
    const { group, next } = await renderStepper();
    const states = [progress(group)];
    for (let step = 0; step < 4; step += 1) {
      fireEvent.click(next);
      states.push(progress(group));
    }
    const names = ['Want', 'Reading', 'Done'];
    expect(states).toEqual([
      { status: 'none', fills: ['empty', 'empty', 'empty'], current: -1, names },
      { status: 'want', fills: ['solid', 'empty', 'empty'], current: 0, names },
      { status: 'reading', fills: ['solid', 'solid', 'empty'], current: 1, names },
      { status: 'on_hold', fills: ['paused', 'paused', 'empty'], current: 1, names },
      { status: 'finished', fills: ['solid', 'solid', 'solid'], current: 2, names },
    ]);
  });

  it('debounces: quick steps send one request with the final state, and a return to the saved state sends nothing', async () => {
    const requests = serveStatus('want');
    const { previous, next, shown } = await renderStepper();
    fireEvent.click(next);
    await advance(200);
    fireEvent.click(next);
    await advance(200);
    fireEvent.click(next);
    expect(shown()).toHaveTextContent(catalogs.en.reading.finished);
    await advance(499);
    expect(requests).toEqual([]);
    await advance(1);
    expect(requests).toEqual([{ body: { status: 'finished' } }]);
    await advance(0);

    // Away and back again before the debounce ends: nothing to save.
    fireEvent.click(previous);
    fireEvent.click(next);
    await advance(1000);
    expect(requests).toHaveLength(1);

    // Stepping back to no status sends a null status.
    for (let step = 0; step < 4; step += 1) fireEvent.click(previous);
    expect(shown()).toHaveTextContent(catalogs.en.reading.noStatus);
    await advance(500);
    expect(requests).toEqual([{ body: { status: 'finished' } }, { body: { status: null } }]);
  });

  it('keeps stepping while a save is in flight and saves the newest state after it', async () => {
    let release: () => void = () => {};
    const requests = serveStatus('reading', {
      respond: (body) =>
        body.status === 'on_hold'
          ? new Promise<Response>((resolve) => {
              release = () => resolve(json({ edition: { ...edition, reading: { status: 'on_hold', rating: null, favorite: false, queued: false, shelves: [] } } }));
            })
          : null,
    });
    const { previous, next, shown } = await renderStepper();
    fireEvent.click(next);
    await advance(500);
    expect(requests).toEqual([{ body: { status: 'on_hold' } }]);
    expect(screen.getByRole('button', { name: catalogs.en.reading.favorite })).toBeDisabled();

    fireEvent.click(next);
    expect(shown()).toHaveTextContent(catalogs.en.reading.finished);
    fireEvent.click(previous);
    fireEvent.click(previous);
    expect(shown()).toHaveTextContent(catalogs.en.reading.reading);
    await advance(500);
    // The next save waits for the one in flight.
    expect(requests).toHaveLength(1);
    release();
    await advance(0);
    expect(requests).toEqual([{ body: { status: 'on_hold' } }, { body: { status: 'reading' } }]);
    await advance(0);
    expect(shown()).toHaveTextContent(catalogs.en.reading.reading);
    expect(screen.getByRole('button', { name: catalogs.en.reading.favorite })).toBeEnabled();
  });

  it('falls back to the last saved state and shows the error when a save fails', async () => {
    const requests = serveStatus('reading', { respond: () => json({ error: 'forbidden' }, 403) });
    const { group, previous, next, shown } = await renderStepper();
    fireEvent.click(next);
    fireEvent.click(next);
    expect(shown()).toHaveTextContent(catalogs.en.reading.finished);
    await advance(500);
    await advance(0);
    expect(requests).toEqual([{ body: { status: 'finished' } }]);
    expect(screen.getByRole('alert')).toHaveTextContent(catalogs.en.errors.forbidden);
    expect(shown()).toHaveTextContent(catalogs.en.reading.reading);
    expect(progress(group).status).toBe('reading');
    expect(previous).toHaveAccessibleName('Previous status: Want to read');
    expect(next).toHaveAccessibleName('Next status: On hold');
  });

  it('steps with the Left and Right arrow keys while focus is in the group', async () => {
    const requests = serveStatus('want');
    const { group, next, shown } = await renderStepper();
    next.focus();
    fireEvent.keyDown(next, { key: 'ArrowRight' });
    expect(shown()).toHaveTextContent(catalogs.en.reading.reading);
    fireEvent.keyDown(next, { key: 'ArrowRight' });
    expect(shown()).toHaveTextContent(catalogs.en.reading.on_hold);
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(shown()).toHaveTextContent(catalogs.en.reading.reading);
    fireEvent.keyDown(next, { key: 'ArrowDown' });
    expect(shown()).toHaveTextContent(catalogs.en.reading.reading);
    expect(next).toHaveFocus();
    await advance(500);
    expect(requests).toEqual([{ body: { status: 'reading' } }]);
  });

  it('names the group and the chevrons in Chinese', async () => {
    serveStatus('reading');
    const { group, previous, next, shown } = await renderStepper('zh-Hans');
    expect(group).toHaveAccessibleName('阅读状态');
    expect(shown()).toHaveTextContent('在读');
    expect(previous).toHaveAccessibleName('上一个状态：想读');
    expect(next).toHaveAccessibleName('下一个状态：搁置');
    expect(progress(group).names).toEqual(['想读', '在读', '读完']);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(next).toHaveAccessibleName('下一个状态');
    for (let step = 0; step < 4; step += 1) fireEvent.click(previous);
    expect(shown()).toHaveTextContent('未设置状态');
    expect(previous).toHaveAccessibleName('上一个状态');
  });

  it('lets a reader set their own status', async () => {
    const requests = serveStatus(null, { role: 'reader' });
    const { next, shown } = await renderStepper();
    fireEvent.click(next);
    fireEvent.click(next);
    await advance(500);
    await advance(0);
    expect(requests).toEqual([{ body: { status: 'reading' } }]);
    expect(shown()).toHaveTextContent(catalogs.en.reading.reading);
  });

  it('sends a waiting step at once when the page is left', async () => {
    const requests = serveStatus('want');
    const { next } = await renderStepper();
    fireEvent.click(next);
    window.dispatchEvent(new Event('pagehide'));
    await advance(0);
    expect(requests).toEqual([{ body: { status: 'reading' }, keepalive: true }]);
    // Nothing is left to send afterwards.
    await advance(1000);
    expect(requests).toHaveLength(1);
  });
});
