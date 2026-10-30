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
      payload: { locator: adaPlace, assetId, quote: 'scan', revision: 0 },
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

const selection = 'pdfsel({"v":1,"pages":[{"page":2,"rects":[[12.5,240,150,260],[12.5,220,180,238]]},{"page":3,"rects":[[0,0,100,20]]}]})';
const laterSelection = 'pdfsel({"v":1,"pages":[{"page":4,"rects":[[1,2,30,40]]}]})';

function seedAnnotationBook(started: Awaited<ReturnType<typeof startApp>>, libraryId = started.libraryId) {
  const sqlite = openDatabase(started.databasePath);
  const now = '2026-04-05T00:00:00.000Z';
  const editionId = Number(sqlite.sqlite.prepare(
    `INSERT INTO editions (library_id, title, sort_title, created_at, updated_at)
    VALUES (?, 'Annotated scan', 'annotated scan', ?, ?)`,
  ).run(libraryId, now, now).lastInsertRowid);
  const assetIds = ['pdf', 'pdf', 'epub'].map((format, index) => {
    const blob = writeImmutableBlob(started.dataDir, Buffer.from(`%PDF-1.4\n% fixture ${index}\n`));
    return Number(sqlite.sqlite.prepare(
      `INSERT INTO file_assets (edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at)
      VALUES (?, ?, ?, ?, ?, 'managed', ?, 'present', ?)`,
    ).run(editionId, format, blob.sha256, blob.bytes, `book-${index}.${format}`, blob.relativePath, now).lastInsertRowid);
  });
  sqlite.sqlite.close();
  return { editionId, assetId: assetIds[0], secondAssetId: assetIds[1], epubId: assetIds[2] };
}

function annotationApi(started: Awaited<ReturnType<typeof startApp>>, editionId: number, cookie = started.cookie) {
  return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', suffix: string, payload?: Record<string, unknown>) => started.app.inject({
    method,
    url: `/api/editions/${editionId}${suffix}`,
    headers: { cookie },
    payload,
  });
}

describe('PDF annotations', () => {
  it('creates, reloads, exports, revises, and deletes selections and scan page notes', async () => {
    const started = await startApp();
    const { editionId, assetId, secondAssetId } = seedAnnotationBook(started);
    const api = annotationApi(started, editionId);
    const anonymous = await annotationApi(started, editionId, '')('POST', '/highlights', {
      locator: selection, assetId, quote: 'anonymous', revision: 0,
    });
    expect(anonymous.statusCode).toBe(401);

    for (const kind of ['highlights', 'notes']) {
      const conflict = await api('POST', `/${kind}`, {
        locator: selection, assetId, ...(kind === 'highlights' ? { quote: 'text' } : { body: 'text' }), revision: 1,
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({ error: 'conflict', [kind === 'highlights' ? 'highlight' : 'note']: null });
    }
    const marked = await api('POST', '/highlights', { locator: `  ${selection}  `, assetId, quote: ' Selected text ', revision: 0 });
    expect(marked.statusCode).toBe(201);
    expect(marked.json().highlight).toMatchObject({ locator: selection, quote: 'Selected text', assetId, label: null, revision: 1 });
    const highlightId = marked.json().highlight.id as number;
    const noted = await api('POST', '/notes', { locator: selection, assetId, body: ' Selection note ', revision: 0 });
    expect(noted.statusCode).toBe(201);
    expect(noted.json().note).toMatchObject({ locator: selection, body: 'Selection note', assetId, revision: 1 });
    const noteId = noted.json().note.id as number;
    const pageNoted = await api('POST', '/notes', { locator: ` ${adaPlace} `, assetId, body: 'Page note on a scan', revision: 0 });
    expect(pageNoted.statusCode).toBe(201);
    expect(pageNoted.json().note).toMatchObject({ locator: adaPlace, body: 'Page note on a scan', assetId, revision: 1 });
    const pageNoteId = pageNoted.json().note.id as number;
    const otherAsset = await api('POST', '/highlights', { locator: selection, assetId: secondAssetId, quote: 'Other asset', revision: 0 });
    expect(otherAsset.statusCode).toBe(201);
    const otherHighlightId = otherAsset.json().highlight.id as number;

    await started.app.close();
    started.replace(await buildApp({ config: started.config, clientDist: null, logger: false }));
    const loaded = await api('GET', '/reading-place');
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().highlights).toEqual([
      expect.objectContaining({ id: highlightId, locator: selection, quote: 'Selected text', assetId, revision: 1 }),
      expect.objectContaining({ id: otherHighlightId, locator: selection, quote: 'Other asset', assetId: secondAssetId, revision: 1 }),
    ]);
    expect(loaded.json().notes).toEqual([
      expect.objectContaining({ id: noteId, locator: selection, body: 'Selection note', assetId, revision: 1 }),
      expect.objectContaining({ id: pageNoteId, locator: adaPlace, body: 'Page note on a scan', assetId, revision: 1 }),
    ]);
    const exported = await api('GET', '/annotations?format=json');
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toEqual({
      book: { id: editionId, title: 'Annotated scan', authors: [], identifiers: [] },
      highlights: [{ text: 'Selected text', locator: selection }, { text: 'Other asset', locator: selection }],
      notes: [{ text: 'Selection note', locator: selection }, { text: 'Page note on a scan', locator: adaPlace }],
    });
    const markdown = await api('GET', '/annotations?format=markdown');
    expect(markdown.statusCode).toBe(200);
    expect(markdown.body).toContain(`## Highlight\n\nSelected text\n\nLocation: ${selection}`);
    expect(markdown.body).toContain(`## Note\n\nSelection note\n\nLocation: ${selection}`);
    expect(markdown.body).toContain(`## Note\n\nPage note on a scan\n\nLocation: ${adaPlace}`);

    const revised = await api('PATCH', `/highlights/${highlightId}`, { locator: laterSelection, quote: 'Revised text', revision: 1 });
    expect(revised.statusCode).toBe(200);
    expect(revised.json().highlight).toMatchObject({ locator: laterSelection, quote: 'Revised text', assetId, revision: 2 });
    const stale = await api('PATCH', `/highlights/${highlightId}`, { locator: selection, quote: 'Stale text', revision: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'conflict', highlight: revised.json().highlight });
    const staleDelete = await api('DELETE', `/highlights/${highlightId}`, { revision: 1 });
    expect(staleDelete.statusCode).toBe(409);
    expect(staleDelete.json().highlight).toEqual(revised.json().highlight);
    for (const [id, locator] of [[noteId, selection], [pageNoteId, adaPlace]] as const) {
      const revisedNote = await api('PATCH', `/notes/${id}`, { body: 'Revised note', revision: 1 });
      expect(revisedNote.statusCode).toBe(200);
      expect(revisedNote.json().note).toMatchObject({ locator, body: 'Revised note', assetId, revision: 2 });
      for (const method of ['PATCH', 'DELETE'] as const) {
        const staleNote = await api(method, `/notes/${id}`, { ...(method === 'PATCH' ? { body: 'Stale note' } : {}), revision: 1 });
        expect(staleNote.statusCode).toBe(409);
        expect(staleNote.json().note).toEqual(revisedNote.json().note);
      }
      expect((await api('DELETE', `/notes/${id}`, { revision: 2 })).statusCode).toBe(204);
    }
    expect((await api('DELETE', `/highlights/${highlightId}`, { revision: 2 })).statusCode).toBe(204);
    const remaining = await api('GET', '/reading-place');
    expect(remaining.json().highlights).toEqual([otherAsset.json().highlight]);
    expect(remaining.json().notes).toEqual([]);
  });

  it('enforces format, text limits, existing asset, and legacy EPUB update rules', async () => {
    const started = await startApp();
    const { editionId, assetId, epubId } = seedAnnotationBook(started);
    const other = seedAnnotationBook(started);
    const api = annotationApi(started, editionId);
    for (const kind of ['highlights', 'notes']) {
      const text = kind === 'highlights' ? { quote: 'text' } : { body: 'text' };
      for (const [id, locator] of [[assetId, cfi], [epubId, selection], [epubId, adaPlace], [assetId, 'pdfsel({"v":2,"pages":[]})']] as const) {
        expect((await api('POST', `/${kind}`, { assetId: id, locator, ...text, revision: 0 })).statusCode).toBe(400);
      }
      for (const id of [other.assetId, 1_000_000]) {
        expect((await api('POST', `/${kind}`, { assetId: id, locator: selection, ...text, revision: 0 })).statusCode).toBe(404);
      }
    }
    expect((await api('POST', '/highlights', { locator: adaPlace, assetId, quote: 'scan', revision: 0 })).statusCode).toBe(400);
    expect((await api('POST', '/highlights', { locator: selection, assetId, quote: 'x'.repeat(2001), revision: 0 })).statusCode).toBe(400);
    expect((await api('POST', '/highlights', { locator: selection, assetId, quote: 'bad\u0000text', revision: 0 })).statusCode).toBe(400);
    for (const body of ['', 'x'.repeat(10_001), 'bad\u0000text']) {
      expect((await api('POST', '/notes', { locator: selection, assetId, body, revision: 0 })).statusCode).toBe(400);
    }
    const pdf = await api('POST', '/highlights', { locator: selection, assetId, quote: 'x'.repeat(2000), revision: 0 });
    const epub = await api('POST', '/highlights', { locator: cfi, assetId: epubId, revision: 0 });
    const note = await api('POST', '/notes', { locator: selection, assetId, body: 'x'.repeat(10_000), revision: 0 });
    expect(pdf.statusCode).toBe(201);
    expect(epub.statusCode).toBe(201);
    expect(note.statusCode).toBe(201);
    for (const [id, locator] of [[pdf.json().highlight.id, cfi], [pdf.json().highlight.id, adaPlace], [epub.json().highlight.id, selection]] as const) {
      expect((await api('PATCH', `/highlights/${id}`, { locator, revision: 1 })).statusCode).toBe(400);
    }
    expect((await api('PATCH', `/highlights/${pdf.json().highlight.id}`, { quote: 'x'.repeat(2001), revision: 1 })).statusCode).toBe(400);
    expect((await api('PATCH', `/notes/${note.json().note.id}`, { body: 'x'.repeat(10_001), revision: 1 })).statusCode).toBe(400);

    // Old EPUB rows without an asset retain CFI-only locator editing.
    const sqlite = openDatabase(started.databasePath);
    sqlite.sqlite.prepare('UPDATE highlights SET asset_id = NULL WHERE id = ?').run(epub.json().highlight.id);
    sqlite.sqlite.close();
    expect((await api('PATCH', `/highlights/${epub.json().highlight.id}`, { locator: selection, revision: 1 })).statusCode).toBe(400);
    const legacy = await api('PATCH', `/highlights/${epub.json().highlight.id}`, { locator: 'epubcfi(/6/8!/4/2:10)', revision: 1 });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().highlight).toMatchObject({ locator: 'epubcfi(/6/8!/4/2:10)', assetId: null, revision: 2 });

    // Content edits and loads survive missing/trashed source assets; locator changes require a present asset.
    for (const condition of ["availability = 'missing'", "availability = 'present', trashed_at = '2026-04-06T00:00:00.000Z'"]) {
      const db = openDatabase(started.databasePath);
      db.sqlite.prepare(`UPDATE file_assets SET ${condition} WHERE id = ?`).run(assetId);
      db.sqlite.close();
      for (const kind of ['highlights', 'notes']) {
        expect((await api('POST', `/${kind}`, { locator: selection, assetId, ...(kind === 'highlights' ? { quote: 'text' } : { body: 'text' }), revision: 0 })).statusCode).toBe(404);
      }
      expect((await api('PATCH', `/highlights/${pdf.json().highlight.id}`, { locator: laterSelection, revision: 1 })).statusCode).toBe(404);
    }
    const quoteOnly = await api('PATCH', `/highlights/${pdf.json().highlight.id}`, { quote: 'Still editable', revision: 1 });
    expect(quoteOnly.statusCode).toBe(200);
    expect(quoteOnly.json().highlight).toMatchObject({ locator: selection, quote: 'Still editable', assetId, revision: 2 });
    const bodyOnly = await api('PATCH', `/notes/${note.json().note.id}`, { body: 'Still editable', revision: 1 });
    expect(bodyOnly.statusCode).toBe(200);
    expect(bodyOnly.json().note).toMatchObject({ locator: selection, body: 'Still editable', assetId, revision: 2 });
    expect((await api('GET', '/reading-place')).json().highlights).toContainEqual(quoteOnly.json().highlight);

    const trashed = openDatabase(started.databasePath);
    trashed.sqlite.prepare("UPDATE editions SET trashed_at = '2026-04-06T00:00:00.000Z' WHERE id = ?").run(editionId);
    trashed.sqlite.close();
    for (const [method, suffix, payload] of [
      ['GET', '/reading-place', undefined], ['GET', '/annotations?format=json', undefined],
      ['POST', '/highlights', { locator: selection, assetId, revision: 0 }],
      ['POST', '/notes', { locator: adaPlace, assetId, body: 'hidden', revision: 0 }],
      ['PATCH', `/highlights/${pdf.json().highlight.id}`, { quote: 'hidden', revision: 2 }],
      ['PATCH', `/notes/${note.json().note.id}`, { body: 'hidden', revision: 2 }],
      ['DELETE', `/highlights/${pdf.json().highlight.id}`, { revision: 2 }],
      ['DELETE', `/notes/${note.json().note.id}`, { revision: 2 }],
    ] as const) {
      expect((await api(method, suffix, payload)).statusCode).toBe(404);
    }
  });

  it('scopes annotations and mutations by user, edition, and library access', async () => {
    const started = await startApp();
    const { editionId, assetId } = seedAnnotationBook(started);
    const other = seedAnnotationBook(started);
    const api = annotationApi(started, editionId);
    const created = await started.app.inject({
      method: 'POST', url: '/api/users', headers: { cookie: started.cookie }, payload: { username: 'beau', password },
    });
    expect(created.statusCode).toBe(201);
    const login = await started.app.inject({ method: 'POST', url: '/api/session/login', payload: { username: 'beau', password } });
    expect(login.statusCode).toBe(200);
    const beau = annotationApi(started, editionId, cookieFrom(login));
    const highlight = await api('POST', '/highlights', { locator: selection, assetId, quote: 'Private quote', revision: 0 });
    const note = await api('POST', '/notes', { locator: adaPlace, assetId, body: 'Private page note', revision: 0 });
    expect(highlight.statusCode).toBe(201);
    expect(note.statusCode).toBe(201);
    const highlightId = highlight.json().highlight.id as number;
    const noteId = note.json().note.id as number;
    for (const [method, suffix, payload] of [
      ['GET', '/reading-place', undefined], ['GET', '/annotations?format=json', undefined],
      ['POST', '/highlights', { locator: selection, assetId, revision: 0 }],
      ['POST', '/notes', { locator: adaPlace, assetId, body: 'denied', revision: 0 }],
      ['PATCH', `/highlights/${highlightId}`, { locator: cfi, revision: 1 }],
      ['PATCH', `/notes/${noteId}`, { body: 'denied', revision: 1 }],
      ['DELETE', `/highlights/${highlightId}`, { revision: 1 }],
      ['DELETE', `/notes/${noteId}`, { revision: 1 }],
    ] as const) {
      expect((await beau(method, suffix, payload)).statusCode).toBe(403);
    }
    expect((await started.app.inject({
      method: 'POST', url: `/api/libraries/${started.libraryId}/grants`, headers: { cookie: started.cookie },
      payload: { userId: created.json().user.id },
    })).statusCode).toBe(201);
    const otherUser = await beau('GET', '/reading-place');
    expect(otherUser.json().highlights).toEqual([]);
    expect(otherUser.json().notes).toEqual([]);
    expect((await beau('GET', '/annotations?format=json')).json()).toMatchObject({ highlights: [], notes: [] });
    expect((await annotationApi(started, other.editionId)('GET', '/reading-place')).json()).toMatchObject({ highlights: [], notes: [] });
    for (const scoped of [beau, annotationApi(started, other.editionId)]) {
      for (const method of ['PATCH', 'DELETE'] as const) {
        const h = await scoped(method, `/highlights/${highlightId}`, { ...(method === 'PATCH' ? { locator: cfi } : {}), revision: 1 });
        expect(h.statusCode).toBe(404);
        const n = await scoped(method, `/notes/${noteId}`, { ...(method === 'PATCH' ? { body: 'other user' } : {}), revision: 1 });
        expect(n.statusCode).toBe(404);
      }
    }
    const own = await beau('POST', '/highlights', { locator: laterSelection, assetId, quote: 'Beau quote', revision: 0 });
    expect(own.statusCode).toBe(201);
    expect((await api('GET', '/reading-place')).json().highlights).toEqual([highlight.json().highlight]);
    expect((await beau('GET', '/reading-place')).json().highlights).toEqual([own.json().highlight]);
  });
});
