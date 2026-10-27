import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { writeImmutableBlob } from '../src/blobs.js';
import { openDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { parsePdfLocator, parsePdfPlace } from '../src/pdf-locator.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir, tempConfig } from './helpers.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';
const adaPlace = 'pdfpos(page=2;x=12.5;y=240;zoom=1.25)';
const beauPlace = 'pdfpos(page=5;x=0;y=400;fit=width)';
const cfi = 'epubcfi(/6/4!/4/2:10)';

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

describe('pdf locator', () => {
  it('accepts a page, offset, and zoom or fit mode, and refuses a percentage', () => {
    expect(parsePdfLocator(adaPlace)).toBe(adaPlace);
    expect(parsePdfLocator(`  ${beauPlace}  `)).toBe(beauPlace);
    expect(parsePdfPlace(adaPlace)).toEqual({ page: 2, x: 12.5, y: 240, zoom: 1.25 });
    expect(parsePdfPlace(beauPlace)).toEqual({ page: 5, x: 0, y: 400, zoom: 'width' });
    expect(parsePdfLocator('0.42')).toBeNull();
    expect(parsePdfLocator('42%')).toBeNull();
    expect(parsePdfLocator('1')).toBeNull();
    expect(parsePdfLocator('0')).toBeNull();
    expect(parsePdfLocator(cfi)).toBeNull();
    expect(parsePdfLocator('pdfpos(page=1;x=0;y=0;zoom=100%)')).toBeNull();
    expect(String(adaPlace).includes('%')).toBe(false);
    expect(String(beauPlace).includes('%')).toBe(false);
  });
});

describe('pdf reading place', () => {
  it('streams a pdf only to a reader who can access it and round-trips position per user', async () => {
    const started = await startApp();
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
    const blob = writeImmutableBlob(started.dataDir, pdf);
    const sqlite = openDatabase(started.databasePath);
    const now = '2026-04-03T00:00:00.000Z';
    const editionId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO editions (library_id, title, sort_title, language, created_at, updated_at)
          VALUES (?, '扫描件', '扫描件', 'zh-Hans', ?, ?)`,
        )
        .run(started.libraryId, now, now).lastInsertRowid,
    );
    const assetId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO file_assets (
            edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
          ) VALUES (?, 'pdf', ?, ?, 'scan.pdf', 'managed', ?, 'present', ?)`,
        )
        .run(editionId, blob.sha256, blob.bytes, blob.relativePath, now).lastInsertRowid,
    );
    const epubId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO file_assets (
            edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
          ) VALUES (?, 'epub', ?, ?, 'tale.epub', 'managed', ?, 'present', ?)`,
        )
        .run(editionId, 'ab'.repeat(32), 4, `blobs/${'ab'.repeat(32)}`, now).lastInsertRowid,
    );
    sqlite.sqlite.close();

    const anonymous = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${assetId}/file`,
    });
    expect(anonymous.statusCode).toBe(401);

    const file = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${assetId}/file`,
      headers: { cookie: started.cookie },
    });
    expect(file.statusCode).toBe(200);
    expect(String(file.headers['content-type'])).toContain('application/pdf');
    expect(String(file.headers['content-disposition'])).toContain('scan.pdf');
    expect(file.rawPayload.equals(pdf)).toBe(true);

    const percent = await started.app.inject({
      method: 'PUT',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: started.cookie },
      payload: { locator: '42%', assetId },
    });
    expect(percent.statusCode).toBe(400);
    const fraction = await started.app.inject({
      method: 'PUT',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: started.cookie },
      payload: { locator: '0.42', assetId },
    });
    expect(fraction.statusCode).toBe(400);
    const asCfi = await started.app.inject({
      method: 'PUT',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: started.cookie },
      payload: { locator: cfi, assetId },
    });
    expect(asCfi.statusCode).toBe(400);
    const pdfOnEpub = await started.app.inject({
      method: 'PUT',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: started.cookie },
      payload: { locator: adaPlace, assetId: epubId },
    });
    expect(pdfOnEpub.statusCode).toBe(400);

    const first = await started.app.inject({
      method: 'PUT',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: started.cookie },
      payload: { locator: adaPlace, assetId, revision: 0 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().position).toMatchObject({ locator: adaPlace, revision: 1, assetId });
    expect(parsePdfPlace(first.json().position.locator)).toEqual({ page: 2, x: 12.5, y: 240, zoom: 1.25 });

    const marked = await started.app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/bookmarks`,
      headers: { cookie: started.cookie },
      payload: { locator: adaPlace, assetId, label: 'Page 2', revision: 0 },
    });
    expect(marked.statusCode).toBe(201);
    expect(parsePdfPlace(marked.json().bookmark.locator)).toMatchObject({ page: 2, x: 12.5, y: 240 });
    const bookmarkId = marked.json().bookmark.id as number;

    const highlight = await started.app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/highlights`,
      headers: { cookie: started.cookie },
      payload: { locator: adaPlace, assetId, quote: 'scan' },
    });
    expect(highlight.statusCode).toBe(400);

    const created = await started.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: started.cookie },
      payload: { username: 'beau', password },
    });
    expect(created.statusCode).toBe(201);
    const beauId = created.json().user.id as number;
    const granted = await started.app.inject({
      method: 'POST',
      url: `/api/libraries/${started.libraryId}/grants`,
      headers: { cookie: started.cookie },
      payload: { userId: beauId },
    });
    expect(granted.statusCode).toBe(201);
    const login = await started.app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { username: 'beau', password },
    });
    expect(login.statusCode).toBe(200);
    const beauCookie = cookieFrom(login);
    const beauFile = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${assetId}/file`,
      headers: { cookie: beauCookie },
    });
    expect(beauFile.statusCode).toBe(200);
    expect(beauFile.rawPayload.equals(pdf)).toBe(true);
    const beauSave = await started.app.inject({
      method: 'PUT',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: beauCookie },
      payload: { locator: beauPlace, assetId, revision: 0 },
    });
    expect(beauSave.statusCode).toBe(200);
    expect(beauSave.json().position.locator).toBe(beauPlace);

    const adaAgain = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: started.cookie },
    });
    expect(adaAgain.statusCode).toBe(200);
    expect(adaAgain.json().position).toMatchObject({ locator: adaPlace, revision: 1, assetId });
    expect(adaAgain.json().bookmarks).toEqual([
      expect.objectContaining({ id: bookmarkId, locator: adaPlace, label: 'Page 2' }),
    ]);
    const beauAgain = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: beauCookie },
    });
    expect(beauAgain.json().position).toMatchObject({ locator: beauPlace, revision: 1, assetId });
    expect(beauAgain.json().bookmarks).toEqual([]);

    await started.app.close();
    const restarted = await buildApp({ config: started.config, clientDist: null, logger: false });
    started.replace(restarted);
    const adaStored = await restarted.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: started.cookie },
    });
    const beauStored = await restarted.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: beauCookie },
    });
    expect(adaStored.json().position.locator).toBe(adaPlace);
    expect(beauStored.json().position.locator).toBe(beauPlace);
    expect(parsePdfPlace(adaStored.json().position.locator)?.page).toBe(2);
    expect(parsePdfPlace(beauStored.json().position.locator)).toMatchObject({ page: 5, x: 0, y: 400, zoom: 'width' });

    const stranger = await restarted.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: started.cookie },
      payload: { username: 'cy', password },
    });
    expect(stranger.statusCode).toBe(201);
    const strangerLogin = await restarted.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { username: 'cy', password },
    });
    const strangerCookie = cookieFrom(strangerLogin);
    const hidden = await restarted.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${assetId}/file`,
      headers: { cookie: strangerCookie },
    });
    expect(hidden.statusCode).toBe(403);
    const hiddenPlace = await restarted.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/reading-place`,
      headers: { cookie: strangerCookie },
    });
    expect(hiddenPlace.statusCode).toBe(403);
  });

  it('streams an indexed pdf that stays inside the library root', async () => {
    const started = await startApp();
    const root = path.join(started.dataDir, 'indexed-root');
    mkdirSync(root, { recursive: true });
    const pdf = Buffer.from('%PDF-1.4\n% indexed\n');
    writeFileSync(path.join(root, 'scan.pdf'), pdf);
    const sqlite = openDatabase(started.databasePath);
    const now = '2026-04-04T00:00:00.000Z';
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
          VALUES (?, 'Indexed scan', 'indexed', ?, ?)`,
        )
        .run(libraryId, now, now).lastInsertRowid,
    );
    const assetId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO file_assets (
            edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
          ) VALUES (?, 'pdf', ?, ?, 'scan.pdf', 'indexed', 'scan.pdf', 'present', ?)`,
        )
        .run(editionId, 'cd'.repeat(32), pdf.length, now).lastInsertRowid,
    );
    sqlite.sqlite.close();

    const file = await started.app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${assetId}/file`,
      headers: { cookie: started.cookie },
    });
    expect(file.statusCode).toBe(200);
    expect(String(file.headers['content-type'])).toContain('application/pdf');
    expect(file.rawPayload.equals(pdf)).toBe(true);
  });
});
