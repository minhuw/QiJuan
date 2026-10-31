import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import type { AppDatabase } from './db.js';
import { toIsbn13 } from './identifiers.js';
import type { WebTransport } from './metadata/assistant/client.js';
import { GOOGLE_BOOKS_ORIGIN } from './metadata/assistant/web-tools.js';
import { OPEN_LIBRARY_ORIGIN } from './metadata/openLibrary.js';
import { type SafeFetchResult, safeGet } from './metadata/safe-fetch.js';
import { editionIdentifiers, editionRatings, editionRatingsQueue, editions } from './schema.js';
import { holder } from './work-gate.js';

/**
 * External ratings read from public pages and APIs. Each provider keeps its own scale (Douban out
 * of 10, the rest out of 5); values are never normalized or averaged across providers. Every
 * request goes through `safeGet`, at most one edition is fetched at a time, requests to one host
 * are spaced out, and a provider that answers 403, 418, or 429 is left alone for a while.
 */

export const RATING_PROVIDERS = ['douban', 'goodreads', 'open_library', 'google_books'] as const;
export type RatingProvider = (typeof RATING_PROVIDERS)[number];
export type RatingStatus = 'ok' | 'no_rating' | 'not_found' | 'error';

export const RATING_SCALES: Record<RatingProvider, number> = {
  douban: 10,
  goodreads: 5,
  open_library: 5,
  google_books: 5,
};

/** Ratings older than this are fetched again when the book page is viewed. */
export const RATINGS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A failed fetch is retried sooner, on a page view at least a day later. */
export const RATINGS_ERROR_RETRY_MS = 24 * 60 * 60 * 1000;
/** The least time between two requests to the same host, redirect hops included. */
export const RATINGS_HOST_INTERVAL_MS = 1500;
/** How long a provider is skipped after it answers 403, 418, or 429. */
export const RATINGS_BACKOFF_MS = 6 * 60 * 60 * 1000;
const RATINGS_POLL_MS = 1000;

const DOUBAN_ORIGIN = 'https://book.douban.com';
const GOODREADS_ORIGIN = 'https://www.goodreads.com';
/** Pages are cut here; the scores sit near the top of both. */
const PAGE_BYTES = 1024 * 1024;
const JSON_BYTES = 1024 * 1024;
/** At most this many ISBNs of one edition are tried per provider. */
const ISBN_ATTEMPTS = 2;
const URL_MAX = 2000;

/** What one provider said about one edition. */
export interface ProviderOutcome {
  status: RatingStatus;
  url: string | null;
  rating: number | null;
  count: number | null;
  error: string | null;
  /** The provider refused us (403, 418, 429, or an anti-bot page); back off. */
  backoff?: boolean;
}

/** The identifiers ratings are looked up by. ISBNs are ISBN-13, in the edition's order. */
export interface RatingKeys {
  isbns: string[];
  douban: string | null;
  olids: string[];
  googleBooks: string | null;
}

// --- parsers ----------------------------------------------------------------------

/** A Douban subject page. Below about ten votes Douban shows no score; that is `no_rating`. */
export function parseDoubanPage(html: string, url: string): ProviderOutcome {
  const average = /property=["']v:average["'][^>]*>([^<]*)</.exec(html);
  const votes = /property=["']v:votes["'][^>]*>\s*([\d,]+)\s*</.exec(html);
  const text = average?.[1]?.trim() ?? '';
  if (!average) {
    // A subject page without the rating block at all is a layout change, unless it says why.
    if (/评价人数不足|目前无人评价|尚未上映|rating_wrap/.test(html)) return outcome('no_rating', url);
    return failed('layout', url);
  }
  if (text === '') return outcome('no_rating', url);
  const rating = readRating(text, RATING_SCALES.douban);
  if (rating === undefined) return failed('invalid_value', url);
  const count = votes?.[1] ? readCount(votes[1].replace(/,/g, '')) : null;
  if (count === undefined) return failed('invalid_value', url);
  if (count === 0) return outcome('no_rating', url);
  return { status: 'ok', url, rating, count, error: null };
}

/** A Goodreads book page: the schema.org Book in its JSON-LD carries aggregateRating. */
export function parseGoodreadsPage(html: string, url: string): ProviderOutcome {
  const book = findJsonLdBook(html);
  if (!book) return failed('layout', url);
  const aggregate = asRecord(book.aggregateRating);
  if (!aggregate) return outcome('no_rating', url);
  const count = aggregate.ratingCount === undefined ? null : readCount(aggregate.ratingCount);
  if (count === undefined) return failed('invalid_value', url);
  if (count === 0) return outcome('no_rating', url);
  if (aggregate.ratingValue === undefined || aggregate.ratingValue === null || aggregate.ratingValue === '') {
    return outcome('no_rating', url);
  }
  const rating = readRating(aggregate.ratingValue, RATING_SCALES.goodreads);
  if (rating === undefined) return failed('invalid_value', url);
  return { status: 'ok', url, rating, count, error: null };
}

/** Open Library's `/works/<id>/ratings.json`. */
export function parseOpenLibraryRatings(body: unknown, url: string): ProviderOutcome {
  const summary = asRecord(asRecord(body)?.summary);
  if (!summary) return failed('layout', url);
  const count = summary.count === undefined || summary.count === null ? 0 : readCount(summary.count);
  if (count === undefined) return failed('invalid_value', url);
  if (count === 0 || summary.average === null || summary.average === undefined) return outcome('no_rating', url);
  const rating = readRating(summary.average, RATING_SCALES.open_library);
  if (rating === undefined) return failed('invalid_value', url);
  return { status: 'ok', url, rating, count, error: null };
}

/** The work key (`OL…W`) of an Open Library edition record. */
export function openLibraryWorkKey(body: unknown): string | null {
  const works = asRecord(body)?.works;
  if (!Array.isArray(works)) return null;
  const key = asRecord(works[0])?.key;
  if (typeof key !== 'string') return null;
  const match = /^\/works\/(OL[1-9]\d{0,11}W)$/.exec(key);
  return match?.[1] ?? null;
}

/** One Google Books volume: volumeInfo.averageRating and ratingsCount, out of 5. */
export function parseGoogleVolume(item: unknown): ProviderOutcome {
  const volume = asRecord(item);
  const info = asRecord(volume?.volumeInfo);
  const id = typeof volume?.id === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(volume.id) ? volume.id : null;
  if (!volume || !info || !id) return failed('layout', null);
  const url =
    pageUrl(info.canonicalVolumeLink, /(^|\.)google\.[a-z.]+$/) ??
    pageUrl(info.infoLink, /(^|\.)google\.[a-z.]+$/) ??
    `https://books.google.com/books?id=${encodeURIComponent(id)}`;
  if (info.averageRating === undefined || info.averageRating === null) return outcome('no_rating', url);
  const rating = readRating(info.averageRating, RATING_SCALES.google_books);
  const count = info.ratingsCount === undefined ? null : readCount(info.ratingsCount);
  if (rating === undefined || count === undefined) return failed('invalid_value', url);
  if (count === 0) return outcome('no_rating', url);
  return { status: 'ok', url, rating, count, error: null };
}

function findJsonLdBook(html: string): Record<string, unknown> | null {
  const scripts = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script[1] ?? '');
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed, ...(asArray(asRecord(parsed)?.['@graph']))];
    for (const candidate of candidates) {
      const record = asRecord(candidate);
      const type = record?.['@type'];
      if (record && (type === 'Book' || (Array.isArray(type) && type.includes('Book')))) return record;
    }
  }
  return null;
}

/** A score within 0..scale, rounded to two decimals; `undefined` when invalid. */
export function readRating(value: unknown, scale: number): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0 || number > scale) return undefined;
  return Math.round(number * 100) / 100;
}

/** A non-negative whole count; `undefined` when invalid. */
export function readCount(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) return undefined;
  return number;
}

// --- fetching --------------------------------------------------------------------

export interface RatingsFetcherOptions {
  /** Tests pass a stub `fetch` and `lookup`. Without a stub, Vitest never reaches the network. */
  transport?: WebTransport;
  /** The saved Google Books API key, read for each request. */
  googleBooksApiKey?: () => string | null;
  openLibraryOrigin?: string;
  hostIntervalMs?: number;
  backoffMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Fetches ratings one provider at a time. Every request, redirect hops included, waits for its
 * host's slot; a provider that refuses us is skipped until its backoff ends.
 */
export class RatingsFetcher {
  private readonly nextSlot = new Map<string, number>();
  private readonly backoff = new Map<RatingProvider, number>();
  private readonly transport: WebTransport;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly hostIntervalMs: number;
  private readonly backoffMs: number;
  private readonly googleKey: () => string | null;
  private readonly openLibraryOrigin: string;

  constructor(options: RatingsFetcherOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.hostIntervalMs = options.hostIntervalMs ?? RATINGS_HOST_INTERVAL_MS;
    this.backoffMs = options.backoffMs ?? RATINGS_BACKOFF_MS;
    this.googleKey = options.googleBooksApiKey ?? (() => null);
    this.openLibraryOrigin = options.openLibraryOrigin ?? OPEN_LIBRARY_ORIGIN;
    const base = options.transport?.fetch ?? (process.env.VITEST ? undefined : globalThis.fetch);
    this.transport = {
      lookup: options.transport?.lookup,
      // Left undefined under Vitest without a stub, so safeGet refuses instead of going online.
      fetch: base
        ? async (input, init) => {
            const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
            await this.waitForHost(url.hostname);
            return base(input, init);
          }
        : undefined,
    };
  }

  /** When the provider may be asked again, or null when it is not backing off. */
  backoffUntil(provider: RatingProvider): number | null {
    const until = this.backoff.get(provider);
    if (until === undefined) return null;
    if (until <= this.now()) {
      this.backoff.delete(provider);
      return null;
    }
    return until;
  }

  async fetch(provider: RatingProvider, keys: RatingKeys): Promise<ProviderOutcome> {
    let result: ProviderOutcome;
    try {
      result = await this.fetchProvider(provider, keys);
    } catch {
      result = failed('internal', null);
    }
    if (result.backoff) this.backoff.set(provider, this.now() + this.backoffMs);
    return result;
  }

  private async waitForHost(host: string): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    // Reserve the slot before waiting, so a concurrent caller queues behind it.
    this.nextSlot.set(host, slot + this.hostIntervalMs);
    if (slot > now) await this.sleep(slot - now);
  }

  private fetchProvider(provider: RatingProvider, keys: RatingKeys): Promise<ProviderOutcome> {
    switch (provider) {
      case 'douban':
        return this.douban(keys);
      case 'goodreads':
        return this.goodreads(keys);
      case 'open_library':
        return this.openLibrary(keys);
      case 'google_books':
        return this.googleBooks(keys);
    }
  }

  private async douban(keys: RatingKeys): Promise<ProviderOutcome> {
    const targets = keys.douban
      ? [`${DOUBAN_ORIGIN}/subject/${encodeURIComponent(keys.douban)}/`]
      : keys.isbns.slice(0, ISBN_ATTEMPTS).map((isbn) => `${DOUBAN_ORIGIN}/isbn/${isbn}/`);
    return firstFound(targets, async (target) => {
      const reply = await this.page(target);
      if (!reply.ok) return fetchFailure(reply);
      const url = reply.url;
      const subject = /^\/subject\/(\d{1,12})\/?$/.exec(url.pathname);
      if (url.hostname === 'book.douban.com' && subject) {
        return parseDoubanPage(text(reply), `${DOUBAN_ORIGIN}/subject/${subject[1]}/`);
      }
      // Douban sends suspected bots to sec.douban.com or a "sorry" page.
      if (url.hostname !== 'book.douban.com' || /sorry|misc/.test(url.pathname)) return { ...failed('blocked', null), backoff: true };
      return outcome('not_found', null);
    });
  }

  private async goodreads(keys: RatingKeys): Promise<ProviderOutcome> {
    const isbns = keys.isbns.slice(0, ISBN_ATTEMPTS);
    const targets = isbns.map((isbn) => `${GOODREADS_ORIGIN}/book/isbn/${isbn}`);
    // Older Goodreads records are sometimes indexed under the ISBN-10 only.
    const first = isbns[0];
    const isbn10 = first ? toIsbn10(first) : null;
    if (isbn10) targets.push(`${GOODREADS_ORIGIN}/book/isbn/${isbn10}`);
    return firstFound(targets, async (target) => {
      const reply = await this.page(target);
      if (!reply.ok) return fetchFailure(reply);
      const url = reply.url;
      const show = /^\/book\/show\/[^/]{1,200}$/.exec(url.pathname);
      if (url.hostname === 'www.goodreads.com' && show) {
        return parseGoodreadsPage(text(reply), `${GOODREADS_ORIGIN}${url.pathname}`);
      }
      return outcome('not_found', null);
    });
  }

  private async openLibrary(keys: RatingKeys): Promise<ProviderOutcome> {
    const origin = this.openLibraryOrigin;
    let workKey = keys.olids.find((olid) => olid.endsWith('W')) ?? null;
    if (!workKey) {
      // An edition record (by OLID, then by ISBN, which redirects to it) names its work.
      const editionPaths = [
        ...keys.olids.filter((olid) => olid.endsWith('M')).map((olid) => `/books/${olid}.json`),
        ...keys.isbns.slice(0, ISBN_ATTEMPTS).map((isbn) => `/isbn/${isbn}.json`),
      ];
      let miss: ProviderOutcome = outcome('not_found', null);
      for (const path of editionPaths) {
        const reply = await this.json(new URL(path, origin).href);
        if (!reply.ok) {
          miss = fetchFailure(reply);
          if (miss.status !== 'not_found') return miss;
          continue;
        }
        workKey = openLibraryWorkKey(parseJson(reply));
        if (workKey) break;
      }
      if (!workKey) return miss;
    }
    const pageUrl = `${OPEN_LIBRARY_ORIGIN}/works/${workKey}`;
    const reply = await this.json(new URL(`/works/${workKey}/ratings.json`, origin).href);
    if (!reply.ok) {
      const failure = fetchFailure(reply);
      // The work exists even when its ratings endpoint is missing; keep the link.
      return failure.status === 'not_found' ? outcome('no_rating', pageUrl) : failure;
    }
    return parseOpenLibraryRatings(parseJson(reply), pageUrl);
  }

  private async googleBooks(keys: RatingKeys): Promise<ProviderOutcome> {
    const key = this.googleKey();
    const build = (path: string, query: Record<string, string>) => {
      const url = new URL(path, GOOGLE_BOOKS_ORIGIN);
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
      if (key) url.searchParams.set('key', key);
      return url.href;
    };
    if (keys.googleBooks) {
      const reply = await this.json(build(`/books/v1/volumes/${encodeURIComponent(keys.googleBooks)}`, {}));
      if (!reply.ok) return fetchFailure(reply);
      return parseGoogleVolume(parseJson(reply));
    }
    const targets = keys.isbns.slice(0, ISBN_ATTEMPTS).map((isbn) => build('/books/v1/volumes', { q: `isbn:${isbn}`, maxResults: '1' }));
    return firstFound(targets, async (target) => {
      const reply = await this.json(target);
      if (!reply.ok) return fetchFailure(reply);
      const items = asRecord(parseJson(reply))?.items;
      if (!Array.isArray(items) || items.length === 0) return outcome('not_found', null);
      return parseGoogleVolume(items[0]);
    });
  }

  private page(url: string): Promise<SafeFetchResult> {
    return safeGet(url, {
      transport: this.transport,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      maxBytes: PAGE_BYTES,
      overflow: 'truncate',
    });
  }

  private json(url: string): Promise<SafeFetchResult> {
    return safeGet(url, { transport: this.transport, accept: 'application/json', maxBytes: JSON_BYTES, overflow: 'reject' });
  }
}

/** Tries each target in turn while the provider says not found. */
async function firstFound(targets: string[], attempt: (target: string) => Promise<ProviderOutcome>): Promise<ProviderOutcome> {
  let last: ProviderOutcome = outcome('not_found', null);
  for (const target of targets) {
    last = await attempt(target);
    if (last.status !== 'not_found') return last;
  }
  return last;
}

function fetchFailure(reply: Extract<SafeFetchResult, { ok: false }>): ProviderOutcome {
  if (reply.code === 'http_error' && (reply.status === 404 || reply.status === 410)) return outcome('not_found', null);
  if (reply.code === 'http_error' && (reply.status === 403 || reply.status === 418 || reply.status === 429)) {
    return { ...failed(reply.status === 429 ? 'rate_limited' : 'blocked', null), backoff: true };
  }
  if (reply.code === 'http_error') return failed(`http_${reply.status ?? 'error'}`, null);
  return failed(reply.code, null);
}

function text(reply: Extract<SafeFetchResult, { ok: true }>): string {
  return reply.bytes.toString('utf8');
}

function parseJson(reply: Extract<SafeFetchResult, { ok: true }>): unknown {
  try {
    return JSON.parse(reply.bytes.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function outcome(status: RatingStatus, url: string | null): ProviderOutcome {
  return { status, url, rating: null, count: null, error: null };
}

function failed(error: string, url: string | null): ProviderOutcome {
  return { status: 'error', url, rating: null, count: null, error };
}

/** An http(s) URL on a host matching `host`, or null. */
function pageUrl(value: unknown, host: RegExp): string | null {
  if (typeof value !== 'string' || value.length > URL_MAX) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!host.test(url.hostname) || url.username || url.password) return null;
    url.protocol = 'https:';
    return url.href;
  } catch {
    return null;
  }
}

/** ISBN-10 for a 978 ISBN-13, else null. */
export function toIsbn10(isbn13: string): string | null {
  if (!/^978\d{10}$/.test(isbn13)) return null;
  const body = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += (10 - i) * Number(body[i]);
  const check = (11 - (sum % 11)) % 11;
  return `${body}${check === 10 ? 'X' : String(check)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// --- storage and queue -----------------------------------------------------------

export function loadRatingKeys(db: AppDatabase, editionId: number): RatingKeys {
  const rows = db
    .select({ scheme: editionIdentifiers.scheme, value: editionIdentifiers.value })
    .from(editionIdentifiers)
    .where(eq(editionIdentifiers.editionId, editionId))
    .orderBy(asc(editionIdentifiers.id))
    .all();
  const keys: RatingKeys = { isbns: [], douban: null, olids: [], googleBooks: null };
  for (const row of rows) {
    if (row.scheme === 'isbn') {
      const isbn = toIsbn13(row.value);
      if (isbn && !keys.isbns.includes(isbn)) keys.isbns.push(isbn);
    } else if (row.scheme === 'douban' && /^[1-9]\d{0,11}$/.test(row.value)) {
      keys.douban ??= row.value;
    } else if (row.scheme === 'olid' && /^OL[1-9]\d{0,11}[MW]$/.test(row.value)) {
      keys.olids.push(row.value);
    } else if (row.scheme === 'google_books' && /^[A-Za-z0-9_-]{8,20}$/.test(row.value)) {
      keys.googleBooks ??= row.value;
    }
  }
  return keys;
}

/** True when the provider can be asked about this edition at all. */
export function providerHasKey(provider: RatingProvider, keys: RatingKeys): boolean {
  if (provider === 'douban') return keys.douban !== null || keys.isbns.length > 0;
  if (provider === 'goodreads') return keys.isbns.length > 0;
  if (provider === 'open_library') return keys.olids.length > 0 || keys.isbns.length > 0;
  return keys.googleBooks !== null || keys.isbns.length > 0;
}

function hasAnyKey(keys: RatingKeys): boolean {
  return RATING_PROVIDERS.some((provider) => providerHasKey(provider, keys));
}

/** Queues a fetch of every provider, as an admin refresh does. */
export function enqueueRatings(db: AppDatabase, editionId: number, now = new Date()): void {
  const stamp = now.toISOString();
  db.insert(editionRatingsQueue)
    .values({ editionId, queuedAt: stamp, notBefore: null })
    .onConflictDoUpdate({ target: editionRatingsQueue.editionId, set: { queuedAt: stamp, notBefore: null } })
    .run();
}

/**
 * On a page view: queues the edition when a provider it can be looked up on has no row, a row
 * older than 30 days, or an error older than a day. Never fetches; returns whether it queued.
 */
export function ensureRatingsFresh(db: AppDatabase, editionId: number, now = new Date()): boolean {
  const keys = loadRatingKeys(db, editionId);
  if (!hasAnyKey(keys)) return false;
  const rows = new Map(
    db.select().from(editionRatings).where(eq(editionRatings.editionId, editionId)).all().map((row) => [row.provider, row]),
  );
  const stale = RATING_PROVIDERS.some((provider) => {
    if (!providerHasKey(provider, keys)) return false;
    const row = rows.get(provider);
    if (!row) return true;
    const age = now.getTime() - Date.parse(row.fetchedAt);
    const limit = row.status === 'error' ? RATINGS_ERROR_RETRY_MS : RATINGS_MAX_AGE_MS;
    return !Number.isFinite(age) || age > limit;
  });
  if (!stale) return false;
  // A queued edition keeps its place and its deferral.
  db.insert(editionRatingsQueue)
    .values({ editionId, queuedAt: now.toISOString(), notBefore: null })
    .onConflictDoNothing()
    .run();
  return true;
}

/** True while the edition waits for the worker. An edition deferred by a provider's backoff is not waiting. */
export function ratingsQueued(db: AppDatabase, editionId: number, now = new Date()): boolean {
  const row = db
    .select({ notBefore: editionRatingsQueue.notBefore })
    .from(editionRatingsQueue)
    .where(eq(editionRatingsQueue.editionId, editionId))
    .get();
  return Boolean(row) && (!row?.notBefore || row.notBefore <= now.toISOString());
}

export interface RatingView {
  provider: RatingProvider;
  url: string | null;
  rating: number | null;
  scale: number;
  count: number | null;
  fetchedAt: string;
}

export interface AdminRatingView extends RatingView {
  status: RatingStatus;
  error: string | null;
}

/**
 * Ratings in provider order. Readers get scores and links only: `not_found` and `error` rows,
 * and a `no_rating` row without a page, are left out. Admins get every row with its status.
 */
export function presentRatings(db: AppDatabase, editionId: number, admin: boolean): RatingView[] | AdminRatingView[] {
  const rows = db.select().from(editionRatings).where(eq(editionRatings.editionId, editionId)).all();
  rows.sort((a, b) => RATING_PROVIDERS.indexOf(a.provider) - RATING_PROVIDERS.indexOf(b.provider));
  const views: Array<RatingView | AdminRatingView> = [];
  for (const row of rows) {
    const view: RatingView = {
      provider: row.provider,
      url: row.url,
      rating: row.status === 'ok' ? row.rating : null,
      scale: row.scale,
      count: row.status === 'ok' ? row.count : null,
      fetchedAt: row.fetchedAt,
    };
    if (admin) {
      views.push({ ...view, status: row.status, error: row.error });
      continue;
    }
    if (row.status === 'ok' || (row.status === 'no_rating' && row.url)) views.push(view);
  }
  return views as RatingView[] | AdminRatingView[];
}

// --- worker ----------------------------------------------------------------------

/**
 * Fetches the oldest due edition in the queue. Providers already fetched since the edition was
 * queued are skipped, so an edition deferred by one provider's backoff only asks that provider
 * again. Returns the edition id, or null when nothing was due.
 */
export async function runNextRatingsJob(
  getDb: () => AppDatabase,
  fetcher: RatingsFetcher,
  now: () => Date = () => new Date(),
): Promise<number | null> {
  const stamp = now().toISOString();
  const next = getDb()
    .select()
    .from(editionRatingsQueue)
    .where(or(isNull(editionRatingsQueue.notBefore), lte(editionRatingsQueue.notBefore, stamp)))
    .orderBy(asc(editionRatingsQueue.queuedAt), asc(editionRatingsQueue.editionId))
    .get();
  if (!next) return null;
  const { editionId, queuedAt } = next;
  const edition = getDb().select({ trashedAt: editions.trashedAt }).from(editions).where(eq(editions.id, editionId)).get();
  if (!edition || edition.trashedAt) {
    finishQueued(getDb(), editionId, queuedAt, null);
    return editionId;
  }
  const keys = loadRatingKeys(getDb(), editionId);
  let deferUntil: number | null = null;
  for (const provider of RATING_PROVIDERS) {
    const db = getDb();
    const existing = db
      .select({ fetchedAt: editionRatings.fetchedAt, status: editionRatings.status })
      .from(editionRatings)
      .where(and(eq(editionRatings.editionId, editionId), eq(editionRatings.provider, provider)))
      .get();
    // Fetched since it was queued. A failure is asked again when a deferred edition comes back.
    if (existing && existing.status !== 'error' && existing.fetchedAt >= queuedAt) continue;
    if (!providerHasKey(provider, keys)) {
      db.delete(editionRatings).where(and(eq(editionRatings.editionId, editionId), eq(editionRatings.provider, provider))).run();
      continue;
    }
    const until = fetcher.backoffUntil(provider);
    if (until !== null) {
      deferUntil = deferUntil === null ? until : Math.min(deferUntil, until);
      continue;
    }
    // Stamped before the request: an identifier change while it runs queues the edition again.
    const requestedAt = now().toISOString();
    const result = await fetcher.fetch(provider, keys);
    if (result.backoff) {
      const backedOff = fetcher.backoffUntil(provider);
      if (backedOff !== null) deferUntil = deferUntil === null ? backedOff : Math.min(deferUntil, backedOff);
      // A refusal never replaces an answer we already have; without one it is recorded for admins.
      if (existing && existing.status !== 'error') continue;
    }
    storeRating(getDb(), editionId, provider, result, requestedAt);
  }
  finishQueued(getDb(), editionId, queuedAt, deferUntil === null ? null : new Date(deferUntil).toISOString());
  return editionId;
}

function storeRating(db: AppDatabase, editionId: number, provider: RatingProvider, result: ProviderOutcome, fetchedAt: string): void {
  // Still alive? The edition may have been purged while its providers were asked.
  const live = db.select({ id: editions.id }).from(editions).where(eq(editions.id, editionId)).get();
  if (!live) return;
  const values = {
    url: result.url && result.url.length <= URL_MAX ? result.url : null,
    rating: result.status === 'ok' ? result.rating : null,
    scale: RATING_SCALES[provider],
    count: result.status === 'ok' ? result.count : null,
    status: result.status,
    error: result.status === 'error' ? (result.error ?? 'error').slice(0, 100) : null,
    fetchedAt,
  };
  db.insert(editionRatings)
    .values({ editionId, provider, ...values })
    .onConflictDoUpdate({ target: [editionRatings.editionId, editionRatings.provider], set: values })
    .run();
}

/** Drops the queue row, or defers it, unless the edition was queued again meanwhile. */
function finishQueued(db: AppDatabase, editionId: number, queuedAt: string, notBefore: string | null): void {
  const match = and(eq(editionRatingsQueue.editionId, editionId), eq(editionRatingsQueue.queuedAt, queuedAt));
  if (notBefore) db.update(editionRatingsQueue).set({ notBefore }).where(match).run();
  else db.delete(editionRatingsQueue).where(match).run();
}

export interface RatingsLogger {
  error(context: Record<string, unknown>, message: string): void;
}

/** Polls the queue and fetches one edition at a time. Pauses while a backup holds the database. */
export function startRatingsWorker(options: {
  db: AppDatabase;
  fetcher: RatingsFetcher;
  pollMs?: number;
  log?: RatingsLogger;
}): { stop: () => void } {
  let stopped = false;
  let active = false;
  const timer = setInterval(() => {
    if (stopped || active || holder() === 'backup') return;
    active = true;
    void runNextRatingsJob(() => options.db, options.fetcher)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : '';
        if (/closed|not open/i.test(message)) return;
        options.log?.error({ name: error instanceof Error ? error.name : 'Error' }, 'ratings worker failed');
      })
      .finally(() => {
        active = false;
      });
  }, options.pollMs ?? RATINGS_POLL_MS);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
