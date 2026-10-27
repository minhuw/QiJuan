import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { Converter } from 'opencc-js';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir, tempConfig } from './helpers.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';
const toTraditional = Converter({ from: 'cn', to: 't' });
const toSimplified = Converter({ from: 't', to: 'cn' });

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
  return {
    app,
    databasePath: config.databasePath,
    cookie: cookieFrom(setup),
    libraryId: setup.json().library.id as number,
    userId: setup.json().user.id as number,
  };
}

function sha(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

function insertEdition(
  sqlite: Database.Database,
  input: {
    libraryId: number;
    title: string;
    sortTitle: string;
    language: string;
    createdAt: string;
    seriesId?: number;
    seriesOrder?: number;
    author?: string;
    translator?: string;
    alternate?: string;
    tag?: string;
    isbn?: string;
    format?: 'epub' | 'pdf';
    cover?: boolean;
  },
): number {
  const edition = sqlite
    .prepare(
      `INSERT INTO editions (
        library_id, title, sort_title, language, series_id, series_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.libraryId,
      input.title,
      input.sortTitle,
      input.language,
      input.seriesId ?? null,
      input.seriesOrder ?? null,
      input.createdAt,
      input.createdAt,
    );
  const id = Number(edition.lastInsertRowid);
  const link = (name: string, role: 'author' | 'translator') => {
    const existing = sqlite.prepare('SELECT id FROM persons WHERE name = ?').get(name) as { id: number } | undefined;
    const personId = existing
      ? existing.id
      : Number(
          sqlite.prepare('INSERT INTO persons (name, sort_name, created_at) VALUES (?, ?, ?)').run(name, name, input.createdAt)
            .lastInsertRowid,
        );
    sqlite
      .prepare(
        `INSERT INTO edition_contributors (edition_id, person_id, role, position, display_name)
        VALUES (?, ?, ?, 0, ?)`,
      )
      .run(id, personId, role, name);
  };
  if (input.author) link(input.author, 'author');
  if (input.translator) link(input.translator, 'translator');
  if (input.alternate) {
    sqlite.prepare('INSERT INTO alternate_titles (edition_id, title) VALUES (?, ?)').run(id, input.alternate);
  }
  if (input.tag) {
    sqlite.prepare('INSERT INTO tags (edition_id, name, created_at) VALUES (?, ?, ?)').run(id, input.tag, input.createdAt);
  }
  if (input.isbn) {
    sqlite.prepare('INSERT INTO identifiers (edition_id, scheme, value) VALUES (?, ?, ?)').run(id, 'isbn', input.isbn);
  }
  const format = input.format ?? 'epub';
  const digest = sha(`${id}:${format}:${input.title}`);
  sqlite
    .prepare(
      `INSERT INTO file_assets (
        edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
      ) VALUES (?, ?, ?, 32, ?, 'managed', ?, 'present', ?)`,
    )
    .run(id, format, digest, `${input.sortTitle}.${format}`, `blobs/${digest.slice(0, 2)}/${digest}`, input.createdAt);
  if (input.cover) {
    const cover = sha(`cover:${id}`);
    sqlite
      .prepare(
        `INSERT INTO covers (edition_id, sha256, bytes, media_type, relative_path, created_at)
        VALUES (?, ?, 8, 'image/png', ?, ?)`,
      )
      .run(id, cover, `blobs/${cover.slice(0, 2)}/${cover}`, input.createdAt);
  }
  return id;
}

describe('library search and personal state', () => {
  it('searches both Chinese scripts without rewriting stored text, and keeps personal filters per user', async () => {
    const title = '红楼梦人物';
    const traditionalTitle = toTraditional(title);
    expect(traditionalTitle).not.toBe(title);
    expect(toSimplified(traditionalTitle)).toBe(title);
    expect(traditionalTitle).not.toMatch(/\s/);
    const substring = '楼梦人';
    const short = '梦人';
    expect(title.includes(substring)).toBe(true);
    expect(substring).not.toMatch(/\s/);
    expect(Array.from(substring).length).toBeGreaterThanOrEqual(3);
    expect(Array.from(short).length).toBeLessThan(3);
    expect(toSimplified(toTraditional(substring))).toBe(substring);

    const { app, databasePath, cookie, libraryId, userId } = await startApp();
    const sqlite = new Database(databasePath);
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    const ftsSql = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'edition_fts'").get() as { sql: string };
    expect(ftsSql.sql.toLowerCase()).toContain('trigram');

    const denied = await app.inject({ method: 'GET', url: '/api/library?limit=10' });
    expect(denied.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/library', headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/library?limit=61', headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/library?limit=0', headers: { cookie } })).statusCode).toBe(400);

    const series = sqlite
      .prepare('INSERT INTO series (library_id, name, sort_name, created_at) VALUES (?, ?, ?, ?)')
      .run(libraryId, '武侠系列', '武侠系列', '2026-01-01T00:00:00.000Z');
    const seriesId = Number(series.lastInsertRowid);
    const main = insertEdition(sqlite, {
      libraryId,
      title,
      sortTitle: 'a',
      language: 'zh',
      createdAt: '2026-01-01T00:00:00.000Z',
      seriesId,
      seriesOrder: 1,
      author: '余华',
      translator: '张三丰',
      alternate: 'Riverside',
      tag: '小说',
      isbn: '978-7-5327-1234-5',
      format: 'epub',
      cover: true,
    });
    const neighbor = insertEdition(sqlite, {
      libraryId,
      title: '射雕后传',
      sortTitle: 'b',
      language: 'zh',
      createdAt: '2026-01-02T00:00:00.000Z',
      seriesId,
      seriesOrder: 2,
      author: '金庸',
      format: 'epub',
    });
    const readingOnly = insertEdition(sqlite, {
      libraryId,
      title: '海边来信',
      sortTitle: 'c',
      language: 'zh',
      createdAt: '2026-01-03T00:00:00.000Z',
      author: '匿名',
      format: 'epub',
    });
    const pdf = insertEdition(sqlite, {
      libraryId,
      title: '画册一页',
      sortTitle: 'd',
      language: 'zh',
      createdAt: '2026-01-04T00:00:00.000Z',
      author: '画师',
      format: 'pdf',
    });
    const english = insertEdition(sqlite, {
      libraryId,
      title: 'English Tale',
      sortTitle: 'e',
      language: 'en',
      createdAt: '2026-01-05T00:00:00.000Z',
      author: 'Ada',
      format: 'epub',
    });
    const finished = insertEdition(sqlite, {
      libraryId,
      title: '完结篇',
      sortTitle: 'f',
      language: 'zh',
      createdAt: '2026-01-06T00:00:00.000Z',
      author: '完结者',
      format: 'epub',
    });
    const decoy = insertEdition(sqlite, {
      libraryId,
      title: '安静的日子',
      sortTitle: 'g',
      language: 'zh',
      createdAt: '2026-01-07T00:00:00.000Z',
      author: '路人',
      format: 'epub',
    });
    sqlite
      .prepare(
        `INSERT INTO reading_positions (user_id, edition_id, locator, revision, updated_at)
        VALUES (?, ?, 'epubcfi(/6/2)', 1, ?)`,
      )
      .run(userId, main, '2026-01-08T00:00:00.000Z');
    sqlite.close();

    async function search(params: Record<string, string> = {}, session = cookie) {
      const query = new URLSearchParams({ limit: '60', ...params });
      const response = await app.inject({
        method: 'GET',
        url: `/api/library?${query}`,
        headers: { cookie: session },
      });
      expect(response.statusCode).toBe(200);
      return response.json() as {
        editions: Array<{ id: number; title: string; hasCover: boolean; status: string | null; favorite: boolean; rating: number | null }>;
        total: number;
      };
    }

    const bySubstring = await search({ q: substring });
    expect(bySubstring.editions.map((item) => item.id)).toEqual([main]);
    expect(bySubstring.editions[0]?.title).toBe(title);
    expect(bySubstring.editions[0]?.hasCover).toBe(true);

    const byShort = await search({ q: short });
    expect(byShort.editions.map((item) => item.id)).toEqual([main]);
    const byTraditional = await search({ q: traditionalTitle });
    expect(byTraditional.editions.map((item) => item.id)).toEqual([main]);
    expect(byTraditional.editions[0]?.title).toBe(title);
    const byTraditionalPart = await search({ q: toTraditional(substring) });
    expect(byTraditionalPart.editions.map((item) => item.id)).toEqual([main]);

    expect((await search({ q: '余华' })).editions.map((item) => item.id)).toEqual([main]);
    expect((await search({ q: toTraditional('余华') })).editions.map((item) => item.id)).toEqual([main]);
    expect((await search({ q: '张三丰' })).editions.map((item) => item.id)).toEqual([main]);
    expect((await search({ q: toTraditional('张三丰') })).editions.map((item) => item.id)).toEqual([main]);
    expect((await search({ q: 'Rive' })).editions.map((item) => item.id)).toEqual([main]);
    expect((await search({ q: '小说' })).editions.map((item) => item.id)).toEqual([main]);
    expect((await search({ q: toTraditional('小说') })).editions.map((item) => item.id)).toEqual([main]);
    expect((await search({ q: '武侠系列' })).editions.map((item) => item.id)).toEqual([main, neighbor]);
    expect((await search({ q: toTraditional('武侠系列') })).editions.map((item) => item.id)).toEqual([main, neighbor]);
    expect((await search({ q: '9787532712345' })).editions.map((item) => item.id)).toEqual([main]);
    expect((await search({ q: '978-7-5327-1234-5' })).editions.map((item) => item.id)).toEqual([main]);
    expect((await search({ q: '完全没有' })).editions).toEqual([]);

    const check = new Database(databasePath, { readonly: true, fileMustExist: true });
    const stored = check.prepare('SELECT title FROM editions WHERE id = ?').get(main) as { title: string };
    expect(stored.title).toBe(title);
    expect(Buffer.from(stored.title, 'utf8').equals(Buffer.from(title, 'utf8'))).toBe(true);
    expect(stored.title).not.toContain(traditionalTitle);
    const indexed = check.prepare('SELECT title, authors, isbn FROM edition_fts WHERE rowid = ?').get(main) as {
      title: string;
      authors: string;
      isbn: string;
    };
    expect(indexed.title).toBe(title);
    expect(indexed.authors).toBe('余华');
    expect(indexed.isbn).toBe('9787532712345');
    const author = check
      .prepare(
        `SELECT COALESCE(ec.display_name, p.name) AS name
        FROM edition_contributors ec
        JOIN persons p ON p.id = ec.person_id
        WHERE ec.edition_id = ? AND ec.role = 'author'`,
      )
      .get(main) as { name: string };
    expect(author.name).toBe('余华');
    check.close();

    async function read(session: string, id: number) {
      const response = await app.inject({ method: 'GET', url: `/api/editions/${id}`, headers: { cookie: session } });
      expect(response.statusCode).toBe(200);
      return response.json().edition as {
        title: string;
        reading: {
          status: string | null;
          rating: number | null;
          favorite: boolean;
          queued: boolean;
          shelves: Array<{ id: number; name: string; included: boolean }>;
        };
        neighbors: { previous: { id: number } | null; next: { title: string } | null };
      };
    }

    const shelfResponse = await app.inject({
      method: 'POST',
      url: '/api/shelves',
      headers: { cookie },
      payload: { name: 'Weekend', editionId: main },
    });
    expect(shelfResponse.statusCode).toBe(201);
    const shelfId = shelfResponse.json().shelf.id as number;
    for (const id of [pdf, english, finished]) {
      const added = await app.inject({
        method: 'POST',
        url: `/api/shelves/${shelfId}/items`,
        headers: { cookie },
        payload: { editionId: id },
      });
      expect(added.statusCode).toBe(200);
    }
    for (const [id, status] of [
      [main, 'reading'],
      [readingOnly, 'reading'],
      [pdf, 'reading'],
      [english, 'reading'],
      [finished, 'finished'],
    ] as const) {
      const saved = await app.inject({
        method: 'PATCH',
        url: `/api/editions/${id}/reading`,
        headers: { cookie },
        payload: id === main ? { status, rating: 5, favorite: true, queued: true } : { status },
      });
      expect(saved.statusCode).toBe(200);
    }

    const adaEdition = await read(cookie, main);
    expect(adaEdition.reading).toMatchObject({ status: 'reading', rating: 5, favorite: true, queued: true });
    expect(adaEdition.reading.shelves).toEqual([{ id: shelfId, name: 'Weekend', included: true }]);
    expect(adaEdition.neighbors.previous).toBeNull();
    expect(adaEdition.neighbors.next?.title).toBe('射雕后传');
    const neighborEdition = await read(cookie, neighbor);
    expect(neighborEdition.neighbors.previous?.id).toBe(main);

    const intersection = await search({
      language: 'zh',
      format: 'epub',
      status: 'reading',
      shelfId: String(shelfId),
    });
    expect(intersection.editions.map((item) => item.id)).toEqual([main]);
    expect(intersection.total).toBe(1);
    const withoutShelf = await search({ language: 'zh', format: 'epub', status: 'reading' });
    expect(withoutShelf.editions.map((item) => item.id)).toEqual([main, readingOnly]);

    const page = await app.inject({ method: 'GET', url: '/api/library?limit=2&offset=0', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.json().total).toBe(7);
    expect(page.json().editions.map((item: { id: number }) => item.id)).toEqual([main, neighbor]);
    const pageTail = await app.inject({ method: 'GET', url: '/api/library?limit=2&offset=6', headers: { cookie } });
    expect(pageTail.json().editions.map((item: { id: number }) => item.id)).toEqual([decoy]);
    const wide = await app.inject({ method: 'GET', url: '/api/library?limit=60', headers: { cookie } });
    expect(wide.statusCode).toBe(200);
    expect(wide.json().editions).toHaveLength(7);

    const home = await app.inject({ method: 'GET', url: '/api/home', headers: { cookie } });
    expect(home.statusCode).toBe(200);
    expect(home.json().continueReading.map((item: { id: number; title: string }) => [item.id, item.title])).toEqual([[main, title]]);
    expect(home.json().recent[0].id).toBe(decoy);
    expect(home.json().shelves).toEqual([{ id: shelfId, name: 'Weekend', count: 4 }]);

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: { username: 'bea', password: 'reader-password' },
    });
    expect(created.statusCode).toBe(201);
    const readerId = created.json().user.id as number;
    expect(readerId).not.toBe(userId);
    const grant = await app.inject({
      method: 'POST',
      url: `/api/libraries/${libraryId}/grants`,
      headers: { cookie },
      payload: { userId: readerId },
    });
    expect(grant.statusCode).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { username: 'bea', password: 'reader-password' },
    });
    expect(login.statusCode).toBe(200);
    const bea = cookieFrom(login);

    const hidden = await read(bea, main);
    expect(hidden.title).toBe(title);
    expect(hidden.reading).toMatchObject({ status: null, rating: null, favorite: false, queued: false, shelves: [] });
    const beaShelves = await app.inject({ method: 'GET', url: '/api/shelves', headers: { cookie: bea } });
    expect(beaShelves.statusCode).toBe(200);
    expect(beaShelves.json().shelves).toEqual([]);
    const beaHome = await app.inject({ method: 'GET', url: '/api/home', headers: { cookie: bea } });
    expect(beaHome.json().continueReading).toEqual([]);
    expect(beaHome.json().shelves).toEqual([]);
    expect(beaHome.json().recent[0].id).toBe(decoy);
    expect((await search({ status: 'reading' }, bea)).editions).toEqual([]);
    const foreignShelf = await app.inject({
      method: 'GET',
      url: `/api/library?limit=60&shelfId=${shelfId}`,
      headers: { cookie: bea },
    });
    expect(foreignShelf.statusCode).toBe(404);

    const beaState = await app.inject({
      method: 'PATCH',
      url: `/api/editions/${main}/reading`,
      headers: { cookie: bea },
      payload: { status: 'want', rating: 2, favorite: true, queued: true },
    });
    expect(beaState.statusCode).toBe(200);
    const beaShelf = await app.inject({
      method: 'POST',
      url: '/api/shelves',
      headers: { cookie: bea },
      payload: { name: 'Weekend', editionId: main },
    });
    expect(beaShelf.statusCode).toBe(201);
    const beaShelfId = beaShelf.json().shelf.id as number;
    expect(beaShelfId).not.toBe(shelfId);

    const adaAfter = await read(cookie, main);
    expect(adaAfter.reading).toMatchObject({ status: 'reading', rating: 5, favorite: true, queued: true });
    expect(adaAfter.reading.shelves.map((item) => item.id)).toEqual([shelfId]);
    const beaAfter = await read(bea, main);
    expect(beaAfter.reading).toMatchObject({ status: 'want', rating: 2, favorite: true, queued: true });
    expect(beaAfter.reading.shelves).toEqual([{ id: beaShelfId, name: 'Weekend', included: true }]);
    const adaShelves = await app.inject({ method: 'GET', url: '/api/shelves', headers: { cookie } });
    expect(adaShelves.json().shelves.map((item: { id: number }) => item.id)).toEqual([shelfId]);
    expect((await search({ status: 'reading' }, bea)).editions.map((item) => item.id)).not.toContain(main);
    expect((await search({ status: 'reading', shelfId: String(shelfId) })).editions.map((item) => item.id)).toEqual([
      main,
      pdf,
      english,
    ]);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/editions/${decoy}`,
      headers: { cookie },
      payload: { title: '喧哗与骚动' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().edition.title).toBe('喧哗与骚动');
    expect((await search({ q: '静的日' })).editions).toEqual([]);
    expect((await search({ q: '喧哗与' })).editions.map((item) => item.id)).toEqual([decoy]);
    expect((await search({ q: toTraditional('喧哗与骚动') })).editions.map((item) => item.id)).toEqual([decoy]);
    const after = new Database(databasePath, { readonly: true, fileMustExist: true });
    expect(after.prepare('SELECT title FROM editions WHERE id = ?').get(decoy)).toEqual({ title: '喧哗与骚动' });
    expect(after.prepare('SELECT title FROM editions WHERE id = ?').get(main)).toEqual({ title });
    expect(after.prepare('SELECT title FROM edition_fts WHERE rowid = ?').get(decoy)).toEqual({ title: '喧哗与骚动' });
    after.close();
  });
});
