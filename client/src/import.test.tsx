import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { ImportJob, MetadataTrajectory, TrajectoryStep } from './api';
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
  libraries: [
    { id: 1, name: 'Home', mode: 'managed' as const },
    { id: 2, name: 'Shelf', mode: 'indexed' as const },
  ],
};

const reader = {
  user: { id: 2, username: 'bea', role: 'reader' as const },
  libraries: [{ id: 1, name: 'Home', mode: 'managed' as const }],
};

function installFetch(
  jobs: () => Response,
  options: { me?: typeof admin | typeof reader; extra?: (url: string) => Response | null } = {},
) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === '/api/setup') return Promise.resolve(json({ needed: false }));
    if (url === '/api/me') return Promise.resolve(json(options.me ?? admin));
    if (url === '/api/jobs') return Promise.resolve(jobs());
    const handled = options.extra?.(url);
    if (handled) return Promise.resolve(handled);
    return Promise.resolve(json({ error: 'not_found' }, 404));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ALL_STEPS: TrajectoryStep[] = [
  {
    seq: 1,
    kind: 'input',
    at: '2026-01-01T00:00:01.000Z',
    data: { prompt: 'metadata-assistant', model: 'scripted-model', input: { filename: 'tale.epub', format: 'epub', fields: {} } },
  },
  {
    seq: 2,
    kind: 'model',
    at: '2026-01-01T00:00:02.000Z',
    data: { turn: 1, text: 'Searching by title first.', toolCalls: ['search_open_library'], durationMs: 820 },
  },
  {
    seq: 3,
    kind: 'tool_call',
    at: '2026-01-01T00:00:02.000Z',
    data: { turn: 1, callId: 'c1', name: 'search_open_library', args: { title: 'The Tale' } },
  },
  {
    seq: 4,
    kind: 'tool_result',
    at: '2026-01-01T00:00:03.000Z',
    data: {
      callId: 'c1',
      name: 'search_open_library',
      summary: { count: 5, key: '/works/OL123W', title: 'The Tale' },
      result: '{"results":[{"key":"/works/OL123W","title":"The Tale"}]}',
      truncated: false,
      durationMs: 410,
    },
  },
  {
    seq: 5,
    kind: 'model',
    at: '2026-01-01T00:00:04.000Z',
    data: { turn: 2, text: null, toolCalls: ['submit_metadata'], durationMs: 1300 },
  },
  {
    seq: 6,
    kind: 'submit',
    at: '2026-01-01T00:00:04.000Z',
    data: { turn: 2, callId: 'c2', accepted: false, error: 'metadata_incomplete', missing: ['publisher'], args: { title: 'The Tale' } },
  },
  {
    seq: 7,
    kind: 'end',
    at: '2026-01-01T00:00:04.000Z',
    data: { outcome: 'limit', error: 'metadata_incomplete', reason: null, turns: 4, toolCalls: 6, totalMs: 4200 },
  },
];

function trajectoryOf(count: number): MetadataTrajectory {
  const steps = ALL_STEPS.slice(0, count);
  const end = steps.find((step) => step.kind === 'end');
  return {
    id: 21,
    jobId: 9,
    jobItemId: 8,
    editionId: null,
    previewId: null,
    model: 'scripted-model',
    outcome: end ? 'limit' : null,
    error: end ? 'metadata_incomplete' : null,
    summary: end ? { turns: 4, toolCalls: 6, totalMs: 4200 } : null,
    truncated: false,
    stepCount: steps.length,
    createdAt: '2026-01-01T00:00:01.000Z',
    updatedAt: '2026-01-01T00:00:04.000Z',
    steps,
  };
}

function trajectoryJob(item: Partial<ImportJob['items'][number]>, status: ImportJob['status'] = 'succeeded'): ImportJob {
  return {
    id: 9,
    libraryId: 1,
    source: 'upload',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:04.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: status === 'running' ? null : '2026-01-01T00:00:04.000Z',
    result: null,
    summary: { total: 1, queued: 0, running: status === 'running' ? 1 : 0, succeeded: 0, failed: status === 'running' ? 0 : 1, duplicate: 0, needs_confirmation: 0 },
    items: [
      {
        id: 8,
        position: 0,
        filename: 'tale.epub',
        status: status === 'running' ? 'running' : 'failed',
        error: status === 'running' ? null : 'metadata_incomplete',
        editionId: null,
        assetId: null,
        sha256: null,
        candidateEditionId: null,
        conflicts: [],
        merged: false,
        resolution: null,
        ...item,
      },
    ],
  };
}

function renderImport(locale: 'en' | 'zh-Hans' = 'en') {
  window.history.pushState({}, '', '/import');
  return render(<App locale={locale} />);
}

describe('import screen', () => {
  it('sends the keep-private choice with the upload batch, and words it in Chinese', async () => {
    const fetchMock = installFetch(() => json({ jobs: [] }), {
      extra: (url) => (url.startsWith('/api/imports?') ? json({ job: { id: 5 } }, 202) : null),
    });
    renderImport('en');
    expect(await screen.findByText(catalogs.en.import.empty)).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: catalogs.en.metadataPrivate.label });
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleDescription(catalogs.en.metadataPrivate.hint);
    const input = screen.getByLabelText(catalogs.en.import.files) as HTMLInputElement;
    const file = new File(['x'], 'secret.epub', { type: 'application/epub+zip' });

    fireEvent.click(box);
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.import.upload }));
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([request]) => String(request));
      expect(urls).toContain('/api/imports?libraryId=1&private=1');
    });

    fireEvent.click(box);
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.import.upload }));
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([request]) => String(request));
      expect(urls).toContain('/api/imports?libraryId=1');
    });

    fireEvent.change(screen.getByLabelText(catalogs.en.shell.language), { target: { value: 'zh-Hans' } });
    expect(screen.getByRole('checkbox', { name: catalogs['zh-Hans'].metadataPrivate.label })).toBeInTheDocument();
    expect(catalogs['zh-Hans'].metadataPrivate.label).toBe('不交给元数据助手（保持私密）');
    expect(screen.getByText(catalogs['zh-Hans'].metadataPrivate.hint)).toBeInTheDocument();
    expect(catalogs['zh-Hans'].metadataPrivate.mark).toBe('私密');
    expect(catalogs['zh-Hans'].errors.metadata_private).toBeTruthy();
  });

  it('shows an empty import in English and Simplified Chinese', async () => {
    installFetch(() => json({ jobs: [] }));
    renderImport('en');
    expect(await screen.findByRole('heading', { name: catalogs.en.import.title })).toBeInTheDocument();
    expect(await screen.findByText(catalogs.en.import.empty)).toBeInTheDocument();
    expect(screen.getByLabelText(catalogs.en.import.files)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: catalogs.en.import.upload })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(catalogs.en.shell.language), { target: { value: 'zh-Hans' } });
    expect(screen.getByRole('heading', { name: catalogs['zh-Hans'].import.title })).toBeInTheDocument();
    expect(screen.getByText(catalogs['zh-Hans'].import.empty)).toBeInTheDocument();
    expect(screen.getByLabelText(catalogs['zh-Hans'].import.files)).toBeInTheDocument();
  });

  it('shows queued, running, succeeded, and failed files with a completion summary', async () => {
    const job: ImportJob = {
      id: 4,
      libraryId: 1,
      source: 'upload',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      startedAt: '2026-01-01T00:00:01.000Z',
      finishedAt: null,
      result: null,
      summary: { total: 4, queued: 1, running: 1, succeeded: 1, failed: 1, duplicate: 0, needs_confirmation: 0 },
      items: [
        { id: 1, position: 0, filename: 'tale.epub', status: 'succeeded', error: null, editionId: 1, assetId: 1, sha256: 'abc', candidateEditionId: null, conflicts: [], merged: false, resolution: null },
        { id: 2, position: 1, filename: 'page.pdf', status: 'running', error: null, editionId: null, assetId: null, sha256: null, candidateEditionId: null, conflicts: [], merged: false, resolution: null },
        { id: 3, position: 2, filename: 'next.pdf', status: 'queued', error: null, editionId: null, assetId: null, sha256: null, candidateEditionId: null, conflicts: [], merged: false, resolution: null },
        { id: 4, position: 3, filename: 'broken.epub', status: 'failed', error: 'malformed', editionId: null, assetId: null, sha256: null, candidateEditionId: null, conflicts: [], merged: false, resolution: null },
      ],
    };
    installFetch(() => json({ jobs: [job] }));
    renderImport('en');
    expect(await screen.findByText(catalogs.en.import.running)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: catalogs.en.import.summary })).toBeInTheDocument();
    for (const status of ['queued', 'running', 'succeeded', 'failed'] as const) {
      expect(screen.getAllByText(catalogs.en.import.status[status]).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('tale.epub')).toBeInTheDocument();
    expect(screen.getByText('broken.epub')).toBeInTheDocument();
    expect(screen.getByText(/Malformed file/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(catalogs.en.shell.language), { target: { value: 'zh-Hans' } });
    expect(screen.getByText(catalogs['zh-Hans'].import.running)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: catalogs['zh-Hans'].import.summary })).toBeInTheDocument();
    for (const status of ['queued', 'running', 'succeeded', 'failed'] as const) {
      expect(screen.getAllByText(catalogs['zh-Hans'].import.status[status]).length).toBeGreaterThan(0);
    }
  });

  it('shows metadata agent failures on each item in English and Simplified Chinese', async () => {
    const job: ImportJob = {
      id: 5,
      libraryId: 1,
      source: 'upload',
      status: 'failed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:02.000Z',
      startedAt: '2026-01-01T00:00:01.000Z',
      finishedAt: '2026-01-01T00:00:02.000Z',
      result: null,
      summary: { total: 2, queued: 0, running: 0, succeeded: 0, failed: 2, duplicate: 0, needs_confirmation: 0 },
      items: [
        {
          id: 6,
          position: 0,
          filename: 'incomplete.epub',
          status: 'failed',
          error: 'metadata_incomplete',
          editionId: null,
          assetId: null,
          sha256: null,
          candidateEditionId: null,
          conflicts: [],
          merged: false,
          resolution: null,
        },
        {
          id: 7,
          position: 1,
          filename: 'unconfigured.pdf',
          status: 'failed',
          error: 'metadata_assistant_unconfigured',
          editionId: null,
          assetId: null,
          sha256: null,
          candidateEditionId: null,
          conflicts: [],
          merged: false,
          resolution: null,
        },
      ],
    };
    installFetch(() => json({ jobs: [job] }));
    renderImport('en');
    expect(
      await screen.findByText(new RegExp(catalogs.en.import.fileError.metadata_incomplete)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(catalogs.en.import.fileError.metadata_assistant_unconfigured)),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(catalogs.en.shell.language), { target: { value: 'zh-Hans' } });
    expect(
      screen.getByText(new RegExp(catalogs['zh-Hans'].import.fileError.metadata_incomplete)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(catalogs['zh-Hans'].import.fileError.metadata_assistant_unconfigured)),
    ).toBeInTheDocument();
  });

  it('opens an item trajectory with readable steps, links, durations, and a raw view', async () => {
    installFetch(() => json({ jobs: [trajectoryJob({ trajectoryId: 21, trajectoryStepCount: 7 })] }), {
      extra: (url) => (url === '/api/metadata/trajectories/21' ? json({ trajectory: trajectoryOf(7) }) : null),
    });
    renderImport('en');
    const toggle = await screen.findByRole('button', { name: catalogs.en.trajectory.title });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    expect(await screen.findByText(catalogs.en.trajectory.step.search)).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.trajectory.step.input)).toBeInTheDocument();
    expect(screen.getByText('tale.epub · EPUB')).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.trajectory.step.note)).toBeInTheDocument();
    expect(screen.getByText('Searching by title first.')).toBeInTheDocument();
    expect(screen.getByText('The Tale', { selector: '.trajectory-detail' })).toBeInTheDocument();
    expect(screen.getByText('5 results')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '/works/OL123W' })).toHaveAttribute('href', 'https://openlibrary.org/works/OL123W');
    expect(screen.getByText('410 ms')).toBeInTheDocument();
    expect(screen.getByText('Model turn 2')).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.trajectory.step.rejected)).toBeInTheDocument();
    expect(screen.getByText('Missing: publisher')).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.trajectory.outcome.limit)).toBeInTheDocument();
    expect(screen.getByText('4 turns · 6 tool calls · 4.2 s')).toBeInTheDocument();
    expect(screen.queryByText(catalogs.en.trajectory.working)).not.toBeInTheDocument();

    const raws = screen.getAllByRole('button', { name: catalogs.en.trajectory.raw });
    expect(raws).toHaveLength(5);
    const searchRow = screen.getByText(catalogs.en.trajectory.step.search).closest('li')!;
    const raw = within(searchRow).getByRole('button', { name: catalogs.en.trajectory.raw });
    expect(raw).toHaveAttribute('aria-expanded', 'false');
    expect(searchRow.querySelector('pre')).toBeNull();
    fireEvent.click(raw);
    expect(raw).toHaveAttribute('aria-expanded', 'true');
    const block = searchRow.querySelector('pre')!;
    expect(JSON.parse(block.textContent ?? '')).toEqual({
      args: { title: 'The Tale' },
      result: { results: [{ key: '/works/OL123W', title: 'The Tale' }] },
    });
    fireEvent.click(raw);
    expect(searchRow.querySelector('pre')).toBeNull();

    fireEvent.change(screen.getByLabelText(catalogs.en.shell.language), { target: { value: 'zh-Hans' } });
    expect(screen.getByText(catalogs['zh-Hans'].trajectory.step.search)).toBeInTheDocument();
    expect(screen.getByText(catalogs['zh-Hans'].trajectory.outcome.limit)).toBeInTheDocument();
  });

  it('labels web search, page reads, and Google Books with linked hosts', async () => {
    const searchResult = JSON.stringify({
      query: '三体 site:book.douban.com',
      results: [
        { title: '三体 (豆瓣)', url: 'https://book.douban.com/subject/2567698/', host: 'book.douban.com' },
        { title: 'Three-Body Press', url: 'https://press.example.com/santi', host: 'press.example.com' },
      ],
    });
    const steps: TrajectoryStep[] = [
      { seq: 1, kind: 'tool_call', at: '2026-01-01T00:00:01.000Z', data: { turn: 1, callId: 'g', name: 'google_books', args: { isbn: '9787536692930' } } },
      {
        seq: 2,
        kind: 'tool_result',
        at: '2026-01-01T00:00:02.000Z',
        data: {
          callId: 'g',
          name: 'google_books',
          summary: { error: 'rate_limited', detail: 'Google Books anonymous shared quota is exhausted (HTTP 429).' },
          result: '{"error":"rate_limited"}',
          truncated: false,
          durationMs: 120,
        },
      },
      { seq: 3, kind: 'tool_call', at: '2026-01-01T00:00:02.000Z', data: { turn: 1, callId: 's', name: 'web_search', args: { query: '三体 site:book.douban.com' } } },
      {
        seq: 4,
        kind: 'tool_result',
        at: '2026-01-01T00:00:03.000Z',
        data: { callId: 's', name: 'web_search', summary: { count: 2, title: '三体 (豆瓣)' }, result: searchResult, truncated: false, durationMs: 900 },
      },
      {
        seq: 5,
        kind: 'tool_call',
        at: '2026-01-01T00:00:03.000Z',
        data: { turn: 2, callId: 'f', name: 'fetch_page', args: { url: 'https://book.douban.com/subject/2567698/' } },
      },
      {
        seq: 6,
        kind: 'tool_result',
        at: '2026-01-01T00:00:04.000Z',
        data: {
          callId: 'f',
          name: 'fetch_page',
          summary: { title: '三体 (豆瓣)', host: 'book.douban.com', url: 'https://book.douban.com/subject/2567698/', truncated: true },
          result: '{"title":"三体 (豆瓣)","content":"# 三体"}',
          truncated: false,
          durationMs: 1500,
        },
      },
      {
        seq: 7,
        kind: 'tool_call',
        at: '2026-01-01T00:00:04.000Z',
        data: { turn: 2, callId: 'v', name: 'google_books', args: { query: 'intitle:三体' } },
      },
      {
        seq: 8,
        kind: 'tool_result',
        at: '2026-01-01T00:00:05.000Z',
        data: { callId: 'v', name: 'google_books', summary: { count: 2, key: 'abc', title: '三体' }, result: '{"volumes":[]}', truncated: false, durationMs: 300 },
      },
    ];
    const trajectory: MetadataTrajectory = { ...trajectoryOf(0), steps, stepCount: steps.length };
    installFetch(() => json({ jobs: [trajectoryJob({ trajectoryId: 21, trajectoryStepCount: steps.length }, 'running')] }), {
      extra: (url) => (url === '/api/metadata/trajectories/21' ? json({ trajectory }) : null),
    });
    renderImport('en');
    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.trajectory.title }));

    const labels = catalogs.en.trajectory.step;
    expect(await screen.findByText(labels.webSearch)).toBeInTheDocument();
    expect(screen.getAllByText(labels.googleBooks)).toHaveLength(2);
    expect(screen.getByText(labels.fetchPage)).toBeInTheDocument();
    expect(screen.queryByText(/Called /)).not.toBeInTheDocument();

    // Google Books: the ISBN as the query and the quota message beside the error code.
    expect(screen.getByText('9787536692930', { selector: '.trajectory-detail' })).toBeInTheDocument();
    expect(screen.getByText('Error: rate_limited')).toBeInTheDocument();
    expect(screen.getByText(/anonymous shared quota is exhausted/)).toBeInTheDocument();
    expect(screen.getByText('2 volumes')).toBeInTheDocument();

    // Web search: the query and the result count.
    const searchRow = screen.getByText(labels.webSearch).closest('li')!;
    expect(within(searchRow).getByText('三体 site:book.douban.com')).toBeInTheDocument();
    expect(within(searchRow).getByText('2 results')).toBeInTheDocument();
    // Its raw view lists each result's title and linked host before the JSON.
    fireEvent.click(within(searchRow).getByRole('button', { name: catalogs.en.trajectory.raw }));
    const sources = searchRow.querySelectorAll('.trajectory-sources li');
    expect(sources).toHaveLength(2);
    expect(within(sources[0] as HTMLElement).getByText('三体 (豆瓣)')).toBeInTheDocument();
    expect(within(sources[0] as HTMLElement).getByRole('link', { name: 'book.douban.com' })).toHaveAttribute(
      'href',
      'https://book.douban.com/subject/2567698/',
    );
    expect(within(sources[1] as HTMLElement).getByRole('link', { name: 'press.example.com' })).toBeInTheDocument();
    expect(JSON.parse(searchRow.querySelector('pre')!.textContent ?? '').args).toEqual({ query: '三体 site:book.douban.com' });

    // Read page: the host is linked in the detail and the result shows the page title.
    const pageRow = screen.getByText(labels.fetchPage).closest('li')!;
    const hostLinks = within(pageRow).getAllByRole('link', { name: 'book.douban.com' });
    expect(hostLinks.length).toBeGreaterThan(0);
    for (const link of hostLinks) {
      expect(link).toHaveAttribute('href', 'https://book.douban.com/subject/2567698/');
      expect(link).toHaveAttribute('rel', 'noreferrer noopener');
    }
    expect(within(pageRow).getByText(/三体 \(豆瓣\)/, { selector: '.trajectory-result' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(catalogs.en.shell.language), { target: { value: 'zh-Hans' } });
    expect(screen.getByText(catalogs['zh-Hans'].trajectory.step.webSearch)).toBeInTheDocument();
    expect(screen.getByText(catalogs['zh-Hans'].trajectory.step.fetchPage)).toBeInTheDocument();
  });

  it('refetches a running trajectory as the polled step count grows', async () => {
    let polls = 0;
    const fetchMock = installFetch(
      () => {
        polls += 1;
        const count = polls === 1 ? 2 : polls === 2 ? 4 : 7;
        return json({ jobs: [trajectoryJob({ trajectoryId: 21, trajectoryStepCount: count }, count < 7 ? 'running' : 'failed')] });
      },
      {
        extra: (url) => {
          if (url !== '/api/metadata/trajectories/21') return null;
          const count = polls === 1 ? 2 : polls === 2 ? 4 : 7;
          return json({ trajectory: trajectoryOf(count) });
        },
      },
    );
    renderImport('en');
    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.trajectory.title }));
    expect(await screen.findByText(catalogs.en.trajectory.working)).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.trajectory.step.note)).toBeInTheDocument();
    expect(screen.queryByText(catalogs.en.trajectory.step.search)).not.toBeInTheDocument();

    expect(await screen.findByText('5 results', {}, { timeout: 3000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(catalogs.en.trajectory.outcome.limit)).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.queryByText(catalogs.en.trajectory.working)).not.toBeInTheDocument();
    const trajectoryCalls = fetchMock.mock.calls.filter(([input]) => String(input) === '/api/metadata/trajectories/21');
    expect(trajectoryCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('links an unconfigured failure to settings for admins and shows readers no trajectory', async () => {
    const unconfigured = trajectoryJob({ error: 'metadata_assistant_unconfigured' });
    installFetch(() => json({ jobs: [unconfigured] }));
    renderImport('en');
    expect(await screen.findByText(new RegExp(catalogs.en.import.fileError.metadata_assistant_unconfigured))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: catalogs.en.import.settingsLink })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('button', { name: catalogs.en.trajectory.title })).not.toBeInTheDocument();
    cleanup();

    // A reader's job payload never carries trajectory fields, so there is nothing to open.
    const fetchMock = installFetch(() => json({ jobs: [trajectoryJob({})] }), { me: reader });
    renderImport('en');
    expect(await screen.findByText('tale.epub')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: catalogs.en.trajectory.title })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: catalogs.en.import.settingsLink })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/metadata/trajectories'))).toBe(false);
  });

  it('shows an error state when the job list cannot be loaded', async () => {
    installFetch(() => json({ error: 'internal' }, 500));
    renderImport('zh-Hans');
    expect(await screen.findByRole('alert')).toHaveTextContent(catalogs['zh-Hans'].import.error);
    expect(screen.getByRole('button', { name: catalogs['zh-Hans'].status.retry })).toBeInTheDocument();
    expect(screen.queryByText(catalogs['zh-Hans'].import.empty)).not.toBeInTheDocument();
  });

  it('compares a waiting file with the matched book, marks what differs, and resolves it with a live status', async () => {
    const waiting = trajectoryJob({
      status: 'needs_confirmation',
      error: null,
      filename: 'tale.pdf',
      candidateEditionId: 12,
      conflicts: ['title', 'format'],
      incoming: { title: 'A Tale Retold', authors: ['Lin Qi'], format: 'pdf', identifier: { scheme: 'isbn', value: '9780140328721' } },
    });
    const candidate = {
      id: 12,
      title: 'The Tale',
      authors: ['Lin Qi'],
      assets: [{ id: 1, format: 'pdf', originalFilename: 'tale.pdf', bytes: 1, availability: 'present' }],
    };
    let release: (response: Response) => void = () => {};
    const queued = { ...waiting, status: 'queued' as const, items: [{ ...waiting.items[0]!, status: 'queued' as const, resolution: 'merge' as const }] };
    let decided = false;
    const fetchMock = installFetch(() => json({ jobs: [decided ? queued : waiting] }), {
      extra: (url) => {
        if (url === '/api/editions/12') return json({ edition: candidate });
        return null;
      },
    });
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/jobs/9/items/8/keep-separate') return Promise.resolve(json({ error: 'not_found' }, 404));
      if (url === '/api/jobs/9/items/8/merge') {
        return new Promise<Response>((resolve) => {
          release = (response) => {
            decided = true;
            resolve(response);
          };
        });
      }
      return base(input);
    });
    renderImport('en');

    const block = await screen.findByRole('group', {
      name: 'This file has the same ISBN as a book you already have, but the titles differ. That book already has a PDF file.',
    });
    const table = within(block).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      catalogs.en.import.confirm.incoming,
      catalogs.en.import.confirm.existing,
    ]);
    const titleRow = within(table).getByRole('rowheader', { name: /Title/ }).closest('tr')!;
    expect(titleRow).toHaveClass('confirm-conflict');
    expect(titleRow).toHaveTextContent('A Tale Retold');
    expect(await within(titleRow).findByRole('link', { name: 'The Tale' })).toHaveAttribute('href', '/books/12');
    expect(within(table).getByRole('rowheader', { name: /Title/ })).toHaveTextContent(catalogs.en.import.confirm.differs);
    const authorsRow = within(table).getByRole('rowheader', { name: /Authors/ }).closest('tr')!;
    expect(authorsRow).not.toHaveClass('confirm-conflict');
    expect(within(table).getByRole('rowheader', { name: /Format/ }).closest('tr')).toHaveClass('confirm-conflict');
    expect(within(table).getByRole('rowheader', { name: catalogs.en.import.confirm.matched }).closest('tr')).toHaveTextContent(
      'ISBN 9780140328721',
    );
    expect(within(block).getByRole('link', { name: catalogs.en.import.confirm.open })).toHaveAttribute('href', '/books/12');

    // A refused decision shows in the alert style and leaves both choices.
    fireEvent.click(within(block).getByRole('button', { name: catalogs.en.import.resolve.separate }));
    expect(await within(block).findByRole('alert')).toHaveTextContent(catalogs.en.import.resolve.gone);

    // Pending: both choices wait while the decision saves.
    const merge = within(block).getByRole('button', { name: catalogs.en.import.resolve.merge });
    merge.focus();
    fireEvent.click(merge);
    await waitFor(() => expect(merge).toBeDisabled());
    expect(within(block).getByRole('button', { name: catalogs.en.import.resolve.separate })).toBeDisabled();
    expect(block).toHaveAttribute('aria-busy', 'true');
    expect(within(block).getByText(catalogs.en.import.resolve.pending)).toBeInTheDocument();
    expect(within(block).queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/9/items/8/merge', expect.objectContaining({ method: 'POST' }));

    release(json({ job: queued }, 202));
    const note = 'Added to “The Tale”. The import will finish in a moment.';
    await waitFor(() => expect(screen.queryByRole('group', { name: /same ISBN/ })).not.toBeInTheDocument());
    const statuses = screen.getAllByRole('status').filter((element) => element.textContent === note);
    expect(statuses).toHaveLength(1);
    const shown = screen.getByText(note, { selector: '.import-resolved' });
    await waitFor(() => expect(document.activeElement).toBe(shown));
  });

  it('words the decision in Simplified Chinese and for authors that differ', async () => {
    const waiting = trajectoryJob({
      status: 'needs_confirmation',
      error: null,
      candidateEditionId: 12,
      conflicts: ['title', 'authors'],
      incoming: { title: '另一个故事', authors: ['陈南'], format: 'epub', identifier: { scheme: 'douban', value: '1084336' } },
    });
    installFetch(() => json({ jobs: [waiting] }), {
      extra: (url) => (url === '/api/editions/12' ? json({ edition: { id: 12, title: '故事', authors: ['林栖'], assets: [] } }) : null),
    });
    renderImport('zh-Hans');
    const block = await screen.findByRole('group', { name: '这个文件的 豆瓣 与书库中的一本书相同，但书名和作者都不同。' });
    expect(within(block).getByRole('button', { name: catalogs['zh-Hans'].import.resolve.merge })).toBeInTheDocument();
    expect(within(block).getByRole('button', { name: catalogs['zh-Hans'].import.resolve.separate })).toBeInTheDocument();
    expect(within(block).getByRole('rowheader', { name: /作者/ }).closest('tr')).toHaveClass('confirm-conflict');
  });

  it('shows the needs-confirmation state to readers without the resolve actions', async () => {
    const waiting = trajectoryJob({ status: 'needs_confirmation', error: null, candidateEditionId: 12, conflicts: ['authors'] });
    installFetch(() => json({ jobs: [waiting] }), { me: reader });
    renderImport('en');
    expect(await screen.findByText(catalogs.en.import.status.needs_confirmation, { selector: '.import-status' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: catalogs.en.import.resolve.merge })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: catalogs.en.import.resolve.separate })).not.toBeInTheDocument();
  });
});
