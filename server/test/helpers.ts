import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type AppConfig } from '../src/config.js';

export function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'qijuan-'));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function tempConfig(dir: string, env: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({ ...env, QIJUAN_DATA_DIR: dir });
}
