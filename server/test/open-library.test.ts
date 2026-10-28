import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { absoluteBlobPath } from '../src/blobs.js';
import type { AssistantTransport } from '../src/metadata/assistant/client.js';
import type { AssistantProposal } from '../src/metadata/assistant/submit.js';
import {
  OPEN_LIBRARY_COVERS_ORIGIN,
  OPEN_LIBRARY_ORIGIN,
  OpenLibraryError,
  buildCoverUrl,
  buildIsbnUrl,
  buildSearchUrl,
  lookupOpenLibrary,
  type OpenLibraryTransport,
} from '../src/metadata/openLibrary.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { configureTestAssistant, embeddedMetadataAssistant, makeTempDir, tempConfig } from './helpers.js';
import { COVER_PNG, buildEpub, buildTextPdf } from './fixtures.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface RecordedCall {
  url: string;
  userAgent: string | null;
}

function cookieFrom(response: { headers: { 'set-cookie'?: string | string[] | undefined } }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(';')[0] ?? '';
}

async function waitForJob(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, id: number) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const job = response.json().job as {
      id: number;
      status: string;
      source: string;
      result: {
        preview?: {
          previewId: number;
          fields: Array<{ field: string; status: string; locked: boolean; current: string | null; proposed: string | null }>;
        } | null;
        error?: string;
        applied?: boolean;
        checked?: number;
        missing?: number;
        present?: number;
      } | null;
      items: Array<{ status: string; editionId: number | null }>;
    };
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${id} did not finish`);
}

async function editionOf(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, editionId: number) {
  const response = await app.inject({ method: 'GET', url: `/api/editions/${editionId}`, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json().edition as {
    title: string;
    description: string | null;
    publisher: string | null;
    language: string | null;
    identifiers: Array<{ scheme: string; value: string }>;
    cover: { mediaType: string } | null;
    locks: string[];
  };
}

function stubTransport(): { transport: OpenLibraryTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: OpenLibraryTransport = {
    async fetch(input, init) {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href);
      if (url.hostname !== 'openlibrary.org' && url.hostname !== 'covers.openlibrary.org') {
        throw new Error(`unexpected host ${url.href}`);
      }
      for (const name of ['key', 'api_key', 'apikey']) {
        if (url.searchParams.has(name)) throw new Error(`api key on ${url.href}`);
      }
      const headers = new Headers(init?.headers);
      calls.push({ url: url.href, userAgent: headers.get('user-agent') });
      if (url.pathname === '/search.json') {
        return Response.json({
          docs: [
            {
              title: 'OL Title',
              author_name: ['Ada Lovelace'],
              publisher: ['OL Press'],
              first_publish_year: 1843,
              language: ['eng'],
              isbn: ['9780000000002'],
              cover_i: 42,
            },
          ],
        });
      }
      if (url.pathname.startsWith('/isbn/')) {
        return Response.json({
          title: 'OL Title',
          publishers: ['OL Press'],
          publish_date: '1843',
          description: 'From the catalog.',
          languages: [{ key: '/languages/eng' }],
          covers: [42],
          isbn_13: ['9780000000002'],
        });
      }
      if (url.pathname.startsWith('/b/')) {
        return new Response(COVER_PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response('missing', { status: 404 });
    },
  };
  return { transport, calls };
}

function proposalAssistant(
  overrides: Partial<AssistantProposal> = {},
  onRequest?: () => Promise<void>,
): AssistantTransport {
  const proposal: AssistantProposal = {
    title: 'OL Title',
    authors: ['Ada Lovelace'],
    translators: [],
    description: 'From the catalog.',
    publisher: 'OL Press',
    publishedDate: '1843',
    language: 'en',
    identifiers: [{ scheme: 'isbn', value: '9780000000002' }],
    series: null,
    seriesOrder: null,
    coverId: 42,
    isbn: '9780000000002',
    ...overrides,
  };
  return {
    async fetch() {
      await onRequest?.();
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

function failingAssistant(): AssistantTransport {
  return {
    async fetch() {
      return new Response('unavailable', { status: 503 });
    },
  };
}

describe('open library client', () => {
  it('builds the public search, isbn, and cover urls with no api key', () => {
    expect(buildSearchUrl({ title: 'Tale', author: 'Lin' }).href).toBe(
      `${OPEN_LIBRARY_ORIGIN}/search.json?title=Tale&author=Lin&limit=5`,
    );
    expect(buildIsbnUrl('9780140328721').href).toBe(`${OPEN_LIBRARY_ORIGIN}/isbn/9780140328721.json`);
    expect(buildCoverUrl({ coverId: 42 }).href).toBe(`${OPEN_LIBRARY_COVERS_ORIGIN}/b/id/42-L.jpg?default=false`);
    expect(buildCoverUrl({ isbn: '9780140328721' }).href).toBe(
      `${OPEN_LIBRARY_COVERS_ORIGIN}/b/isbn/9780140328721-L.jpg?default=false`,
    );
    for (const href of [
      buildSearchUrl({ isbn: '9780140328721' }).href,
      buildIsbnUrl('9780140328721').href,
      buildCoverUrl({ coverId: 42 }).href,
    ]) {
      const url = new URL(href);
      expect(url.searchParams.has('key')).toBe(false);
      expect(url.searchParams.has('api_key')).toBe(false);
      expect(url.searchParams.has('apikey')).toBe(false);
    }
  });

  it('does not call the live service when tests forget a stub', async () => {
    await expect(lookupOpenLibrary({}, { title: 'Tale' })).rejects.toBeInstanceOf(OpenLibraryError);
  });

  it('previews locked fields as kept and applies only confirmed unlocked fields', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = tempConfig(temp.dir);
    migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
    configureTestAssistant(config.dataDir);
    const { transport, calls } = stubTransport();
    const assistant = embeddedMetadataAssistant();
    const app = await buildApp({
      config,
      clientDist: null,
      logger: false,
      openLibrary: transport,
      assistant,
    });
    cleanups.push(() => {
      void app.close();
    });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'ada', password, libraryName: 'Home' },
    });
    const cookie = cookieFrom(setup);
    const libraryId = setup.json().library.id as number;
    const pdf = buildTextPdf();
    const boundary = '----qijuanboundary';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="notes.pdf"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const created = await app.inject({
      method: 'POST',
      url: `/api/imports?libraryId=${libraryId}`,
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(created.statusCode).toBe(202);
    let editionId = 0;
    let sha = '';
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/jobs/${created.json().job.id as number}`,
        headers: { cookie },
      });
      const job = response.json().job as {
        status: string;
        items: Array<{ status: string; editionId: number | null; sha256: string | null }>;
      };
      if (job.status === 'succeeded' || job.status === 'failed') {
        expect(job.items[0]?.status).toBe('succeeded');
        editionId = job.items[0]?.editionId ?? 0;
        sha = job.items[0]?.sha256 ?? '';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const blobPath = absoluteBlobPath(config.dataDir, sha);
    const before = statSync(blobPath);
    const beforeHash = createHash('sha256').update(readFileSync(blobPath)).digest('hex');
    calls.length = 0;
    assistant.fetch = proposalAssistant().fetch;

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/editions/${editionId}`,
      headers: { cookie },
      payload: { title: 'Kept Title' },
    });
    expect(renamed.statusCode).toBe(200);

    const reader = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: { username: 'bea', password: 'reader-password' },
    });
    expect(reader.statusCode).toBe(201);
    const granted = await app.inject({
      method: 'POST',
      url: `/api/libraries/${libraryId}/grants`,
      headers: { cookie },
      payload: { userId: reader.json().user.id as number },
    });
    expect(granted.statusCode).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { username: 'bea', password: 'reader-password' },
    });
    const readerCookie = cookieFrom(login);
    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/lookup`,
      headers: { cookie: readerCookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(calls).toEqual([]);

    const lookup = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/lookup`,
      headers: { cookie },
    });
    expect(lookup.statusCode).toBe(202);
    const lookupJob = await waitForJob(app, cookie, lookup.json().job.id as number);
    expect(lookupJob.status).toBe('succeeded');
    const preview = lookupJob.result?.preview;
    expect(preview?.fields.find((field) => field.field === 'title')).toMatchObject({
      status: 'kept',
      locked: true,
      current: 'Kept Title',
      proposed: 'OL Title',
    });
    expect(preview?.fields.find((field) => field.field === 'description')).toMatchObject({
      status: 'change',
      locked: false,
      proposed: 'From the catalog.',
    });
    expect(calls.some((call) => call.url.startsWith(`${OPEN_LIBRARY_ORIGIN}/search.json`))).toBe(false);
    expect(calls.some((call) => call.url === `${OPEN_LIBRARY_ORIGIN}/isbn/9780000000002.json`)).toBe(false);
    expect(calls.some((call) => call.url.includes('covers.openlibrary.org'))).toBe(false);
    const beforeApply = await editionOf(app, cookie, editionId);

    const applied = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/apply`,
      headers: { cookie },
      payload: { previewId: preview?.previewId, confirm: ['title', 'description'] },
    });
    expect(applied.statusCode).toBe(202);
    const applyJob = await waitForJob(app, cookie, applied.json().job.id as number);
    expect(applyJob.status).toBe('succeeded');
    const afterApply = await editionOf(app, cookie, editionId);
    expect(afterApply.title).toBe('Kept Title');
    expect(afterApply.description).toBe('From the catalog.');
    expect(afterApply.publisher).toBe('QiJuan Test Press');
    expect(afterApply.language).toBe('en');
    expect(afterApply.identifiers).toEqual([{ scheme: 'isbn', value: '9780000000002' }]);
    expect(afterApply.cover).toEqual(beforeApply.cover);
    expect(afterApply.locks).toEqual(expect.arrayContaining(['title', 'description']));
    expect(afterApply.locks).not.toContain('publisher');

    const again = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/lookup`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(202);
    const againJob = await waitForJob(app, cookie, again.json().job.id as number);
    expect(againJob.status).toBe('succeeded');
    const covered = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/apply`,
      headers: { cookie },
      payload: { previewId: againJob.result?.preview?.previewId, confirm: ['title', 'publisher', 'cover'] },
    });
    expect(covered.statusCode).toBe(202);
    const coverJob = await waitForJob(app, cookie, covered.json().job.id as number);
    expect(coverJob.status).toBe('succeeded');
    const afterCover = await editionOf(app, cookie, editionId);
    expect(afterCover.title).toBe('Kept Title');
    expect(afterCover.description).toBe('From the catalog.');
    expect(afterCover.publisher).toBe('OL Press');
    expect(afterCover.cover).toEqual({ mediaType: 'image/png' });
    expect(calls.some((call) => call.url.startsWith(`${OPEN_LIBRARY_COVERS_ORIGIN}/b/id/42-L.jpg`))).toBe(true);
    expect(statSync(blobPath).ino).toBe(before.ino);
    expect(createHash('sha256').update(readFileSync(blobPath)).digest('hex')).toBe(beforeHash);

    const db = new Database(config.databasePath, { readonly: true });
    const editions = db.prepare('SELECT COUNT(*) AS count FROM editions').get() as { count: number };
    db.close();
    expect(editions.count).toBe(1);
  });

  it('returns an assistant preview even when Open Library has no match', async () => {
    const { transport, calls } = stubTransport();
    transport.fetch = async (input, init) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      calls.push({ url: href, userAgent: headers.get('user-agent') });
      const url = new URL(href);
      if (url.pathname === '/search.json') return Response.json({ docs: [] });
      return new Response('missing', { status: 404 });
    };
    const { app, config, cookie, editionId } = await importedPdf(transport);
    const before = await editionOf(app, cookie, editionId);
    const lookup = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/lookup`,
      headers: { cookie },
    });
    expect(lookup.statusCode).toBe(202);
    const job = await waitForJob(app, cookie, lookup.json().job.id as number);
    expect(job.status).toBe('succeeded');
    expect(job.result).toMatchObject({ preview: { source: 'assistant', model: 'scripted-model' } });
    expect(calls).toEqual([]);
    expect(await editionOf(app, cookie, editionId)).toMatchObject({ title: before.title, description: before.description });
    const db = new Database(config.databasePath, { readonly: true });
    const previews = db.prepare('SELECT COUNT(*) AS count FROM metadata_previews').get() as { count: number };
    db.close();
    expect(previews.count).toBe(1);
  });

  it('fails the lookup job when the assistant transport fails and leaves the edition unchanged', async () => {
    const { transport } = stubTransport();
    const { app, config, cookie, editionId } = await importedPdf(transport, failingAssistant());
    const before = await editionOf(app, cookie, editionId);
    const lookup = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/lookup`,
      headers: { cookie },
    });
    expect(lookup.statusCode).toBe(202);
    const job = await waitForJob(app, cookie, lookup.json().job.id as number);
    expect(job.status).toBe('failed');
    expect(job.result).toEqual({ error: 'metadata_unavailable' });
    expect(await editionOf(app, cookie, editionId)).toMatchObject({
      title: before.title,
      description: before.description,
      publisher: before.publisher,
    });
    const db = new Database(config.databasePath, { readonly: true });
    const previews = db.prepare('SELECT COUNT(*) AS count FROM metadata_previews').get() as { count: number };
    db.close();
    expect(previews.count).toBe(0);
  });

  it('fails apply when the cover transport fails and does not write confirmed fields', async () => {
    const { transport } = stubTransport();
    const original = transport.fetch;
    transport.fetch = async (input, init) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(href).pathname.startsWith('/b/')) return new Response('no', { status: 503 });
      if (!original) throw new Error('missing fetch');
      return original(input, init);
    };
    const { app, cookie, editionId } = await importedPdf(transport, proposalAssistant());
    const before = await editionOf(app, cookie, editionId);
    const lookup = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/lookup`,
      headers: { cookie },
    });
    const lookupJob = await waitForJob(app, cookie, lookup.json().job.id as number);
    expect(lookupJob.status).toBe('succeeded');
    const applied = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/apply`,
      headers: { cookie },
      payload: { previewId: lookupJob.result?.preview?.previewId, confirm: ['publisher', 'cover'] },
    });
    expect(applied.statusCode).toBe(202);
    const applyJob = await waitForJob(app, cookie, applied.json().job.id as number);
    expect(applyJob.status).toBe('failed');
    expect(applyJob.result).toEqual({ error: 'metadata_unavailable' });
    const after = await editionOf(app, cookie, editionId);
    expect(after.publisher).toBe(before.publisher);
    expect(after.cover).toBeNull();
    expect(after.title).toBe(before.title);
  });

  it('waits for the assistant and does not claim a second job or scan while one is in flight', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let assistantCalls = 0;
    const assistant = proposalAssistant({}, async () => {
      assistantCalls += 1;
      await gate;
    });
    const { transport } = stubTransport();
    const { app, config, dir, cookie, libraryId, editionId } = await importedPdf(transport, assistant);
    const root = path.join(dir, 'indexed');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'tale.epub'), buildEpub());
    const inserted = new Database(config.databasePath);
    const library = inserted
      .prepare(`INSERT INTO libraries (name, mode, root_path, created_at) VALUES ('Shelf', 'indexed', ?, ?) RETURNING id`)
      .get(root, new Date().toISOString()) as { id: number };
    inserted.close();
    const imported = await app.inject({
      method: 'POST',
      url: '/api/imports/folder',
      headers: { cookie },
      payload: { libraryId: library.id, path: '.' },
    });
    expect(imported.statusCode).toBe(202);
    const folderJob = await waitForJob(app, cookie, imported.json().job.id as number);
    expect(folderJob.items[0]?.status).toBe('succeeded');
    renameSync(root, path.join(dir, 'indexed-away'));

    const lookupPromise = app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/lookup`,
      headers: { cookie },
    });
    const lookup = await Promise.race([
      lookupPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('lookup waited on Open Library')), 1000)),
    ]);
    expect(lookup.statusCode).toBe(202);
    const lookupId = lookup.json().job.id as number;
    const started = Date.now();
    let running = false;
    while (Date.now() - started < 2000) {
      const view = await app.inject({ method: 'GET', url: `/api/jobs/${lookupId}`, headers: { cookie } });
      if (view.json().job.status === 'running' && assistantCalls >= 1) {
        running = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(running).toBe(true);
    expect(assistantCalls).toBe(1);

    const second = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/lookup`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(202);
    const rescan = await app.inject({
      method: 'POST',
      url: `/api/libraries/${library.id}/rescan`,
      headers: { cookie },
    });
    expect(rescan.statusCode).toBe(202);
    expect(assistantCalls).toBe(1);
    const queuedLookup = await app.inject({
      method: 'GET',
      url: `/api/jobs/${second.json().job.id as number}`,
      headers: { cookie },
    });
    const queuedScan = await app.inject({
      method: 'GET',
      url: `/api/jobs/${rescan.json().job.id as number}`,
      headers: { cookie },
    });
    expect(queuedLookup.json().job.status).toBe('queued');
    expect(queuedScan.json().job.status).toBe('queued');
    const during = new Database(config.databasePath, { readonly: true });
    const availability = during.prepare(
      `SELECT a.availability FROM file_assets a JOIN editions e ON e.id = a.edition_id WHERE e.library_id = ?`,
    ).all(library.id) as Array<{ availability: string }>;
    during.close();
    expect(availability.every((row) => row.availability === 'present')).toBe(true);

    release();
    expect((await waitForJob(app, cookie, lookupId)).status).toBe('succeeded');
    expect((await waitForJob(app, cookie, second.json().job.id as number)).status).toBe('succeeded');
    const scan = await waitForJob(app, cookie, rescan.json().job.id as number);
    expect(scan.status).toBe('succeeded');
    expect(scan.result).toMatchObject({ checked: 1, missing: 1, present: 0 });
    const after = new Database(config.databasePath, { readonly: true });
    const missing = after.prepare(
      `SELECT a.availability FROM file_assets a JOIN editions e ON e.id = a.edition_id WHERE e.library_id = ?`,
    ).all(library.id) as Array<{ availability: string }>;
    after.close();
    expect(missing.every((row) => row.availability === 'missing')).toBe(true);
    expect(libraryId).toBeGreaterThan(0);
  });
});

async function importedPdf(
  transport: OpenLibraryTransport,
  lookupAssistant?: AssistantTransport,
) {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  const config = tempConfig(temp.dir);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  configureTestAssistant(config.dataDir);
  const uploadAssistant = embeddedMetadataAssistant({ avoidIsbn: true });
  let modelCalls = 0;
  const assistant: AssistantTransport = {
    async fetch(input, init) {
      const current = modelCalls === 0 ? uploadAssistant : lookupAssistant ?? uploadAssistant;
      modelCalls += 1;
      return current.fetch!(input, init);
    },
  };
  const app = await buildApp({
    config,
    clientDist: null,
    logger: false,
    openLibrary: transport,
    assistant,
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
  const cookie = cookieFrom(setup);
  const libraryId = setup.json().library.id as number;
  const boundary = '----qijuanboundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="notes.pdf"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    buildTextPdf(),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const created = await app.inject({
    method: 'POST',
    url: `/api/imports?libraryId=${libraryId}`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  expect(created.statusCode).toBe(202);
  const job = await waitForJob(app, cookie, created.json().job.id as number);
  expect(job.items[0]?.status).toBe('succeeded');
  return { app, config, dir: temp.dir, cookie, libraryId, editionId: job.items[0]?.editionId ?? 0 };
}
