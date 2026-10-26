import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { readFileSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { absoluteBlobPath } from '../src/blobs.js';
import {
  OPEN_LIBRARY_COVERS_ORIGIN,
  OPEN_LIBRARY_ORIGIN,
  OpenLibraryError,
  buildCoverUrl,
  buildIsbnUrl,
  buildSearchUrl,
  lookupOpenLibrary,
  type OpenLibraryTransport,
} from '../src/metadata/openLibrary.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir, tempConfig } from './helpers.js';
import { COVER_PNG, buildTextPdf } from './fixtures.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface RecordedCall {
  url: string;
  userAgent: string | null;
}

function cookieFrom(response: { headers: { 'set-cookie'?: string | string[] | undefined } }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(';')[0] ?? '';
}

function stubTransport(): { transport: OpenLibraryTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: OpenLibraryTransport = {
    async fetch(input, init) {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href);
      if (url.hostname !== 'openlibrary.org' && url.hostname !== 'covers.openlibrary.org') {
        throw new Error(`unexpected host ${url.href}`);
      }
      for (const name of ['key', 'api_key', 'apikey']) {
        if (url.searchParams.has(name)) throw new Error(`api key on ${url.href}`);
      }
      const headers = new Headers(init?.headers);
      calls.push({ url: url.href, userAgent: headers.get('user-agent') });
      if (url.pathname === '/search.json') {
        return Response.json({
          docs: [
            {
              title: 'OL Title',
              author_name: ['Ada Lovelace'],
              publisher: ['OL Press'],
              first_publish_year: 1843,
              language: ['eng'],
              isbn: ['9780000000002'],
              cover_i: 42,
            },
          ],
        });
      }
      if (url.pathname.startsWith('/isbn/')) {
        return Response.json({
          title: 'OL Title',
          publishers: ['OL Press'],
          publish_date: '1843',
          description: 'From the catalog.',
          languages: [{ key: '/languages/eng' }],
          covers: [42],
          isbn_13: ['9780000000002'],
        });
      }
      if (url.pathname.startsWith('/b/')) {
        return new Response(COVER_PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response('missing', { status: 404 });
    },
  };
  return { transport, calls };
}

describe('open library client', () => {
  it('builds the public search, isbn, and cover urls with no api key', () => {
    expect(buildSearchUrl({ title: 'Tale', author: 'Lin' }).href).toBe(
      `${OPEN_LIBRARY_ORIGIN}/search.json?title=Tale&author=Lin&limit=5`,
    );
    expect(buildIsbnUrl('9780140328721').href).toBe(`${OPEN_LIBRARY_ORIGIN}/isbn/9780140328721.json`);
    expect(buildCoverUrl({ coverId: 42 }).href).toBe(`${OPEN_LIBRARY_COVERS_ORIGIN}/b/id/42-L.jpg?default=false`);
    expect(buildCoverUrl({ isbn: '9780140328721' }).href).toBe(
      `${OPEN_LIBRARY_COVERS_ORIGIN}/b/isbn/9780140328721-L.jpg?default=false`,
    );
    for (const href of [
      buildSearchUrl({ isbn: '9780140328721' }).href,
      buildIsbnUrl('9780140328721').href,
      buildCoverUrl({ coverId: 42 }).href,
    ]) {
      const url = new URL(href);
      expect(url.searchParams.has('key')).toBe(false);
      expect(url.searchParams.has('api_key')).toBe(false);
      expect(url.searchParams.has('apikey')).toBe(false);
    }
  });

  it('does not call the live service when tests forget a stub', async () => {
    await expect(lookupOpenLibrary({}, { title: 'Tale' })).rejects.toBeInstanceOf(OpenLibraryError);
  });

  it('previews locked fields as kept and applies only confirmed unlocked fields', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = tempConfig(temp.dir);
    migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
    const { transport, calls } = stubTransport();
    const app = await buildApp({ config, clientDist: null, logger: false, openLibrary: transport });
    cleanups.push(() => {
      void app.close();
    });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'ada', password, libraryName: 'Home' },
    });
    const cookie = cookieFrom(setup);
    const libraryId = setup.json().library.id as number;
    const pdf = buildTextPdf();
    const boundary = '----qijuanboundary';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="notes.pdf"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const created = await app.inject({
      method: 'POST',
      url: `/api/imports?libraryId=${libraryId}`,
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(created.statusCode).toBe(202);
    let editionId = 0;
    let sha = '';
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/jobs/${created.json().job.id as number}`,
        headers: { cookie },
      });
      const job = response.json().job as {
        status: string;
        items: Array<{ status: string; editionId: number | null; sha256: string | null }>;
      };
      if (job.status === 'succeeded' || job.status === 'failed') {
        expect(job.items[0]?.status).toBe('succeeded');
        editionId = job.items[0]?.editionId ?? 0;
        sha = job.items[0]?.sha256 ?? '';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const blobPath = absoluteBlobPath(config.dataDir, sha);
    const before = statSync(blobPath);
    const beforeHash = createHash('sha256').update(readFileSync(blobPath)).digest('hex');

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/editions/${editionId}`,
      headers: { cookie },
      payload: { title: 'Kept Title' },
    });
    expect(renamed.statusCode).toBe(200);

    const reader = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: { username: 'bea', password: 'reader-password' },
    });
    expect(reader.statusCode).toBe(201);
    const granted = await app.inject({
      method: 'POST',
      url: `/api/libraries/${libraryId}/grants`,
      headers: { cookie },
      payload: { userId: reader.json().user.id as number },
    });
    expect(granted.statusCode).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { username: 'bea', password: 'reader-password' },
    });
    const readerCookie = cookieFrom(login);
    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/lookup`,
      headers: { cookie: readerCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const lookup = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/lookup`,
      headers: { cookie },
    });
    expect(lookup.statusCode).toBe(200);
    const preview = lookup.json() as {
      previewId: number;
      fields: Array<{ field: string; status: string; locked: boolean; current: string | null; proposed: string | null }>;
    };
    expect(preview.fields.find((field) => field.field === 'title')).toMatchObject({
      status: 'kept',
      locked: true,
      current: 'Kept Title',
      proposed: 'OL Title',
    });
    expect(preview.fields.find((field) => field.field === 'description')).toMatchObject({
      status: 'change',
      locked: false,
      proposed: 'From the catalog.',
    });
    expect(calls.some((call) => call.url.startsWith(`${OPEN_LIBRARY_ORIGIN}/search.json`))).toBe(true);
    expect(calls.some((call) => call.url === `${OPEN_LIBRARY_ORIGIN}/isbn/9780000000002.json`)).toBe(true);
    expect(calls.every((call) => call.userAgent?.includes('QiJuan'))).toBe(true);
    expect(calls.some((call) => call.url.includes('covers.openlibrary.org'))).toBe(false);

    const applied = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/apply`,
      headers: { cookie },
      payload: { previewId: preview.previewId, confirm: ['title', 'description'] },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().edition.title).toBe('Kept Title');
    expect(applied.json().edition.description).toBe('From the catalog.');
    expect(applied.json().edition.publisher).toBeNull();
    expect(applied.json().edition.language).toBe('en');
    expect(applied.json().edition.identifiers).toEqual([{ scheme: 'isbn', value: 'urn:isbn:9780000000002' }]);
    expect(applied.json().edition.cover).toBeNull();
    expect(applied.json().edition.locks).toEqual(expect.arrayContaining(['title', 'description']));
    expect(applied.json().edition.locks).not.toContain('publisher');

    const again = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/lookup`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(200);
    const covered = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/apply`,
      headers: { cookie },
      payload: { previewId: again.json().previewId as number, confirm: ['title', 'publisher', 'cover'] },
    });
    expect(covered.statusCode).toBe(200);
    expect(covered.json().edition.title).toBe('Kept Title');
    expect(covered.json().edition.description).toBe('From the catalog.');
    expect(covered.json().edition.publisher).toBe('OL Press');
    expect(covered.json().edition.cover).toEqual({ mediaType: 'image/png' });
    expect(calls.some((call) => call.url.startsWith(`${OPEN_LIBRARY_COVERS_ORIGIN}/b/id/42-L.jpg`))).toBe(true);
    expect(statSync(blobPath).ino).toBe(before.ino);
    expect(createHash('sha256').update(readFileSync(blobPath)).digest('hex')).toBe(beforeHash);

    const db = new Database(config.databasePath, { readonly: true });
    const editions = db.prepare('SELECT COUNT(*) AS count FROM editions').get() as { count: number };
    db.close();
    expect(editions.count).toBe(1);
  });
});
