import { useLayoutEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserRouter } from 'react-router';
import { catalogs } from '../i18n';
import { Shell } from '../shell';
import { PdfReader } from './pdf-reader';
import { openPdfSession } from './pdf/session';
import type { PdfSession, RenderedPage } from './pdf/types';
import type { PdfViewportProps } from './pdf/viewport';
import type { PdfHighlight, PdfNote } from './pdf/annotation-tools';

vi.mock('./pdf/session', () => ({ openPdfSession: vi.fn() }));
vi.mock('./pdf/viewport', () => ({
  PdfViewport: function MockViewport({ session, place, scrollerRef, annotations, onSelection, onRendered }: PdfViewportProps) {
    useLayoutEffect(() => {
      if (session && place) onRendered(place, painted, place);
    }, [session, place]);
    return (
      <div ref={scrollerRef} className="pdf-scroller">
        <button type="button" disabled={!session} onClick={() => onSelection?.({
          locator: selected, quote: 'Selected passage', anchor: { left: 100, top: 100, width: 90, height: 15 },
        })}>Select passage</button>
        <output aria-label="Viewport page">{place?.page}</output>
        <ul aria-label="Annotation overlays">{annotations?.map((mark) => <li key={mark.id}>{mark.id}</li>)}</ul>
      </div>
    );
  },
}));

const t = catalogs.en.reader;
const selected = 'pdfsel({"v":1,"pages":[{"page":1,"rects":[[10,20,90,35]]}]})';
const saved = 'pdfpos(page=4;x=15;y=220;zoom=1.5)';
const painted: RenderedPage = {
  scale: 1.5, cssWidth: 300, cssHeight: 400,
  toViewport: (x, y) => ({ x, y }), toPdf: (x, y) => ({ x, y }),
};
const highlight: PdfHighlight = { id: 21, assetId: 10, locator: selected, quote: 'Selected passage', revision: 1 };
const note: PdfNote = { id: 31, assetId: 10, locator: selected, body: 'First note', revision: 3 };

type Reading = { highlights: PdfHighlight[]; notes: PdfNote[] };
type Mutation = { path: string; method: string; body: Record<string, unknown> };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function install({ reading = () => ({ highlights: [], notes: [] }), mutate, searchable = true }: {
  reading?: () => Reading;
  mutate?: (request: Mutation) => Response | Promise<Response>;
  searchable?: boolean;
} = {}) {
  const session: PdfSession = {
    pageCount: 8, outline: [], thumbnailPages: [],
    searchable: vi.fn(async () => searchable),
    pageBox: vi.fn(async () => ({ xMin: 0, yMin: 0, xMax: 300, yMax: 400 })),
    pageSize: vi.fn(async () => painted),
    releasePage: vi.fn(), renderPage: vi.fn(async () => painted),
    renderThumbnail: vi.fn(async () => true),
    search: vi.fn(async () => ({ searchable, hits: [] })), destroy: vi.fn(async () => {}),
  };
  vi.mocked(openPdfSession).mockResolvedValue(session);
  const requests: Mutation[] = [];
  const load = vi.fn(reading);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    if (/^\/api\/editions\/3\/assets\/(10|11)\/file$/.test(path)) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    if (path === '/api/editions/3/reading-place' && method === 'GET') {
      return json({ position: { locator: saved, revision: 2, assetId: 10, updatedAt: '2026-01-01T00:00:00.000Z' }, bookmarks: [], ...load() });
    }
    if (path === '/api/editions/3/reading-place' && method === 'PUT') {
      return json({ position: { ...JSON.parse(String(init?.body)), revision: 3 } });
    }
    const request = { path, method, body: JSON.parse(String(init?.body)) as Mutation['body'] };
    requests.push(request);
    if (!mutate) throw new Error(`Unexpected request: ${method} ${path}`);
    return mutate(request);
  }));
  return { requests, load, session };
}

async function renderReader() {
  render(<BrowserRouter><Shell locale="en"><PdfReader editionId={3} assetId={10} title="Scan" /></Shell></BrowserRouter>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Select passage' })).toBeEnabled());
  expect(screen.getByLabelText('Viewport page')).toHaveTextContent('4');
  expect(openPdfSession).toHaveBeenCalledWith(expect.any(ArrayBuffer));
}

function openPanel(name: 'notes' | 'highlights') {
  fireEvent.click(screen.getByRole('button', { name: t.options }));
  fireEvent.click(screen.getByRole('button', { name: t[name] }));
  return screen.getByRole('complementary', { name: t[name] });
}

function select(action: 'highlight' | 'note') {
  fireEvent.click(screen.getByRole('button', { name: 'Select passage' }));
  fireEvent.click(within(screen.getByRole('toolbar', { name: 'Selected text' })).getByRole('button', { name: t[action] }));
}

function writeNote(body: string) {
  fireEvent.change(screen.getByRole('textbox', { name: t.noteBody }), { target: { value: body } });
  fireEvent.click(screen.getByRole('button', { name: t.saveNote }));
}

function overlays() {
  return within(screen.getByRole('list', { name: 'Annotation overlays' })).queryAllByRole('listitem').map((item) => item.textContent);
}

afterEach(() => {
  cleanup();
  localStorage.removeItem('qijuan.reader.flow');
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('PDF annotations through the reader', () => {
  it('posts selected text as a highlight and displays it in overlays and the Highlights panel', async () => {
    const { requests } = install({ mutate: () => json({ highlight }, 201) });
    await renderReader();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    select('highlight');
    await waitFor(() => expect(overlays()).toEqual(['highlight-21']));
    expect(requests).toEqual([{
      path: '/api/editions/3/highlights', method: 'POST',
      body: { assetId: 10, locator: selected, quote: 'Selected passage', revision: 0 },
    }]);
    expect(screen.queryByRole('toolbar', { name: 'Selected text' })).not.toBeInTheDocument();
    expect(within(openPanel('highlights')).getByRole('button', { name: /Selected passage/ })).toBeInTheDocument();
  });

  it('creates, edits with the current revision, and deletes a selected-text note with a 204 response', async () => {
    const changed = { ...note, body: 'Changed note', revision: 4 };
    const { requests } = install({ mutate: ({ method }) => method === 'DELETE'
      ? new Response(null, { status: 204 }) : json({ note: method === 'PATCH' ? changed : note }) });
    await renderReader();
    select('note');
    expect(screen.queryByRole('toolbar', { name: 'Selected text' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: t.noteBody })).toHaveFocus();
    expect(within(screen.getByRole('complementary', { name: t.notes })).getByText('Selected passage')).toBeInTheDocument();
    writeNote('  First note  ');
    expect(await screen.findByRole('button', { name: /First note/ })).toBeInTheDocument();
    expect(overlays()).toEqual(['note-31']);
    expect(screen.queryByRole('textbox', { name: t.noteBody })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t.editNote }));
    expect(screen.getByRole('textbox', { name: t.noteBody })).toHaveValue('First note');
    writeNote('Changed note');
    expect(await screen.findByRole('button', { name: /Changed note/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /First note/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t.remove }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Changed note/ })).not.toBeInTheDocument());
    expect(screen.getByText(t.noNotes)).toBeInTheDocument();
    expect(overlays()).toEqual([]);
    expect(requests).toEqual([
      { path: '/api/editions/3/notes', method: 'POST', body: { assetId: 10, locator: selected, body: 'First note', revision: 0 } },
      { path: '/api/editions/3/notes/31', method: 'PATCH', body: { body: 'Changed note', revision: 3 } },
      { path: '/api/editions/3/notes/31', method: 'DELETE', body: { revision: 4 } },
    ]);
  });

  it('anchors a page note to pdfpos on a PDF without searchable text', async () => {
    const pageNote = { ...note, locator: saved, body: 'Scan reminder' };
    const { requests } = install({ searchable: false, mutate: () => json({ note: pageNote }, 201) });
    await renderReader();
    expect(await screen.findByText(t.scanNoText)).toBeInTheDocument();
    fireEvent.click(within(openPanel('notes')).getByRole('button', { name: t.addPageNote }));
    writeNote('Scan reminder');
    expect(await screen.findByRole('button', { name: /Scan reminder/ })).toBeInTheDocument();
    expect(requests).toEqual([{
      path: '/api/editions/3/notes', method: 'POST', body: { assetId: 10, locator: saved, body: 'Scan reminder', revision: 0 },
    }]);
    expect(overlays()).toEqual([]);
  });

  it('loads only this asset’s valid PDF anchors, allowing page notes but requiring selections for highlights', async () => {
    install({ reading: () => ({
      highlights: [highlight,
        { ...highlight, id: 22, assetId: 11, quote: 'Other asset' },
        { ...highlight, id: 23, locator: saved, quote: 'Page highlight' },
        { ...highlight, id: 24, locator: 'pdfsel({"v":1,"pages":[]})', quote: 'Invalid selection' },
        { ...highlight, id: 25, assetId: null, quote: 'Unassigned highlight' }],
      notes: [note, { ...note, id: 32, locator: saved, body: 'Page reminder' },
        { ...note, id: 33, assetId: 11, body: 'Other asset note' },
        { ...note, id: 34, locator: 'epubcfi(/6/2)', body: 'EPUB note' },
        { ...note, id: 35, locator: null, body: 'Unanchored note' },
        { ...note, id: 36, assetId: null, body: 'Unassigned note' },
        { ...note, id: 37, locator: 'pdfpos(page=0;x=0;y=0;zoom=1)', body: 'Invalid page' }],
    }) });
    await renderReader();
    expect(overlays()).toEqual(['highlight-21', 'note-31']);
    const highlights = within(openPanel('highlights'));
    expect(highlights.getAllByRole('listitem')).toHaveLength(1);
    expect(highlights.getByRole('button', { name: /Selected passage/ })).toBeInTheDocument();
    const notes = within(openPanel('notes'));
    expect(notes.getAllByRole('listitem')).toHaveLength(2);
    expect(notes.getByRole('button', { name: /First note/ })).toBeInTheDocument();
    expect(notes.getByRole('button', { name: /Page reminder/ })).toBeInTheDocument();
  });

  it('reloads the latest annotations after a 409 and discards the conflicting editor', async () => {
    let conflicted = false;
    const latest = { ...note, body: 'Latest server note', revision: 9 };
    const { requests, load } = install({
      reading: () => ({ notes: [conflicted ? latest : note], highlights: conflicted ? [highlight] : [] }),
      mutate: () => { conflicted = true; return json({ error: 'conflict' }, 409); },
    });
    await renderReader();
    fireEvent.click(within(openPanel('notes')).getByRole('button', { name: t.editNote }));
    writeNote('Stale edit');
    expect(await screen.findByRole('button', { name: /Latest server note/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /First note/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: t.noteBody })).not.toBeInTheDocument();
    expect(screen.getByText(t.newerKept)).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([{ path: '/api/editions/3/notes/31', method: 'PATCH', body: { body: 'Stale edit', revision: 3 } }]);
    expect(overlays()).toEqual(['highlight-21', 'note-31']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t.editNote }));
    expect(screen.getByRole('textbox', { name: t.noteBody })).toHaveValue('Latest server note');
  });

  it('keeps a draft retryable after a network error and clears the error after saving', async () => {
    let fail = true;
    const { requests } = install({ mutate: () => {
      if (fail) { fail = false; throw new TypeError('Failed to fetch'); }
      return json({ note }, 201);
    } });
    await renderReader();
    select('note');
    writeNote('First note');
    expect(await screen.findByRole('alert')).toHaveTextContent(catalogs.en.errors.network);
    expect(screen.getByRole('textbox', { name: t.noteBody })).toHaveValue('First note');
    expect(screen.getByRole('button', { name: t.saveNote })).toBeEnabled();
    expect(overlays()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: t.saveNote }));
    expect(await screen.findByRole('button', { name: /First note/ })).toBeInTheDocument();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: t.noteBody })).not.toBeInTheDocument();
    expect(overlays()).toEqual(['note-31']);
  });

  it('drops an unsaved draft when switching PDF assets', async () => {
    install();
    const reader = (assetId: number) => <BrowserRouter><Shell locale="en"><PdfReader editionId={3} assetId={assetId} title="Scan" /></Shell></BrowserRouter>;
    const view = render(reader(10));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select passage' })).toBeEnabled());
    select('note');
    fireEvent.change(screen.getByRole('textbox', { name: t.noteBody }), { target: { value: 'Unsaved on first PDF' } });
    view.rerender(reader(11));
    await waitFor(() => expect(openPdfSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select passage' })).toBeEnabled());
    expect(screen.queryByRole('textbox', { name: t.noteBody })).not.toBeInTheDocument();
    expect(within(openPanel('notes')).getByText(t.noNotes)).toBeInTheDocument();
    expect(screen.queryByText('Unsaved on first PDF')).not.toBeInTheDocument();
  });

  it('ignores a previous asset’s pending mutation and leaves the new asset usable', async () => {
    let finish!: (response: Response) => void;
    const { requests } = install({ mutate: () => new Promise<Response>((resolve) => { finish = resolve; }) });
    const reader = (assetId: number) => <BrowserRouter><Shell locale="en"><PdfReader editionId={3} assetId={assetId} title="Scan" /></Shell></BrowserRouter>;
    const view = render(reader(10));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select passage' })).toBeEnabled());
    select('highlight');
    expect(requests).toHaveLength(1);
    view.rerender(reader(11));
    await waitFor(() => expect(openPdfSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select passage' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Select passage' }));
    expect(within(screen.getByRole('toolbar')).getByRole('button', { name: t.highlight })).toBeEnabled();
    finish(json({ highlight }, 201));
    await waitFor(() => expect(overlays()).toEqual([]));
    expect(within(screen.getByRole('toolbar')).getByRole('button', { name: t.highlight })).toBeEnabled();
  });

  it.each(['shiftKey', 'ctrlKey', 'metaKey', 'altKey'])('preserves %s+arrow for selection while plain arrows navigate', async (modifier) => {
    const { session } = install();
    await renderReader();
    vi.mocked(session.pageBox).mockClear();
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      const event = new KeyboardEvent('keydown', { key, [modifier]: true, bubbles: true, cancelable: true });
      fireEvent(window, event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(session.pageBox).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Viewport page')).toHaveTextContent('4');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByLabelText('Viewport page')).toHaveTextContent('5'));
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByLabelText('Viewport page')).toHaveTextContent('4'));
  });
});
