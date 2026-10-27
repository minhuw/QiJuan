import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { writeImmutableBlob } from '../src/blobs.js';
import { openDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { descendants, deepText, parseXml } from '../src/xml.js';
import { makeTempDir, tempConfig } from './helpers.js';
import { COVER_PNG, buildEpub } from './fixtures.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cleanups: Array<() => Promise<void> | void> = [];
const ADMIN_PASSWORD = 'correct-horse-battery';
const READER_PASSWORD = 'reader-password-ok';
const cfi = 'epubcfi(/6/4!/4/2:10)';
const noteCfi = 'epubcfi(/6/8!/4,/2:4,/2:12)';
const VISIBLE_TITLE = 'Visible & Tale';
const HIDDEN_TITLE = 'Hidden Tale';
const VISIBLE_AUTHOR = 'Visible Author';
const HIDDEN_AUTHOR = 'Hidden Author';
const VISIBLE_SUMMARY = 'Visible summary sentence';
const HIDDEN_SUMMARY = 'Hidden summary sentence';
const HIDDEN_LIBRARY = 'Other Stack';
const ADA_HIGHLIGHT = 'ada-private-highlight';
const ADA_NOTE = 'ada-private-note';
const BEA_HIGHLIGHT = 'bea-private-highlight';
const BEA_NOTE = 'bea-private-note';
const HIDDEN_NOTE = 'hidden-library-note';
const SHELF_NAME = 'bea-private-shelf';

const PRIVATE = [ADA_HIGHLIGHT, ADA_NOTE, BEA_HIGHLIGHT, BEA_NOTE, HIDDEN_NOTE];
const HIDDEN_TEXT = [HIDDEN_TITLE, HIDDEN_AUTHOR, HIDDEN_SUMMARY, HIDDEN_LIBRARY, HIDDEN_NOTE, 'hidden-tale.epub'];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function cookieFrom(response: { headers: { 'set-cookie'?: string | string[] | undefined } }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(';')[0] ?? '';
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function requestPath(href: string): string {
  if (href.startsWith('/')) return href;
  const url = new URL(href);
  return `${url.pathname}${url.search}`;
}

function feedLinks(xml: string): Array<{ rel: string; href: string; type: string }> {
  return descendants(parseXml(xml), 'link').map((node) => ({
    rel: node.attrs.rel ?? '',
    href: node.attrs.href ?? '',
    type: node.attrs.type ?? '',
  }));
}

function texts(xml: string, name: string): string[] {
  return descendants(parseXml(xml), name).map((node) => deepText(node).trim());
}

function expectNoProgress(xml: string): void {
  expect(xml.toLowerCase()).not.toMatch(/progress|sync/);
  for (const link of feedLinks(xml)) {
    expect(`${link.rel} ${link.href}`.toLowerCase()).not.toMatch(/progress|sync/);
  }
}

function forbid(response: { body: string; rawPayload: Buffer }, secrets: string[]): void {
  for (const secret of secrets) {
    expect(response.body).not.toContain(secret);
    expect(response.rawPayload.includes(Buffer.from(secret))).toBe(false);
  }
}

function expectDenied(response: { statusCode: number; body: string; rawPayload: Buffer; headers: { 'content-type'?: string | string[] } }, secrets: string[]): void {
  expect([403, 404]).toContain(response.statusCode);
  expect(String(response.headers['content-type'] ?? '')).not.toMatch(/epub|image\/png|atom\+xml/);
  forbid(response, secrets);
}

async function annotate(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  editionId: number,
  assetId: number,
  kind: 'highlights' | 'notes',
  text: string,
): Promise<number> {
  const payload =
    kind === 'highlights'
      ? { locator: cfi, assetId, quote: text, revision: 0 }
      : { locator: noteCfi, assetId, body: text, revision: 0 };
  const response = await app.inject({
    method: 'POST',
    url: `/api/editions/${editionId}/${kind}`,
    headers: { cookie },
    payload,
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { highlight?: { id: number }; note?: { id: number } };
  return (kind === 'highlights' ? body.highlight?.id : body.note?.id) ?? 0;
}

async function world() {
  const temp = makeTempDir();
  const config = tempConfig(temp.dir);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  const app = await buildApp({ config, clientDist: null, logger: false });
  cleanups.push(async () => {
    await app.close();
    temp.cleanup();
  });

  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { username: 'ada', password: ADMIN_PASSWORD, libraryName: 'Home' },
  });
  expect(setup.statusCode).toBe(201);
  const adaCookie = cookieFrom(setup);
  const adaId = setup.json().user.id as number;
  const libraryA = setup.json().library.id as number;

  const reader = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { cookie: adaCookie },
    payload: { username: 'bea', password: READER_PASSWORD },
  });
  expect(reader.statusCode).toBe(201);
  const beaId = reader.json().user.id as number;

  const visibleEpub = buildEpub({ title: VISIBLE_TITLE, author: VISIBLE_AUTHOR });
  const hiddenEpub = buildEpub({ title: HIDDEN_TITLE, author: HIDDEN_AUTHOR, identifier: 'urn:uuid:hidden-tale' });
  const visibleBlob = writeImmutableBlob(config.dataDir, visibleEpub);
  const hiddenBlob = writeImmutableBlob(config.dataDir, hiddenEpub);
  const coverBlob = writeImmutableBlob(config.dataDir, COVER_PNG);
  const now = '2026-04-02T00:00:00.000Z';
  const sqlite = openDatabase(config.databasePath);
  const libraryB = Number(
    sqlite.sqlite
      .prepare(`INSERT INTO libraries (name, mode, root_path, created_at) VALUES (?, 'managed', ?, ?)`)
      .run(HIDDEN_LIBRARY, path.join(config.dataDir, 'libraries', 'other'), now).lastInsertRowid,
  );
  mkdirSync(path.join(config.dataDir, 'libraries', 'other'), { recursive: true });

  const insertEdition = (libraryId: number, title: string, author: string, summary: string, filename: string, blob: typeof visibleBlob) => {
    const editionId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO editions (library_id, title, sort_title, language, description, created_at, updated_at)
          VALUES (?, ?, ?, 'en', ?, ?, ?)`,
        )
        .run(libraryId, title, title, summary, now, now).lastInsertRowid,
    );
    const assetId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO file_assets (
            edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
          ) VALUES (?, 'epub', ?, ?, ?, 'managed', ?, 'present', ?)`,
        )
        .run(editionId, blob.sha256, blob.bytes, filename, blob.relativePath, now).lastInsertRowid,
    );
    sqlite.sqlite
      .prepare(
        `INSERT INTO covers (edition_id, sha256, bytes, media_type, relative_path, created_at)
        VALUES (?, ?, ?, 'image/png', ?, ?)`,
      )
      .run(editionId, coverBlob.sha256, coverBlob.bytes, coverBlob.relativePath, now);
    const person = sqlite.sqlite.prepare('SELECT id FROM persons WHERE name = ?').get(author) as { id: number } | undefined;
    const personId = person
      ? person.id
      : Number(
          sqlite.sqlite.prepare('INSERT INTO persons (name, sort_name, created_at) VALUES (?, ?, ?)').run(author, author, now)
            .lastInsertRowid,
        );
    sqlite.sqlite
      .prepare(
        `INSERT INTO edition_contributors (edition_id, person_id, role, position, display_name) VALUES (?, ?, 'author', 0, ?)`,
      )
      .run(editionId, personId, author);
    return { editionId, assetId };
  };

  const visible = { ...insertEdition(libraryA, VISIBLE_TITLE, VISIBLE_AUTHOR, VISIBLE_SUMMARY, 'visible-tale.epub', visibleBlob), epub: visibleEpub };
  const hidden = { ...insertEdition(libraryB, HIDDEN_TITLE, HIDDEN_AUTHOR, HIDDEN_SUMMARY, 'hidden-tale.epub', hiddenBlob), epub: hiddenEpub };

  const grant = await app.inject({
    method: 'POST',
    url: `/api/libraries/${libraryA}/grants`,
    headers: { cookie: adaCookie },
    payload: { userId: beaId },
  });
  expect(grant.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/session/login',
    payload: { username: 'bea', password: READER_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  expect(login.json().libraries).toEqual([{ id: libraryA, name: 'Home', mode: 'managed' }]);
  const beaCookie = cookieFrom(login);

  const adaHighlightId = await annotate(app, adaCookie, visible.editionId, visible.assetId, 'highlights', ADA_HIGHLIGHT);
  await annotate(app, adaCookie, visible.editionId, visible.assetId, 'notes', ADA_NOTE);
  await annotate(app, beaCookie, visible.editionId, visible.assetId, 'highlights', BEA_HIGHLIGHT);
  await annotate(app, beaCookie, visible.editionId, visible.assetId, 'notes', BEA_NOTE);
  await annotate(app, adaCookie, hidden.editionId, hidden.assetId, 'notes', HIDDEN_NOTE);

  const shelf = await app.inject({
    method: 'POST',
    url: '/api/shelves',
    headers: { cookie: beaCookie },
    payload: { name: SHELF_NAME, editionId: visible.editionId },
  });
  expect(shelf.statusCode).toBe(201);
  const shelfId = shelf.json().shelf.id as number;
  sqlite.sqlite
    .prepare(`INSERT INTO shelf_items (shelf_id, edition_id, position, added_at) VALUES (?, ?, 1, ?)`)
    .run(shelfId, hidden.editionId, now);
  sqlite.sqlite
    .prepare(
      `INSERT INTO reading_positions (user_id, edition_id, asset_id, locator, revision, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .run(beaId, hidden.editionId, hidden.assetId, cfi, now);
  sqlite.sqlite.close();

  return { app, config, adaCookie, beaCookie, adaId, beaId, libraryA, libraryB, visible, hidden, adaHighlightId, shelfId };
}

describe('library and annotation denial', () => {
  it('hides another library and another user\'s notes, including from an admin', async () => {
    const { app, adaCookie, beaCookie, beaId, libraryB, visible, hidden, adaHighlightId, shelfId } = await world();
    const secrets = [...HIDDEN_TEXT, ADA_HIGHLIGHT, ADA_NOTE];

    const lists = [
      '/api/home',
      '/api/editions',
      '/api/library?limit=24',
      '/api/library?limit=24&q=Tale',
      '/api/library?limit=24&q=Hidden',
      `/api/library?limit=24&shelfId=${shelfId}`,
      '/api/shelves',
    ];
    for (const url of lists) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie: beaCookie } });
      expect(response.statusCode).toBe(200);
      forbid(response, secrets);
    }
    const found = await app.inject({
      method: 'GET',
      url: '/api/library?limit=24&q=Visible',
      headers: { cookie: beaCookie },
    });
    expect(found.statusCode).toBe(200);
    expect(found.body).toContain(VISIBLE_TITLE);
    expect(found.body).toContain(VISIBLE_AUTHOR);
    forbid(found, secrets);

    const shelves = await app.inject({ method: 'GET', url: '/api/shelves', headers: { cookie: beaCookie } });
    expect(shelves.json().shelves).toEqual([expect.objectContaining({ id: shelfId, name: SHELF_NAME, count: 1 })]);

    for (const url of [
      `/api/editions/${hidden.editionId}`,
      `/api/editions/${hidden.editionId}/cover`,
      `/api/editions/${hidden.editionId}/assets/${hidden.assetId}/file`,
      `/api/editions/${hidden.editionId}/reading-place`,
      `/api/editions/${hidden.editionId}/annotations?format=json`,
      `/api/editions/${hidden.editionId}/annotations?format=markdown`,
      `/api/editions?libraryId=${libraryB}`,
    ]) {
      expectDenied(await app.inject({ method: 'GET', url, headers: { cookie: beaCookie } }), secrets);
    }

    const visibleCover = await app.inject({
      method: 'GET',
      url: `/api/editions/${visible.editionId}/cover`,
      headers: { cookie: beaCookie },
    });
    expect(visibleCover.statusCode).toBe(200);
    expect(visibleCover.rawPayload.equals(COVER_PNG)).toBe(true);
    const visibleFile = await app.inject({
      method: 'GET',
      url: `/api/editions/${visible.editionId}/assets/${visible.assetId}/file`,
      headers: { cookie: beaCookie },
    });
    expect(visibleFile.statusCode).toBe(200);
    expect(visibleFile.rawPayload.equals(visible.epub)).toBe(true);

    const hiddenCover = await app.inject({
      method: 'GET',
      url: `/api/editions/${hidden.editionId}/cover`,
      headers: { cookie: beaCookie },
    });
    expectDenied(hiddenCover, secrets);
    expect(hiddenCover.rawPayload.equals(COVER_PNG)).toBe(false);
    const hiddenFile = await app.inject({
      method: 'GET',
      url: `/api/editions/${hidden.editionId}/assets/${hidden.assetId}/file`,
      headers: { cookie: beaCookie },
    });
    expectDenied(hiddenFile, secrets);
    expect(hiddenFile.rawPayload.equals(hidden.epub)).toBe(false);

    for (const [method, url, payload] of [
      ['POST', '/api/shelves', { name: 'Nope', editionId: hidden.editionId }],
      ['POST', `/api/shelves/${shelfId}/items`, { editionId: hidden.editionId }],
      ['PATCH', `/api/editions/${hidden.editionId}/reading`, { status: 'reading' }],
      ['POST', '/api/editions/batch', { editionIds: [hidden.editionId], language: 'fr' }],
      ['POST', `/api/imports?libraryId=${libraryB}`, {}],
    ] as const) {
      const response = await app.inject({ method, url, headers: { cookie: beaCookie }, payload });
      expectDenied(response, secrets);
    }

    const beaJson = await app.inject({
      method: 'GET',
      url: `/api/editions/${visible.editionId}/annotations?format=json`,
      headers: { cookie: beaCookie },
    });
    expect(beaJson.statusCode).toBe(200);
    expect(beaJson.body).toContain(BEA_HIGHLIGHT);
    expect(beaJson.body).toContain(BEA_NOTE);
    forbid(beaJson, [ADA_HIGHLIGHT, ADA_NOTE, HIDDEN_NOTE, HIDDEN_TITLE]);
    const beaMd = await app.inject({
      method: 'GET',
      url: `/api/editions/${visible.editionId}/annotations?format=markdown`,
      headers: { cookie: beaCookie },
    });
    expect(beaMd.statusCode).toBe(200);
    expect(beaMd.body).toContain(BEA_HIGHLIGHT);
    forbid(beaMd, [ADA_HIGHLIGHT, ADA_NOTE, HIDDEN_NOTE]);

    const adminJson = await app.inject({
      method: 'GET',
      url: `/api/editions/${visible.editionId}/annotations?format=json&userId=${beaId}`,
      headers: { cookie: adaCookie },
    });
    expect(adminJson.statusCode).toBe(200);
    expect(adminJson.body).toContain(ADA_HIGHLIGHT);
    expect(adminJson.body).toContain(ADA_NOTE);
    forbid(adminJson, [BEA_HIGHLIGHT, BEA_NOTE]);
    const adminMd = await app.inject({
      method: 'GET',
      url: `/api/editions/${visible.editionId}/annotations?format=markdown`,
      headers: { cookie: adaCookie },
    });
    expect(adminMd.body).toContain(ADA_NOTE);
    forbid(adminMd, [BEA_HIGHLIGHT, BEA_NOTE]);

    const adminPlace = await app.inject({
      method: 'GET',
      url: `/api/editions/${visible.editionId}/reading-place`,
      headers: { cookie: adaCookie },
    });
    expect(adminPlace.body).toContain(ADA_HIGHLIGHT);
    forbid(adminPlace, [BEA_HIGHLIGHT, BEA_NOTE]);
    const beaPlace = await app.inject({
      method: 'GET',
      url: `/api/editions/${visible.editionId}/reading-place`,
      headers: { cookie: beaCookie },
    });
    expect(beaPlace.body).toContain(BEA_HIGHLIGHT);
    forbid(beaPlace, [ADA_HIGHLIGHT, ADA_NOTE, HIDDEN_NOTE]);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/editions/${visible.editionId}/highlights/${adaHighlightId}`,
      headers: { cookie: beaCookie },
      payload: { revision: 1 },
    });
    expect(removed.statusCode).toBe(404);
    const still = await app.inject({
      method: 'GET',
      url: `/api/editions/${visible.editionId}/reading-place`,
      headers: { cookie: adaCookie },
    });
    expect(still.body).toContain(ADA_HIGHLIGHT);
  });
});

describe('OPDS 1.2', () => {
  it('acquires an EPUB with a revocable token and omits other libraries', async () => {
    const { app, config, beaCookie, libraryB, visible, hidden } = await world();
    const created = await app.inject({
      method: 'POST',
      url: '/api/opds-tokens',
      headers: { cookie: beaCookie },
      payload: { label: 'KOReader' },
    });
    expect(created.statusCode).toBe(201);
    const secret = created.json().secret as string;
    const tokenId = created.json().token.id as number;
    expect(secret.startsWith('qjt_')).toBe(true);
    expect(created.body).not.toContain(READER_PASSWORD);
    expect(created.body).not.toContain(ADMIN_PASSWORD);

    const second = await app.inject({
      method: 'POST',
      url: '/api/opds-tokens',
      headers: { cookie: beaCookie },
      payload: { label: 'Other client' },
    });
    expect(second.statusCode).toBe(201);
    const otherSecret = second.json().secret as string;
    const otherId = second.json().token.id as number;

    const listed = await app.inject({ method: 'GET', url: '/api/opds-tokens', headers: { cookie: beaCookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(secret);
    expect(listed.body).not.toContain(otherSecret);
    const hash = createHash('sha256').update(secret).digest('hex');
    expect(listed.body).not.toContain(hash);

    const check = openDatabase(config.databasePath);
    const stored = check.sqlite.prepare('SELECT token_hash FROM opds_tokens WHERE id = ?').get(tokenId) as { token_hash: string };
    expect(stored.token_hash).toBe(hash);
    expect(stored.token_hash).not.toBe(secret);
    const password = check.sqlite.prepare(`SELECT password_hash FROM users WHERE username = 'bea'`).get() as { password_hash: string };
    expect(password.password_hash.startsWith('scrypt$')).toBe(true);
    expect(password.password_hash).not.toBe(hash);
    check.sqlite.close();
    for (const file of [config.databasePath, `${config.databasePath}-wal`, `${config.databasePath}-shm`]) {
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
      expect(bytes.includes(Buffer.from(otherSecret))).toBe(false);
    }

    const authorization = basic('bea', secret);
    const catalog = await app.inject({ method: 'GET', url: '/opds/catalog', headers: { authorization } });
    expect(catalog.statusCode).toBe(200);
    expect(String(catalog.headers['content-type'])).toContain('application/atom+xml');
    expect(String(catalog.headers['content-type'])).toContain('kind=navigation');
    expect(String(catalog.headers['cache-control'])).toContain('private');
    expectNoProgress(catalog.body);
    forbid(catalog, [...HIDDEN_TEXT, ...PRIVATE, SHELF_NAME]);
    expect(texts(catalog.body, 'title')).toContain('Home');
    expect(texts(catalog.body, 'title')).not.toContain(HIDDEN_LIBRARY);
    const subsections = feedLinks(catalog.body).filter((link) => link.rel === 'subsection');
    expect(subsections).toHaveLength(1);

    const anon = await app.inject({ method: 'GET', url: '/opds/catalog' });
    expect(anon.statusCode).toBe(401);
    expect(String(anon.headers['www-authenticate'])).toMatch(/Basic/);
    expect(anon.json()).toEqual({ error: 'unauthorized' });
    forbid(anon, [VISIBLE_TITLE, ...HIDDEN_TEXT, ...PRIVATE]);

    const passwordAuth = await app.inject({
      method: 'GET',
      url: '/opds/catalog',
      headers: { authorization: basic('bea', READER_PASSWORD) },
    });
    expect(passwordAuth.statusCode).toBe(401);
    forbid(passwordAuth, [VISIBLE_TITLE, ...HIDDEN_TEXT]);

    const wrongUser = await app.inject({
      method: 'GET',
      url: '/opds/catalog',
      headers: { authorization: basic('ada', secret) },
    });
    expect(wrongUser.statusCode).toBe(401);

    const apiWithToken = await app.inject({
      method: 'GET',
      url: '/api/editions',
      headers: { authorization },
    });
    expect(apiWithToken.statusCode).toBe(401);
    forbid(apiWithToken, [VISIBLE_TITLE, HIDDEN_TITLE]);

    const libraryFeed = await app.inject({
      method: 'GET',
      url: requestPath(subsections[0]!.href),
      headers: { authorization },
    });
    expect(libraryFeed.statusCode).toBe(200);
    expect(String(libraryFeed.headers['content-type'])).toContain('kind=acquisition');
    expectNoProgress(libraryFeed.body);
    expect(texts(libraryFeed.body, 'title')).toContain(VISIBLE_TITLE);
    expect(texts(libraryFeed.body, 'name')).toContain(VISIBLE_AUTHOR);
    expect(libraryFeed.body).toContain('Visible &amp; Tale');
    forbid(libraryFeed, [...HIDDEN_TEXT, ...PRIVATE, SHELF_NAME]);
    const acquisition = feedLinks(libraryFeed.body).find((link) => link.type === 'application/epub+zip');
    expect(acquisition?.rel).toBe('http://opds-spec.org/acquisition/open-access');
    const coverLink = feedLinks(libraryFeed.body).find((link) => link.rel === 'http://opds-spec.org/image');
    expect(coverLink?.type).toBe('image/png');

    const downloaded = await app.inject({
      method: 'GET',
      url: requestPath(acquisition!.href),
      headers: { authorization },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(String(downloaded.headers['content-type'])).toContain('application/epub+zip');
    expect(downloaded.rawPayload.equals(visible.epub)).toBe(true);

    const downloadAnon = await app.inject({ method: 'GET', url: requestPath(acquisition!.href) });
    expect(downloadAnon.statusCode).toBe(401);
    expect(downloadAnon.rawPayload.equals(visible.epub)).toBe(false);
    forbid(downloadAnon, [VISIBLE_TITLE, HIDDEN_TITLE]);

    const hiddenFeed = await app.inject({
      method: 'GET',
      url: `/opds/libraries/${libraryB}`,
      headers: { authorization },
    });
    expectDenied(hiddenFeed, [...HIDDEN_TEXT, ...PRIVATE]);
    const hiddenDownload = await app.inject({
      method: 'GET',
      url: `/opds/editions/${hidden.editionId}/assets/${hidden.assetId}`,
      headers: { authorization },
    });
    expectDenied(hiddenDownload, HIDDEN_TEXT);
    expect(hiddenDownload.rawPayload.equals(hidden.epub)).toBe(false);
    const hiddenCover = await app.inject({
      method: 'GET',
      url: `/opds/editions/${hidden.editionId}/cover`,
      headers: { authorization },
    });
    expectDenied(hiddenCover, HIDDEN_TEXT);
    expect(hiddenCover.rawPayload.equals(COVER_PNG)).toBe(false);

    const visibleCover = await app.inject({
      method: 'GET',
      url: requestPath(coverLink!.href),
      headers: { authorization },
    });
    expect(visibleCover.statusCode).toBe(200);
    expect(visibleCover.rawPayload.equals(COVER_PNG)).toBe(true);

    const searchLink = feedLinks(catalog.body).find((link) => link.rel === 'search' && link.type.includes('opensearchdescription'));
    expect(searchLink).toBeTruthy();
    const description = await app.inject({
      method: 'GET',
      url: requestPath(searchLink!.href),
      headers: { authorization },
    });
    expect(description.statusCode).toBe(200);
    expect(String(description.headers['content-type'])).toContain('opensearchdescription');
    expectNoProgress(description.body);
    const template = descendants(parseXml(description.body), 'Url')[0]?.attrs.template ?? '';
    expect(template).toContain('{searchTerms}');
    const descriptionAnon = await app.inject({ method: 'GET', url: requestPath(searchLink!.href) });
    expect(descriptionAnon.statusCode).toBe(401);

    const results = await app.inject({
      method: 'GET',
      url: requestPath(template.replaceAll('{searchTerms}', encodeURIComponent('Tale'))),
      headers: { authorization },
    });
    expect(results.statusCode).toBe(200);
    expect(String(results.headers['content-type'])).toContain('kind=acquisition');
    expectNoProgress(results.body);
    expect(texts(results.body, 'title')).toContain(VISIBLE_TITLE);
    forbid(results, [...HIDDEN_TEXT, ...PRIVATE]);

    for (const url of ['/opds/progress', '/opds/sync', '/api/opds/progress', '/api/sync/progress']) {
      const response = await app.inject({ method: 'GET', url, headers: { authorization } });
      expect(response.statusCode).not.toBe(200);
      forbid(response, [VISIBLE_TITLE, ...HIDDEN_TEXT, ...PRIVATE]);
    }

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/opds-tokens/${tokenId}`,
      headers: { cookie: beaCookie },
    });
    expect(revoked.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/opds/catalog', headers: { authorization } });
    expect(after.statusCode).toBe(401);
    forbid(after, [VISIBLE_TITLE, ...HIDDEN_TEXT, ...PRIVATE]);
    const still = await app.inject({
      method: 'GET',
      url: requestPath(acquisition!.href),
      headers: { authorization: basic('bea', otherSecret) },
    });
    expect(still.statusCode).toBe(200);
    expect(still.rawPayload.equals(visible.epub)).toBe(true);
    const remaining = await app.inject({ method: 'GET', url: '/api/opds-tokens', headers: { cookie: beaCookie } });
    expect(remaining.json().tokens.map((token: { id: number }) => token.id)).toEqual([otherId]);
  });
});

describe('OPDS documentation', () => {
  it('states version 1.2, the tested operations, and that progress sync is not implemented', () => {
    const doc = readFileSync(path.join(root, 'docs/opds.md'), 'utf8');
    expect(doc).toMatch(/1\.2/);
    expect(doc).toMatch(/navigation/i);
    expect(doc).toMatch(/acquisition/i);
    expect(doc).toMatch(/HTTP Basic/);
    expect(doc).toMatch(/revok/i);
    expect(doc).toMatch(/Reading-progress synchronization is not implemented/);
    expect(doc).toMatch(/KOReader/);
    expect(doc).toMatch(/not a report of a live device test/);
    expect(doc).not.toMatch(/tested on a device|live device test passed|verified with KOReader/i);
  });
});
