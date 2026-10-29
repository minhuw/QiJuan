import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { absoluteBlobPath } from '../src/blobs.js';
import { openDatabase } from '../src/db.js';
import { requeueInterruptedJobs, resolveUploadPath } from '../src/jobs.js';
import type { AssistantTransport } from '../src/metadata/assistant/client.js';
import { writeAssistantSettings } from '../src/metadata/assistant-settings.js';
import type { OpenLibraryTransport } from '../src/metadata/openLibrary.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir, tempConfig } from './helpers.js';
import {
  buildEpub,
  buildImagePdf,
  buildTextPdf,
  COVER_PNG,
  EPUB_AUTHOR,
  EPUB_ID,
  EPUB_LANGUAGE,
  EPUB_TITLE,
  IMAGE_PDF_TITLE,
  malformedBook,
  TEXT_PDF_AUTHOR,
  TEXT_PDF_LANGUAGE,
  TEXT_PDF_TITLE,
} from './fixtures.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function multipart(parts: Array<{ name: string; filename: string; content: Buffer }>): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = '----qijuanboundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
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

async function waitForJob(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  id: number,
): Promise<{
  status: string;
  result: { checked?: number; missing?: number; present?: number; refreshed?: number } | null;
  summary: { total: number; queued: number; running: number; succeeded: number; failed: number; duplicate: number };
  items: Array<{ filename: string; status: string; error: string | null; editionId: number | null; assetId: number | null }>;
}> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const job = response.json().job as Awaited<ReturnType<typeof waitForJob>>;
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${id} did not finish`);
}

const assistantBaseUrl = 'https://model.example/v1';

interface PromptInput {
  filename: string;
  format: 'epub' | 'pdf';
  fields: {
    title: string | null;
    authors: string[];
    translators: string[];
    description: string | null;
    publisher: string | null;
    publishedDate: string | null;
    language: string | null;
    identifiers: Array<{ scheme: string; value: string }>;
    series: string | null;
    seriesOrder: number | null;
  };
}

interface ScriptedReply {
  content?: string | null;
  tool_calls?: Array<{ id?: string; name: string; arguments: string | unknown }>;
}

function configureAssistant(dataDir: string): void {
  writeAssistantSettings(dataDir, { baseUrl: assistantBaseUrl, model: 'scripted-model' });
}

function scriptedAssistant(script: (body: Record<string, unknown>, index: number) => ScriptedReply) {
  const bodies: Array<Record<string, unknown>> = [];
  const transport: AssistantTransport = {
    async fetch(_input, init) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const reply = script(body, bodies.length - 1);
      const calls = reply.tool_calls?.map((call, index) => ({
        id: call.id ?? `call_${index + 1}`,
        type: 'function',
        function: {
          name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
        },
      }));
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: reply.content ?? null,
              ...(calls && calls.length > 0 ? { tool_calls: calls } : {}),
            },
          },
        ],
      });
    },
  };
  return { transport, bodies, calls: () => bodies.length };
}

function promptInput(body: Record<string, unknown>): PromptInput {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
  const user = messages.find((message) => message.role === 'user');
  return JSON.parse(String(user?.content ?? '{}')) as PromptInput;
}

function defaultSubmission(body: Record<string, unknown>): Record<string, unknown> {
  const input = promptInput(body);
  const fields = input.fields;
  const title = fields.title ?? input.filename.replace(/\.[^.]+$/, '');
  const embeddedIsbn = fields.identifiers.find((item) => item.scheme.toLowerCase() === 'isbn')?.value ?? null;
  return {
    title,
    authors: fields.authors.length > 0 ? fields.authors : ['QiJuan Agent'],
    translators: fields.translators,
    description: fields.description ?? `Description for ${title}.`,
    publisher: fields.publisher ?? 'QiJuan Press',
    publishedDate: '2024-01-01',
    language: fields.language ?? 'en',
    identifiers:
      fields.identifiers.length > 0 ? fields.identifiers : [{ scheme: 'isbn', value: '9780140328721' }],
    series: null,
    seriesOrder: null,
    coverId: title === EPUB_TITLE ? 42 : null,
    isbn: embeddedIsbn,
  };
}

function defaultAssistant() {
  return scriptedAssistant((body) => ({
    tool_calls: [{ name: 'submit_metadata', arguments: defaultSubmission(body) }],
  }));
}

function openLibraryStub() {
  const urls: string[] = [];
  const transport: OpenLibraryTransport = {
    origin: 'https://ol.example',
    async fetch(input) {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      urls.push(url.href);
      if (url.pathname.startsWith('/b/')) {
        return new Response(new Uint8Array(COVER_PNG), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return Response.json({ docs: [] });
    },
  };
  return { transport, urls };
}

function blobFiles(dataDir: string): string[] {
  const root = path.join(dataDir, 'blobs');
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files.push(path.relative(root, absolute));
    }
  };
  walk(root);
  return files.sort();
}

async function startUploadApp(input: {
  assistant: AssistantTransport;
  openLibrary?: OpenLibraryTransport;
  configure?: boolean;
}) {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  const config = tempConfig(temp.dir);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  if (input.configure !== false) configureAssistant(config.dataDir);
  const app = await buildApp({
    config,
    clientDist: null,
    logger: false,
    assistant: input.assistant,
    openLibrary: input.openLibrary,
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
  return {
    temp,
    config,
    app,
    cookie: (setup.headers['set-cookie'] as string).split(';')[0] ?? '',
    libraryId: setup.json().library.id as number,
  };
}

async function uploadFiles(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  libraryId: number,
  parts: Array<{ name: string; filename: string; content: Buffer }>,
): Promise<Awaited<ReturnType<typeof waitForJob>>> {
  const body = multipart(parts);
  const created = await app.inject({
    method: 'POST',
    url: `/api/imports?libraryId=${libraryId}`,
    headers: { ...body.headers, cookie },
    payload: body.payload,
  });
  expect(created.statusCode).toBe(202);
  return waitForJob(app, cookie, created.json().job.id as number);
}

describe('batch import', () => {
  it('imports valid books, attaches a duplicate, and fails only the bad files', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = tempConfig(temp.dir);
    migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
    configureAssistant(config.dataDir);
    const assistant = defaultAssistant();
    const openLibrary = openLibraryStub();
    const app = await buildApp({
      config,
      clientDist: null,
      logger: false,
      assistant: assistant.transport,
      openLibrary: openLibrary.transport,
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
    const cookie = (setup.headers['set-cookie'] as string).split(';')[0] ?? '';
    const libraryId = setup.json().library.id as number;
    const epub = buildEpub();
    const textPdf = buildTextPdf();
    const imagePdf = buildImagePdf();
    const body = multipart([
      { name: 'files', filename: '../../qijuan-slip-Secret.epub', content: epub },
      { name: 'files', filename: 'text.pdf', content: textPdf },
      { name: 'files', filename: 'image.pdf', content: imagePdf },
      { name: 'files', filename: 'copy.epub', content: epub },
      { name: 'files', filename: 'broken.epub', content: malformedBook() },
      { name: 'files', filename: 'notes.txt', content: Buffer.from('hello') },
    ]);
    const created = await app.inject({
      method: 'POST',
      url: `/api/imports?libraryId=${libraryId}`,
      headers: { ...body.headers, cookie },
      payload: body.payload,
    });
    expect(created.statusCode).toBe(202);
    const job = await waitForJob(app, cookie, created.json().job.id as number);
    expect(job.status).toBe('succeeded');
    expect(job.summary).toMatchObject({ total: 6, succeeded: 3, failed: 2, duplicate: 1, queued: 0, running: 0 });
    expect(job.items.map((item) => [item.filename, item.status, item.error])).toEqual([
      ['qijuan-slip-Secret.epub', 'succeeded', null],
      ['text.pdf', 'succeeded', null],
      ['image.pdf', 'succeeded', null],
      ['copy.epub', 'duplicate', null],
      ['broken.epub', 'failed', 'malformed'],
      ['notes.txt', 'failed', 'unsupported'],
    ]);
    expect(job.items[3]?.assetId).toBe(job.items[0]?.assetId);
    expect(job.items[3]?.editionId).toBe(job.items[0]?.editionId);

    const db = new Database(config.databasePath, { readonly: true });
    const editions = db.prepare('SELECT id, title, language, trashed_at FROM editions ORDER BY id').all() as Array<{
      id: number;
      title: string;
      language: string | null;
      trashed_at: string | null;
    }>;
    const assets = db.prepare('SELECT id, edition_id, format, sha256, storage, original_filename FROM file_assets ORDER BY id').all() as Array<{
      id: number;
      edition_id: number;
      format: string;
      sha256: string;
      storage: string;
      original_filename: string;
    }>;
    const people = db
      .prepare(
        `SELECT p.name, c.role, c.edition_id
         FROM edition_contributors c JOIN persons p ON p.id = c.person_id
         ORDER BY c.edition_id, c.position`,
      )
      .all() as Array<{ name: string; role: string; edition_id: number }>;
    const ids = db.prepare('SELECT edition_id, scheme, value FROM identifiers ORDER BY edition_id, scheme').all() as Array<{
      edition_id: number;
      scheme: string;
      value: string;
    }>;
    const covers = db.prepare('SELECT edition_id, sha256, bytes, media_type FROM covers').all() as Array<{
      edition_id: number;
      sha256: string;
      bytes: number;
      media_type: string;
    }>;
    db.close();

    expect(editions.map((row) => row.title)).toEqual([EPUB_TITLE, TEXT_PDF_TITLE, IMAGE_PDF_TITLE]);
    expect(editions.every((row) => row.trashed_at === null)).toBe(true);
    expect(editions[0]?.language).toBe(EPUB_LANGUAGE);
    expect(editions[1]?.language).toBe(TEXT_PDF_LANGUAGE);
    expect(assets).toHaveLength(3);
    expect(assets.every((row) => row.storage === 'managed')).toBe(true);
    expect(assets[0]?.original_filename).toBe('qijuan-slip-Secret.epub');
    expect(assets.filter((row) => row.sha256 === assets[0]?.sha256)).toHaveLength(1);
    expect(people).toEqual([
      { name: EPUB_AUTHOR, role: 'author', edition_id: editions[0]?.id },
      { name: TEXT_PDF_AUTHOR, role: 'author', edition_id: editions[1]?.id },
      { name: 'QiJuan Agent', role: 'author', edition_id: editions[2]?.id },
    ]);
    expect(ids).toEqual([
      { edition_id: editions[0]?.id, scheme: 'uuid', value: EPUB_ID },
      { edition_id: editions[1]?.id, scheme: 'isbn', value: '9780000000002' },
      { edition_id: editions[2]?.id, scheme: 'isbn', value: '9780140328721' },
    ]);
    expect(covers).toHaveLength(3);
    expect(covers.every((cover) => cover.media_type === 'image/png' && cover.bytes === COVER_PNG.length)).toBe(true);
    const coverPath = absoluteBlobPath(config.dataDir, covers[0]?.sha256 ?? '');
    expect(coverPath.startsWith(config.dataDir)).toBe(true);

    const again = await app.inject({
      method: 'POST',
      url: `/api/imports?libraryId=${libraryId}`,
      headers: { ...multipart([{ name: 'files', filename: 'tale.epub', content: epub }]).headers, cookie },
      payload: multipart([{ name: 'files', filename: 'tale.epub', content: epub }]).payload,
    });
    expect(again.statusCode).toBe(202);
    const duplicate = await waitForJob(app, cookie, again.json().job.id as number);
    expect(duplicate.summary).toMatchObject({ total: 1, duplicate: 1, succeeded: 0 });
    expect(duplicate.items[0]?.assetId).toBe(assets[0]?.id);

    const revised = buildEpub({
      identifier: 'urn:uuid:11111111-2222-4333-8444-555555555555',
      english: 'Another edition of the same title.',
    });
    expect(revised.equals(epub)).toBe(false);
    const second = await app.inject({
      method: 'POST',
      url: `/api/imports?libraryId=${libraryId}`,
      headers: { ...multipart([{ name: 'files', filename: 'revised.epub', content: revised }]).headers, cookie },
      payload: multipart([{ name: 'files', filename: 'revised.epub', content: revised }]).payload,
    });
    const revisedJob = await waitForJob(app, cookie, second.json().job.id as number);
    expect(revisedJob.items[0]?.status).toBe('succeeded');
    const after = new Database(config.databasePath, { readonly: true });
    const titles = after.prepare('SELECT title FROM editions ORDER BY id').all() as Array<{ title: string }>;
    after.close();
    expect(titles.map((row) => row.title)).toEqual([EPUB_TITLE, TEXT_PDF_TITLE, IMAGE_PDF_TITLE, EPUB_TITLE]);
  });

  it('creates an upload edition from the agent proposal instead of embedded metadata', async () => {
    const submitted = {
      title: 'Agent Title',
      authors: ['Agent Author', 'Second Author'],
      translators: ['Agent Translator'],
      description: 'Agent description.',
      publisher: 'Agent Press',
      publishedDate: '1965-03-02',
      language: 'fr',
      identifiers: [{ scheme: 'isbn', value: '9780140328721' }],
      series: 'Agent Series',
      seriesOrder: 2.5,
      coverId: 8123,
      isbn: '9780140328721',
    };
    const assistant = scriptedAssistant(() => ({
      tool_calls: [{ name: 'submit_metadata', arguments: submitted }],
    }));
    const openLibrary = openLibraryStub();
    const started = await startUploadApp({
      assistant: assistant.transport,
      openLibrary: openLibrary.transport,
    });
    const epub = buildEpub({
      identifier: 'urn:uuid:99999999-8888-4777-8666-555555555555',
      title: 'Embedded Title',
      author: 'Embedded Author',
      language: 'en',
      description: 'Embedded description.',
      publisher: 'Embedded Press',
    });

    const job = await uploadFiles(started.app, started.cookie, started.libraryId, [
      { name: 'files', filename: 'agent.epub', content: epub },
    ]);
    expect(job.items[0]).toMatchObject({ status: 'succeeded', error: null });

    const db = new Database(started.config.databasePath, { readonly: true });
    const edition = db
      .prepare(
        `SELECT e.title, e.language, e.publisher, e.published_date, e.description,
                e.series_id, e.series_order, s.name AS series_name
         FROM editions e LEFT JOIN series s ON s.id = e.series_id`,
      )
      .get() as {
      title: string;
      language: string;
      publisher: string;
      published_date: string;
      description: string;
      series_id: number;
      series_order: number;
      series_name: string;
    };
    const people = db
      .prepare(
        `SELECT p.name, c.role FROM edition_contributors c JOIN persons p ON p.id = c.person_id
         ORDER BY c.position`,
      )
      .all() as Array<{ name: string; role: string }>;
    const ids = db.prepare('SELECT scheme, value FROM identifiers ORDER BY id').all() as Array<{
      scheme: string;
      value: string;
    }>;
    const covers = db.prepare('SELECT bytes, media_type FROM covers').all() as Array<{
      bytes: number;
      media_type: string;
    }>;
    db.close();

    expect(edition).toMatchObject({
      title: 'Agent Title',
      language: 'fr',
      publisher: 'Agent Press',
      published_date: '1965-03-02',
      description: 'Agent description.',
      series_name: 'Agent Series',
      series_order: 2.5,
    });
    expect(people).toEqual([
      { name: 'Agent Author', role: 'author' },
      { name: 'Second Author', role: 'author' },
      { name: 'Agent Translator', role: 'translator' },
    ]);
    expect(ids).toEqual([{ scheme: 'isbn', value: '9780140328721' }]);
    expect(covers).toEqual([{ bytes: COVER_PNG.length, media_type: 'image/png' }]);
    expect(openLibrary.urls.some((url) => url.includes('/b/id/8123-L.jpg'))).toBe(true);
  });

  it('reuses an existing series when an upload proposal differs only in ASCII case', async () => {
    const assistant = scriptedAssistant((body) => {
      const input = promptInput(body);
      const title = input.fields.title ?? input.filename.replace(/\.[^.]+$/, '');
      const series = input.filename.startsWith('second') ? 'agent series' : 'Agent Series';
      return {
        tool_calls: [
          {
            name: 'submit_metadata',
            arguments: {
              title,
              authors: ['Agent Author'],
              translators: [],
              description: 'Agent description.',
              publisher: 'Agent Press',
              publishedDate: '1965-03-02',
              language: 'fr',
              identifiers:
                input.fields.identifiers.length > 0
                  ? input.fields.identifiers
                  : [{ scheme: 'isbn', value: '9780140328721' }],
              series,
              seriesOrder: null,
              coverId: null,
              isbn: null,
            },
          },
        ],
      };
    });
    const started = await startUploadApp({ assistant: assistant.transport });
    const job = await uploadFiles(started.app, started.cookie, started.libraryId, [
      {
        name: 'files',
        filename: 'first.epub',
        content: buildEpub({
          title: 'First Series Book',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee21',
        }),
      },
      {
        name: 'files',
        filename: 'second.epub',
        content: buildEpub({
          title: 'Second Series Book',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee22',
        }),
      },
    ]);
    expect(job.status).toBe('succeeded');
    expect(job.summary).toMatchObject({ total: 2, succeeded: 2, failed: 0, duplicate: 0 });

    const db = new Database(started.config.databasePath, { readonly: true });
    const seriesRows = db.prepare('SELECT id, name FROM series ORDER BY id').all() as Array<{
      id: number;
      name: string;
    }>;
    const editions = db
      .prepare(
        `SELECT e.title, e.series_id AS seriesId, s.name AS seriesName
         FROM editions e LEFT JOIN series s ON s.id = e.series_id
         ORDER BY e.id`,
      )
      .all() as Array<{ title: string; seriesId: number | null; seriesName: string | null }>;
    db.close();

    expect(seriesRows).toHaveLength(1);
    expect(seriesRows[0]?.name).toBe('Agent Series');
    expect(editions).toEqual([
      { title: 'First Series Book', seriesId: seriesRows[0]?.id, seriesName: 'Agent Series' },
      { title: 'Second Series Book', seriesId: seriesRows[0]?.id, seriesName: 'Agent Series' },
    ]);
  });

  it('fails each upload missing a required field without creating a blob or edition', async () => {
    const required = ['title', 'authors', 'language', 'description', 'publisher', 'publishedDate', 'identifiers'];
    const attempts = new Map<string, number>();
    const assistant = scriptedAssistant((body) => {
      const input = promptInput(body);
      const attempt = (attempts.get(input.filename) ?? 0) + 1;
      attempts.set(input.filename, attempt);
      if (attempt > 1) return { content: 'I cannot complete this submission.' };
      const field = input.filename.slice('missing-'.length, -'.epub'.length);
      const submission = defaultSubmission(body);
      delete submission[field];
      return { tool_calls: [{ name: 'submit_metadata', arguments: submission }] };
    });
    const started = await startUploadApp({ assistant: assistant.transport });
    const before = blobFiles(started.config.dataDir);
    const files = required.map((field, index) => ({
      name: 'files',
      filename: `missing-${field}.epub`,
      content: buildEpub({
        identifier: `urn:uuid:00000000-0000-4000-8000-00000000000${index}`,
        title: `Missing ${field}`,
      }),
    }));

    const job = await uploadFiles(started.app, started.cookie, started.libraryId, files);
    expect(job.summary).toMatchObject({ total: required.length, succeeded: 0, failed: required.length, duplicate: 0 });
    expect(job.items.map((item) => [item.filename, item.status, item.error])).toEqual(
      required.map((field) => [`missing-${field}.epub`, 'failed', 'metadata_incomplete']),
    );
    expect(job.items.every((item) => item.editionId === null && item.assetId === null)).toBe(true);

    const db = new Database(started.config.databasePath, { readonly: true });
    const counts = {
      editions: (db.prepare('SELECT COUNT(*) AS count FROM editions').get() as { count: number }).count,
      assets: (db.prepare('SELECT COUNT(*) AS count FROM file_assets').get() as { count: number }).count,
      covers: (db.prepare('SELECT COUNT(*) AS count FROM covers').get() as { count: number }).count,
    };
    db.close();
    expect(counts).toEqual({ editions: 0, assets: 0, covers: 0 });
    expect(blobFiles(started.config.dataDir)).toEqual(before);
    const incoming = path.join(started.config.dataDir, 'incoming');
    expect(existsSync(incoming) ? readdirSync(incoming) : []).toEqual([]);
  });

  it('fails uploads with metadata_assistant_unconfigured when no assistant is saved', async () => {
    const assistant = defaultAssistant();
    const started = await startUploadApp({ assistant: assistant.transport, configure: false });
    const before = blobFiles(started.config.dataDir);

    const job = await uploadFiles(started.app, started.cookie, started.libraryId, [
      { name: 'files', filename: 'unconfigured.epub', content: buildEpub() },
    ]);
    expect(job.items[0]).toMatchObject({
      status: 'failed',
      error: 'metadata_assistant_unconfigured',
      editionId: null,
      assetId: null,
    });
    expect(assistant.calls()).toBe(0);

    const db = new Database(started.config.databasePath, { readonly: true });
    const editions = db.prepare('SELECT COUNT(*) AS count FROM editions').get() as { count: number };
    db.close();
    expect(editions.count).toBe(0);
    expect(blobFiles(started.config.dataDir)).toEqual(before);
  });

  it('fails a model error or timeout for one item and continues with the next file', async () => {
    const requestNames: string[] = [];
    const assistant: AssistantTransport = {
      async fetch(_input, init) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const input = promptInput(body);
        requestNames.push(input.filename);
        if (input.filename === 'server-error.epub') {
          return new Response('server secret', { status: 500 });
        }
        if (input.filename === 'timeout.epub') {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
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
                    function: {
                      name: 'submit_metadata',
                      arguments: JSON.stringify(defaultSubmission(body)),
                    },
                  },
                ],
              },
            },
          ],
        });
      },
    };
    const started = await startUploadApp({ assistant, openLibrary: openLibraryStub().transport });
    const job = await uploadFiles(started.app, started.cookie, started.libraryId, [
      {
        name: 'files',
        filename: 'server-error.epub',
        content: buildEpub({ identifier: 'urn:uuid:11111111-1111-4111-8111-111111111111', title: 'Server Error' }),
      },
      {
        name: 'files',
        filename: 'timeout.epub',
        content: buildEpub({ identifier: 'urn:uuid:22222222-2222-4222-8222-222222222222', title: 'Timeout' }),
      },
      { name: 'files', filename: 'continues.epub', content: buildEpub() },
    ]);
    expect(job.status).toBe('succeeded');
    expect(job.summary).toMatchObject({ total: 3, succeeded: 1, failed: 2, duplicate: 0 });
    expect(job.items.map((item) => [item.filename, item.status, item.error])).toEqual([
      ['server-error.epub', 'failed', 'metadata_unavailable'],
      ['timeout.epub', 'failed', 'metadata_unavailable'],
      ['continues.epub', 'succeeded', null],
    ]);
    expect(requestNames).toEqual(['server-error.epub', 'timeout.epub', 'continues.epub']);

    const db = new Database(started.config.databasePath, { readonly: true });
    const editions = db.prepare('SELECT title FROM editions').all() as Array<{ title: string }>;
    db.close();
    expect(editions.map((row) => row.title)).toEqual([EPUB_TITLE]);
  });

  it('marks a second upload with the same bytes as duplicate without calling the agent', async () => {
    const assistant = defaultAssistant();
    const started = await startUploadApp({
      assistant: assistant.transport,
      openLibrary: openLibraryStub().transport,
    });
    const epub = buildEpub();
    const job = await uploadFiles(started.app, started.cookie, started.libraryId, [
      { name: 'files', filename: 'first.epub', content: epub },
      { name: 'files', filename: 'copy.epub', content: epub },
    ]);
    expect(job.summary).toMatchObject({ total: 2, succeeded: 1, failed: 0, duplicate: 1 });
    expect(job.items.map((item) => [item.filename, item.status, item.error])).toEqual([
      ['first.epub', 'succeeded', null],
      ['copy.epub', 'duplicate', null],
    ]);
    expect(job.items[1]?.assetId).toBe(job.items[0]?.assetId);
    expect(job.items[1]?.editionId).toBe(job.items[0]?.editionId);
    expect(assistant.calls()).toBe(1);

    const db = new Database(started.config.databasePath, { readonly: true });
    const editions = db.prepare('SELECT COUNT(*) AS count FROM editions').get() as { count: number };
    const assets = db.prepare('SELECT COUNT(*) AS count FROM file_assets').get() as { count: number };
    db.close();
    expect(editions.count).toBe(1);
    expect(assets.count).toBe(1);
  });

  it('imports a folder inside an indexed root and keeps the edition when that directory moves', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = tempConfig(temp.dir);
    migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
    const root = path.join(temp.dir, 'indexed');
    const outside = path.join(temp.dir, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const epub = buildEpub();
    writeFileSync(path.join(root, 'tale.epub'), epub);
    writeFileSync(path.join(root, 'tale-copy.epub'), epub);
    writeFileSync(path.join(root, 'text.pdf'), buildTextPdf());
    writeFileSync(path.join(root, 'image.pdf'), buildImagePdf());
    writeFileSync(path.join(root, 'broken.epub'), malformedBook());
    writeFileSync(path.join(outside, 'secret.epub'), epub);
    symlinkSync(outside, path.join(root, 'escape'));

    let assistantCalls = 0;
    const assistant: AssistantTransport = {
      async fetch() {
        assistantCalls += 1;
        throw new Error('the metadata agent must not run for folder imports');
      },
    };
    const app = await buildApp({ config, clientDist: null, logger: false, assistant });
    cleanups.push(() => {
      void app.close();
    });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'ada', password, libraryName: 'Home' },
    });
    const cookie = (setup.headers['set-cookie'] as string).split(';')[0] ?? '';
    const inserted = new Database(config.databasePath);
    const library = inserted
      .prepare(
        `INSERT INTO libraries (name, mode, root_path, created_at) VALUES ('Shelf', 'indexed', ?, ?) RETURNING id`,
      )
      .get(root, new Date().toISOString()) as { id: number };
    inserted.close();

    const escaped = await app.inject({
      method: 'POST',
      url: '/api/imports/folder',
      headers: { cookie },
      payload: { libraryId: library.id, path: '../outside' },
    });
    expect(escaped.statusCode).toBe(400);
    expect(escaped.json()).toEqual({ error: 'invalid_path' });

    const linked = await app.inject({
      method: 'POST',
      url: '/api/imports/folder',
      headers: { cookie },
      payload: { libraryId: library.id, path: 'escape' },
    });
    expect(linked.statusCode).toBe(400);
    expect(linked.json()).toEqual({ error: 'invalid_path' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/imports/folder',
      headers: { cookie },
      payload: { libraryId: library.id, path: '.' },
    });
    expect(created.statusCode).toBe(202);
    const job = await waitForJob(app, cookie, created.json().job.id as number);
    expect(job.summary).toMatchObject({ total: 5, succeeded: 3, failed: 1, duplicate: 1 });
    expect(job.items.find((item) => item.filename === 'broken.epub')).toMatchObject({
      status: 'failed',
      error: 'malformed',
    });
    expect(job.items.some((item) => item.filename.includes('secret'))).toBe(false);
    expect(assistantCalls).toBe(0);

    const before = new Database(config.databasePath, { readonly: true });
    const edition = before
      .prepare(
        `SELECT e.id, e.title, e.trashed_at
         FROM editions e JOIN file_assets a ON a.edition_id = e.id
         WHERE e.library_id = ? AND a.format = 'epub'`,
      )
      .get(library.id) as { id: number; title: string; trashed_at: string | null };
    const asset = before
      .prepare(`SELECT storage, availability, relative_path, trashed_at FROM file_assets WHERE edition_id = ?`)
      .get(edition.id) as { storage: string; availability: string; relative_path: string; trashed_at: string | null };
    before.close();
    expect(edition.title).toBe(EPUB_TITLE);
    expect(edition.trashed_at).toBeNull();
    expect(asset.storage).toBe('indexed');
    expect(asset.availability).toBe('present');
    expect(asset.trashed_at).toBeNull();
    expect(asset.relative_path.startsWith('..')).toBe(false);

    renameSync(root, path.join(temp.dir, 'indexed-away'));
    const rescan = await app.inject({
      method: 'POST',
      url: `/api/libraries/${library.id}/rescan`,
      headers: { cookie },
    });
    expect(rescan.statusCode).toBe(202);
    const scan = await waitForJob(app, cookie, rescan.json().job.id as number);
    expect(scan.status).toBe('succeeded');
    expect(scan.result).toMatchObject({ checked: 3, missing: 3, present: 0 });

    const after = new Database(config.databasePath, { readonly: true });
    const kept = after.prepare('SELECT title, trashed_at FROM editions WHERE id = ?').get(edition.id) as {
      title: string;
      trashed_at: string | null;
    };
    const missing = after.prepare('SELECT availability, trashed_at FROM file_assets WHERE edition_id = ?').all(edition.id) as Array<{
      availability: string;
      trashed_at: string | null;
    }>;
    after.close();
    expect(kept).toEqual({ title: EPUB_TITLE, trashed_at: null });
    expect(missing.every((row) => row.availability === 'missing' && row.trashed_at === null)).toBe(true);
  });

  it('rejects an upload over the size cap and requeues a job left running', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = tempConfig(temp.dir, { QIJUAN_MAX_UPLOAD_BYTES: '128' });
    migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
    configureAssistant(config.dataDir);
    const assistant = defaultAssistant();
    const openLibrary = openLibraryStub();
    const staged = path.join(config.dataDir, 'incoming', 'requeue');
    mkdirSync(staged, { recursive: true });
    const epub = buildEpub();
    writeFileSync(path.join(staged, '0-tale.epub'), epub);

    const seed = new Database(config.databasePath);
    const now = new Date().toISOString();
    const library = seed
      .prepare(`INSERT INTO libraries (name, mode, root_path, created_at) VALUES ('Home', 'managed', ?, ?) RETURNING id`)
      .get(path.join(temp.dir, 'managed'), now) as { id: number };
    const job = seed
      .prepare(
        `INSERT INTO jobs (library_id, source, status, created_at, updated_at, started_at)
         VALUES (?, 'upload', 'running', ?, ?, ?) RETURNING id`,
      )
      .get(library.id, now, now, now) as { id: number };
    seed
      .prepare(
        `INSERT INTO job_items (job_id, position, filename, source_path, status, created_at, updated_at)
         VALUES (?, 0, 'tale.epub', 'incoming/requeue/0-tale.epub', 'running', ?, ?)`,
      )
      .run(job.id, now, now);
    seed.close();

    const opened = openDatabase(config.databasePath);
    requeueInterruptedJobs(opened.db);
    const queued = opened.sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as { status: string };
    expect(queued.status).toBe('queued');
    const item = opened.sqlite.prepare('SELECT status FROM job_items WHERE job_id = ?').get(job.id) as { status: string };
    expect(item.status).toBe('queued');
    opened.sqlite.close();

    const app = await buildApp({
      config,
      clientDist: null,
      logger: false,
      assistant: assistant.transport,
      openLibrary: openLibrary.transport,
    });
    cleanups.push(() => {
      void app.close();
    });
    const finished = await new Promise<string>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const sqlite = new Database(config.databasePath, { readonly: true });
        const row = sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as { status: string } | undefined;
        const editions = sqlite.prepare('SELECT COUNT(*) AS count FROM editions').get() as { count: number };
        sqlite.close();
        if (row?.status === 'succeeded' || row?.status === 'failed') {
          clearInterval(timer);
          resolve(`${row.status}:${editions.count}`);
        } else if (Date.now() - started > 4000) {
          clearInterval(timer);
          reject(new Error(`stuck ${row?.status}`));
        }
      }, 30);
    });
    expect(finished).toBe('succeeded:1');

    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'ada', password, libraryName: 'Other' },
    });
    expect(setup.statusCode).toBe(201);
    const cookie = (setup.headers['set-cookie'] as string).split(';')[0] ?? '';
    const managedId = setup.json().library.id as number;
    const oversized = multipart([{ name: 'files', filename: 'big.epub', content: Buffer.alloc(256, 1) }]);
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/imports?libraryId=${managedId}`,
      headers: { ...oversized.headers, cookie },
      payload: oversized.payload,
    });
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json()).toEqual({ error: 'payload_too_large' });
  });

  it('imports uploads whose filenames contain embedded dots', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = tempConfig(temp.dir);
    migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
    configureAssistant(config.dataDir);
    const assistant = defaultAssistant();
    const openLibrary = openLibraryStub();
    const app = await buildApp({
      config,
      clientDist: null,
      logger: false,
      assistant: assistant.transport,
      openLibrary: openLibrary.transport,
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
    const cookie = (setup.headers['set-cookie'] as string).split(';')[0] ?? '';
    const libraryId = setup.json().library.id as number;
    const body = multipart([
      { name: 'files', filename: 'Edition..epub', content: buildEpub() },
      { name: 'files', filename: 'Notes...pdf', content: buildTextPdf() },
    ]);
    const created = await app.inject({
      method: 'POST',
      url: `/api/imports?libraryId=${libraryId}`,
      headers: { ...body.headers, cookie },
      payload: body.payload,
    });
    expect(created.statusCode).toBe(202);
    const job = await waitForJob(app, cookie, created.json().job.id as number);
    expect(job.status).toBe('succeeded');
    expect(job.summary).toMatchObject({ total: 2, succeeded: 2, failed: 0, duplicate: 0 });
    expect(job.items.map((item) => [item.filename, item.status, item.error])).toEqual([
      ['Edition..epub', 'succeeded', null],
      ['Notes...pdf', 'succeeded', null],
    ]);
    const incoming = path.join(config.dataDir, 'incoming');
    expect(existsSync(incoming) ? readdirSync(incoming) : []).toEqual([]);
  });
});

describe('resolveUploadPath', () => {
  const dataDir = path.resolve('/tmp/qijuan-upload-root');

  it('keeps a single path segment that merely contains dots', () => {
    expect(resolveUploadPath(dataDir, 'incoming/abc/0-Edition..epub')).toBe(
      path.resolve(dataDir, 'incoming/abc/0-Edition..epub'),
    );
    expect(resolveUploadPath(dataDir, 'incoming/abc/1-Notes...pdf')).toBe(
      path.resolve(dataDir, 'incoming/abc/1-Notes...pdf'),
    );
  });

  it('rejects a parent segment even when the normalized path would stay inside incoming', () => {
    expect(resolveUploadPath(dataDir, 'incoming/abc/../sibling/0-file.epub')).toBeNull();
    expect(resolveUploadPath(dataDir, 'incoming/abc/../../etc/passwd')).toBeNull();
    expect(resolveUploadPath(dataDir, 'incoming/../secret.epub')).toBeNull();
    expect(resolveUploadPath(dataDir, 'other/abc/0-Edition..epub')).toBeNull();
    expect(resolveUploadPath(dataDir, 'incoming/abc/0-file.epub\0')).toBeNull();
    expect(resolveUploadPath(dataDir, 'incoming\\abc\\0-file.epub')).toBeNull();
  });
});
