import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserRouter } from 'react-router';
import type { AssetOcr, EditionAsset, EditionDetail } from './api';
import { PdfOcrControl, ReaderOcrAction, resetOcrAvailability } from './book-ocr';
import { catalogs } from './i18n';
import { Shell } from './shell';

type Strings = Record<string, string>;
const en = (catalogs.en!.book as unknown as { ocr: Strings }).ocr;
const zh = (catalogs['zh-Hans']!.book as unknown as { ocr: Strings }).ocr;

const pdf: EditionAsset = {
  id: 7, format: 'pdf', originalFilename: 'scan.pdf', displayFilename: 'Ada - Scan (2014).pdf', bytes: 10, availability: 'present',
};
const ocr = (status: AssetOcr['status'], ready = status === 'succeeded'): AssetOcr => ({
  status, ready, error: status === 'failed' ? 'ocr_failed' : null,
  requestedAt: '2026-11-01T10:00:00.000Z', startedAt: status === 'running' ? new Date(Date.now() - 3 * 60_000).toISOString() : null, finishedAt: null,
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function install(available = true, after: AssetOcr | null = ocr('queued')) {
  const calls: Array<{ method: string; url: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (url === '/api/ocr') return json({ available, languages: ['chi_sim', 'eng'] });
    if (url === '/api/editions/3/assets/7/ocr') return method === 'POST' ? json({ queued: true }, 202) : json({ deleted: true });
    if (url === '/api/editions/3') return json({ edition: { id: 3, assets: [{ ...pdf, ocr: after }] } });
    return json({ error: 'not_found' }, 404);
  }));
  return calls;
}

function show(asset: EditionAsset, admin: boolean, locale = 'en') {
  const onEdition = vi.fn<(edition: EditionDetail) => void>();
  render(
    <BrowserRouter>
      <Shell locale={locale}>
        <PdfOcrControl editionId={3} asset={asset} admin={admin} onEdition={onEdition} />
      </Shell>
    </BrowserRouter>,
  );
  return onEdition;
}

afterEach(() => {
  cleanup();
  resetOcrAvailability();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PDF OCR control', () => {
  it('shows readers only whether recognized text is in use', () => {
    const calls = install();
    show({ ...pdf, ocr: ocr('succeeded') }, false);
    expect(screen.getByText(en.ready!)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    show({ ...pdf, ocr: ocr('running') }, false);
    expect(screen.queryByText(en.ready!)).toBeNull();
    expect(calls.filter((call) => call.url === '/api/ocr')).toEqual([]);
  });

  it('starts recognition and reloads the book', async () => {
    const calls = install();
    const onEdition = show({ ...pdf, ocr: null }, true);
    const start = await screen.findByRole('button', { name: en.start });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(onEdition).toHaveBeenCalledWith(expect.objectContaining({ id: 3 })));
    expect(calls).toContainEqual({ method: 'POST', url: '/api/editions/3/assets/7/ocr' });
  });

  it('follows a running recognition, polls the book, and cancels it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = install(true, ocr('succeeded'));
    const onEdition = show({ ...pdf, ocr: ocr('running') }, true);
    expect(screen.getByRole('status')).toHaveTextContent(en.running!.replace('{minutes}', '3'));
    await vi.advanceTimersByTimeAsync(4100);
    await waitFor(() => expect(onEdition).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: en.cancel }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'DELETE', url: '/api/editions/3/assets/7/ocr' }));
  });

  it('offers a retry after a failure and removal with a confirm when ready', async () => {
    const calls = install();
    show({ ...pdf, ocr: ocr('failed') }, true);
    expect(screen.getByText(en.failed!)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: en.retry })).toBeInTheDocument();
    cleanup();

    show({ ...pdf, ocr: ocr('succeeded') }, true);
    expect(screen.getByText(en.ready!)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.start })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.remove }));
    const dialog = screen.getByRole('dialog', { name: en.removeTitle });
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: en.remove }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'DELETE', url: '/api/editions/3/assets/7/ocr' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says when OCR is not installed and keeps the action disabled', async () => {
    install(false);
    show({ ...pdf, ocr: null }, true);
    expect(await screen.findByText(en.unavailable!)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.start })).toBeDisabled();
  });

  it('shows nothing for an EPUB and speaks Chinese', async () => {
    install();
    show({ ...pdf, format: 'epub' }, true);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    show({ ...pdf, ocr: null }, true, 'zh-Hans');
    expect(await screen.findByRole('button', { name: zh.start })).toBeInTheDocument();
  });

  it('lets an admin start recognition from the reader, then says it is running', async () => {
    const calls = install();
    render(
      <BrowserRouter>
        <Shell locale="en">
          <ReaderOcrAction editionId={3} assetId={7} initial={null} />
        </Shell>
      </BrowserRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: en.start }));
    expect(await screen.findByText(en.readerRunning!)).toBeInTheDocument();
    expect(calls).toContainEqual({ method: 'POST', url: '/api/editions/3/assets/7/ocr' });
  });

  it('shows no reader action when OCR cannot run', async () => {
    install(false);
    render(
      <BrowserRouter>
        <Shell locale="en">
          <ReaderOcrAction editionId={3} assetId={7} initial={null} />
        </Shell>
      </BrowserRouter>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button')).toBeNull();
  });
});
