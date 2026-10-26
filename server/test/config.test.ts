import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, parseLibraryPaths, prepareFilesystem } from '../src/config.js';
import { makeTempDir } from './helpers.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('config', () => {
  it('defaults port, trust proxy, data dir, and library path', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = loadConfig({ QIJUAN_DATA_DIR: temp.dir });
    expect(config.port).toBe(8080);
    expect(config.trustProxy).toBe(false);
    expect(config.dataDir).toBe(temp.dir);
    expect(config.databasePath).toBe(path.join(temp.dir, 'qijuan.sqlite'));
    expect(config.libraryPaths).toEqual([path.join(temp.dir, 'library')]);
    expect(existsSync(path.join(temp.dir, 'session.secret'))).toBe(true);
  });

  it('persists a session secret when QIJUAN_SESSION_SECRET is unset', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const first = loadConfig({ QIJUAN_DATA_DIR: temp.dir });
    const file = path.join(temp.dir, 'session.secret');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8').trim()).toBe(first.sessionSecret);
    expect(first.sessionSecret.length).toBeGreaterThanOrEqual(32);

    const second = loadConfig({ QIJUAN_DATA_DIR: temp.dir });
    expect(second.sessionSecret).toBe(first.sessionSecret);
  });

  it('uses QIJUAN_SESSION_SECRET without replacing the file', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = loadConfig({
      QIJUAN_DATA_DIR: temp.dir,
      QIJUAN_SESSION_SECRET: 'env-secret',
    });
    expect(config.sessionSecret).toBe('env-secret');
    expect(existsSync(path.join(temp.dir, 'session.secret'))).toBe(false);
  });

  it('accepts configurable library paths, port, and trust proxy', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const books = path.join(temp.dir, 'books');
    const imports = path.join(temp.dir, 'imports');
    const config = loadConfig({
      QIJUAN_DATA_DIR: temp.dir,
      QIJUAN_PORT: '9090',
      QIJUAN_TRUST_PROXY: 'true',
      QIJUAN_LIBRARY_PATHS: [books, imports].join(path.delimiter),
    });
    expect(config.port).toBe(9090);
    expect(config.trustProxy).toBe(true);
    expect(config.libraryPaths).toEqual([path.resolve(books), path.resolve(imports)]);

    prepareFilesystem(config);
    expect(existsSync(books)).toBe(true);
    expect(existsSync(imports)).toBe(true);
  });

  it('rejects an invalid port before creating a data directory', () => {
    const missing = path.join('/tmp', `qijuan-missing-${Date.now()}`);
    expect(() => loadConfig({ QIJUAN_DATA_DIR: missing, QIJUAN_PORT: 'nope' })).toThrow(/QIJUAN_PORT/);
    expect(existsSync(missing)).toBe(false);
  });

  it('splits library paths on the platform delimiter', () => {
    const paths = parseLibraryPaths(`one${path.delimiter}two`, '/data');
    expect(paths).toEqual([path.resolve('one'), path.resolve('two')]);
  });
});
