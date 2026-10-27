import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { OPEN_LIBRARY_ORIGIN } from '../src/metadata/openLibrary.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir } from './helpers.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function configIn(dir: string): AppConfig {
  return {
    dataDir: dir,
    port: 8080,
    trustProxy: false,
    sessionSecret: 'test-secret-should-not-leak',
    libraryPaths: [path.join(dir, 'library')],
    databasePath: path.join(dir, 'qijuan.sqlite'),
    migrationsDir: path.join(dir, 'migrations'),
    maxUploadBytes: 128 * 1024 * 1024,
    openLibraryOrigin: OPEN_LIBRARY_ORIGIN,
  };
}

describe('GET /health', () => {
  it('returns ok without auth or private data', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = configIn(temp.dir);
    migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
    const app = await buildApp({ config, clientDist: null, logger: false });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.body).not.toContain('test-secret-should-not-leak');
    expect(response.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it('serves a built client and falls back to index.html', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const clientDist = path.join(temp.dir, 'client');
    mkdirSync(clientDist);
    writeFileSync(path.join(clientDist, 'index.html'), '<!doctype html><title>QiJuan</title>');
    writeFileSync(path.join(clientDist, 'app.js'), 'console.log("qijuan")');

    const config = configIn(temp.dir);
    migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
    const app = await buildApp({
      config,
      clientDist,
      logger: false,
    });

    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('QiJuan');

    const script = await app.inject({ method: 'GET', url: '/app.js' });
    expect(script.statusCode).toBe(200);
    expect(script.body).toContain('qijuan');

    const fallback = await app.inject({
      method: 'GET',
      url: '/shelf/later',
      headers: { accept: 'text/html' },
    });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.body).toContain('QiJuan');

    const missingApi = await app.inject({
      method: 'GET',
      url: '/api/missing',
      headers: { accept: 'application/json' },
    });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toEqual({ error: 'not_found' });

    await app.close();
  });
});
