import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { ImportJob } from './api';
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

function installFetch(jobs: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === '/api/setup') return Promise.resolve(json({ needed: false }));
      if (url === '/api/me') return Promise.resolve(json(admin));
      if (url === '/api/jobs') return Promise.resolve(jobs());
      return Promise.resolve(json({ error: 'not_found' }, 404));
    }),
  );
}

function renderImport(locale: 'en' | 'zh-Hans' = 'en') {
  window.history.pushState({}, '', '/import');
  return render(<App locale={locale} />);
}

describe('import screen', () => {
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
      summary: { total: 4, queued: 1, running: 1, succeeded: 1, failed: 1, duplicate: 0 },
      items: [
        { id: 1, position: 0, filename: 'tale.epub', status: 'succeeded', error: null, editionId: 1, assetId: 1, sha256: 'abc' },
        { id: 2, position: 1, filename: 'page.pdf', status: 'running', error: null, editionId: null, assetId: null, sha256: null },
        { id: 3, position: 2, filename: 'next.pdf', status: 'queued', error: null, editionId: null, assetId: null, sha256: null },
        { id: 4, position: 3, filename: 'broken.epub', status: 'failed', error: 'malformed', editionId: null, assetId: null, sha256: null },
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

  it('shows an error state when the job list cannot be loaded', async () => {
    installFetch(() => json({ error: 'internal' }, 500));
    renderImport('zh-Hans');
    expect(await screen.findByRole('alert')).toHaveTextContent(catalogs['zh-Hans'].import.error);
    expect(screen.getByRole('button', { name: catalogs['zh-Hans'].status.retry })).toBeInTheDocument();
    expect(screen.queryByText(catalogs['zh-Hans'].import.empty)).not.toBeInTheDocument();
  });
});
