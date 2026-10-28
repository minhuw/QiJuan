import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SHA = /^[0-9a-f]{7,40}$/i;

/** Commit stamped into an image, otherwise the checkout's HEAD, otherwise `dev`. */
export function resolveRevision(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const fromEnv = env.QIJUAN_REVISION?.trim() ?? '';
  if (fromEnv === 'dev') return 'dev';
  if (SHA.test(fromEnv)) return fromEnv.toLowerCase();
  for (const dir of [cwd, path.resolve(cwd, '..')]) {
    if (!existsSync(path.join(dir, '.git'))) continue;
    try {
      const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (SHA.test(sha)) return sha.toLowerCase();
    } catch {
      // git is missing, or this directory is not a work tree.
    }
  }
  return 'dev';
}
