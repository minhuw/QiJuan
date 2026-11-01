import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { absoluteBlobPath, writeImmutableBlob } from '../src/blobs.js';
import { addManagedAsset, createEdition, removeCatalogEntry } from '../src/catalog.js';
import { openDatabase } from '../src/db.js';
import { findIdentifierMatch } from '../src/merge.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { editionIdentifiers, libraries } from '../src/schema.js';
import { configureTestAssistant, embeddedMetadataAssistant, makeTempDir, tempConfig } from './helpers.js';
import { COVER_PNG, buildEpub, buildTextPdf } from './fixtures.js';

const cleanups: Array<() => void> = [];
const password = 'correct horse battery staple';
const readerPassword = 'reader-password-123';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type App = Awaited<ReturnType<typeof buildApp>>;

function multipart(parts: Array<{ name: string; filename: string; content: Buffer; type?: string }>) {
  const boundary = '----qijuantrash';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
    );
    chunks.push(part.content, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function cookieFrom(response: { headers: { 'set-cookie'?: string | string[] | undefined } }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(';')[0] ?? '';
}

function basic(username: string, secret: string): string {
  return `Basic ${Buffer.from(`${username}:${secret}`, 'utf8').toString('base64')}`;
}

interface Job {
  status: string;
  items: Array<{ filename: string; status: string; editionId: number | null; assetId: number | null; sha256: string | null; merged: boolean }>;
}

async function startApp() {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  const config = tempConfig(temp.dir);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  configureTestAssistant(config.dataDir);
  const app = await buildApp({
    config,
    clientDist: null,
    logger: false,
    assistant: embeddedMetadataAssistant(),
    openLibrary: {
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

async function waitForJob(app: App, cookie: string, id: number): Promise<Job> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const job = response.json().job as Job;
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${id} did not finish`);
}

async function upload(app: App, cookie: string, libraryId: number, files: Array<{ filename: string; content: Buffer }>) {
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

async function addReader(app: App, cookie: string, libraryId: number): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { cookie },
    payload: { username: 'bea', password: readerPassword },
  });
  expect(created.statusCode).toBe(201);
  const userId = created.json().user.id as number;
  const granted = await app.inject({
    method: 'POST',
    url: `/api/libraries/${libraryId}/grants`,
    headers: { cookie },
    payload: { userId },
  });
  expect(granted.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/session/login',
    payload: { username: 'bea', password: readerPassword },
  });
  expect(login.statusCode).toBe(200);
  return cookieFrom(login);
}

async function call(app: App, cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string) {
  return app.inject({ method, url, headers: { cookie } });
}

function rows<T>(databasePath: string, query: string, ...params: unknown[]): T[] {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.prepare(query).all(...params) as T[];
  } finally {
    db.close();
  }
}

describe('trash', () => {
  it('trashes, hides, restores with reading state, and deletes an edition', async () => {
    const { app, config, cookie, libraryId } = await startApp();
    const job = await upload(app, cookie, libraryId, [{ filename: 'tale.epub', content: buildEpub({ title: 'Trashable Tale' }) }]);
    const editionId = job.items[0]!.editionId!;
    const sha = job.items[0]!.sha256!;
    const blobPath = absoluteBlobPath(config.dataDir, sha);

    // Reading state and a shelf, kept through trash and restore.
    const shelf = await app.inject({
      method: 'POST',
      url: '/api/shelves',
      headers: { cookie },
      payload: { name: 'Keep', editionId },
    });
    expect(shelf.statusCode).toBe(201);
    const reading = await app.inject({
      method: 'PATCH',
      url: `/api/editions/${editionId}/reading`,
      headers: { cookie },
      payload: { status: 'reading' },
    });
    expect(reading.statusCode).toBe(200);
    const token = await app.inject({ method: 'POST', url: '/api/opds-tokens', headers: { cookie }, payload: { label: 'Reader' } });
    expect(token.statusCode).toBe(201);
    const opds = basic('ada', token.json().secret as string);

    // A live edition cannot be deleted.
    const early = await call(app, cookie, 'DELETE', `/api/editions/${editionId}`);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toEqual({ error: 'not_in_trash' });

    const trashed = await call(app, cookie, 'POST', `/api/editions/${editionId}/trash`);
    expect(trashed.statusCode).toBe(200);
    expect(trashed.json().edition).toMatchObject({ id: editionId, title: 'Trashable Tale', trashedAt: expect.any(String) });
    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/trash`)).statusCode).toBe(404);

    // Hidden from the book page, library, index, counts, search, home, shelves, the summaries and OPDS.
    expect((await call(app, cookie, 'GET', `/api/editions/${editionId}`)).statusCode).toBe(404);
    const library = (await call(app, cookie, 'GET', '/api/library?limit=24&offset=0')).json();
    expect(library.total).toBe(0);
    expect(library.editions).toEqual([]);
    expect(library.index).toEqual([]);
    expect((await call(app, cookie, 'GET', '/api/library?limit=24&offset=0&q=Trashable')).json().total).toBe(0);
    const home = (await call(app, cookie, 'GET', '/api/home')).json();
    expect(home.recent).toEqual([]);
    expect(home.continueReading).toEqual([]);
    expect(home.shelves).toEqual([expect.objectContaining({ name: 'Keep', count: 0 })]);
    expect((await call(app, cookie, 'GET', '/api/editions')).json().editions).toEqual([]);
    const feed = await app.inject({ method: 'GET', url: `/opds/libraries/${libraryId}`, headers: { authorization: opds } });
    expect(feed.statusCode).toBe(200);
    expect(feed.body).not.toContain('Trashable Tale');
    const search = await app.inject({ method: 'GET', url: '/opds/search?q=Trashable', headers: { authorization: opds } });
    expect(search.statusCode).toBe(200);
    expect(search.body).not.toContain('Trashable Tale');
    const file = await call(app, cookie, 'GET', `/api/editions/${editionId}/assets/${job.items[0]!.assetId}/file`);
    expect(file.statusCode).toBe(404);
    expect(existsSync(blobPath)).toBe(true);

    // Listed in trash with its file.
    const listing = (await call(app, cookie, 'GET', '/api/trash')).json();
    expect(listing.assets).toEqual([]);
    expect(listing.editions).toEqual([
      expect.objectContaining({
        id: editionId,
        title: 'Trashable Tale',
        hasCover: true,
        trashedAt: expect.any(String),
        files: [
          expect.objectContaining({
            id: job.items[0]!.assetId,
            format: 'epub',
            storage: 'managed',
            // Named from the metadata, like the book page, even though the file is in trash.
            displayFilename: expect.stringMatching(/Trashable Tale.*\.epub$/),
          }),
        ],
      }),
    ]);
    // The admin still sees the cover on the Trash screen.
    expect((await call(app, cookie, 'GET', `/api/editions/${editionId}/cover`)).statusCode).toBe(200);

    const restored = await call(app, cookie, 'POST', `/api/editions/${editionId}/restore`);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().edition.reading).toMatchObject({
      status: 'reading',
      shelves: [expect.objectContaining({ name: 'Keep', included: true })],
    });
    expect(restored.json().edition.assets).toHaveLength(1);
    expect((await call(app, cookie, 'GET', '/api/library?limit=24&offset=0&q=Trashable')).json().total).toBe(1);
    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/restore`)).statusCode).toBe(409);

    // Permanent delete removes the rows and the unreferenced blobs.
    const coverSha = rows<{ sha256: string }>(config.databasePath, 'SELECT sha256 FROM covers WHERE edition_id = ?', editionId)[0]!.sha256;
    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/trash`)).statusCode).toBe(200);
    const deleted = await call(app, cookie, 'DELETE', `/api/editions/${editionId}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });
    expect(existsSync(blobPath)).toBe(false);
    expect(existsSync(absoluteBlobPath(config.dataDir, coverSha))).toBe(false);
    for (const table of ['editions', 'file_assets', 'covers', 'shelf_items', 'reading_statuses', 'edition_identifiers']) {
      const column = table === 'editions' ? 'id' : 'edition_id';
      expect(rows(config.databasePath, `SELECT 1 FROM ${table} WHERE ${column} = ?`, editionId)).toEqual([]);
    }
    expect(rows(config.databasePath, 'SELECT 1 FROM edition_ratings_queue WHERE edition_id = ?', editionId)).toEqual([]);
    expect(rows(config.databasePath, 'SELECT name FROM shelves')).toEqual([{ name: 'Keep' }]);
    expect((await call(app, cookie, 'GET', '/api/trash')).json()).toEqual({ editions: [], assets: [] });
    expect((await call(app, cookie, 'DELETE', `/api/editions/${editionId}`)).statusCode).toBe(404);
  });

  it('keeps a blob another edition still uses', async () => {
    const { app, config, cookie, libraryId } = await startApp();
    const job = await upload(app, cookie, libraryId, [{ filename: 'tale.epub', content: buildEpub({ title: 'Shared Bytes' }) }]);
    const editionId = job.items[0]!.editionId!;
    const sha = job.items[0]!.sha256!;
    // A second edition that references the same blob (as after an earlier re-upload of a trashed book).
    const opened = openDatabase(config.databasePath);
    const other = createEdition(opened.db, { libraryId, title: 'Other' });
    addManagedAsset(opened.db, {
      dataDir: config.dataDir,
      editionId: other.id,
      bytes: readFileSync(absoluteBlobPath(config.dataDir, sha)),
      originalFilename: 'other.epub',
    });
    opened.sqlite.close();
    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/trash`)).statusCode).toBe(200);
    expect((await call(app, cookie, 'DELETE', `/api/editions/${editionId}`)).statusCode).toBe(200);
    expect(existsSync(absoluteBlobPath(config.dataDir, sha))).toBe(true);
  });

  it('forgets folder files without touching them on disk', async () => {
    const { app, config, dir, cookie } = await startApp();
    const root = path.join(dir, 'indexed');
    mkdirSync(root, { recursive: true });
    const epubPath = path.join(root, 'tale.epub');
    const pdfPath = path.join(root, 'text.pdf');
    writeFileSync(epubPath, buildEpub({ title: 'Folder Tale' }));
    writeFileSync(pdfPath, buildTextPdf());
    const before = { epub: statSync(epubPath), pdf: statSync(pdfPath) };
    const inserted = new Database(config.databasePath);
    const library = inserted
      .prepare(`INSERT INTO libraries (name, mode, root_path, created_at) VALUES ('Shelf', 'indexed', ?, ?) RETURNING id`)
      .get(root, new Date().toISOString()) as { id: number };
    inserted.close();
    const created = await app.inject({
      method: 'POST',
      url: '/api/imports/folder',
      headers: { cookie },
      payload: { libraryId: library.id, path: '.' },
    });
    expect(created.statusCode).toBe(202);
    const job = await waitForJob(app, cookie, created.json().job.id as number);
    const epubItem = job.items.find((item) => item.filename.endsWith('tale.epub'))!;
    expect(epubItem.status).toBe('succeeded');
    const editionId = epubItem.editionId!;

    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/trash`)).statusCode).toBe(200);
    const listing = (await call(app, cookie, 'GET', '/api/trash')).json();
    expect(listing.editions[0].files).toEqual([expect.objectContaining({ storage: 'indexed', format: 'epub' })]);
    expect((await call(app, cookie, 'DELETE', `/api/editions/${editionId}`)).statusCode).toBe(200);
    expect(rows(config.databasePath, 'SELECT 1 FROM editions WHERE id = ?', editionId)).toEqual([]);
    expect(existsSync(epubPath)).toBe(true);
    expect(existsSync(pdfPath)).toBe(true);
    expect(statSync(epubPath).ino).toBe(before.epub.ino);
    expect(statSync(epubPath).mtimeMs).toBe(before.epub.mtimeMs);
    expect(statSync(pdfPath).mtimeMs).toBe(before.pdf.mtimeMs);
  });

  it('refuses readers', async () => {
    const { app, cookie, libraryId } = await startApp();
    const job = await upload(app, cookie, libraryId, [{ filename: 'tale.epub', content: buildEpub() }]);
    const editionId = job.items[0]!.editionId!;
    const assetId = job.items[0]!.assetId!;
    const reader = await addReader(app, cookie, libraryId);
    expect((await call(app, reader, 'GET', `/api/editions/${editionId}`)).statusCode).toBe(200);
    const attempts: Array<['GET' | 'POST' | 'DELETE', string]> = [
      ['GET', '/api/trash'],
      ['POST', `/api/editions/${editionId}/trash`],
      ['POST', `/api/editions/${editionId}/restore`],
      ['DELETE', `/api/editions/${editionId}`],
      ['POST', `/api/editions/${editionId}/assets/${assetId}/trash`],
      ['POST', `/api/editions/${editionId}/assets/${assetId}/restore`],
      ['DELETE', `/api/editions/${editionId}/assets/${assetId}`],
    ];
    for (const [method, url] of attempts) {
      const response = await call(app, reader, method, url);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json()).toEqual({ error: 'forbidden' });
    }
    // Still live after the readers' attempts; a reader cannot see a trashed cover either.
    expect((await call(app, reader, 'GET', `/api/editions/${editionId}`)).statusCode).toBe(200);
    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/trash`)).statusCode).toBe(200);
    expect((await call(app, reader, 'GET', `/api/editions/${editionId}/cover`)).statusCode).toBe(404);
  });

  it('trashes, restores and deletes one file, never the last', async () => {
    const { app, config, cookie, libraryId } = await startApp();
    const first = await upload(app, cookie, libraryId, [{ filename: 'tale.epub', content: buildEpub({ title: 'Two Files' }) }]);
    const editionId = first.items[0]!.editionId!;
    const epubId = first.items[0]!.assetId!;
    const opened = openDatabase(config.databasePath);
    const pdfBytes = buildTextPdf();
    const pdf = addManagedAsset(opened.db, { dataDir: config.dataDir, editionId, bytes: pdfBytes, originalFilename: 'two.pdf' });
    opened.sqlite.close();
    const pdfBlob = absoluteBlobPath(config.dataDir, pdf.sha256);

    const trashed = await call(app, cookie, 'POST', `/api/editions/${editionId}/assets/${pdf.id}/trash`);
    expect(trashed.statusCode).toBe(200);
    expect(trashed.json().edition.assets.map((asset: { id: number }) => asset.id)).toEqual([epubId]);
    const last = await call(app, cookie, 'POST', `/api/editions/${editionId}/assets/${epubId}/trash`);
    expect(last.statusCode).toBe(409);
    expect(last.json()).toEqual({ error: 'last_asset' });
    expect((await call(app, cookie, 'DELETE', `/api/editions/${editionId}/assets/${epubId}`)).statusCode).toBe(409);

    const listing = (await call(app, cookie, 'GET', '/api/trash')).json();
    expect(listing.editions).toEqual([]);
    expect(listing.assets).toEqual([
      expect.objectContaining({ id: pdf.id, editionId, editionTitle: 'Two Files', format: 'pdf', storage: 'managed' }),
    ]);

    // Trashing the book and restoring it keeps the file trashed on its own in trash.
    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/trash`)).statusCode).toBe(200);
    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/restore`)).statusCode).toBe(200);
    expect((await call(app, cookie, 'GET', '/api/trash')).json().assets).toHaveLength(1);

    const restored = await call(app, cookie, 'POST', `/api/editions/${editionId}/assets/${pdf.id}/restore`);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().edition.assets).toHaveLength(2);
    expect((await call(app, cookie, 'DELETE', `/api/editions/${editionId}/assets/${pdf.id}`)).statusCode).toBe(409);

    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/assets/${pdf.id}/trash`)).statusCode).toBe(200);
    const deleted = await call(app, cookie, 'DELETE', `/api/editions/${editionId}/assets/${pdf.id}`);
    expect(deleted.statusCode).toBe(200);
    expect(existsSync(pdfBlob)).toBe(false);
    expect(rows(config.databasePath, 'SELECT 1 FROM file_assets WHERE id = ?', pdf.id)).toEqual([]);
    expect((await call(app, cookie, 'GET', `/api/editions/${editionId}`)).json().edition.assets).toHaveLength(1);
    // Another edition's file is not reachable through this edition.
    expect((await call(app, cookie, 'POST', `/api/editions/${editionId + 1}/assets/${epubId}/trash`)).statusCode).toBe(404);
  });

  it('discards pending lookup previews and their staged covers on trash', async () => {
    const { app, config, cookie, libraryId } = await startApp();
    const job = await upload(app, cookie, libraryId, [{ filename: 'tale.epub', content: buildEpub() }]);
    const editionId = job.items[0]!.editionId!;
    const staged = Buffer.from(COVER_PNG);
    staged[staged.length - 1] ^= 0x33;
    const blob = writeImmutableBlob(config.dataDir, staged);
    const db = new Database(config.databasePath);
    const stamp = new Date().toISOString();
    db.prepare(
      `INSERT INTO metadata_previews (edition_id, proposal, created_at, cover_sha256, cover_bytes, cover_media_type,
        cover_relative_path, cover_width, cover_height, cover_url, cover_source_url, cover_origin)
       VALUES (?, '{}', ?, ?, ?, 'image/png', ?, 1, 1, 'https://covers.example/x.png', NULL, 'agent')`,
    ).run(editionId, stamp, blob.sha256, blob.bytes, blob.relativePath);
    db.prepare(`INSERT INTO metadata_previews (edition_id, proposal, created_at, applied_at) VALUES (?, '{}', ?, ?)`).run(
      editionId,
      stamp,
      stamp,
    );
    db.close();
    const blobPath = absoluteBlobPath(config.dataDir, blob.sha256);
    expect(existsSync(blobPath)).toBe(true);

    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/trash`)).statusCode).toBe(200);
    // The pending preview and its staged cover are gone; the applied one is history and stays.
    expect(rows(config.databasePath, 'SELECT applied_at FROM metadata_previews WHERE edition_id = ?', editionId)).toEqual([
      { applied_at: stamp },
    ]);
    expect(existsSync(blobPath)).toBe(false);
  });

  it('imports a re-upload of a trashed book as a new live edition', async () => {
    const { app, cookie, libraryId } = await startApp();
    const bytes = buildEpub({ title: 'Second Life' });
    const first = await upload(app, cookie, libraryId, [{ filename: 'tale.epub', content: bytes }]);
    const editionId = first.items[0]!.editionId!;
    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/trash`)).statusCode).toBe(200);

    const again = await upload(app, cookie, libraryId, [{ filename: 'tale.epub', content: bytes }]);
    expect(again.items[0]).toMatchObject({ status: 'succeeded', merged: false });
    const fresh = again.items[0]!.editionId!;
    expect(fresh).not.toBe(editionId);
    expect((await call(app, cookie, 'GET', `/api/editions/${fresh}`)).statusCode).toBe(200);
    expect((await call(app, cookie, 'GET', '/api/library?limit=24&offset=0')).json().total).toBe(1);

    // A copy of a live file is still a duplicate.
    const third = await upload(app, cookie, libraryId, [{ filename: 'tale.epub', content: bytes }]);
    expect(third.items[0]).toMatchObject({ status: 'duplicate', editionId: fresh });

    // Both editions share the blob; deleting the trashed one keeps it for the live one.
    expect((await call(app, cookie, 'DELETE', `/api/editions/${editionId}`)).statusCode).toBe(200);
    const file = await call(app, cookie, 'GET', `/api/editions/${fresh}/assets/${again.items[0]!.assetId}/file`);
    expect(file.statusCode).toBe(200);
  });

  it('never matches a trashed edition by identifier', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = tempConfig(temp.dir);
    migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
    const opened = openDatabase(config.databasePath);
    cleanups.push(() => opened.sqlite.close());
    const { db } = opened;
    const library = db
      .insert(libraries)
      .values({ name: 'Home', mode: 'managed', rootPath: path.join(temp.dir, 'blobs'), createdAt: new Date().toISOString() })
      .returning()
      .get()!;
    const edition = createEdition(db, { libraryId: library.id, title: 'Matched' });
    db.insert(editionIdentifiers)
      .values({ editionId: edition.id, scheme: 'isbn', value: '9780140328721', source: 'manual', createdAt: new Date().toISOString() })
      .run();
    const incoming = {
      libraryId: library.id,
      identifiers: [{ scheme: 'isbn', value: '978-0-14-032872-1' }],
      title: 'Matched',
      authors: [],
      format: 'pdf' as const,
    };
    expect(findIdentifierMatch(db, incoming)?.editionId).toBe(edition.id);
    removeCatalogEntry(db, edition.id);
    expect(findIdentifierMatch(db, incoming)).toBeNull();
  });
});
