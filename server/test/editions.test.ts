import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { absoluteBlobPath } from '../src/blobs.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir, tempConfig } from './helpers.js';
import { COVER_PNG, buildEpub } from './fixtures.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function multipart(parts: Array<{ name: string; filename: string; content: Buffer; type?: string }>): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = '----qijuanboundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type ?? 'application/octet-stream'}\r\n\r\n`,
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

async function waitForJob(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, id: number) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const job = response.json().job as {
      status: string;
      items: Array<{ filename: string; status: string; editionId: number | null; sha256: string | null }>;
    };
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${id} did not finish`);
}

async function upload(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  libraryId: number,
  files: Array<{ filename: string; content: Buffer }>,
) {
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

describe('edition editing', () => {
  it('keeps the book blob hash through a metadata edit and a cover change', async () => {
    const { app, config, cookie, libraryId } = await startApp();
    const epub = buildEpub();
    const job = await upload(app, cookie, libraryId, [{ filename: 'tale.epub', content: epub }]);
    const editionId = job.items[0]?.editionId ?? 0;
    const sha = job.items[0]?.sha256 ?? '';
    const blobPath = absoluteBlobPath(config.dataDir, sha);
    const before = statSync(blobPath);
    const beforeHash = createHash('sha256').update(readFileSync(blobPath)).digest('hex');
    expect(beforeHash).toBe(sha);
    expect(readFileSync(blobPath).equals(epub)).toBe(true);

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/editions/${editionId}`,
      headers: { cookie },
      payload: { title: 'Corrected Title', description: 'Hand written.' },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().edition.title).toBe('Corrected Title');
    expect(edited.json().edition.locks).toEqual(expect.arrayContaining(['title', 'description']));

    const userCover = Buffer.from(COVER_PNG);
    userCover[userCover.length - 1] ^= 0x5a;
    const coverBody = multipart([{ name: 'cover', filename: 'cover.png', content: userCover, type: 'image/png' }]);
    const covered = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/cover`,
      headers: { ...coverBody.headers, cookie },
      payload: coverBody.payload,
    });
    expect(covered.statusCode).toBe(200);
    expect(covered.json().edition.cover).toEqual({ mediaType: 'image/png' });
    expect(covered.json().edition.locks).toEqual(expect.arrayContaining(['cover']));

    expect(statSync(blobPath).ino).toBe(before.ino);
    expect(readFileSync(blobPath).equals(epub)).toBe(true);
    expect(createHash('sha256').update(readFileSync(blobPath)).digest('hex')).toBe(beforeHash);

    const refreshed = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/refresh`,
      headers: { cookie },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().edition.title).toBe('Corrected Title');
    expect(refreshed.json().edition.description).toBe('Hand written.');
    expect(readFileSync(blobPath).equals(epub)).toBe(true);
    expect(statSync(blobPath).ino).toBe(before.ino);

    const db = new Database(config.databasePath, { readonly: true });
    const asset = db.prepare('SELECT sha256 FROM file_assets WHERE edition_id = ?').get(editionId) as { sha256: string };
    const cover = db.prepare('SELECT sha256 FROM covers WHERE edition_id = ?').get(editionId) as { sha256: string };
    db.close();
    expect(asset.sha256).toBe(beforeHash);
    expect(cover.sha256).not.toBe(beforeHash);
    expect(readFileSync(absoluteBlobPath(config.dataDir, cover.sha256)).equals(userCover)).toBe(true);
  });

  it('keeps a corrected title on rescan and refreshes an unlocked description', async () => {
    const { app, config, dir, cookie } = await startApp();
    const root = path.join(dir, 'indexed');
    mkdirSync(root, { recursive: true });
    const original = buildEpub();
    const epubPath = path.join(root, 'tale.epub');
    writeFileSync(epubPath, original);
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
    const editionId = job.items[0]?.editionId ?? 0;
    expect(job.items[0]?.status).toBe('succeeded');

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/editions/${editionId}`,
      headers: { cookie },
      payload: { title: 'Corrected Title' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().edition.locks).toEqual(['title']);

    const userCover = Buffer.from(COVER_PNG);
    userCover[userCover.length - 1] ^= 0x5a;
    const coverBody = multipart([{ name: 'cover', filename: 'cover.png', content: userCover, type: 'image/png' }]);
    const covered = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/cover`,
      headers: { ...coverBody.headers, cookie },
      payload: coverBody.payload,
    });
    expect(covered.statusCode).toBe(200);

    const fileCover = Buffer.from(COVER_PNG);
    fileCover[20] ^= 0x11;
    const rewritten = buildEpub({
      title: 'Embedded Title',
      description: 'A quiet revision.',
      publisher: 'File Press',
      cover: fileCover,
    });
    writeFileSync(epubPath, rewritten);
    const rescan = await app.inject({
      method: 'POST',
      url: `/api/libraries/${library.id}/rescan`,
      headers: { cookie },
    });
    expect(rescan.statusCode).toBe(200);
    const afterRescan = await app.inject({ method: 'GET', url: `/api/editions/${editionId}`, headers: { cookie } });
    expect(afterRescan.statusCode).toBe(200);
    const rescanned = afterRescan.json().edition as {
      title: string;
      description: string | null;
      publisher: string | null;
      locks: string[];
    };
    expect(rescanned.title).toBe('Corrected Title');
    expect(rescanned.description).toBe('A quiet revision.');
    expect(rescanned.publisher).toBe('File Press');
    expect(rescanned.locks).toEqual(expect.arrayContaining(['title', 'cover']));
    expect(rescanned.locks).not.toContain('description');
    expect(readFileSync(epubPath).equals(rewritten)).toBe(true);

    const db = new Database(config.databasePath, { readonly: true });
    const cover = db.prepare('SELECT sha256 FROM covers WHERE edition_id = ?').get(editionId) as { sha256: string };
    db.close();
    expect(cover.sha256).toBe(createHash('sha256').update(userCover).digest('hex'));

    const second = buildEpub({
      title: 'Embedded Title',
      description: 'Second pass.',
      publisher: 'File Press',
      cover: fileCover,
    });
    writeFileSync(epubPath, second);
    const refresh = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/refresh`,
      headers: { cookie },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().edition.title).toBe('Corrected Title');
    expect(refresh.json().edition.description).toBe('Second pass.');
    expect(readFileSync(epubPath).equals(second)).toBe(true);
    const dbAfter = new Database(config.databasePath, { readonly: true });
    const coverAfter = dbAfter.prepare('SELECT sha256 FROM covers WHERE edition_id = ?').get(editionId) as { sha256: string };
    dbAfter.close();
    expect(coverAfter.sha256).toBe(cover.sha256);
  });

  it('batch-edits common fields, locks them, and does not merge editions', async () => {
    const { app, cookie, libraryId } = await startApp();
    const job = await upload(app, cookie, libraryId, [
      { filename: 'one.epub', content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01' }) },
      { filename: 'two.epub', content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02' }) },
    ]);
    expect(job.items.every((item) => item.status === 'succeeded')).toBe(true);
    const ids = job.items.map((item) => item.editionId);
    expect(new Set(ids).size).toBe(2);

    const batched = await app.inject({
      method: 'POST',
      url: '/api/editions/batch',
      headers: { cookie },
      payload: {
        editionIds: ids,
        language: 'la',
        publisher: 'North Press',
        tags: ['essay', 'night'],
        series: 'Letters',
      },
    });
    expect(batched.statusCode).toBe(200);
    expect(batched.json()).toEqual({ updated: 2 });

    const details = [];
    for (const id of ids) {
      const response = await app.inject({ method: 'GET', url: `/api/editions/${id}`, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      details.push(response.json().edition as {
        language: string;
        publisher: string;
        tags: string[];
        series: { id: number; name: string };
        locks: string[];
      });
      const refresh = await app.inject({ method: 'POST', url: `/api/editions/${id}/refresh`, headers: { cookie } });
      expect(refresh.statusCode).toBe(200);
      expect(refresh.json().edition.language).toBe('la');
    }
    expect(details.every((edition) => edition.language === 'la')).toBe(true);
    expect(details.every((edition) => edition.publisher === 'North Press')).toBe(true);
    expect(details[0]?.tags).toEqual(['essay', 'night']);
    expect(details[1]?.tags).toEqual(['essay', 'night']);
    expect(details[0]?.series.name).toBe('Letters');
    expect(details[0]?.series.id).toBe(details[1]?.series.id);
    for (const edition of details) {
      expect(edition.locks).toEqual(expect.arrayContaining(['language', 'publisher', 'tags', 'series']));
    }
    const listed = await app.inject({ method: 'GET', url: '/api/editions', headers: { cookie } });
    expect(listed.json().editions).toHaveLength(2);
  });

  it('keeps separate editions that share a title but differ in language or translator', async () => {
    const { app, cookie, libraryId } = await startApp();
    const shared = { title: 'Shared Story', author: 'Lin Qi' };
    const job = await upload(app, cookie, libraryId, [
      {
        filename: 'zh.epub',
        content: buildEpub({ ...shared, language: 'zh', identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee11' }),
      },
      {
        filename: 'en.epub',
        content: buildEpub({ ...shared, language: 'en', identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee12' }),
      },
      {
        filename: 'tr.epub',
        content: buildEpub({
          ...shared,
          language: 'zh',
          translator: 'Wang',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee13',
        }),
      },
    ]);
    expect(job.items.map((item) => item.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    const ids = job.items.map((item) => item.editionId ?? 0);
    expect(new Set(ids).size).toBe(3);

    const details = [];
    const suggestionIds = new Set<number>();
    for (const id of ids) {
      const response = await app.inject({ method: 'GET', url: `/api/editions/${id}`, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      const edition = response.json().edition as {
        title: string;
        language: string;
        translators: string[];
        suggestions: Array<{ id: number }>;
      };
      details.push(edition);
      for (const suggestion of edition.suggestions) suggestionIds.add(suggestion.id);
    }
    expect(details.map((edition) => edition.title)).toEqual(['Shared Story', 'Shared Story', 'Shared Story']);
    expect(details.map((edition) => edition.language)).toEqual(['zh', 'en', 'zh']);
    expect(details[2]?.translators).toEqual(['Wang']);
    expect(details[0]?.translators).toEqual([]);
    expect(suggestionIds.size).toBeGreaterThan(0);

    for (const suggestionId of suggestionIds) {
      const dismissed = await app.inject({
        method: 'POST',
        url: `/api/suggestions/${suggestionId}/dismiss`,
        headers: { cookie },
      });
      expect(dismissed.statusCode).toBe(200);
      expect(dismissed.json()).toEqual({ dismissed: true });
    }
    for (const id of ids) {
      const response = await app.inject({ method: 'GET', url: `/api/editions/${id}`, headers: { cookie } });
      expect(response.json().edition.suggestions).toEqual([]);
    }
    const merge = await app.inject({ method: 'POST', url: `/api/editions/${ids[0]}/merge`, headers: { cookie } });
    const removed = await app.inject({ method: 'DELETE', url: `/api/editions/${ids[0]}`, headers: { cookie } });
    expect(merge.statusCode).toBe(404);
    expect(removed.statusCode).toBe(404);
    const listed = await app.inject({ method: 'GET', url: '/api/editions', headers: { cookie } });
    expect(listed.json().editions).toHaveLength(3);
  });

  it('keeps a case-only author or translator correction on that edition', async () => {
    const { app, config, cookie, libraryId } = await startApp();
    const job = await upload(app, cookie, libraryId, [
      {
        filename: 'one.epub',
        content: buildEpub({
          author: 'Van Gogh',
          translator: 'Wang Wei',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee21',
        }),
      },
      {
        filename: 'two.epub',
        content: buildEpub({
          author: 'Van Gogh',
          translator: 'Wang Wei',
          identifier: 'urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee22',
        }),
      },
    ]);
    expect(job.items.map((item) => item.status)).toEqual(['succeeded', 'succeeded']);
    const [first, second] = job.items.map((item) => item.editionId ?? 0);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/editions/${first}`,
      headers: { cookie },
      payload: { authors: ['van Gogh'], translators: ['wang wei'] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().edition.authors).toEqual(['van Gogh']);
    expect(patched.json().edition.translators).toEqual(['wang wei']);
    expect(patched.json().edition.locks).toEqual(expect.arrayContaining(['authors', 'translators']));

    const other = await app.inject({ method: 'GET', url: `/api/editions/${second}`, headers: { cookie } });
    expect(other.statusCode).toBe(200);
    expect(other.json().edition.authors).toEqual(['Van Gogh']);
    expect(other.json().edition.translators).toEqual(['Wang Wei']);

    const db = new Database(config.databasePath, { readonly: true });
    const people = db.prepare('SELECT name FROM persons ORDER BY name').all() as { name: string }[];
    const spellings = db
      .prepare(
        `SELECT edition_id, role, display_name FROM edition_contributors ORDER BY edition_id, role`,
      )
      .all() as Array<{ edition_id: number; role: string; display_name: string }>;
    db.close();
    expect(people.map((row) => row.name)).toEqual(['Van Gogh', 'Wang Wei']);
    expect(spellings).toEqual([
      { edition_id: first, role: 'author', display_name: 'van Gogh' },
      { edition_id: first, role: 'translator', display_name: 'wang wei' },
      { edition_id: second, role: 'author', display_name: 'Van Gogh' },
      { edition_id: second, role: 'translator', display_name: 'Wang Wei' },
    ]);

    const refreshed = await app.inject({
      method: 'POST',
      url: `/api/editions/${first}/refresh`,
      headers: { cookie },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().edition.authors).toEqual(['van Gogh']);
    expect(refreshed.json().edition.translators).toEqual(['wang wei']);

    const otherAfter = await app.inject({ method: 'GET', url: `/api/editions/${second}`, headers: { cookie } });
    expect(otherAfter.json().edition.authors).toEqual(['Van Gogh']);
    expect(otherAfter.json().edition.translators).toEqual(['Wang Wei']);
  });
});
