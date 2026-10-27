import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { writeImmutableBlob } from '../src/blobs.js';
import { parseEpubCfi } from '../src/cfi.js';
import { openDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir, tempConfig } from './helpers.js';
import { buildEpub } from './fixtures.js';

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

async function startApp() {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  const config = tempConfig(temp.dir);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  let active = await buildApp({ config, clientDist: null, logger: false });
  cleanups.push(() => {
    void active.close();
  });
  const setup = await active.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { username: 'ada', password, libraryName: 'Home' },
  });
  expect(setup.statusCode).toBe(201);
  return {
    config,
    get app() {
      return active;
    },
    replace(next: typeof active) {
      active = next;
    },
    databasePath: config.databasePath,
    dataDir: config.dataDir,
    cookie: cookieFrom(setup),
    libraryId: setup.json().library.id as number,
    userId: setup.json().user.id as number,
  };
}

describe('epub cfi', () => {
  it('accepts an epubcfi string and refuses a bare percentage', () => {
    expect(parseEpubCfi(cfi)).toBe(cfi);
    expect(parseEpubCfi(`  ${laterCfi}  `)).toBe(laterCfi);
    expect(parseEpubCfi(cfi)?.startsWith('epubcfi(')).toBe(true);
    expect(parseEpubCfi('0.42')).toBeNull();
    expect(parseEpubCfi('42%')).toBeNull();
    expect(parseEpubCfi('1')).toBeNull();
    expect(parseEpubCfi('0')).toBeNull();
    expect(parseEpubCfi('0.0')).toBeNull();
    expect(parseEpubCfi('epubcfi(')).toBeNull();
    expect(parseEpubCfi('')).toBeNull();
  });
});

describe('epub reading place', () => {
  it('streams the epub, stores a cfi, and reads it back from a new connection', async () => {
    const started = await startApp();
    const epub = buildEpub();
    const blob = writeImmutableBlob(started.dataDir, epub);
    const sqlite = openDatabase(started.databasePath);
    const now = '2026-04-01T00:00:00.000Z';
    const editionId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO editions (library_id, title, sort_title, language, created_at, updated_at)
          VALUES (?, '栖卷试读', '栖卷试读', 'zh-Hans', ?, ?)`,
        )
        .run(started.libraryId, now, now).lastInsertRowid,
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

    const anon = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${assetId}/file`,
    });
    expect(anon.statusCode).toBe(401);

    const file = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${assetId}/file`,
      headers: { cookie: started.cookie },
    });
    expect(file.statusCode).toBe(200);
    expect(String(file.headers['content-type'])).toContain('application/epub+zip');
    expect(String(file.headers['cache-control'])).toContain('no-store');
    expect(file.rawPayload.equals(epub)).toBe(true);

    for (const locator of ['0.42', '42%', '1']) {
      const refused = await started.app.inject({
        method: 'PUT',
        url: `/api/editions/${editionId}/reading-place`,
        headers: { cookie: started.cookie },
        payload: { locator, assetId },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({ error: 'invalid_request' });
    }

    const first = await started.app.inject({
      method: 'PUT',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: started.cookie },
      payload: { locator: cfi, assetId },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().position).toMatchObject({ locator: cfi, revision: 1, assetId });
    expect(String(first.json().position.locator).startsWith('epubcfi(')).toBe(true);
    expect(String(first.json().position.locator).includes('%')).toBe(false);

    const second = await started.app.inject({
      method: 'PUT',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: started.cookie },
      payload: { locator: laterCfi, assetId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().position).toMatchObject({ locator: laterCfi, revision: 2, assetId });

    const marked = await started.app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/bookmarks`,
      headers: { cookie: started.cookie },
      payload: { locator: cfi, assetId, label: 'Start' },
    });
    expect(marked.statusCode).toBe(201);
    const bookmarkId = marked.json().bookmark.id as number;

    const markedText = await started.app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/highlights`,
      headers: { cookie: started.cookie },
      payload: { locator: laterCfi, assetId, quote: '书有归处' },
    });
    expect(markedText.statusCode).toBe(201);

    const noted = await started.app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/notes`,
      headers: { cookie: started.cookie },
      payload: { locator: noteCfi, assetId, body: 'Remember this sentence.' },
    });
    expect(noted.statusCode).toBe(201);
    expect(noted.json().note.locator).toBe(noteCfi);
    const noteId = noted.json().note.id as number;
    const edited = await started.app.inject({
      method: 'PATCH',
      url: `/api/editions/${editionId}/notes/${noteId}`,
      headers: { cookie: started.cookie },
      payload: { body: 'A revised note.' },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().note).toMatchObject({ locator: noteCfi, body: 'A revised note.' });

    const percentNote = await started.app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/notes`,
      headers: { cookie: started.cookie },
      payload: { locator: '12%', assetId, body: 'nope' },
    });
    expect(percentNote.statusCode).toBe(400);

    const fresh = openDatabase(started.databasePath);
    const stored = fresh.sqlite
      .prepare('SELECT locator, revision, asset_id AS assetId FROM reading_positions WHERE user_id = ? AND edition_id = ?')
      .get(started.userId, editionId) as { locator: string; revision: number; assetId: number };
    expect(stored).toEqual({ locator: laterCfi, revision: 2, assetId });
    expect(stored.locator.startsWith('epubcfi(')).toBe(true);
    const anchorRows = fresh.sqlite
      .prepare(
        `SELECT 'bookmark' AS kind, locator FROM bookmarks WHERE user_id = ? AND edition_id = ?
        UNION ALL
        SELECT 'highlight', locator FROM highlights WHERE user_id = ? AND edition_id = ?
        UNION ALL
        SELECT 'note', locator FROM notes WHERE user_id = ? AND edition_id = ? AND locator IS NOT NULL`,
      )
      .all(started.userId, editionId, started.userId, editionId, started.userId, editionId) as Array<{
      kind: string;
      locator: string;
    }>;
    expect(anchorRows.map((row) => row.locator).sort()).toEqual([cfi, laterCfi, noteCfi].sort());
    fresh.sqlite.close();

    await started.app.close();
    const restarted = await buildApp({ config: started.config, clientDist: null, logger: false });
    started.replace(restarted);
    const again = await restarted.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: started.cookie },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().position).toMatchObject({ locator: laterCfi, revision: 2, assetId });
    expect(again.json().bookmarks).toEqual([
      expect.objectContaining({ id: bookmarkId, locator: cfi, label: 'Start' }),
    ]);
    expect(again.json().highlights).toEqual([
      expect.objectContaining({ locator: laterCfi, quote: '书有归处' }),
    ]);
    expect(again.json().notes).toEqual([
      expect.objectContaining({ locator: noteCfi, body: 'A revised note.' }),
    ]);

    const reader = await restarted.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: started.cookie },
      payload: { username: 'beau', password },
    });
    expect(reader.statusCode).toBe(201);
    const login = await restarted.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { username: 'beau', password },
    });
    expect(login.statusCode).toBe(200);
    const readerCookie = cookieFrom(login);
    const hidden = await restarted.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: readerCookie },
    });
    expect(hidden.statusCode).toBe(403);
    const hiddenFile = await restarted.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${assetId}/file`,
      headers: { cookie: readerCookie },
    });
    expect(hiddenFile.statusCode).toBe(403);

    const removed = await restarted.inject({
      method: 'DELETE',
      url: `/api/editions/${editionId}/bookmarks/${bookmarkId}`,
      headers: { cookie: readerCookie },
    });
    expect(removed.statusCode).toBe(403);

    const home = await restarted.inject({
      method: 'GET',
      url: '/api/home',
      headers: { cookie: started.cookie },
    });
    expect(home.statusCode).toBe(200);
    expect(home.json().continueReading.map((item: { id: number }) => item.id)).toContain(editionId);
  });

  it('streams an indexed epub that stays inside the library root', async () => {
    const started = await startApp();
    const root = path.join(started.dataDir, 'indexed-root');
    mkdirSync(root, { recursive: true });
    const epub = buildEpub({ title: 'Indexed tale' });
    writeFileSync(path.join(root, 'tale.epub'), epub);
    const sqlite = openDatabase(started.databasePath);
    const now = '2026-04-02T00:00:00.000Z';
    const libraryId = Number(
      sqlite.sqlite
        .prepare(`INSERT INTO libraries (name, mode, root_path, created_at) VALUES ('Shelf', 'indexed', ?, ?)`)
        .run(root, now).lastInsertRowid,
    );
    sqlite.sqlite.prepare('INSERT INTO library_grants (user_id, library_id) VALUES (?, ?)').run(started.userId, libraryId);
    const editionId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO editions (library_id, title, sort_title, created_at, updated_at)
          VALUES (?, 'Indexed tale', 'indexed', ?, ?)`,
        )
        .run(libraryId, now, now).lastInsertRowid,
    );
    const assetId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO file_assets (
            edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
          ) VALUES (?, 'epub', ?, ?, 'tale.epub', 'indexed', 'tale.epub', 'present', ?)`,
        )
        .run(editionId, 'ab'.repeat(32), epub.length, now).lastInsertRowid,
    );
    sqlite.sqlite.close();

    const file = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${assetId}/file`,
      headers: { cookie: started.cookie },
    });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(epub)).toBe(true);
  });
});
