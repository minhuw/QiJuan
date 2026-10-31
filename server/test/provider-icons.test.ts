import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { WebTransport } from '../src/metadata/assistant/client.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import {
  ICON_FAILURE_RETRY_MS,
  ICON_MAX_AGE_MS,
  ICON_MAX_BYTES,
  ProviderIcons,
  extractIconLinks,
  resolveProviderIcon,
  verifyIconBytes,
} from '../src/provider-icons.js';
import { makeTempDir, tempConfig } from './helpers.js';

const password = 'correct horse battery staple';
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A PNG signature and IHDR: enough for the size check. */
function png(width: number, height: number, padding = 0): Buffer {
  const bytes = Buffer.alloc(33 + padding);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** An ICO directory with one entry per size. */
function ico(...sizes: number[]): Buffer {
  const bytes = Buffer.alloc(6 + sizes.length * 16 + 8);
  bytes.writeUInt16LE(0, 0);
  bytes.writeUInt16LE(1, 2);
  bytes.writeUInt16LE(sizes.length, 4);
  sizes.forEach((size, index) => {
    bytes[6 + index * 16] = size === 256 ? 0 : size;
    bytes[7 + index * 16] = size === 256 ? 0 : size;
  });
  return bytes;
}

type Route = () => Response;

function stubTransport(routes: Record<string, Route>) {
  const seen: Array<{ url: string; referer: string | null; language?: string }> = [];
  const transport: WebTransport = {
    async fetch(input, init) {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: url.href, referer: headers.referer ?? null, language: headers['accept-language'] });
      const route = routes[url.href];
      return route ? route() : new Response('missing', { status: 404 });
    },
    async lookup() {
      return ['93.184.216.34'];
    },
  };
  return { transport, seen };
}

const html = (body: string) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const image = (bytes: Buffer, type = 'image/png') => () => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': type } });

describe('icon links', () => {
  it('reads icon links, resolves them against the page, prefers 32px and up, and skips svg', () => {
    const page = `<html><head>
      <link rel="stylesheet" href="/site.css">
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link rel="mask-icon" href="/mask.png">
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel="icon" href="/plain.ico">
      <link sizes="16x16" rel="icon" href="/16.png">
      <link rel="shortcut icon" href="https://cdn.example.org/fav.png?v=2&amp;x=1" sizes="48x48">
      <link rel="icon" href='/32.png' sizes="32x32">
    </head></html>`;
    const links = extractIconLinks(page, 'https://www.example.org/books/');
    expect(links.map((link) => link.url)).toEqual([
      'https://www.example.org/32.png',
      'https://cdn.example.org/fav.png?v=2&x=1',
      'https://www.example.org/plain.ico',
      'https://www.example.org/apple.png',
      'https://www.example.org/16.png',
    ]);
    expect(extractIconLinks('<link rel="icon" href="javascript:alert(1)">', 'https://www.example.org/')).toEqual([]);
  });
});

describe('icon bytes', () => {
  it('accepts PNG, ICO, WebP, and JPEG by magic bytes, and refuses html, other types, and anything over 256 KiB', () => {
    expect(verifyIconBytes(png(32, 32), 'image/png')).toEqual({ mediaType: 'image/png', width: 32, height: 32 });
    expect(verifyIconBytes(ico(16, 32, 48), 'image/vnd.microsoft.icon')).toEqual({ mediaType: 'image/x-icon', width: 48, height: 48 });
    expect(verifyIconBytes(ico(256), null)).toMatchObject({ width: 256 });
    expect(verifyIconBytes(png(32, 32), 'text/html')).toEqual({ error: 'served as text/html' });
    expect(verifyIconBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).toEqual({ error: 'unsupported_type' });
    expect(verifyIconBytes(Buffer.from('GIF89a........'), 'image/gif')).toEqual({ error: 'unsupported_type' });
    expect(verifyIconBytes(png(32, 32, ICON_MAX_BYTES), 'image/png')).toEqual({ error: 'too_large' });
  });
});

describe('resolving an icon', () => {
  it('takes the declared icon and sends the homepage as Referer to a Douban image host', async () => {
    const { transport, seen } = stubTransport({
      'https://book.douban.com/': html('<link rel="icon" href="https://img1.doubanio.com/favicon.png" sizes="32x32">'),
      'https://img1.doubanio.com/favicon.png': image(png(32, 32)),
    });
    const result = await resolveProviderIcon('douban', transport);
    expect(result).toMatchObject({ ok: true, url: 'https://img1.doubanio.com/favicon.png', mediaType: 'image/png', width: 32 });
    expect(seen.at(-1)).toMatchObject({ url: 'https://img1.doubanio.com/favicon.png', referer: 'https://book.douban.com/' });
    // Asked in English: WorldCat sends a Chinese-language request for a static file to a missing /zh-cn/ path.
    expect(seen.every((item) => item.language === 'en')).toBe(true);
  });

  it('falls back to /favicon.ico when the declared icons fail or the page has none', async () => {
    const { transport, seen } = stubTransport({
      'https://www.goodreads.com/': html('<link rel="icon" href="/broken.png"><link rel="icon" href="/page.html">'),
      'https://www.goodreads.com/page.html': html('<p>not an icon</p>'),
      'https://www.goodreads.com/favicon.ico': image(ico(16, 32), 'image/x-icon'),
    });
    const result = await resolveProviderIcon('goodreads', transport);
    expect(result).toMatchObject({ ok: true, url: 'https://www.goodreads.com/favicon.ico', mediaType: 'image/x-icon', width: 32 });
    expect(seen.map((item) => item.url)).toEqual([
      'https://www.goodreads.com/',
      'https://www.goodreads.com/broken.png',
      'https://www.goodreads.com/page.html',
      'https://www.goodreads.com/favicon.ico',
    ]);
    // Icons on the same site are asked for with the homepage as Referer.
    expect(seen[0]!.referer).toBeNull();
    expect(seen.slice(1).every((item) => item.referer === 'https://www.goodreads.com/')).toBe(true);

    const pageDown = stubTransport({ 'https://openlibrary.org/favicon.ico': image(png(16, 16)) });
    expect(await resolveProviderIcon('open_library', pageDown.transport)).toMatchObject({ ok: true, width: 16 });
    expect(await resolveProviderIcon('worldcat', stubTransport({}).transport)).toEqual({ ok: false, error: 'http_error' });
  });
});

describe('icon cache', () => {
  it('stores the icon, serves it for 30 days, then fetches it again', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    let now = Date.parse('2026-10-01T00:00:00Z');
    let size = 32;
    const { transport, seen } = stubTransport({
      'https://openlibrary.org/': html('<link rel="icon" href="/static/favicon.png">'),
      'https://openlibrary.org/static/favicon.png': () => image(png(size, size))(),
    });
    const icons = new ProviderIcons({ dataDir: temp.dir, transport, now: () => now });
    const first = await icons.get('open_library');
    expect(first?.mediaType).toBe('image/png');
    expect(readFileSync(path.join(temp.dir, 'provider-icons', 'open_library.png')).equals(first!.bytes)).toBe(true);
    const meta = JSON.parse(readFileSync(path.join(temp.dir, 'provider-icons', 'open_library.json'), 'utf8'));
    expect(meta).toMatchObject({ provider: 'open_library', mediaType: 'image/png', width: 32, sourceUrl: 'https://openlibrary.org/static/favicon.png' });

    now += ICON_MAX_AGE_MS - 1;
    size = 64;
    await icons.get('open_library');
    expect(seen).toHaveLength(2);
    // A new ProviderIcons, as after a restart, reads the disk cache.
    await new ProviderIcons({ dataDir: temp.dir, transport, now: () => now }).get('open_library');
    expect(seen).toHaveLength(2);

    now += 2;
    const refreshed = await icons.get('open_library');
    expect(seen).toHaveLength(4);
    expect(refreshed!.bytes.readUInt32BE(16)).toBe(64);
  });

  it('remembers a failure for six hours and keeps a stale icon meanwhile', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    let now = Date.parse('2026-10-01T00:00:00Z');
    let up = false;
    const { transport, seen } = stubTransport({
      'https://books.google.com/favicon.ico': () => (up ? image(png(32, 32))() : new Response('nope', { status: 503 })),
    });
    const icons = new ProviderIcons({ dataDir: temp.dir, transport, now: () => now });
    expect(await icons.get('google_books')).toBeNull();
    const calls = seen.length;
    expect(await icons.get('google_books')).toBeNull();
    now += ICON_FAILURE_RETRY_MS - 1;
    expect(await icons.get('google_books')).toBeNull();
    expect(seen).toHaveLength(calls);

    now += 2;
    up = true;
    expect(await icons.get('google_books')).not.toBeNull();
    expect(seen.length).toBeGreaterThan(calls);

    // Thirty days on the site is down again: the old icon is still served, and not re-asked for six hours.
    now += ICON_MAX_AGE_MS + 1;
    up = false;
    const stale = await icons.get('google_books');
    expect(stale?.mediaType).toBe('image/png');
    const afterFailure = seen.length;
    expect(await icons.get('google_books')).not.toBeNull();
    expect(seen).toHaveLength(afterFailure);
    expect(JSON.parse(readFileSync(path.join(temp.dir, 'provider-icons', 'google_books.json'), 'utf8'))).toMatchObject({ error: 'http_error' });
  });

  it('asks the site once when several pages want the same icon at the same time', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const { transport, seen } = stubTransport({ 'https://search.worldcat.org/favicon.ico': image(ico(32), 'image/x-icon') });
    const icons = new ProviderIcons({ dataDir: temp.dir, transport });
    const results = await Promise.all([icons.get('worldcat'), icons.get('worldcat'), icons.get('worldcat')]);
    expect(results.every((result) => result?.mediaType === 'image/x-icon')).toBe(true);
    expect(seen.filter((item) => item.url.endsWith('/favicon.ico'))).toHaveLength(1);
    expect(existsSync(path.join(temp.dir, 'provider-icons', 'worldcat.ico'))).toBe(true);
  });
});

describe('GET /api/providers/:provider/icon', () => {
  async function startApp(transport: WebTransport) {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = tempConfig(temp.dir);
    migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
    const app = await buildApp({ config, clientDist: null, logger: false, ratings: { worker: false }, providerIcons: { transport } });
    cleanups.push(() => {
      void app.close();
    });
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'ada', password, libraryName: 'Home' } });
    expect(setup.statusCode).toBe(201);
    const raw = setup.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '';
    return { app, cookie };
  }

  it('serves the icon to a signed-in user with a private cache header, and 404s otherwise', async () => {
    const { transport } = stubTransport({
      'https://www.goodreads.com/': html('<link rel="icon" href="/favicon.png" sizes="32x32">'),
      'https://www.goodreads.com/favicon.png': image(png(32, 32)),
    });
    const { app, cookie } = await startApp(transport);

    const signedOut = await app.inject({ method: 'GET', url: '/api/providers/goodreads/icon' });
    expect(signedOut.statusCode).toBe(401);

    const served = await app.inject({ method: 'GET', url: '/api/providers/goodreads/icon', headers: { cookie } });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['cache-control']).toBe('private, max-age=86400');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.rawPayload.equals(png(32, 32))).toBe(true);

    const unknown = await app.inject({ method: 'GET', url: '/api/providers/amazon/icon', headers: { cookie } });
    expect(unknown.statusCode).toBe(404);
    const missing = await app.inject({ method: 'GET', url: '/api/providers/douban/icon', headers: { cookie } });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
  });
});
