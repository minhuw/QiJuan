import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { writeImmutableBlob } from '../src/blobs.js';
import { openDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { configureTestAssistant, embeddedMetadataAssistant, makeTempDir, tempConfig } from './helpers.js';
import {
  buildEpub,
  CHINESE_PARAGRAPH,
  ENGLISH_PARAGRAPH,
  EPUB_AUTHOR,
  EPUB_ID,
  EPUB_TITLE,
} from './fixtures.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';
const cfi = 'epubcfi(/6/4!/4/2:10)';
const laterCfi = 'epubcfi(/6/8!/4,/2:1,/2:20)';
const noteCfi = 'epubcfi(/6/8!/4,/2:4,/2:12)';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function cookieFrom(response: { headers: { 'set-cookie'?: string | string[] | undefined } }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(';')[0] ?? '';
}

async function startApp(env: NodeJS.ProcessEnv = {}) {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  const config = tempConfig(temp.dir, env);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  configureTestAssistant(config.dataDir);
  const app = await buildApp({
    config,
    clientDist: null,
    logger: false,
    assistant: embeddedMetadataAssistant(),
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
    app,
    config,
    cookie: cookieFrom(setup),
    libraryId: setup.json().library.id as number,
    userId: setup.json().user.id as number,
  };
}

async function seedEpub(started: Awaited<ReturnType<typeof startApp>>) {
  const epub = buildEpub();
  const blob = writeImmutableBlob(started.config.dataDir, epub);
  const sqlite = openDatabase(started.config.databasePath);
  const now = '2026-04-08T00:00:00.000Z';
  const editionId = Number(
    sqlite.sqlite
      .prepare(
        `INSERT INTO editions (library_id, title, sort_title, language, created_at, updated_at)
        VALUES (?, ?, ?, 'zh-Hans', ?, ?)`,
      )
      .run(started.libraryId, EPUB_TITLE, EPUB_TITLE, now, now).lastInsertRowid,
  );
  const assetId = Number(
    sqlite.sqlite
      .prepare(
        `INSERT INTO file_assets (
          edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
        ) VALUES (?, 'epub', ?, ?, 'tale.epub', 'managed', ?, 'present', ?)`,
      )
      .run(editionId, blob.sha256, blob.bytes, blob.relativePath, now).lastInsertRowid,
  );
  sqlite.sqlite.close();
  return { epub, editionId, assetId };
}

function multipart(filename: string, content: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----qijuanboundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function waitForJob(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, id: number) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const job = response.json().job as {
      status: string;
      items: Array<{ status: string; editionId: number | null; assetId: number | null }>;
    };
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${id} did not finish`);
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

describe('reading state revisions', () => {
  it('keeps the newer progress and highlight when an older write arrives', async () => {
    const started = await startApp();
    const { editionId, assetId } = await seedEpub(started);
    const headers = { cookie: started.cookie };
    const place = `/api/editions/${editionId}/reading-place`;

    const first = await started.app.inject({
      method: 'PUT',
      url: place,
      headers,
      payload: { locator: cfi, assetId, revision: 0 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().position.revision).toBe(1);

    const newer = await started.app.inject({
      method: 'PUT',
      url: place,
      headers,
      payload: { locator: laterCfi, assetId, revision: 1 },
    });
    expect(newer.statusCode).toBe(200);
    expect(newer.json().position).toMatchObject({ locator: laterCfi, revision: 2 });

    const stale = await started.app.inject({
      method: 'PUT',
      url: place,
      headers,
      payload: { locator: cfi, assetId, revision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('conflict');
    expect(stale.json().position).toMatchObject({ locator: laterCfi, revision: 2, assetId });

    const kept = await started.app.inject({ method: 'GET', url: place, headers });
    expect(kept.json().position).toMatchObject({ locator: laterCfi, revision: 2 });

    const fresh = await started.app.inject({
      method: 'PUT',
      url: place,
      headers,
      payload: { locator: noteCfi, assetId, revision: 2 },
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().position).toMatchObject({ locator: noteCfi, revision: 3 });

    const created = await started.app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/highlights`,
      headers,
      payload: { locator: cfi, assetId, quote: 'first wording', revision: 0 },
    });
    expect(created.statusCode).toBe(201);
    const highlightId = created.json().highlight.id as number;
    expect(created.json().highlight.revision).toBe(1);

    const writerB = await started.app.inject({
      method: 'PATCH',
      url: `/api/editions/${editionId}/highlights/${highlightId}`,
      headers,
      payload: { quote: 'kept wording', revision: 1 },
    });
    expect(writerB.statusCode).toBe(200);
    expect(writerB.json().highlight).toMatchObject({ quote: 'kept wording', locator: cfi, revision: 2 });

    const writerA = await started.app.inject({
      method: 'PATCH',
      url: `/api/editions/${editionId}/highlights/${highlightId}`,
      headers,
      payload: { quote: 'stale wording', locator: laterCfi, revision: 1 },
    });
    expect(writerA.statusCode).toBe(409);
    expect(writerA.json().highlight).toMatchObject({ quote: 'kept wording', locator: cfi, revision: 2 });

    const afterHighlight = await started.app.inject({ method: 'GET', url: place, headers });
    expect(afterHighlight.json().highlights).toEqual([
      expect.objectContaining({ id: highlightId, quote: 'kept wording', locator: cfi, revision: 2 }),
    ]);

    const writerAAgain = await started.app.inject({
      method: 'PATCH',
      url: `/api/editions/${editionId}/highlights/${highlightId}`,
      headers,
      payload: { quote: 'after reload', revision: 2 },
    });
    expect(writerAAgain.statusCode).toBe(200);
    expect(writerAAgain.json().highlight.quote).toBe('after reload');
    expect(writerAAgain.json().highlight.revision).toBe(3);

    const marked = await started.app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/bookmarks`,
      headers,
      payload: { locator: cfi, assetId, label: 'Start', revision: 0 },
    });
    expect(marked.statusCode).toBe(201);
    const bookmarkId = marked.json().bookmark.id as number;
    const renamed = await started.app.inject({
      method: 'PATCH',
      url: `/api/editions/${editionId}/bookmarks/${bookmarkId}`,
      headers,
      payload: { label: 'Kept label', revision: 1 },
    });
    expect(renamed.statusCode).toBe(200);
    const staleRename = await started.app.inject({
      method: 'PATCH',
      url: `/api/editions/${editionId}/bookmarks/${bookmarkId}`,
      headers,
      payload: { label: 'Old label', revision: 1 },
    });
    expect(staleRename.statusCode).toBe(409);
    expect(staleRename.json().bookmark.label).toBe('Kept label');
    const staleDelete = await started.app.inject({
      method: 'DELETE',
      url: `/api/editions/${editionId}/bookmarks/${bookmarkId}`,
      headers,
      payload: { revision: 1 },
    });
    expect(staleDelete.statusCode).toBe(409);
    expect(staleDelete.json().bookmark.label).toBe('Kept label');

    const noted = await started.app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/notes`,
      headers,
      payload: { locator: noteCfi, assetId, body: 'first note', revision: 0 },
    });
    const noteId = noted.json().note.id as number;
    const revised = await started.app.inject({
      method: 'PATCH',
      url: `/api/editions/${editionId}/notes/${noteId}`,
      headers,
      payload: { body: 'kept note', revision: 1 },
    });
    expect(revised.statusCode).toBe(200);
    const staleNote = await started.app.inject({
      method: 'PATCH',
      url: `/api/editions/${editionId}/notes/${noteId}`,
      headers,
      payload: { body: 'stale note', revision: 1 },
    });
    expect(staleNote.statusCode).toBe(409);
    expect(staleNote.json().note).toMatchObject({ body: 'kept note', locator: noteCfi, revision: 2 });
  });
});

describe('annotation export', () => {
  it('writes obsidian markdown and json for the current user only', async () => {
    const started = await startApp();
    const epub = buildEpub();
    const body = multipart('tale.epub', epub);
    const created = await started.app.inject({
      method: 'POST',
      url: `/api/imports?libraryId=${started.libraryId}`,
      headers: { ...body.headers, cookie: started.cookie },
      payload: body.payload,
    });
    expect(created.statusCode).toBe(202);
    const job = await waitForJob(started.app, started.cookie, created.json().job.id as number);
    expect(job.items[0]?.status).toBe('succeeded');
    const editionId = job.items[0]?.editionId as number;
    const assetId = job.items[0]?.assetId as number;
    const headers = { cookie: started.cookie };

    const highlight = await started.app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/highlights`,
      headers,
      payload: { locator: cfi, assetId, quote: CHINESE_PARAGRAPH, revision: 0 },
    });
    expect(highlight.statusCode).toBe(201);
    const note = await started.app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/notes`,
      headers,
      payload: { locator: noteCfi, assetId, body: ENGLISH_PARAGRAPH, revision: 0 },
    });
    expect(note.statusCode).toBe(201);

    const markdown = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/annotations?format=markdown`,
      headers,
    });
    expect(markdown.statusCode).toBe(200);
    expect(String(markdown.headers['content-type'])).toContain('text/markdown');
    const text = markdown.body;
    expect(text).toContain(EPUB_TITLE);
    expect(text).toContain(EPUB_AUTHOR);
    expect(text).toContain('## Highlight');
    expect(text).toContain(CHINESE_PARAGRAPH);
    expect(text).toContain(cfi);
    expect(text).toContain('## Note');
    expect(text).toContain(ENGLISH_PARAGRAPH);
    expect(text).toContain(noteCfi);

    const jsonExport = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/annotations?format=json`,
      headers,
    });
    expect(jsonExport.statusCode).toBe(200);
    expect(String(jsonExport.headers['content-type'])).toContain('application/json');
    const document = jsonExport.json() as {
      book: { title: string; authors: string[]; identifiers: Array<{ scheme: string; value: string }> };
      highlights: Array<{ text: string; locator: string }>;
      notes: Array<{ text: string; locator: string }>;
    };
    expect(document.book.title).toBe(EPUB_TITLE);
    expect(document.book.authors).toContain(EPUB_AUTHOR);
    expect(document.book.identifiers).toEqual(expect.arrayContaining([expect.objectContaining({ value: EPUB_ID })]));
    expect(document.highlights).toEqual([expect.objectContaining({ text: CHINESE_PARAGRAPH, locator: cfi })]);
    expect(document.notes).toEqual([expect.objectContaining({ text: ENGLISH_PARAGRAPH, locator: noteCfi })]);

    const anon = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/annotations?format=json`,
    });
    expect(anon.statusCode).toBe(401);

    const reader = await started.app.inject({
      method: 'POST',
      url: '/api/users',
      headers,
      payload: { username: 'beau', password },
    });
    expect(reader.statusCode).toBe(201);
    const granted = await started.app.inject({
      method: 'POST',
      url: `/api/libraries/${started.libraryId}/grants`,
      headers,
      payload: { userId: reader.json().user.id },
    });
    expect(granted.statusCode).toBe(201);
    const login = await started.app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { username: 'beau', password },
    });
    const other = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/annotations?format=json`,
      headers: { cookie: cookieFrom(login) },
    });
    expect(other.statusCode).toBe(200);
    expect(other.json().highlights).toEqual([]);
    expect(other.json().notes).toEqual([]);
    expect(JSON.stringify(other.json())).not.toContain(CHINESE_PARAGRAPH);
    expect(JSON.stringify(other.json())).not.toContain(ENGLISH_PARAGRAPH);
  });
});

describe('local reading without metadata or backup', () => {
  it('lists the library, reads an epub byte range, and saves progress', async () => {
    const port = await closedPort();
    const origin = `http://127.0.0.1:${port}`;
    await expect(fetch(`${origin}/search.json`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
    const started = await startApp({ QIJUAN_OPEN_LIBRARY_ORIGIN: origin });
    expect(started.config.openLibraryOrigin).toBe(origin);
    expect(started.config).not.toHaveProperty('backupDestination');

    const { epub, editionId, assetId } = await seedEpub(started);
    const headers = { cookie: started.cookie };

    const library = await started.app.inject({ method: 'GET', url: '/api/library?limit=24', headers });
    expect(library.statusCode).toBe(200);
    expect(library.json().editions.map((item: { title: string }) => item.title)).toContain(EPUB_TITLE);

    const ranged = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${assetId}/file`,
      headers: { ...headers, range: 'bytes=0-15' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(String(ranged.headers['content-range'])).toBe(`bytes 0-15/${epub.length}`);
    expect(ranged.rawPayload.equals(epub.subarray(0, 16))).toBe(true);

    const whole = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${assetId}/file`,
      headers,
    });
    expect(whole.statusCode).toBe(200);
    expect(whole.rawPayload.equals(epub)).toBe(true);

    const saved = await started.app.inject({
      method: 'PUT',
      url: `/api/editions/${editionId}/reading-place`,
      headers,
      payload: { locator: cfi, assetId, revision: 0 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().position).toMatchObject({ locator: cfi, revision: 1, assetId });
  });
});
