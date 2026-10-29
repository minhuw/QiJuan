import { rmSync } from 'node:fs';
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
import { COVER_PNG, buildEpub, buildTextPdf } from './fixtures.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface PreviewFieldView {
  field: string;
  locked: boolean;
  status: 'kept' | 'change' | 'unchanged';
  current: string | null;
  proposed: string | null;
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
    expect(cover.calls).toEqual([]);

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
      proposed: 'present',
    });

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

  it('leaves an existing cover alone when Open Library has no selected cover', async () => {
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
    assistant.fetch = proposalAssistant({ coverId: 404, isbn: '9780140328721' }).fetch;
    const lookupJob = await lookup(app, cookie, editionId);
    const preview = lookupJob.result?.preview;
    expect(preview?.fields.find((field) => field.field === 'cover')).toMatchObject({
      status: 'change',
      proposed: 'present',
    });

    const applied = await apply(app, cookie, editionId, preview?.previewId ?? 0, ['cover']);
    expect(applied.status).toBe('succeeded');
    const after = await edition(app, cookie, editionId);
    expect(after.cover).toBeNull();
    expect(after.title).toBe('No Cover');
    expect(cover.calls.length).toBeGreaterThan(0);
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
