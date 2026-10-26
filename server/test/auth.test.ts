import Database from 'better-sqlite3';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { routeRequiresSession } from '../src/auth.js';
import type { AppConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { verifyPassword } from '../src/passwords.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir, tempConfig } from './helpers.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const password = 'correct-horse-battery';

async function createApp(dir: string, trustProxy: AppConfig['trustProxy'] = false) {
  const config = { ...tempConfig(dir), trustProxy };
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  const app = await buildApp({ config, clientDist: null, logger: false });
  return { config, app };
}

function setCookie(response: { headers: { 'set-cookie'?: string | string[] | undefined } }): string {
  const raw = response.headers['set-cookie'];
  const line = Array.isArray(raw) ? raw.join('\n') : raw;
  return line ?? '';
}

function cookiePair(response: { headers: { 'set-cookie'?: string | string[] | undefined } }): string {
  const line = setCookie(response);
  return line.split(';')[0] ?? '';
}

describe('route session policy', () => {
  it('leaves setup, login, and health public and guards library routes', () => {
    expect(routeRequiresSession('GET', '/health')).toBe(false);
    expect(routeRequiresSession('GET', '/api/setup')).toBe(false);
    expect(routeRequiresSession('POST', '/api/setup')).toBe(false);
    expect(routeRequiresSession('POST', '/api/session/login')).toBe(false);

    for (const url of [
      '/api/me',
      '/api/books',
      '/api/books/1',
      '/api/search?q=ada',
      '/api/session/logout',
      '/books/1',
      '/covers/1',
      '/downloads/1',
      '/search',
      '/annotations/1',
      '/opds',
      '/opds/catalog',
    ]) {
      expect(routeRequiresSession('GET', url)).toBe(true);
    }

    expect(routeRequiresSession('PUT', '/api/setup')).toBe(true);
    expect(routeRequiresSession('GET', '/api/session/login')).toBe(true);
  });

  it('decodes percent-encoded paths before the public allowlist', () => {
    for (const url of [
      '/%61pi/me',
      '/%62ooks/1',
      '/%63overs/1',
      '/%64ownloads/1',
      '/%73earch',
      '/%61nnotations/1',
      '/%6fpds',
      '/%6Fpds',
      '/%61%70%69/me',
      '/%61pi/me?unused=1',
    ]) {
      expect(routeRequiresSession('GET', url)).toBe(true);
    }

    expect(routeRequiresSession('GET', '/%68ealth')).toBe(false);
    expect(routeRequiresSession('GET', '/%61pi/setup')).toBe(false);
    expect(routeRequiresSession('POST', '/%61pi/setup')).toBe(false);
    expect(routeRequiresSession('POST', '/%61pi/session/login')).toBe(false);

    expect(routeRequiresSession('GET', '/%')).toBe(true);
    expect(routeRequiresSession('GET', '/%ZZ')).toBe(true);
    expect(routeRequiresSession('GET', '/api/%')).toBe(true);
  });
});

describe('first-run setup and sessions', () => {
  it('creates one admin and one managed library, then rejects a second setup', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const { config, app } = await createApp(temp.dir);

    try {
      const needed = await app.inject({ method: 'GET', url: '/api/setup' });
      expect(needed.statusCode).toBe(200);
      expect(needed.json()).toEqual({ needed: true });
      expect(needed.headers['set-cookie']).toBeUndefined();

      const invalid = await app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { username: 'ada', password: 'short', libraryName: 'Home' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ error: 'invalid_request' });

      const created = await app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { username: ' ada ', password, libraryName: ' Home ' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({
        user: { id: expect.any(Number), username: 'ada', role: 'admin' },
        library: { id: expect.any(Number), name: 'Home', mode: 'managed' },
      });
      const header = setCookie(created);
      expect(header).toMatch(/^qijuan_session=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+$/);
      expect(header).not.toMatch(/Secure/);
      expect(created.body).not.toContain(password);
      expect(created.body).not.toContain('scrypt$');
      expect(created.body).not.toContain(path.join(config.dataDir, 'libraries'));

      const sqlite = new Database(config.databasePath, { readonly: true });
      const users = sqlite.prepare('SELECT id, username, role, password_hash FROM users').all() as Array<{
        id: number;
        username: string;
        role: string;
        password_hash: string;
      }>;
      const libraries = sqlite.prepare('SELECT id, name, mode, root_path FROM libraries').all() as Array<{
        id: number;
        name: string;
        mode: string;
        root_path: string;
      }>;
      const grants = sqlite.prepare('SELECT user_id, library_id FROM library_grants').all();
      const sessions = sqlite.prepare('SELECT user_id, expires_at FROM sessions').all() as Array<{
        user_id: number;
        expires_at: string;
      }>;
      sqlite.close();

      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ username: 'ada', role: 'admin' });
      expect(users[0]?.password_hash.startsWith('scrypt$')).toBe(true);
      expect(users[0]?.password_hash).not.toContain(password);
      expect(await verifyPassword(password, users[0]?.password_hash ?? '')).toBe(true);
      expect(libraries).toHaveLength(1);
      expect(libraries[0]).toMatchObject({ name: 'Home', mode: 'managed' });
      const root = libraries[0]?.root_path ?? '';
      expect(statSync(root).isDirectory()).toBe(true);
      expect(path.relative(realpathSync(config.dataDir), realpathSync(root))).toBe(
        path.join('libraries', String(libraries[0]?.id)),
      );
      expect(grants).toEqual([{ user_id: users[0]?.id, library_id: libraries[0]?.id }]);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.user_id).toBe(users[0]?.id);
      expect(Date.parse(sessions[0]?.expires_at ?? '')).toBeGreaterThan(Date.now());

      const raw = readFileSync(config.databasePath);
      expect(raw.includes(Buffer.from(password))).toBe(false);
      const wal = `${config.databasePath}-wal`;
      if (existsSync(wal)) expect(readFileSync(wal).includes(Buffer.from(password))).toBe(false);

      const again = await app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { username: 'other', password: 'another-password', libraryName: 'Elsewhere' },
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({ error: 'setup_complete' });

      const after = new Database(config.databasePath, { readonly: true });
      expect((after.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1);
      expect((after.prepare('SELECT COUNT(*) AS n FROM libraries').get() as { n: number }).n).toBe(1);
      after.close();

      const status = await app.inject({ method: 'GET', url: '/api/setup' });
      expect(status.json()).toEqual({ needed: false });
      expect(status.headers['set-cookie']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('denies a missing cookie, allows login, and denies the session after logout', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const { app } = await createApp(temp.dir);

    try {
      await app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { username: 'ada', password, libraryName: 'Home' },
      });

      const missing = await app.inject({ method: 'GET', url: '/api/me' });
      expect(missing.statusCode).toBe(401);
      expect(missing.json()).toEqual({ error: 'unauthorized' });
      expect(missing.headers['set-cookie']).toBeUndefined();
      expect(missing.body).not.toBe('{}');
      expect(missing.body).not.toContain('"ok":true');

      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);

      const bad = await app.inject({
        method: 'POST',
        url: '/api/session/login',
        payload: { username: 'ada', password: 'wrong-password' },
      });
      expect(bad.statusCode).toBe(401);
      expect(bad.json()).toEqual({ error: 'invalid_credentials' });
      expect(bad.headers['set-cookie']).toBeUndefined();

      const unknown = await app.inject({
        method: 'POST',
        url: '/api/session/login',
        payload: { username: 'nobody', password },
      });
      expect(unknown.statusCode).toBe(401);
      expect(unknown.json()).toEqual({ error: 'invalid_credentials' });

      const login = await app.inject({
        method: 'POST',
        url: '/api/session/login',
        payload: { username: 'Ada', password },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json()).toMatchObject({
        user: { username: 'ada', role: 'admin' },
        libraries: [{ name: 'Home', mode: 'managed' }],
      });
      const header = setCookie(login);
      expect(header).toMatch(/HttpOnly/);
      expect(header).toMatch(/SameSite=Lax/);
      expect(header).not.toMatch(/Secure/);

      const cookie = cookiePair(login);
      const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ user: { username: 'ada', role: 'admin' } });

      const logout = await app.inject({ method: 'POST', url: '/api/session/logout', headers: { cookie } });
      expect(logout.statusCode).toBe(204);
      expect(setCookie(logout)).toMatch(/^qijuan_session=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/);

      const after = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
      expect(after.statusCode).toBe(401);
      expect(after.json()).toEqual({ error: 'unauthorized' });
    } finally {
      await app.close();
    }
  });

  it('sets Secure on the session cookie when the request is HTTPS', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const { app } = await createApp(temp.dir, true);

    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/setup',
        headers: { 'x-forwarded-proto': 'https' },
        payload: { username: 'ada', password, libraryName: 'Home' },
      });
      expect(created.statusCode).toBe(201);
      expect(setCookie(created)).toMatch(
        /^qijuan_session=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+; Secure$/,
      );
    } finally {
      await app.close();
    }
  });

  it('denies percent-encoded paths that the router decodes onto protected routes', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const { app } = await createApp(temp.dir);
    const ran: string[] = [];
    const handler = (route: string) => async () => {
      ran.push(route);
      return { ok: true };
    };
    app.get('/books/:id', handler('/books/:id'));
    app.get('/covers/:id', handler('/covers/:id'));
    app.get('/downloads/:id', handler('/downloads/:id'));
    app.get('/search', handler('/search'));
    app.get('/annotations/:id', handler('/annotations/:id'));
    app.get('/opds', handler('/opds'));

    try {
      for (const url of [
        '/%61pi/me',
        '/%62ooks/1',
        '/%63overs/1',
        '/%64ownloads/1',
        '/%73earch',
        '/%61nnotations/1',
        '/%6fpds',
      ]) {
        const denied = await app.inject({ method: 'GET', url });
        expect(denied.statusCode).toBe(401);
        expect(denied.json()).toEqual({ error: 'unauthorized' });
        expect(denied.body).not.toContain('"ok":true');
      }
      expect(ran).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('protects routes registered later for books, covers, downloads, search, annotations, and OPDS', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const { app } = await createApp(temp.dir);
    app.get('/api/books', async () => ({ ok: true }));
    app.get('/covers/:id', async () => ({ ok: true }));
    app.get('/downloads/:id', async () => ({ ok: true }));
    app.get('/search', async () => ({ ok: true }));
    app.get('/annotations/:id', async () => ({ ok: true }));
    app.get('/opds', async () => ({ ok: true }));
    app.get('/books/:id', async () => ({ ok: true }));

    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { username: 'ada', password, libraryName: 'Home' },
      });
      const cookie = cookiePair(created);

      for (const url of ['/api/books', '/covers/1', '/downloads/1', '/search', '/annotations/1', '/opds', '/books/1']) {
        const denied = await app.inject({ method: 'GET', url });
        expect(denied.statusCode).toBe(401);
        expect(denied.json()).toEqual({ error: 'unauthorized' });

        const allowed = await app.inject({ method: 'GET', url, headers: { cookie } });
        expect(allowed.statusCode).toBe(200);
        expect(allowed.json()).toEqual({ ok: true });
      }
    } finally {
      await app.close();
    }
  });

  it('lets an admin create a reader and grant or revoke a library', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const { config, app } = await createApp(temp.dir);

    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { username: 'ada', password, libraryName: 'Home' },
      });
      const adminCookie = cookiePair(created);
      const libraryId = (created.json() as { library: { id: number } }).library.id;

      const unauthenticated = await app.inject({
        method: 'POST',
        url: '/api/users',
        payload: { username: 'bea', password: 'reader-password' },
      });
      expect(unauthenticated.statusCode).toBe(401);

      const reader = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { cookie: adminCookie },
        payload: { username: 'bea', password: 'reader-password' },
      });
      expect(reader.statusCode).toBe(201);
      expect(reader.json()).toEqual({
        user: { id: expect.any(Number), username: 'bea', role: 'reader' },
      });
      expect(reader.body).not.toContain('reader-password');
      expect(reader.body).not.toContain('scrypt$');
      const readerId = (reader.json() as { user: { id: number } }).user.id;

      const taken = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { cookie: adminCookie },
        payload: { username: 'Ada', password: 'another-password' },
      });
      expect(taken.statusCode).toBe(409);
      expect(taken.json()).toEqual({ error: 'username_taken' });

      const adminAttempt = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { cookie: adminCookie },
        payload: { username: 'extra', password: 'another-password', role: 'admin' },
      });
      expect(adminAttempt.statusCode).toBe(400);

      const login = await app.inject({
        method: 'POST',
        url: '/api/session/login',
        payload: { username: 'bea', password: 'reader-password' },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json()).toMatchObject({ user: { username: 'bea', role: 'reader' }, libraries: [] });
      const readerCookie = cookiePair(login);

      const forbidden = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { cookie: readerCookie },
        payload: { username: 'cara', password: 'another-password' },
      });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toEqual({ error: 'forbidden' });

      const before = await app.inject({
        method: 'GET',
        url: '/api/libraries',
        headers: { cookie: readerCookie },
      });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({ libraries: [] });

      const grant = await app.inject({
        method: 'POST',
        url: `/api/libraries/${libraryId}/grants`,
        headers: { cookie: adminCookie },
        payload: { userId: readerId },
      });
      expect(grant.statusCode).toBe(201);
      expect(grant.json()).toEqual({ userId: readerId, libraryId });

      const granted = await app.inject({
        method: 'GET',
        url: '/api/libraries',
        headers: { cookie: readerCookie },
      });
      expect(granted.json()).toEqual({
        libraries: [{ id: libraryId, name: 'Home', mode: 'managed' }],
      });

      const revoke = await app.inject({
        method: 'DELETE',
        url: `/api/libraries/${libraryId}/grants/${readerId}`,
        headers: { cookie: adminCookie },
      });
      expect(revoke.statusCode).toBe(204);

      const revoked = await app.inject({
        method: 'GET',
        url: '/api/libraries',
        headers: { cookie: readerCookie },
      });
      expect(revoked.json()).toEqual({ libraries: [] });

      const readerGrant = await app.inject({
        method: 'POST',
        url: `/api/libraries/${libraryId}/grants`,
        headers: { cookie: readerCookie },
        payload: { userId: readerId },
      });
      expect(readerGrant.statusCode).toBe(403);

      const sqlite = new Database(config.databasePath, { readonly: true });
      const roles = sqlite.prepare('SELECT username, role FROM users ORDER BY id').all();
      sqlite.close();
      expect(roles).toEqual([
        { username: 'ada', role: 'admin' },
        { username: 'bea', role: 'reader' },
      ]);
    } finally {
      await app.close();
    }
  });
});
