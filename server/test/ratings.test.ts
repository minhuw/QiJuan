import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase, type AppDatabase } from '../src/db.js';
import type { WebTransport } from '../src/metadata/assistant/client.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import {
  RATINGS_BACKOFF_MS,
  RATINGS_HOST_INTERVAL_MS,
  RatingsFetcher,
  ensureRatingsFresh,
  enqueueRatings,
  loadRatingKeys,
  openLibraryWorkKey,
  parseDoubanPage,
  parseGoodreadsPage,
  parseGoogleVolume,
  parseOpenLibraryRatings,
  presentRatings,
  ratingsQueued,
  runNextRatingsJob,
  toIsbn10,
} from '../src/ratings.js';
import { makeTempDir, tempConfig } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(path.join(here, 'fixtures', 'ratings', name), 'utf8');
const password = 'correct horse battery staple';
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const CHINESE_ISBN = '9787010134185';
const DAHL_ISBN = '9780140328721';
const DOUBAN_SUBJECT = 'https://book.douban.com/subject/25869109/';
const GOODREADS_DAHL = 'https://www.goodreads.com/book/show/1507552.Fantastic_Mr_Fox';

type Route = Response | (() => Response);

/** Answers by exact URL (query included); anything else is a 404. DNS is public unless listed. */
function stubTransport(routes: Record<string, Route>, dns: Record<string, string[]> = {}) {
  const seen: string[] = [];
  const transport: WebTransport = {
    async fetch(input) {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      seen.push(url.href);
      const route = routes[url.href];
      if (!route) return new Response('missing', { status: 404 });
      return typeof route === 'function' ? route() : route.clone();
    },
    async lookup(host) {
      return dns[host] ?? ['93.184.216.34'];
    },
  };
  return { transport, seen };
}

const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const json = (body: unknown) => Response.json(body);
const redirect = (location: string, status = 301) => new Response(null, { status, headers: { location } });

/** The real-shaped answers for both probe books, on every provider. */
function realisticRoutes(): Record<string, Route> {
  return {
    [`https://book.douban.com/isbn/${CHINESE_ISBN}/`]: () => redirect(DOUBAN_SUBJECT),
    [DOUBAN_SUBJECT]: () => html(fixture('douban-subject.html')),
    [`https://www.goodreads.com/book/isbn/${CHINESE_ISBN}`]: () => redirect('https://www.goodreads.com/book/show/99329011'),
    'https://www.goodreads.com/book/show/99329011': () => html(fixture('goodreads-no-rating.html')),
    [`https://www.goodreads.com/book/isbn/${DAHL_ISBN}`]: () => redirect(GOODREADS_DAHL),
    [GOODREADS_DAHL]: () => html(fixture('goodreads-book.html')),
    [`https://openlibrary.org/isbn/${DAHL_ISBN}.json`]: () => redirect('https://openlibrary.org/books/OL7353617M.json', 302),
    'https://openlibrary.org/books/OL7353617M.json': () => json(JSON.parse(fixture('openlibrary-edition.json'))),
    'https://openlibrary.org/works/OL45804W/ratings.json': () => json(JSON.parse(fixture('openlibrary-ratings.json'))),
    [`https://www.googleapis.com/books/v1/volumes?q=isbn%3A${DAHL_ISBN}&maxResults=1`]: () =>
      json(JSON.parse(fixture('google-volumes.json'))),
  };
}

function quickFetcher(transport: WebTransport, extra: Partial<ConstructorParameters<typeof RatingsFetcher>[0]> = {}) {
  return new RatingsFetcher({ transport, hostIntervalMs: 0, ...extra });
}

const keysFor = (isbn: string) => ({ isbns: [isbn], douban: null, olids: [], googleBooks: null });

describe('rating parsers', () => {
  it('reads a Douban score out of 10 and treats too few votes as no rating', () => {
    expect(parseDoubanPage(fixture('douban-subject.html'), DOUBAN_SUBJECT)).toEqual({
      status: 'ok',
      url: DOUBAN_SUBJECT,
      rating: 9.3,
      count: 209,
      error: null,
    });
    expect(parseDoubanPage(fixture('douban-no-rating.html'), 'https://book.douban.com/subject/30000001/')).toMatchObject({
      status: 'no_rating',
      url: 'https://book.douban.com/subject/30000001/',
      rating: null,
    });
    expect(parseDoubanPage('<html><body>redesigned</body></html>', DOUBAN_SUBJECT)).toMatchObject({ status: 'error', error: 'layout' });
  });

  it('reads Goodreads JSON-LD and keeps the link when there is no aggregateRating', () => {
    expect(parseGoodreadsPage(fixture('goodreads-book.html'), GOODREADS_DAHL)).toEqual({
      status: 'ok',
      url: GOODREADS_DAHL,
      rating: 4.08,
      count: 153507,
      error: null,
    });
    expect(parseGoodreadsPage(fixture('goodreads-no-rating.html'), 'https://www.goodreads.com/book/show/99329011')).toMatchObject({
      status: 'no_rating',
      url: 'https://www.goodreads.com/book/show/99329011',
    });
    expect(parseGoodreadsPage('<script type="application/ld+json">{not json</script>', GOODREADS_DAHL)).toMatchObject({
      status: 'error',
      error: 'layout',
    });
  });

  it('reads Open Library ratings and the work key of an edition record', () => {
    const url = 'https://openlibrary.org/works/OL45804W';
    expect(parseOpenLibraryRatings(JSON.parse(fixture('openlibrary-ratings.json')), url)).toEqual({
      status: 'ok',
      url,
      rating: 3.95,
      count: 121,
      error: null,
    });
    expect(parseOpenLibraryRatings({ summary: { count: 0 } }, url)).toMatchObject({ status: 'no_rating', url });
    expect(parseOpenLibraryRatings({ nope: true }, url)).toMatchObject({ status: 'error', error: 'layout' });
    expect(openLibraryWorkKey(JSON.parse(fixture('openlibrary-edition.json')))).toBe('OL45804W');
    expect(openLibraryWorkKey({ works: [{ key: '/authors/OL1A' }] })).toBeNull();
  });

  it('reads a Google Books volume and keeps only a Google link', () => {
    const volume = JSON.parse(fixture('google-volumes.json')).items[0];
    expect(parseGoogleVolume(volume)).toEqual({
      status: 'ok',
      url: 'https://books.google.com/books/about/Fantastic_Mr_Fox.html?hl=&id=wrOQLV6xB-wC',
      rating: 4,
      count: 127,
      error: null,
    });
    const elsewhere = { id: 'wrOQLV6xB-wC', volumeInfo: { canonicalVolumeLink: 'https://evil.example/x', infoLink: 'javascript:alert(1)' } };
    expect(parseGoogleVolume(elsewhere)).toMatchObject({ status: 'no_rating', url: 'https://books.google.com/books?id=wrOQLV6xB-wC' });
  });

  it('rejects scores outside the scale and negative counts', () => {
    const douban = fixture('douban-subject.html');
    expect(parseDoubanPage(douban.replace('> 9.3 <', '> 11.2 <'), DOUBAN_SUBJECT)).toMatchObject({ status: 'error', error: 'invalid_value' });
    const goodreads = fixture('goodreads-book.html');
    expect(parseGoodreadsPage(goodreads.replace('"ratingValue":4.08', '"ratingValue":6'), GOODREADS_DAHL)).toMatchObject({
      status: 'error',
      error: 'invalid_value',
    });
    expect(parseGoodreadsPage(goodreads.replace('"ratingCount":153507', '"ratingCount":-4'), GOODREADS_DAHL)).toMatchObject({
      status: 'error',
      error: 'invalid_value',
    });
    expect(parseOpenLibraryRatings({ summary: { average: 3, count: -3 } }, 'u')).toMatchObject({ status: 'error' });
    expect(parseOpenLibraryRatings({ summary: { average: 'NaN', count: 3 } }, 'u')).toMatchObject({ status: 'error' });
    expect(parseGoogleVolume({ id: 'wrOQLV6xB-wC', volumeInfo: { averageRating: -1, ratingsCount: 3 } })).toMatchObject({
      status: 'error',
      error: 'invalid_value',
    });
  });

  it('converts a 978 ISBN-13 to its ISBN-10', () => {
    expect(toIsbn10(DAHL_ISBN)).toBe('0140328726');
    expect(toIsbn10('9791234567896')).toBeNull();
  });
});

describe('rating fetchers', () => {
  it('follows the Douban ISBN redirect to the subject page and the Goodreads one to the book page', async () => {
    const { transport, seen } = stubTransport(realisticRoutes());
    const fetcher = quickFetcher(transport);
    expect(await fetcher.fetch('douban', keysFor(CHINESE_ISBN))).toMatchObject({
      status: 'ok',
      url: DOUBAN_SUBJECT,
      rating: 9.3,
      count: 209,
    });
    expect(await fetcher.fetch('goodreads', keysFor(CHINESE_ISBN))).toMatchObject({
      status: 'no_rating',
      url: 'https://www.goodreads.com/book/show/99329011',
    });
    expect(await fetcher.fetch('goodreads', keysFor(DAHL_ISBN))).toMatchObject({ status: 'ok', rating: 4.08, url: GOODREADS_DAHL });
    expect(seen).toContain(DOUBAN_SUBJECT);
  });

  it('prefers a Douban subject id over the ISBN', async () => {
    const { transport, seen } = stubTransport(realisticRoutes());
    const result = await quickFetcher(transport).fetch('douban', { ...keysFor(CHINESE_ISBN), douban: '25869109' });
    expect(result).toMatchObject({ status: 'ok', rating: 9.3 });
    expect(seen).toEqual([DOUBAN_SUBJECT]);
  });

  it('resolves the Open Library work through the ISBN redirect, or uses a work OLID directly', async () => {
    const { transport, seen } = stubTransport(realisticRoutes());
    const fetcher = quickFetcher(transport);
    expect(await fetcher.fetch('open_library', keysFor(DAHL_ISBN))).toEqual({
      status: 'ok',
      url: 'https://openlibrary.org/works/OL45804W',
      rating: 3.95,
      count: 121,
      error: null,
    });
    seen.length = 0;
    await fetcher.fetch('open_library', { isbns: [], douban: null, olids: ['OL45804W'], googleBooks: null });
    expect(seen).toEqual(['https://openlibrary.org/works/OL45804W/ratings.json']);
    expect(await fetcher.fetch('open_library', keysFor(CHINESE_ISBN))).toMatchObject({ status: 'not_found', url: null });
  });

  it('asks Google Books by ISBN with the saved key and reports an exhausted quota as a backoff', async () => {
    const routes = realisticRoutes();
    routes[`https://www.googleapis.com/books/v1/volumes?q=isbn%3A${DAHL_ISBN}&maxResults=1&key=secret-key`] = () =>
      json(JSON.parse(fixture('google-volumes.json')));
    const { transport } = stubTransport(routes);
    const keyed = quickFetcher(transport, { googleBooksApiKey: () => 'secret-key' });
    const result = await keyed.fetch('google_books', keysFor(DAHL_ISBN));
    expect(result).toMatchObject({ status: 'ok', rating: 4, count: 127 });
    expect(result.url).not.toContain('secret-key');

    const limited = stubTransport({
      [`https://www.googleapis.com/books/v1/volumes?q=isbn%3A${DAHL_ISBN}&maxResults=1`]: () => new Response('{}', { status: 429 }),
    });
    expect(await quickFetcher(limited.transport).fetch('google_books', keysFor(DAHL_ISBN))).toMatchObject({
      status: 'error',
      error: 'rate_limited',
      backoff: true,
    });
  });

  it('refuses a redirect to a private host and treats an anti-bot page as a refusal', async () => {
    const { transport } = stubTransport(
      {
        [`https://book.douban.com/isbn/${CHINESE_ISBN}/`]: () => redirect('https://intranet-proxy.example/subject/1/'),
        [`https://www.goodreads.com/book/isbn/${CHINESE_ISBN}`]: () => redirect('http://127.0.0.1/book/show/1'),
      },
      { 'intranet-proxy.example': ['10.0.0.8'] },
    );
    const fetcher = quickFetcher(transport);
    expect(await fetcher.fetch('douban', keysFor(CHINESE_ISBN))).toMatchObject({ status: 'error', error: 'redirect_rejected' });
    expect(await fetcher.fetch('goodreads', keysFor(CHINESE_ISBN))).toMatchObject({ status: 'error', error: 'redirect_rejected' });

    const blocked = stubTransport({
      [`https://book.douban.com/isbn/${CHINESE_ISBN}/`]: () => redirect('https://sec.douban.com/b?r=x'),
      'https://sec.douban.com/b?r=x': () => html('<html>验证</html>'),
    });
    expect(await quickFetcher(blocked.transport).fetch('douban', keysFor(CHINESE_ISBN))).toMatchObject({
      status: 'error',
      error: 'blocked',
      backoff: true,
    });
  });

  it('tries the ISBN-10 on Goodreads when the ISBN-13 is not found', async () => {
    const { transport, seen } = stubTransport({
      'https://www.goodreads.com/book/isbn/0140328726': () => redirect(GOODREADS_DAHL),
      [GOODREADS_DAHL]: () => html(fixture('goodreads-book.html')),
    });
    expect(await quickFetcher(transport).fetch('goodreads', keysFor(DAHL_ISBN))).toMatchObject({ status: 'ok', rating: 4.08 });
    expect(seen[0]).toBe(`https://www.goodreads.com/book/isbn/${DAHL_ISBN}`);
  });

  it('never reaches the network under Vitest without a stub', async () => {
    const result = await new RatingsFetcher({ hostIntervalMs: 0 }).fetch('goodreads', keysFor(DAHL_ISBN));
    expect(result).toMatchObject({ status: 'error', error: 'network' });
  });
});

describe('throttle and backoff', () => {
  it('spaces requests to one host, redirect hops included, but not across hosts', async () => {
    let clock = 1_000_000;
    const sleeps: Array<{ ms: number; at: number }> = [];
    const { transport } = stubTransport(realisticRoutes());
    const fetcher = new RatingsFetcher({
      transport,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push({ ms, at: clock });
        clock += ms;
      },
    });
    await fetcher.fetch('douban', keysFor(CHINESE_ISBN));
    // The ISBN page and the subject page it redirects to share book.douban.com.
    expect(sleeps).toEqual([{ ms: RATINGS_HOST_INTERVAL_MS, at: 1_000_000 }]);
    await fetcher.fetch('goodreads', keysFor(DAHL_ISBN));
    expect(sleeps.map((sleep) => sleep.ms)).toEqual([RATINGS_HOST_INTERVAL_MS, RATINGS_HOST_INTERVAL_MS]);
  });

  it('backs off a provider for six hours after a 403, 418, or 429', async () => {
    for (const status of [403, 418, 429]) {
      let clock = 5_000_000;
      const { transport } = stubTransport({ [`https://www.goodreads.com/book/isbn/${DAHL_ISBN}`]: () => new Response('', { status }) });
      const fetcher = new RatingsFetcher({ transport, hostIntervalMs: 0, now: () => clock });
      expect(await fetcher.fetch('goodreads', keysFor(DAHL_ISBN))).toMatchObject({ status: 'error', backoff: true });
      expect(fetcher.backoffUntil('goodreads')).toBe(5_000_000 + RATINGS_BACKOFF_MS);
      expect(fetcher.backoffUntil('douban')).toBeNull();
      clock += RATINGS_BACKOFF_MS;
      expect(fetcher.backoffUntil('goodreads')).toBeNull();
    }
  });
});

function scratchDb(): { db: AppDatabase; sqlite: Database.Database } {
  const temp = makeTempDir();
  const databasePath = path.join(temp.dir, 'qijuan.sqlite');
  migrate({ databasePath, migrationsDir: defaultMigrationsDir() });
  const opened = openDatabase(databasePath);
  cleanups.push(() => {
    opened.sqlite.close();
    temp.cleanup();
  });
  const now = '2026-01-01T00:00:00.000Z';
  opened.sqlite.prepare("INSERT INTO libraries (id, name, mode, root_path, created_at) VALUES (1, 'Home', 'managed', '/x', ?)").run(now);
  return { db: opened.db, sqlite: opened.sqlite };
}

function addEdition(sqlite: Database.Database, id: number, identifiers: Array<[string, string]>): void {
  const now = '2026-01-01T00:00:00.000Z';
  sqlite.prepare("INSERT INTO editions (id, library_id, title, sort_title, created_at, updated_at) VALUES (?, 1, 'T', 'T', ?, ?)").run(id, now, now);
  for (const [scheme, value] of identifiers) {
    sqlite.prepare("INSERT INTO edition_identifiers (edition_id, scheme, value, source, created_at) VALUES (?, ?, ?, 'manual', ?)").run(id, scheme, value, now);
  }
}

function queueRows(sqlite: Database.Database) {
  return sqlite.prepare('SELECT edition_id AS editionId, not_before AS notBefore FROM edition_ratings_queue ORDER BY edition_id').all();
}

describe('ratings queue', () => {
  it('fetches every provider of a queued edition and stores each with its own scale', async () => {
    const { db, sqlite } = scratchDb();
    addEdition(sqlite, 7, [['isbn', DAHL_ISBN]]);
    expect(queueRows(sqlite)).toEqual([{ editionId: 7, notBefore: null }]);
    const { transport } = stubTransport(realisticRoutes());
    expect(await runNextRatingsJob(() => db, quickFetcher(transport))).toBe(7);
    expect(queueRows(sqlite)).toEqual([]);
    const rows = sqlite
      .prepare('SELECT provider, rating, scale, count, status FROM edition_ratings WHERE edition_id = 7 ORDER BY provider')
      .all();
    expect(rows).toEqual([
      { provider: 'douban', rating: null, scale: 10, count: null, status: 'not_found' },
      { provider: 'goodreads', rating: 4.08, scale: 5, count: 153507, status: 'ok' },
      { provider: 'google_books', rating: 4, scale: 5, count: 127, status: 'ok' },
      { provider: 'open_library', rating: 3.95, scale: 5, count: 121, status: 'ok' },
    ]);
    expect(await runNextRatingsJob(() => db, quickFetcher(transport))).toBeNull();
  });

  it('defers an edition while a provider backs off, keeps an existing score, and asks only that provider again', async () => {
    const { db, sqlite } = scratchDb();
    addEdition(sqlite, 3, [['isbn', DAHL_ISBN]]);
    const routes = realisticRoutes();
    const { transport } = stubTransport(routes);
    let clock = Date.parse('2026-03-01T00:00:00.000Z');
    const now = () => new Date(clock);
    const first = new RatingsFetcher({ transport, hostIntervalMs: 0, now: () => clock });
    await runNextRatingsJob(() => db, first, now);

    // Refresh; Goodreads now refuses.
    clock += 60_000;
    enqueueRatings(db, 3, now());
    routes[`https://www.goodreads.com/book/isbn/${DAHL_ISBN}`] = () => new Response('', { status: 429 });
    const second = new RatingsFetcher({ transport, hostIntervalMs: 0, now: () => clock });
    await runNextRatingsJob(() => db, second, now);
    const goodreads = () =>
      sqlite.prepare("SELECT rating, status FROM edition_ratings WHERE edition_id = 3 AND provider = 'goodreads'").get();
    expect(goodreads()).toEqual({ rating: 4.08, status: 'ok' });
    expect(queueRows(sqlite)).toEqual([{ editionId: 3, notBefore: new Date(clock + RATINGS_BACKOFF_MS).toISOString() }]);
    // A deferred edition is not shown as pending.
    expect(ratingsQueued(db, 3, now())).toBe(false);
    expect(ratingsQueued(db, 3, new Date(clock + RATINGS_BACKOFF_MS))).toBe(true);
    // Not due yet.
    expect(await runNextRatingsJob(() => db, second, now)).toBeNull();

    clock += RATINGS_BACKOFF_MS;
    routes[`https://www.goodreads.com/book/isbn/${DAHL_ISBN}`] = () => redirect(GOODREADS_DAHL);
    const asked: string[] = [];
    const counting = stubTransport(routes);
    const watched: WebTransport = {
      lookup: counting.transport.lookup,
      async fetch(input, init) {
        asked.push(new URL(String(input instanceof URL ? input.href : input)).hostname);
        return counting.transport.fetch!(input, init);
      },
    };
    await runNextRatingsJob(() => db, new RatingsFetcher({ transport: watched, hostIntervalMs: 0, now: () => clock }), now);
    expect(new Set(asked)).toEqual(new Set(['www.goodreads.com']));
    expect(queueRows(sqlite)).toEqual([]);
    expect(goodreads()).toEqual({ rating: 4.08, status: 'ok' });
  });

  it('drops queued editions that are trashed or gone, and providers the edition can no longer be looked up on', async () => {
    const { db, sqlite } = scratchDb();
    addEdition(sqlite, 4, [['isbn', DAHL_ISBN]]);
    sqlite.prepare("UPDATE editions SET trashed_at = '2026-02-01T00:00:00.000Z' WHERE id = 4").run();
    const { transport, seen } = stubTransport(realisticRoutes());
    expect(await runNextRatingsJob(() => db, quickFetcher(transport))).toBe(4);
    expect(seen).toEqual([]);
    sqlite.prepare("INSERT INTO edition_ratings_queue (edition_id, queued_at) VALUES (99, '2026-01-01T00:00:00.000Z')").run();
    expect(await runNextRatingsJob(() => db, quickFetcher(transport))).toBe(99);
    expect(queueRows(sqlite)).toEqual([]);

    addEdition(sqlite, 5, [['olid', 'OL45804W']]);
    sqlite
      .prepare("INSERT INTO edition_ratings VALUES (5, 'goodreads', 'https://www.goodreads.com/book/show/1', 4, 5, 3, 'ok', NULL, '2026-01-01T00:00:00.000Z')")
      .run();
    await runNextRatingsJob(() => db, quickFetcher(transport));
    expect(sqlite.prepare('SELECT provider, status FROM edition_ratings WHERE edition_id = 5').all()).toEqual([
      { provider: 'open_library', status: 'ok' },
    ]);
  });

  it('queues a page view only when ratings are missing, older than 30 days, or a day-old error', () => {
    const { db, sqlite } = scratchDb();
    addEdition(sqlite, 8, [['isbn', CHINESE_ISBN]]);
    addEdition(sqlite, 9, [['uuid', 'urn:uuid:nothing']]);
    sqlite.prepare('DELETE FROM edition_ratings_queue').run();
    const now = new Date('2026-06-01T00:00:00.000Z');
    expect(ensureRatingsFresh(db, 9, now)).toBe(false);
    expect(ensureRatingsFresh(db, 8, now)).toBe(true);
    sqlite.prepare('DELETE FROM edition_ratings_queue').run();

    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    const insert = sqlite.prepare('INSERT OR REPLACE INTO edition_ratings VALUES (8, ?, NULL, NULL, ?, NULL, ?, NULL, ?)');
    for (const provider of ['douban', 'goodreads', 'open_library', 'google_books']) {
      insert.run(provider, provider === 'douban' ? 10 : 5, 'no_rating', daysAgo(29));
    }
    expect(ensureRatingsFresh(db, 8, now)).toBe(false);
    insert.run('goodreads', 5, 'error', daysAgo(0.5));
    expect(ensureRatingsFresh(db, 8, now)).toBe(false);
    insert.run('goodreads', 5, 'error', daysAgo(2));
    expect(ensureRatingsFresh(db, 8, now)).toBe(true);
    sqlite.prepare('DELETE FROM edition_ratings_queue').run();
    insert.run('goodreads', 5, 'no_rating', daysAgo(31));
    expect(ensureRatingsFresh(db, 8, now)).toBe(true);
    expect(queueRows(sqlite)).toEqual([{ editionId: 8, notBefore: null }]);

    // A page view keeps a deferred edition's place; an explicit refresh clears the deferral.
    sqlite.prepare("UPDATE edition_ratings_queue SET not_before = '2026-06-01T06:00:00.000Z'").run();
    ensureRatingsFresh(db, 8, now);
    expect(queueRows(sqlite)).toEqual([{ editionId: 8, notBefore: '2026-06-01T06:00:00.000Z' }]);
    enqueueRatings(db, 8, now);
    expect(queueRows(sqlite)).toEqual([{ editionId: 8, notBefore: null }]);
  });

  it('reads lookup keys from the identifiers', () => {
    const { db, sqlite } = scratchDb();
    addEdition(sqlite, 2, [
      ['isbn', CHINESE_ISBN],
      ['douban', '25869109'],
      ['olid', 'OL7353617M'],
      ['google_books', 'wrOQLV6xB-wC'],
      ['isbn', 'not-an-isbn'],
    ]);
    expect(loadRatingKeys(db, 2)).toEqual({
      isbns: [CHINESE_ISBN],
      douban: '25869109',
      olids: ['OL7353617M'],
      googleBooks: 'wrOQLV6xB-wC',
    });
  });

  it('shows readers scores and links only, in provider order, and admins every row', () => {
    const { db, sqlite } = scratchDb();
    addEdition(sqlite, 6, [['isbn', CHINESE_ISBN]]);
    const at = '2026-02-01T00:00:00.000Z';
    const insert = sqlite.prepare('INSERT INTO edition_ratings VALUES (6, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('google_books', null, null, 5, null, 'error', 'rate_limited', at);
    insert.run('open_library', null, null, 5, null, 'not_found', null, at);
    insert.run('goodreads', 'https://www.goodreads.com/book/show/99329011', null, 5, null, 'no_rating', null, at);
    insert.run('douban', DOUBAN_SUBJECT, 9.3, 10, 209, 'ok', null, at);
    expect(presentRatings(db, 6, false)).toEqual([
      { provider: 'douban', url: DOUBAN_SUBJECT, rating: 9.3, scale: 10, count: 209, fetchedAt: at },
      { provider: 'goodreads', url: 'https://www.goodreads.com/book/show/99329011', rating: null, scale: 5, count: null, fetchedAt: at },
    ]);
    const admin = presentRatings(db, 6, true);
    expect(admin.map((row) => row.provider)).toEqual(['douban', 'goodreads', 'open_library', 'google_books']);
    expect(admin[3]).toMatchObject({ status: 'error', error: 'rate_limited' });
  });
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
  const app = await buildApp({
    config,
    clientDist: null,
    logger: false,
    openLibrary: {
      fetch: async () => {
        throw new Error('network disabled in test');
      },
    },
    ratings: { worker: false },
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
  const admin = cookieFrom(setup);
  const libraryId = setup.json().library.id as number;
  const created = await app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin }, payload: { username: 'bea', password } });
  expect(created.statusCode).toBe(201);
  const granted = await app.inject({
    method: 'POST',
    url: `/api/libraries/${libraryId}/grants`,
    headers: { cookie: admin },
    payload: { userId: created.json().user.id },
  });
  expect(granted.statusCode).toBe(201);
  const login = await app.inject({ method: 'POST', url: '/api/session/login', payload: { username: 'bea', password } });
  expect(login.statusCode).toBe(200);

  const sqlite = new Database(config.databasePath);
  cleanups.unshift(() => sqlite.close());
  const now = '2026-01-01T00:00:00.000Z';
  sqlite
    .prepare("INSERT INTO editions (id, library_id, title, sort_title, created_at, updated_at) VALUES (1, ?, 'Book', 'Book', ?, ?)")
    .run(libraryId, now, now);
  return { app, admin, reader: cookieFrom(login), sqlite };
}

describe('ratings routes', () => {
  it('returns ratings to readers and admins, filtered for readers', async () => {
    const { app, admin, reader, sqlite } = await startApp();
    const at = new Date().toISOString();
    const insert = sqlite.prepare('INSERT INTO edition_ratings VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('douban', DOUBAN_SUBJECT, 9.3, 10, 209, 'ok', null, at);
    insert.run('google_books', null, null, 5, null, 'error', 'rate_limited', at);

    const asReader = await app.inject({ method: 'GET', url: '/api/editions/1', headers: { cookie: reader } });
    expect(asReader.statusCode).toBe(200);
    expect(asReader.json().edition.ratings).toEqual([
      { provider: 'douban', url: DOUBAN_SUBJECT, rating: 9.3, scale: 10, count: 209, fetchedAt: at },
    ]);
    expect(JSON.stringify(asReader.json())).not.toContain('rate_limited');
    const asAdmin = await app.inject({ method: 'GET', url: '/api/editions/1', headers: { cookie: admin } });
    expect(asAdmin.json().edition.ratings).toHaveLength(2);
    expect(asAdmin.json().edition.ratings[1]).toMatchObject({ provider: 'google_books', status: 'error', error: 'rate_limited' });
  });

  it('queues a fetch when a page with missing ratings is viewed, and never waits for it', async () => {
    const { app, reader, sqlite } = await startApp();
    sqlite.prepare("INSERT INTO edition_identifiers (edition_id, scheme, value, source, created_at) VALUES (1, 'isbn', ?, 'manual', ?)").run(
      CHINESE_ISBN,
      new Date().toISOString(),
    );
    sqlite.prepare('DELETE FROM edition_ratings_queue').run();
    const viewed = await app.inject({ method: 'GET', url: '/api/editions/1', headers: { cookie: reader } });
    expect(viewed.statusCode).toBe(200);
    expect(viewed.json().edition).toMatchObject({ ratings: [], ratingsPending: true });
    expect(queueRows(sqlite)).toEqual([{ editionId: 1, notBefore: null }]);
  });

  it('queues a fetch when an admin edits the identifiers', async () => {
    const { app, admin, sqlite } = await startApp();
    expect(queueRows(sqlite)).toEqual([]);
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/editions/1',
      headers: { cookie: admin },
      payload: { identifiers: [{ scheme: 'isbn', value: DAHL_ISBN }] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().edition.ratingsPending).toBe(true);
    expect(queueRows(sqlite)).toEqual([{ editionId: 1, notBefore: null }]);
  });

  it('lets only admins force a refresh', async () => {
    const { app, admin, reader, sqlite } = await startApp();
    const refused = await app.inject({ method: 'POST', url: '/api/editions/1/ratings/refresh', headers: { cookie: reader } });
    expect(refused.statusCode).toBe(403);
    expect(queueRows(sqlite)).toEqual([]);
    const accepted = await app.inject({ method: 'POST', url: '/api/editions/1/ratings/refresh', headers: { cookie: admin } });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().edition.ratingsPending).toBe(true);
    expect(queueRows(sqlite)).toEqual([{ editionId: 1, notBefore: null }]);
    const missing = await app.inject({ method: 'POST', url: '/api/editions/404/ratings/refresh', headers: { cookie: admin } });
    expect(missing.statusCode).toBe(404);
  });
});
