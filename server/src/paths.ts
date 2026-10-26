import path from 'node:path';

/** Directory of this module: `server/src` in dev, `server/dist` in production. */
function moduleDir(): string {
  return import.meta.dirname;
}

export function defaultMigrationsDir(): string {
  return path.resolve(moduleDir(), '../migrations');
}

export function defaultClientDist(): string {
  return path.resolve(moduleDir(), '../../client/dist');
}
