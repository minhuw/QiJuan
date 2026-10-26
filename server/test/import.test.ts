import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { absoluteBlobPath } from '../src/blobs.js';
import { openDatabase } from '../src/db.js';
import { requeueInterruptedJobs, resolveUploadPath } from '../src/jobs.js';
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
  TEXT_PDF_ID,
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

describe('batch import', () => {
  it('imports valid books, attaches a duplicate, and fails only the bad files', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = tempConfig(temp.dir);
    migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
    const app = await buildApp({ config, clientDist: null, logger: false });
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
    ]);
    expect(ids).toEqual([
      { edition_id: editions[0]?.id, scheme: 'uuid', value: EPUB_ID },
      { edition_id: editions[1]?.id, scheme: 'isbn', value: TEXT_PDF_ID },
    ]);
    expect(covers).toHaveLength(1);
    expect(covers[0]?.media_type).toBe('image/png');
    expect(covers[0]?.bytes).toBe(COVER_PNG.length);
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

    const app = await buildApp({ config, clientDist: null, logger: false });
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
    expect(rescan.statusCode).toBe(200);
    expect(rescan.json()).toMatchObject({ checked: 3, missing: 3, present: 0 });

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

    const app = await buildApp({ config, clientDist: null, logger: false });
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
    const app = await buildApp({ config, clientDist: null, logger: false });
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
