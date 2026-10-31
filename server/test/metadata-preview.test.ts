import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AssistantTransport } from '../src/metadata/assistant/client.js';
import type { AssistantProposal } from '../src/metadata/assistant/submit.js';
import type { OpenLibraryTransport } from '../src/metadata/openLibrary.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { configureTestAssistant, embeddedMetadataAssistant, makeTempDir, tempConfig } from './helpers.js';
import { COVER_PNG, buildEpub, buildTextPdf, jpegOfSize, pngOfSize } from './fixtures.js';
import { absoluteBlobPath } from '../src/blobs.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface PreviewFieldView {
  field: string;
  locked: boolean;
  status: 'kept' | 'change' | 'unchanged';
  current: unknown;
  proposed: unknown;
}

interface PreviewView {
  previewId: number;
  fields: PreviewFieldView[];
  source: 'assistant';
  model: string;
}

interface JobView {
  status: string;
  items: Array<{ status: string; editionId: number | null }>;
  result: { preview?: PreviewView | null; error?: string; applied?: boolean } | null;
}

interface CoverStub {
  transport: OpenLibraryTransport;
  calls: string[];
}

function coverStub(status = 200): CoverStub {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      async fetch(input) {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        calls.push(url.href);
        if (url.pathname.startsWith('/b/') && status === 200) {
          return new Response(COVER_PNG, { status: 200, headers: { 'content-type': 'image/png' } });
        }
        return new Response('missing', { status: status === 200 ? 404 : status });
      },
    },
  };
}

function proposalAssistant(overrides: Partial<AssistantProposal> = {}): AssistantTransport {
  const proposal: AssistantProposal = {
    title: 'Agent Title',
    authors: ['Agent Author'],
    translators: ['Agent Translator'],
    description: 'Agent description.',
    publisher: 'Agent Press',
    publishedDate: '1999-09-09',
    language: 'fr',
    identifiers: [{ scheme: 'isbn', value: '9780140328721' }],
    series: 'Agent Series',
    seriesOrder: 2,
    coverId: 77,
    isbn: '9780140328721',
    cover: null,
    ...overrides,
  };
  return {
    async fetch() {
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'submit_metadata', arguments: JSON.stringify(proposal) },
                },
              ],
            },
          },
        ],
      });
    },
  };
}

function multipart(parts: Array<{ name: string; filename: string; content: Buffer; type?: string }>): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = '----qijuanboundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
    );
    chunks.push(part.content);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function cookieFrom(response: { headers: { 'set-cookie'?: string | string[] | undefined } }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(';')[0] ?? '';
}

async function startApp(options: {
  assistant?: AssistantTransport;
  openLibrary?: OpenLibraryTransport;
  configure?: boolean;
}) {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  const config = tempConfig(temp.dir);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  if (options.configure !== false) configureTestAssistant(config.dataDir);
  const app = await buildApp({
    config,
    clientDist: null,
    logger: false,
    assistant: options.assistant ?? embeddedMetadataAssistant(),
    openLibrary: options.openLibrary ?? {
      fetch: async () => {
        throw new Error('network disabled in test');
      },
    },
  });
  cleanups.push(() => {
    void app.close();
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { username: 'ada', password, libraryName: 'Home' },
  });
  expect(setup.statusCode).toBe(201);
  return { app, config, dir: temp.dir, cookie: cookieFrom(setup), libraryId: setup.json().library.id as number };
}

async function waitForJob(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, id: number): Promise<JobView> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const job = response.json().job as JobView;
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${id} did not finish`);
}

async function upload(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  libraryId: number,
  files: Array<{ filename: string; content: Buffer }>,
): Promise<JobView> {
  const body = multipart(files.map((file) => ({ name: 'files', filename: file.filename, content: file.content })));
  const created = await app.inject({
    method: 'POST',
    url: `/api/imports?libraryId=${libraryId}`,
    headers: { ...body.headers, cookie },
    payload: body.payload,
  });
  expect(created.statusCode).toBe(202);
  return waitForJob(app, cookie, created.json().job.id as number);
}

async function lookup(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, editionId: number): Promise<JobView> {
  const started = await app.inject({
    method: 'POST',
    url: `/api/editions/${editionId}/metadata/lookup`,
    headers: { cookie },
  });
  expect(started.statusCode).toBe(202);
  return waitForJob(app, cookie, started.json().job.id as number);
}

async function apply(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  editionId: number,
  previewId: number,
  confirm: string[],
): Promise<JobView> {
  const started = await app.inject({
    method: 'POST',
    url: `/api/editions/${editionId}/metadata/apply`,
    headers: { cookie },
    payload: { previewId, confirm },
  });
  expect(started.statusCode).toBe(202);
  return waitForJob(app, cookie, started.json().job.id as number);
}

async function edition(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  editionId: number,
): Promise<{
  title: string;
  description: string | null;
  publisher: string | null;
  publishedDate: string | null;
  language: string | null;
  authors: string[];
  translators: string[];
  identifiers: Array<{ scheme: string; value: string }>;
  series: { id: number; name: string } | null;
  seriesOrder: number | null;
  cover: { mediaType: string } | null;
  locks: string[];
}> {
  const response = await app.inject({ method: 'GET', url: `/api/editions/${editionId}`, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json().edition;
}

describe('metadata assistant preview and apply', () => {
  it('previews the assistant proposal with its source and model', async () => {
    const assistant = embeddedMetadataAssistant();
    const cover = coverStub();
    const { app, config, cookie, libraryId } = await startApp({ assistant, openLibrary: cover.transport });
    const imported = await upload(app, cookie, libraryId, [
      {
        filename: 'original.epub',
        content: buildEpub({
          title: 'Original Title',
          author: 'Original Author',
          description: 'Original description.',
          publisher: 'Original Press',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01',
        }),
      },
    ]);
    const editionId = imported.items[0]?.editionId ?? 0;
    expect(imported.status).toBe('succeeded');

    assistant.fetch = proposalAssistant().fetch;
    const lookupJob = await lookup(app, cookie, editionId);
    expect(lookupJob.status).toBe('succeeded');
    const preview = lookupJob.result?.preview;
    expect(preview).toMatchObject({ source: 'assistant', model: 'scripted-model' });
    expect(preview?.fields.find((field) => field.field === 'title')).toMatchObject({
      status: 'change',
      current: 'Original Title',
      proposed: 'Agent Title',
    });
    expect(preview?.fields.find((field) => field.field === 'translators')).toMatchObject({
      status: 'change',
      proposed: 'Agent Translator',
    });
    expect(preview?.fields.find((field) => field.field === 'series')).toMatchObject({
      status: 'change',
      proposed: 'Agent Series',
    });
    expect(preview?.fields.find((field) => field.field === 'seriesOrder')).toMatchObject({
      status: 'change',
      proposed: '2',
    });
    // Open Library's cover is fetched for the preview, so the admin sees the actual image.
    expect(cover.calls.some((href) => href.includes('/b/id/77-L.jpg'))).toBe(true);
    expect(preview?.fields.find((field) => field.field === 'cover')).toMatchObject({
      proposed: { host: 'covers.openlibrary.org', url: `/api/editions/${editionId}/metadata/previews/${preview?.previewId}/cover` },
    });

    const db = new Database(config.databasePath, { readonly: true });
    const stored = db.prepare('SELECT proposal FROM metadata_previews WHERE id = ?').get(preview?.previewId) as {
      proposal: string;
    };
    db.close();
    expect(JSON.parse(stored.proposal)).toMatchObject({
      series: 'Agent Series',
      seriesOrder: 2,
      translators: ['Agent Translator'],
    });
  });

  it('applies only confirmed fields, keeps a locked title, reuses a series, replaces translators, and stores the cover', async () => {
    const assistant = embeddedMetadataAssistant();
    const cover = coverStub();
    const { app, cookie, libraryId } = await startApp({ assistant, openLibrary: cover.transport });
    const imported = await upload(app, cookie, libraryId, [
      {
        filename: 'first.epub',
        content: buildEpub({
          title: 'Original Title',
          author: 'Original Author',
          translator: 'Old Translator',
          description: 'Old description.',
          publisher: 'Old Press',
          language: 'zh',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02',
        }),
      },
      {
        filename: 'second.epub',
        content: buildEpub({
          title: 'Companion Title',
          author: 'Companion Author',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee03',
        }),
      },
    ]);
    expect(imported.status).toBe('succeeded');
    const firstId = imported.items[0]?.editionId ?? 0;
    const secondId = imported.items[1]?.editionId ?? 0;

    const series = await app.inject({
      method: 'POST',
      url: '/api/editions/batch',
      headers: { cookie },
      payload: { editionIds: [secondId], series: 'Agent Series' },
    });
    expect(series.statusCode).toBe(200);
    const existingSeriesId = (await edition(app, cookie, secondId)).series?.id ?? 0;
    expect(existingSeriesId).toBeGreaterThan(0);

    const locked = await app.inject({
      method: 'PATCH',
      url: `/api/editions/${firstId}`,
      headers: { cookie },
      payload: { title: 'Locked Title' },
    });
    expect(locked.statusCode).toBe(200);
    const before = await edition(app, cookie, firstId);

    assistant.fetch = proposalAssistant({
      translators: ['New Translator', 'Second Translator'],
      seriesOrder: 3.5,
    }).fetch;
    const lookupJob = await lookup(app, cookie, firstId);
    expect(lookupJob.status).toBe('succeeded');
    const preview = lookupJob.result?.preview;
    expect(preview?.fields.find((field) => field.field === 'title')).toMatchObject({
      status: 'kept',
      locked: true,
      current: 'Locked Title',
      proposed: 'Agent Title',
    });

    const applied = await apply(app, cookie, firstId, preview?.previewId ?? 0, [
      'title',
      'description',
      'translators',
      'series',
      'seriesOrder',
      'cover',
    ]);
    expect(applied.status).toBe('succeeded');

    const after = await edition(app, cookie, firstId);
    expect(after.title).toBe('Locked Title');
    expect(after.description).toBe('Agent description.');
    expect(after.publisher).toBe(before.publisher);
    expect(after.publishedDate).toBe(before.publishedDate);
    expect(after.language).toBe(before.language);
    expect(after.authors).toEqual(before.authors);
    expect(after.translators).toEqual(['New Translator', 'Second Translator']);
    expect(after.identifiers).toEqual(before.identifiers);
    expect(after.series).toEqual({ id: existingSeriesId, name: 'Agent Series' });
    expect(after.seriesOrder).toBe(3.5);
    expect(after.cover).toEqual({ mediaType: 'image/png' });
    expect(after.locks).toEqual(
      expect.arrayContaining(['title', 'description', 'translators', 'series', 'seriesOrder', 'cover']),
    );
    expect(after.locks).not.toContain('publisher');
    expect(after.locks).not.toContain('language');

    const coverResponse = await app.inject({
      method: 'GET',
      url: `/api/editions/${firstId}/cover`,
      headers: { cookie },
    });
    expect(coverResponse.statusCode).toBe(200);
    expect(coverResponse.rawPayload.equals(COVER_PNG)).toBe(true);
    expect(cover.calls.some((href) => href.includes('/b/id/77-L.jpg'))).toBe(true);
  });

  it('reuses an existing series whose name differs only in ASCII case', async () => {
    const assistant = embeddedMetadataAssistant();
    const { app, config, cookie, libraryId } = await startApp({ assistant });
    const imported = await upload(app, cookie, libraryId, [
      {
        filename: 'first.epub',
        content: buildEpub({
          title: 'Case First',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee11',
        }),
      },
      {
        filename: 'second.epub',
        content: buildEpub({
          title: 'Case Second',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee12',
        }),
      },
    ]);
    expect(imported.status).toBe('succeeded');
    const firstId = imported.items[0]?.editionId ?? 0;
    const secondId = imported.items[1]?.editionId ?? 0;

    const series = await app.inject({
      method: 'POST',
      url: '/api/editions/batch',
      headers: { cookie },
      payload: { editionIds: [secondId], series: 'Agent Series' },
    });
    expect(series.statusCode).toBe(200);
    const existingSeriesId = (await edition(app, cookie, secondId)).series?.id ?? 0;
    expect(existingSeriesId).toBeGreaterThan(0);

    assistant.fetch = proposalAssistant({ series: 'agent series', seriesOrder: null }).fetch;
    const lookupJob = await lookup(app, cookie, firstId);
    expect(lookupJob.status).toBe('succeeded');
    const preview = lookupJob.result?.preview;
    expect(preview?.fields.find((field) => field.field === 'series')).toMatchObject({
      current: null,
      proposed: 'agent series',
    });

    const applied = await apply(app, cookie, firstId, preview?.previewId ?? 0, ['series']);
    expect(applied.status).toBe('succeeded');
    expect((await edition(app, cookie, firstId)).series).toEqual({
      id: existingSeriesId,
      name: 'Agent Series',
    });

    const db = new Database(config.databasePath, { readonly: true });
    const rows = db.prepare('SELECT id, name FROM series ORDER BY id').all() as Array<{ id: number; name: string }>;
    db.close();
    expect(rows).toEqual([{ id: existingSeriesId, name: 'Agent Series' }]);
  });

  it('clears the series order with the series and locks both together', async () => {
    const assistant = proposalAssistant({ series: 'Legacy Series', seriesOrder: 4, coverId: null, isbn: null });
    const { app, cookie, libraryId } = await startApp({ assistant });
    const imported = await upload(app, cookie, libraryId, [
      {
        filename: 'clear-series.epub',
        content: buildEpub({
          title: 'Clear Series',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee13',
        }),
      },
    ]);
    expect(imported.status).toBe('succeeded');
    const editionId = imported.items[0]?.editionId ?? 0;
    const before = await edition(app, cookie, editionId);
    expect(before.series?.name).toBe('Legacy Series');
    expect(before.seriesOrder).toBe(4);
    expect(before.locks).not.toContain('series');

    assistant.fetch = proposalAssistant({ series: null, seriesOrder: null, coverId: null, isbn: null }).fetch;
    const lookupJob = await lookup(app, cookie, editionId);
    expect(lookupJob.status).toBe('succeeded');
    const preview = lookupJob.result?.preview;
    expect(preview?.fields.find((field) => field.field === 'series')).toMatchObject({
      current: 'Legacy Series',
      proposed: null,
    });
    expect(preview?.fields.find((field) => field.field === 'seriesOrder')).toMatchObject({
      current: '4',
      proposed: null,
    });

    const applied = await apply(app, cookie, editionId, preview?.previewId ?? 0, ['series']);
    expect(applied.status).toBe('succeeded');
    const after = await edition(app, cookie, editionId);
    expect(after.series).toBeNull();
    expect(after.seriesOrder).toBeNull();
    expect(after.locks).toEqual(expect.arrayContaining(['series', 'seriesOrder']));
  });

  it('clears the previous series order when switching series without confirming an order', async () => {
    const assistant = proposalAssistant({ series: 'First Series', seriesOrder: 3, coverId: null, isbn: null });
    const { app, cookie, libraryId } = await startApp({ assistant });
    const imported = await upload(app, cookie, libraryId, [
      {
        filename: 'switch-series.epub',
        content: buildEpub({
          title: 'Switch Series',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee17',
        }),
      },
    ]);
    expect(imported.status).toBe('succeeded');
    const editionId = imported.items[0]?.editionId ?? 0;
    expect((await edition(app, cookie, editionId)).seriesOrder).toBe(3);

    assistant.fetch = proposalAssistant({
      series: 'Second Series',
      seriesOrder: 9,
      coverId: null,
      isbn: null,
    }).fetch;
    const lookupJob = await lookup(app, cookie, editionId);
    expect(lookupJob.status).toBe('succeeded');
    const preview = lookupJob.result?.preview;

    const applied = await apply(app, cookie, editionId, preview?.previewId ?? 0, ['series']);
    expect(applied.status).toBe('succeeded');
    const after = await edition(app, cookie, editionId);
    expect(after.series?.name).toBe('Second Series');
    expect(after.seriesOrder).toBeNull();
    expect(after.locks).toContain('series');
    expect(after.locks).not.toContain('seriesOrder');
  });

  it('does not persist or lock a series order when no series results', async () => {
    const assistant = embeddedMetadataAssistant();
    const { app, cookie, libraryId } = await startApp({ assistant });
    const imported = await upload(app, cookie, libraryId, [
      {
        filename: 'order-only.epub',
        content: buildEpub({
          title: 'Order Only',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee14',
        }),
      },
    ]);
    expect(imported.status).toBe('succeeded');
    const editionId = imported.items[0]?.editionId ?? 0;
    const before = await edition(app, cookie, editionId);
    expect(before.series).toBeNull();
    expect(before.seriesOrder).toBeNull();

    assistant.fetch = proposalAssistant({
      series: null,
      seriesOrder: 7,
      description: 'Order-only description.',
      coverId: null,
      isbn: null,
    }).fetch;
    const lookupJob = await lookup(app, cookie, editionId);
    expect(lookupJob.status).toBe('succeeded');
    const preview = lookupJob.result?.preview;
    expect(preview?.fields.find((field) => field.field === 'seriesOrder')).toMatchObject({
      current: null,
      proposed: '7',
    });
    expect(preview?.fields.find((field) => field.field === 'description')).toMatchObject({
      status: 'change',
      current: before.description,
      proposed: 'Order-only description.',
    });

    const applied = await apply(app, cookie, editionId, preview?.previewId ?? 0, ['seriesOrder', 'description']);
    expect(applied.status).toBe('succeeded');
    const after = await edition(app, cookie, editionId);
    expect(after.description).toBe('Order-only description.');
    expect(after.description).not.toBe(before.description);
    expect(after.series).toBeNull();
    expect(after.seriesOrder).toBeNull();
    expect(after.locks).toContain('description');
    expect(after.locks).not.toContain('seriesOrder');
  });

  it('preserves an existing cover when the cover field is not confirmed', async () => {
    const assistant = proposalAssistant({ coverId: 77, isbn: '9780140328721' });
    const cover = coverStub();
    const { app, config, cookie, libraryId } = await startApp({ assistant, openLibrary: cover.transport });
    const imported = await upload(app, cookie, libraryId, [
      {
        filename: 'cover-source.epub',
        content: buildEpub({
          title: 'Cover Source',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee15',
        }),
      },
    ]);
    expect(imported.status).toBe('succeeded');
    const editionId = imported.items[0]?.editionId ?? 0;
    const before = await edition(app, cookie, editionId);
    expect(before.cover).toEqual({ mediaType: 'image/png' });
    const beforeResponse = await app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/cover`,
      headers: { cookie },
    });
    expect(beforeResponse.statusCode).toBe(200);
    expect(beforeResponse.rawPayload.equals(COVER_PNG)).toBe(true);

    const beforeDb = new Database(config.databasePath, { readonly: true });
    const rowBefore = beforeDb
      .prepare(
        'SELECT id, sha256, bytes, media_type, relative_path, created_at FROM covers WHERE edition_id = ?',
      )
      .get(editionId) as
      | { id: number; sha256: string; bytes: number; media_type: string; relative_path: string; created_at: string }
      | undefined;
    beforeDb.close();
    expect(rowBefore).toBeTruthy();
    cover.calls.length = 0;

    assistant.fetch = proposalAssistant({
      title: 'Cover Kept',
      series: null,
      seriesOrder: null,
      coverId: 999,
      isbn: null,
    }).fetch;
    const lookupJob = await lookup(app, cookie, editionId);
    expect(lookupJob.status).toBe('succeeded');
    const preview = lookupJob.result?.preview;
    expect(preview?.fields.find((field) => field.field === 'cover')).toMatchObject({
      proposed: { host: 'covers.openlibrary.org' },
    });
    cover.calls.length = 0;

    const applied = await apply(app, cookie, editionId, preview?.previewId ?? 0, ['title']);
    expect(applied.status).toBe('succeeded');
    const after = await edition(app, cookie, editionId);
    expect(after.title).toBe('Cover Kept');
    expect(after.cover).toEqual({ mediaType: 'image/png' });

    const afterDb = new Database(config.databasePath, { readonly: true });
    const rowAfter = afterDb
      .prepare(
        'SELECT id, sha256, bytes, media_type, relative_path, created_at FROM covers WHERE edition_id = ?',
      )
      .get(editionId) as
      | { id: number; sha256: string; bytes: number; media_type: string; relative_path: string; created_at: string }
      | undefined;
    afterDb.close();
    expect(rowAfter).toEqual(rowBefore);

    const afterResponse = await app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/cover`,
      headers: { cookie },
    });
    expect(afterResponse.statusCode).toBe(200);
    expect(afterResponse.rawPayload.equals(COVER_PNG)).toBe(true);
    expect(cover.calls).toEqual([]);
  });

  it('sends the present asset filename and format to the agent instead of the edition title', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const base = proposalAssistant({ title: 'Agent Chosen Title', coverId: null, isbn: null });
    const assistant: AssistantTransport = {
      async fetch(input, init) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (!base.fetch) throw new Error('missing assistant transport');
        return base.fetch(input, init);
      },
    };
    const { app, config, cookie, libraryId } = await startApp({ assistant });
    const imported = await upload(app, cookie, libraryId, [
      {
        filename: 'first-present-source.epub',
        content: buildEpub({
          title: 'Embedded Source Title',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee16',
        }),
      },
    ]);
    expect(imported.status).toBe('succeeded');
    const editionId = imported.items[0]?.editionId ?? 0;
    expect((await edition(app, cookie, editionId)).title).toBe('Agent Chosen Title');

    const assets = new Database(config.databasePath);
    assets
      .prepare(
        `INSERT INTO file_assets
           (edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at)
         VALUES (?, 'pdf', ?, 1, 'second-present-source.pdf', 'managed', 'blobs/second', 'present', ?)`,
      )
      .run(editionId, '0'.repeat(64), new Date().toISOString());
    assets.close();

    const beforeLookup = bodies.length;
    const lookupJob = await lookup(app, cookie, editionId);
    expect(lookupJob.status).toBe('succeeded');
    const lookupBodies = bodies.slice(beforeLookup);
    expect(lookupBodies).toHaveLength(1);
    const messages = Array.isArray(lookupBodies[0]?.messages)
      ? (lookupBodies[0]?.messages as Array<Record<string, unknown>>)
      : [];
    const user = messages.find((message) => message.role === 'user');
    const prompt = JSON.parse(String(user?.content ?? '{}')) as {
      filename?: string;
      format?: string;
      fields?: { title?: string | null };
    };
    expect(prompt.filename).toBe('first-present-source.epub');
    expect(prompt.format).toBe('epub');
    expect(prompt.fields?.title).toBe('Agent Chosen Title');
    expect(prompt.filename).not.toBe(prompt.fields?.title);
  });

  it('sends the PDF asset filename and format to the agent when the only asset is a PDF', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const base = proposalAssistant({ title: 'Pdf Agent Title', coverId: null, isbn: null });
    const assistant: AssistantTransport = {
      async fetch(input, init) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (!base.fetch) throw new Error('missing assistant transport');
        return base.fetch(input, init);
      },
    };
    const { app, config, cookie, libraryId } = await startApp({ assistant });
    const imported = await upload(app, cookie, libraryId, [
      {
        filename: 'only-present-source.pdf',
        content: buildTextPdf(),
      },
    ]);
    expect(imported.status).toBe('succeeded');
    const editionId = imported.items[0]?.editionId ?? 0;
    expect((await edition(app, cookie, editionId)).title).toBe('Pdf Agent Title');

    const assets = new Database(config.databasePath, { readonly: true });
    const asset = assets
      .prepare('SELECT original_filename, format FROM file_assets WHERE edition_id = ? ORDER BY id')
      .all(editionId) as Array<{ original_filename: string; format: string }>;
    assets.close();
    expect(asset).toEqual([{ original_filename: 'only-present-source.pdf', format: 'pdf' }]);

    const beforeLookup = bodies.length;
    const lookupJob = await lookup(app, cookie, editionId);
    expect(lookupJob.status).toBe('succeeded');
    const lookupBodies = bodies.slice(beforeLookup);
    expect(lookupBodies).toHaveLength(1);
    const messages = Array.isArray(lookupBodies[0]?.messages)
      ? (lookupBodies[0]?.messages as Array<Record<string, unknown>>)
      : [];
    const user = messages.find((message) => message.role === 'user');
    const prompt = JSON.parse(String(user?.content ?? '{}')) as {
      filename?: string;
      format?: string;
      fields?: { title?: string | null };
    };
    expect(prompt.filename).toBe('only-present-source.pdf');
    expect(prompt.format).toBe('pdf');
    expect(prompt.fields?.title).toBe('Pdf Agent Title');
    expect(prompt.filename).not.toBe(prompt.fields?.title);
  });

  it('reports no proposed cover when Open Library returns none, and leaves the cover alone', async () => {
    const assistant = embeddedMetadataAssistant();
    const cover = coverStub(404);
    const { app, cookie, libraryId } = await startApp({ assistant, openLibrary: cover.transport });
    const imported = await upload(app, cookie, libraryId, [
      {
        filename: 'no-cover.epub',
        content: buildEpub({
          title: 'No Cover',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee04',
        }),
      },
    ]);
    const editionId = imported.items[0]?.editionId ?? 0;
    // Open Library had nothing, so the upload kept the cover embedded in the EPUB.
    const before = await edition(app, cookie, editionId);
    expect(before.cover).toEqual({ mediaType: 'image/png' });
    assistant.fetch = proposalAssistant({ coverId: 404, isbn: '9780140328721' }).fetch;
    cover.calls.length = 0;
    const lookupJob = await lookup(app, cookie, editionId);
    const preview = lookupJob.result?.preview;
    // An ISBN alone is not a cover: Open Library answered 404, so nothing is proposed.
    expect(cover.calls.length).toBeGreaterThan(0);
    expect(preview?.fields.find((field) => field.field === 'cover')).toMatchObject({
      status: 'unchanged',
      proposed: null,
    });
    expect(preview?.fields.find((field) => field.field === 'cover')?.current).toMatchObject({
      url: expect.stringMatching(new RegExp(`^/api/editions/${editionId}/cover`)),
      width: 1,
      height: 1,
    });

    cover.calls.length = 0;
    const applied = await apply(app, cookie, editionId, preview?.previewId ?? 0, ['cover']);
    expect(applied.status).toBe('succeeded');
    const after = await edition(app, cookie, editionId);
    expect(after.cover).toEqual(before.cover);
    expect(after.locks).not.toContain('cover');
    expect(after.title).toBe('No Cover');
    expect(cover.calls).toEqual([]);
  });

  it('fails the lookup job with metadata_assistant_unconfigured when no assistant is saved', async () => {
    const { app, config, cookie, libraryId } = await startApp({ assistant: embeddedMetadataAssistant() });
    const imported = await upload(app, cookie, libraryId, [
      {
        filename: 'unconfigured.epub',
        content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee05' }),
      },
    ]);
    const editionId = imported.items[0]?.editionId ?? 0;
    rmSync(path.join(config.dataDir, 'metadata-assistant.json'), { force: true });

    const lookupJob = await lookup(app, cookie, editionId);
    expect(lookupJob.status).toBe('failed');
    expect(lookupJob.result).toEqual({ error: 'metadata_assistant_unconfigured' });

    const db = new Database(config.databasePath, { readonly: true });
    const previews = db.prepare('SELECT COUNT(*) AS count FROM metadata_previews').get() as { count: number };
    db.close();
    expect(previews.count).toBe(0);
  });

  it('applies a preview stored before translators, series, and series order existed', async () => {
    const { app, config, cookie, libraryId } = await startApp({ assistant: embeddedMetadataAssistant() });
    const imported = await upload(app, cookie, libraryId, [
      {
        filename: 'old-preview.epub',
        content: buildEpub({
          title: 'Old Preview',
          translator: 'Old Translator',
          description: 'Old embedded description.',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee06',
        }),
      },
    ]);
    const editionId = imported.items[0]?.editionId ?? 0;
    const db = new Database(config.databasePath);
    const inserted = db
      .prepare('INSERT INTO metadata_previews (edition_id, proposal, created_at) VALUES (?, ?, ?) RETURNING id')
      .get(
        editionId,
        JSON.stringify({
          title: 'Older Agent Title',
          authors: ['Older Agent Author'],
          description: 'Older agent description.',
          publisher: 'Older Agent Press',
          publishedDate: '1970-01-01',
          language: 'en',
          identifiers: [{ scheme: 'isbn', value: '9780140328721' }],
          coverId: null,
          isbn: null,
        }),
        new Date().toISOString(),
      ) as { id: number };
    db.close();

    const applied = await apply(app, cookie, editionId, inserted.id, ['description']);
    expect(applied.status).toBe('succeeded');
    const after = await edition(app, cookie, editionId);
    expect(after.description).toBe('Older agent description.');
    expect(after.title).toBe('Old Preview');
    expect(after.translators).toEqual(['Old Translator']);
  });
});

const DOUBAN_COVER = 'https://img3.doubanio.com/view/subject/l/public/s28305968.jpg';
const DOUBAN_PAGE = 'https://book.douban.com/subject/25869109/';

/** The agent proposes the Douban cover; the image host answers with `image` (and logs requests). */
function coverAssistant(image: Buffer, overrides: Partial<AssistantProposal> = {}) {
  const requests: Array<{ url: string; referer: string | undefined }> = [];
  const transport: AssistantTransport = {
    ...proposalAssistant({ cover: { url: DOUBAN_COVER, sourceUrl: DOUBAN_PAGE }, ...overrides }),
    web: {
      async fetch(input, init) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requests.push({ url, referer: (init?.headers as Record<string, string> | undefined)?.referer });
        return new Response(new Uint8Array(image), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      },
      async lookup() {
        return ['93.184.216.34'];
      },
    },
  };
  return { transport, requests };
}

function previewRow(databasePath: string, previewId: number): Record<string, unknown> | undefined {
  const db = new Database(databasePath, { readonly: true });
  const row = db.prepare('SELECT * FROM metadata_previews WHERE id = ?').get(previewId) as Record<string, unknown> | undefined;
  db.close();
  return row;
}

describe('agent covers in the lookup preview', () => {
  it('stages the verified agent cover, serves it to admins only, and applies exactly those bytes', async () => {
    const assistant = embeddedMetadataAssistant();
    const ol = coverStub();
    const { app, config, cookie, libraryId } = await startApp({ assistant, openLibrary: ol.transport });
    const imported = await upload(app, cookie, libraryId, [
      { filename: 'jdxx.epub', content: buildEpub({ title: 'Before', identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee31' }) },
    ]);
    const editionId = imported.items[0]?.editionId ?? 0;
    const image = jpegOfSize(357, 500, 8000);
    const agent = coverAssistant(image);
    assistant.fetch = agent.transport.fetch;
    assistant.web = agent.transport.web;
    ol.calls.length = 0;

    const job = await lookup(app, cookie, editionId);
    expect(job.status).toBe('succeeded');
    const preview = job.result!.preview!;
    const coverField = preview.fields.find((field) => field.field === 'cover');
    const stagedUrl = `/api/editions/${editionId}/metadata/previews/${preview.previewId}/cover`;
    expect(coverField).toMatchObject({
      status: 'change',
      proposed: { url: stagedUrl, width: 357, height: 500, sourceUrl: DOUBAN_PAGE, host: 'book.douban.com' },
      current: { width: 1, height: 1 },
    });
    // The agent's image was verified, so Open Library was never asked.
    expect(ol.calls).toEqual([]);
    expect(agent.requests).toEqual([{ url: DOUBAN_COVER, referer: 'https://book.douban.com/' }]);

    const row = previewRow(config.databasePath, preview.previewId)!;
    expect(row).toMatchObject({ cover_media_type: 'image/jpeg', cover_width: 357, cover_height: 500, cover_origin: 'agent' });
    const stagedHash = row.cover_sha256 as string;
    expect(existsSync(absoluteBlobPath(config.dataDir, stagedHash))).toBe(true);

    const served = await app.inject({ method: 'GET', url: stagedUrl, headers: { cookie } });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(served.rawPayload.equals(image)).toBe(true);
    const wrongEdition = await app.inject({
      method: 'GET',
      url: `/api/editions/${editionId + 999}/metadata/previews/${preview.previewId}/cover`,
      headers: { cookie },
    });
    expect([404, 400]).toContain(wrongEdition.statusCode);
    const created = await app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username: 'bea', password } });
    expect(created.statusCode).toBe(201);
    const login = await app.inject({ method: 'POST', url: '/api/session/login', payload: { username: 'bea', password } });
    const reader = await app.inject({ method: 'GET', url: stagedUrl, headers: { cookie: cookieFrom(login) } });
    expect(reader.statusCode).toBe(403);

    const trajectory = await app.inject({ method: 'GET', url: `/api/metadata/trajectories/${(job as { trajectoryId?: number }).trajectoryId}`, headers: { cookie } });
    const notes = (trajectory.json().trajectory.steps as Array<{ kind: string; data: { message?: string } }>)
      .filter((step) => step.kind === 'note')
      .map((step) => step.data.message);
    expect(notes).toContain('Cover verified 357×500 JPEG from img3.doubanio.com');

    agent.requests.length = 0;
    const applied = await apply(app, cookie, editionId, preview.previewId, ['cover']);
    expect(applied.status).toBe('succeeded');
    // Applying reads the staged blob; nothing is downloaded again.
    expect(agent.requests).toEqual([]);
    const after = await edition(app, cookie, editionId);
    expect(after.cover).toEqual({ mediaType: 'image/jpeg' });
    expect(after.locks).toContain('cover');
    const coverBytes = await app.inject({ method: 'GET', url: `/api/editions/${editionId}/cover`, headers: { cookie } });
    expect(coverBytes.rawPayload.equals(image)).toBe(true);
    // The staged columns are cleared; the blob stays because it is now the cover.
    expect(previewRow(config.databasePath, preview.previewId)).toMatchObject({ cover_sha256: null });
    expect(existsSync(absoluteBlobPath(config.dataDir, stagedHash))).toBe(true);
    expect((await app.inject({ method: 'GET', url: stagedUrl, headers: { cookie } })).statusCode).toBe(404);
  });

  it('releases an unused staged cover when the preview is replaced', async () => {
    const assistant = embeddedMetadataAssistant();
    const { app, config, cookie, libraryId } = await startApp({ assistant, openLibrary: coverStub(404).transport });
    const imported = await upload(app, cookie, libraryId, [
      { filename: 'replace.epub', content: buildEpub({ title: 'Replace', identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee32' }) },
    ]);
    const editionId = imported.items[0]?.editionId ?? 0;
    const agent = coverAssistant(jpegOfSize(357, 500, 8000));
    assistant.fetch = agent.transport.fetch;
    assistant.web = agent.transport.web;
    const first = await lookup(app, cookie, editionId);
    const hash = previewRow(config.databasePath, first.result!.preview!.previewId)!.cover_sha256 as string;
    expect(existsSync(absoluteBlobPath(config.dataDir, hash))).toBe(true);

    assistant.fetch = proposalAssistant({ coverId: null, isbn: null }).fetch;
    const second = await lookup(app, cookie, editionId);
    expect(second.result!.preview!.fields.find((field) => field.field === 'cover')).toMatchObject({ proposed: null });
    expect(previewRow(config.databasePath, first.result!.preview!.previewId)).toBeUndefined();
    expect(existsSync(absoluteBlobPath(config.dataDir, hash))).toBe(false);
  });

  it('downloads nothing for a locked cover and never replaces it', async () => {
    const assistant = embeddedMetadataAssistant();
    const ol = coverStub();
    const { app, cookie, libraryId } = await startApp({ assistant, openLibrary: ol.transport });
    const imported = await upload(app, cookie, libraryId, [
      { filename: 'locked.epub', content: buildEpub({ title: 'Locked', identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee33' }) },
    ]);
    const editionId = imported.items[0]?.editionId ?? 0;
    const form = multipart([{ name: 'file', filename: 'mine.png', content: COVER_PNG, type: 'image/png' }]);
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/cover`,
      headers: { ...form.headers, cookie },
      payload: form.payload,
    });
    expect(uploaded.statusCode).toBe(200);
    expect((await edition(app, cookie, editionId)).locks).toContain('cover');

    const agent = coverAssistant(jpegOfSize(357, 500, 8000));
    assistant.fetch = agent.transport.fetch;
    assistant.web = agent.transport.web;
    ol.calls.length = 0;
    const job = await lookup(app, cookie, editionId);
    const preview = job.result!.preview!;
    expect(preview.fields.find((field) => field.field === 'cover')).toMatchObject({ status: 'kept', locked: true, proposed: null });
    expect(agent.requests).toEqual([]);
    expect(ol.calls).toEqual([]);

    const applied = await apply(app, cookie, editionId, preview.previewId, ['cover']);
    expect(applied.status).toBe('succeeded');
    expect((await edition(app, cookie, editionId)).cover).toEqual({ mediaType: 'image/png' });
  });

  it('falls back to Open Library when the agent cover is rejected, and notes why', async () => {
    const assistant = embeddedMetadataAssistant();
    const ol = coverStub();
    const { app, cookie, libraryId } = await startApp({ assistant, openLibrary: ol.transport });
    const imported = await upload(app, cookie, libraryId, [
      { filename: 'wide.epub', content: buildEpub({ title: 'Wide', identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee34' }) },
    ]);
    const editionId = imported.items[0]?.editionId ?? 0;
    const agent = coverAssistant(jpegOfSize(500, 357, 8000), { coverId: 77 });
    assistant.fetch = agent.transport.fetch;
    assistant.web = agent.transport.web;
    ol.calls.length = 0;
    const job = await lookup(app, cookie, editionId);
    expect(job.result!.preview!.fields.find((field) => field.field === 'cover')).toMatchObject({
      proposed: { host: 'covers.openlibrary.org' },
    });
    expect(ol.calls.some((href) => href.includes('/b/id/77-L.jpg'))).toBe(true);
    const trajectory = await app.inject({ method: 'GET', url: `/api/metadata/trajectories/${(job as { trajectoryId?: number }).trajectoryId}`, headers: { cookie } });
    const notes = (trajectory.json().trajectory.steps as Array<{ kind: string; data: { message?: string } }>)
      .filter((step) => step.kind === 'note')
      .map((step) => step.data.message ?? '');
    expect(notes.some((note) => note.startsWith('Cover rejected from img3.doubanio.com: wrong_aspect'))).toBe(true);
  });
});

/** The EPUB's own cover, distinct from Open Library's stub image. */
const FILE_COVER = pngOfSize(300, 450);

describe('upload cover preference', () => {
  async function uploadWith(image: Buffer | null, olStatus: number, identifier: string) {
    const ol = coverStub(olStatus);
    const agent = image ? coverAssistant(image) : null;
    const base = embeddedMetadataAssistant();
    const assistant: AssistantTransport = {
      async fetch(input, init) {
        const response = await base.fetch!(input, init);
        if (!agent) return response;
        // Add the agent's cover to the embedded-metadata submission.
        const body = (await response.json()) as { choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }> };
        const call = body.choices[0]!.message.tool_calls[0]!.function;
        call.arguments = JSON.stringify({ ...JSON.parse(call.arguments), cover: { url: DOUBAN_COVER, sourceUrl: DOUBAN_PAGE } });
        return Response.json(body);
      },
      web: agent?.transport.web,
    };
    const { app, cookie, libraryId } = await startApp({ assistant, openLibrary: ol.transport });
    const imported = await upload(app, cookie, libraryId, [
      { filename: 'pref.epub', content: buildEpub({ title: 'Pref', identifier: `urn:isbn:${identifier}`, cover: FILE_COVER }) },
    ]);
    expect(imported.status).toBe('succeeded');
    const editionId = imported.items[0]?.editionId ?? 0;
    const response = await app.inject({ method: 'GET', url: `/api/editions/${editionId}/cover`, headers: { cookie } });
    return { status: response.statusCode, bytes: response.rawPayload, ol };
  }

  it('uses the verified agent cover first, then Open Library, then the file', async () => {
    const image = jpegOfSize(357, 500, 8000);
    const agentFirst = await uploadWith(image, 200, '9780140328721');
    expect(agentFirst.bytes.equals(image)).toBe(true);
    expect(agentFirst.ol.calls).toEqual([]);

    // A rejected agent image (landscape) falls through to Open Library's cover.
    const olNext = await uploadWith(jpegOfSize(500, 357, 8000), 200, '9780140328721');
    expect(olNext.ol.calls.length).toBeGreaterThan(0);
    expect(olNext.bytes.equals(COVER_PNG)).toBe(true);

    // Neither found anything: the EPUB's own cover is kept.
    const fileLast = await uploadWith(null, 404, '9780140328721');
    expect(fileLast.status).toBe(200);
    expect(fileLast.bytes.equals(FILE_COVER)).toBe(true);
  });
});

/** Removes the edition's cover rows, as for a book imported without one. The blob may stay. */
function dropCover(databasePath: string, editionId: number): void {
  const db = new Database(databasePath);
  db.prepare('DELETE FROM covers WHERE edition_id = ?').run(editionId);
  db.close();
}

function coverRows(databasePath: string, editionId: number): Array<{ sha256: string; created_at: string }> {
  const db = new Database(databasePath, { readonly: true });
  const rows = db.prepare('SELECT sha256, created_at FROM covers WHERE edition_id = ?').all(editionId) as Array<{
    sha256: string;
    created_at: string;
  }>;
  db.close();
  return rows;
}

interface PendingLookupView {
  previewId: number;
  createdAt: string;
  changedFields: string[];
}

async function editionPayload(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, editionId: number) {
  const response = await app.inject({ method: 'GET', url: `/api/editions/${editionId}`, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json().edition as Record<string, unknown> & { pendingLookup?: PendingLookupView | null };
}

async function readerCookie(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, libraryId: number): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username: 'bea', password } });
  expect(created.statusCode).toBe(201);
  const grant = await app.inject({
    method: 'POST',
    url: `/api/libraries/${libraryId}/grants`,
    headers: { cookie },
    payload: { userId: created.json().user.id },
  });
  expect(grant.statusCode).toBe(201);
  const login = await app.inject({ method: 'POST', url: '/api/session/login', payload: { username: 'bea', password } });
  return cookieFrom(login);
}

describe('automatic cover for a coverless book', () => {
  async function coverlessEdition(identifier: string) {
    const assistant = embeddedMetadataAssistant();
    const ol = coverStub(404);
    const started = await startApp({ assistant, openLibrary: ol.transport });
    const imported = await upload(started.app, started.cookie, started.libraryId, [
      { filename: 'bare.epub', content: buildEpub({ title: 'Bare Title', author: 'Bare Author', identifier }) },
    ]);
    const editionId = imported.items[0]?.editionId ?? 0;
    dropCover(started.config.databasePath, editionId);
    const image = jpegOfSize(357, 500, 8000);
    const agent = coverAssistant(image);
    assistant.fetch = agent.transport.fetch;
    assistant.web = agent.transport.web;
    return { ...started, editionId, image, ol };
  }

  it('writes the verified cover at once, without locking it or touching any text field', async () => {
    const { app, config, cookie, libraryId, editionId, image } = await coverlessEdition('urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee41');
    const before = await edition(app, cookie, editionId);
    expect(before.cover).toBeNull();

    const job = await lookup(app, cookie, editionId);
    expect(job.status).toBe('succeeded');
    const preview = job.result!.preview!;

    const after = await edition(app, cookie, editionId);
    expect(after.cover).toEqual({ mediaType: 'image/jpeg' });
    expect(after.locks).not.toContain('cover');
    expect(after.locks).toEqual(before.locks);
    expect(after.title).toBe('Bare Title');
    expect(after.authors).toEqual(before.authors);
    expect(after.description).toBe(before.description);
    expect(after.publisher).toBe(before.publisher);
    expect(after.language).toBe(before.language);
    expect(after.identifiers).toEqual(before.identifiers);
    expect(after.series).toEqual(before.series);
    const served = await app.inject({ method: 'GET', url: `/api/editions/${editionId}/cover`, headers: { cookie } });
    expect(served.rawPayload.equals(image)).toBe(true);

    // The rest of the preview waits for review; its cover row now matches the current cover.
    expect(preview.fields.find((field) => field.field === 'cover')).toMatchObject({ status: 'unchanged' });
    expect(preview.fields.find((field) => field.field === 'title')).toMatchObject({ status: 'change' });
    const row = previewRow(config.databasePath, preview.previewId)!;
    expect(row.applied_at).toBeNull();
    expect(coverRows(config.databasePath, editionId)).toEqual([expect.objectContaining({ sha256: row.cover_sha256 })]);

    const trajectory = await app.inject({
      method: 'GET',
      url: `/api/metadata/trajectories/${(job as { trajectoryId?: number }).trajectoryId}`,
      headers: { cookie },
    });
    const note = (trajectory.json().trajectory.steps as Array<{ kind: string; data: Record<string, unknown> }>).find(
      (step) => step.kind === 'note' && step.data.message === 'cover_auto_applied',
    );
    expect(note?.data.cover).toEqual({ status: 'auto_applied', width: 357, height: 500, host: 'book.douban.com' });

    // The admin sees what is still pending; a reader never does.
    const admin = await editionPayload(app, cookie, editionId);
    expect(admin.pendingLookup).toMatchObject({ previewId: preview.previewId, createdAt: row.created_at });
    expect(admin.pendingLookup?.changedFields).toEqual(expect.arrayContaining(['title', 'description', 'publisher']));
    expect(admin.pendingLookup?.changedFields).not.toContain('cover');
    const reader = await readerCookie(app, cookie, libraryId);
    const readerView = await editionPayload(app, reader, editionId);
    expect(readerView).not.toHaveProperty('pendingLookup');
    const readerPreview = await app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/metadata/previews/${preview.previewId}`,
      headers: { cookie: reader },
    });
    expect(readerPreview.statusCode).toBe(403);
  });

  it('does not write the cover twice when the preview is applied later', async () => {
    const { app, config, cookie, editionId, image } = await coverlessEdition('urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee42');
    const job = await lookup(app, cookie, editionId);
    const preview = job.result!.preview!;
    const written = coverRows(config.databasePath, editionId);
    expect(written).toHaveLength(1);

    const reviewed = await app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/metadata/previews/${preview.previewId}`,
      headers: { cookie },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().preview).toMatchObject({ previewId: preview.previewId, source: 'assistant', model: 'scripted-model' });
    expect(reviewed.json().preview.fields.find((field: PreviewFieldView) => field.field === 'cover')).toMatchObject({
      status: 'unchanged',
    });

    const applied = await apply(app, cookie, editionId, preview.previewId, ['title', 'cover']);
    expect(applied.status).toBe('succeeded');
    expect(coverRows(config.databasePath, editionId)).toEqual(written);
    const after = await edition(app, cookie, editionId);
    expect(after.title).toBe('Agent Title');
    const served = await app.inject({ method: 'GET', url: `/api/editions/${editionId}/cover`, headers: { cookie } });
    expect(served.rawPayload.equals(image)).toBe(true);
    expect(existsSync(absoluteBlobPath(config.dataDir, written[0]!.sha256))).toBe(true);

    expect((await editionPayload(app, cookie, editionId)).pendingLookup).toBeNull();
    expect(previewRow(config.databasePath, preview.previewId)?.applied_at).toEqual(expect.any(String));
    const gone = await app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/metadata/previews/${preview.previewId}`,
      headers: { cookie },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('only proposes a cover when the edition already has one', async () => {
    const assistant = embeddedMetadataAssistant();
    const { app, config, cookie, libraryId } = await startApp({ assistant, openLibrary: coverStub(404).transport });
    const imported = await upload(app, cookie, libraryId, [
      { filename: 'covered.epub', content: buildEpub({ title: 'Covered', identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee43' }) },
    ]);
    const editionId = imported.items[0]?.editionId ?? 0;
    const existing = coverRows(config.databasePath, editionId);
    expect(existing).toHaveLength(1);
    const agent = coverAssistant(jpegOfSize(357, 500, 8000));
    assistant.fetch = agent.transport.fetch;
    assistant.web = agent.transport.web;

    const job = await lookup(app, cookie, editionId);
    const preview = job.result!.preview!;
    expect(preview.fields.find((field) => field.field === 'cover')).toMatchObject({ status: 'change' });
    expect(coverRows(config.databasePath, editionId)).toEqual(existing);
    expect((await editionPayload(app, cookie, editionId)).pendingLookup?.changedFields).toContain('cover');
  });

  it('leaves a locked, coverless edition without a cover', async () => {
    const { app, config, cookie, editionId, ol } = await coverlessEdition('urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee44');
    const db = new Database(config.databasePath);
    db.prepare("INSERT INTO field_locks (edition_id, field, locked_at) VALUES (?, 'cover', ?)").run(editionId, new Date().toISOString());
    db.close();
    ol.calls.length = 0;

    const job = await lookup(app, cookie, editionId);
    expect(job.status).toBe('succeeded');
    expect(coverRows(config.databasePath, editionId)).toEqual([]);
    expect(job.result!.preview!.fields.find((field) => field.field === 'cover')).toMatchObject({ status: 'kept', proposed: null });
  });

  it('dismisses a pending preview and releases its staged cover', async () => {
    const assistant = embeddedMetadataAssistant();
    const { app, config, cookie, libraryId } = await startApp({ assistant, openLibrary: coverStub(404).transport });
    const imported = await upload(app, cookie, libraryId, [
      { filename: 'dismiss.epub', content: buildEpub({ title: 'Dismiss', identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee45' }) },
    ]);
    const editionId = imported.items[0]?.editionId ?? 0;
    const agent = coverAssistant(jpegOfSize(357, 500, 8000));
    assistant.fetch = agent.transport.fetch;
    assistant.web = agent.transport.web;
    const preview = (await lookup(app, cookie, editionId)).result!.preview!;
    const staged = previewRow(config.databasePath, preview.previewId)!.cover_sha256 as string;
    expect(existsSync(absoluteBlobPath(config.dataDir, staged))).toBe(true);
    expect((await editionPayload(app, cookie, editionId)).pendingLookup?.previewId).toBe(preview.previewId);

    const url = `/api/editions/${editionId}/metadata/previews/${preview.previewId}`;
    const reader = await readerCookie(app, cookie, libraryId);
    expect((await app.inject({ method: 'DELETE', url, headers: { cookie: reader } })).statusCode).toBe(403);

    const dismissed = await app.inject({ method: 'DELETE', url, headers: { cookie } });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json().edition.pendingLookup).toBeNull();
    expect((await editionPayload(app, cookie, editionId)).pendingLookup).toBeNull();
    expect(previewRow(config.databasePath, preview.previewId)).toBeUndefined();
    expect(existsSync(absoluteBlobPath(config.dataDir, staged))).toBe(false);
    expect((await app.inject({ method: 'DELETE', url, headers: { cookie } })).statusCode).toBe(404);
  });

  it('backfills a staged cover once at start, and repeating it changes nothing', async () => {
    const assistant = embeddedMetadataAssistant();
    const { app, config, cookie, libraryId } = await startApp({ assistant, openLibrary: coverStub(404).transport });
    const imported = await upload(app, cookie, libraryId, [
      { filename: 'legacy.epub', content: buildEpub({ title: 'Legacy', identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee46' }) },
    ]);
    const editionId = imported.items[0]?.editionId ?? 0;
    const agent = coverAssistant(jpegOfSize(357, 500, 8000));
    assistant.fetch = agent.transport.fetch;
    assistant.web = agent.transport.web;
    // The edition had a cover at lookup time, so the preview only staged one.
    const preview = (await lookup(app, cookie, editionId)).result!.preview!;
    const staged = previewRow(config.databasePath, preview.previewId)!.cover_sha256 as string;
    await app.close();
    // As for a preview created before covers were applied automatically.
    dropCover(config.databasePath, editionId);

    const restart = async () => {
      const next = await buildApp({ config, clientDist: null, logger: false, assistant, openLibrary: coverStub(404).transport });
      const rows = coverRows(config.databasePath, editionId);
      await next.close();
      return rows;
    };
    const first = await restart();
    expect(first).toEqual([expect.objectContaining({ sha256: staged })]);
    const second = await restart();
    expect(second).toEqual(first);
    const db = new Database(config.databasePath, { readonly: true });
    const locks = db.prepare("SELECT count(*) AS count FROM field_locks WHERE edition_id = ? AND field = 'cover'").get(editionId);
    const pending = db.prepare('SELECT applied_at FROM metadata_previews WHERE id = ?').get(preview.previewId);
    db.close();
    expect(locks).toEqual({ count: 0 });
    expect(pending).toEqual({ applied_at: null });
  });
});
