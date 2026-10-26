import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyServerOptions } from 'fastify';
import { defaultMigrationsDir } from './paths.js';

const SECRET_FILE = 'session.secret';

export type TrustProxy = NonNullable<FastifyServerOptions['trustProxy']>;

export interface AppConfig {
  dataDir: string;
  port: number;
  trustProxy: TrustProxy;
  sessionSecret: string;
  libraryPaths: string[];
  databasePath: string;
  migrationsDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = parsePort(env.QIJUAN_PORT);
  const trustProxy = parseTrustProxy(env.QIJUAN_TRUST_PROXY);
  const dataDir = path.resolve(env.QIJUAN_DATA_DIR?.trim() || './data');
  const libraryPaths = parseLibraryPaths(env.QIJUAN_LIBRARY_PATHS, dataDir);
  const databasePath = path.join(dataDir, 'qijuan.sqlite');
  const migrationsDir = env.QIJUAN_MIGRATIONS_DIR?.trim()
    ? path.resolve(env.QIJUAN_MIGRATIONS_DIR.trim())
    : defaultMigrationsDir();

  mkdirSync(dataDir, { recursive: true });
  const sessionSecret = loadSessionSecret(dataDir, env.QIJUAN_SESSION_SECRET);

  return {
    dataDir,
    port,
    trustProxy,
    sessionSecret,
    libraryPaths,
    databasePath,
    migrationsDir,
  };
}

/** Creates library directories. The data directory is created when config is loaded. */
export function prepareFilesystem(config: AppConfig): void {
  mkdirSync(config.dataDir, { recursive: true });
  for (const libraryPath of config.libraryPaths) {
    mkdirSync(libraryPath, { recursive: true });
  }
}

export function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 8080;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`Invalid QIJUAN_PORT: ${value}`);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid QIJUAN_PORT: ${value}`);
  }
  return port;
}

export function parseTrustProxy(value: string | undefined): TrustProxy {
  if (value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed === '' || /^(false|no|off|0)$/i.test(trimmed)) return false;
  if (/^(true|yes|on)$/i.test(trimmed)) return true;
  if (/^[1-9]\d*$/.test(trimmed)) {
    const hops = Number(trimmed);
    return (_address, hop) => hop < hops;
  }
  return trimmed;
}

export function parseLibraryPaths(value: string | undefined, dataDir: string): string[] {
  const fallback = [path.join(dataDir, 'library')];
  if (value === undefined || value.trim() === '') return fallback;
  const parts = value
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => path.resolve(part));
  return parts.length > 0 ? parts : fallback;
}

function loadSessionSecret(dataDir: string, fromEnv: string | undefined): string {
  const configured = fromEnv?.trim();
  if (configured) return configured;

  const file = path.join(dataDir, SECRET_FILE);
  if (existsSync(file)) {
    chmodSync(file, 0o600);
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  }

  const secret = randomBytes(32).toString('hex');
  try {
    writeFileSync(file, `${secret}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
    return secret;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
    chmodSync(file, 0o600);
    const existing = readFileSync(file, 'utf8').trim();
    if (!existing) throw new Error(`Session secret file is empty: ${file}`);
    return existing;
  }
}
