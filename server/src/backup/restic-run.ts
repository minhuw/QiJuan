import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { DestinationConfig } from './model.js';

export interface ResticRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface ResticRunOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  onStdout?: (chunk: string) => void;
}

export interface ResticRunner {
  run(args: string[], options: ResticRunOptions): Promise<ResticRunResult>;
}

export interface ResticRelease {
  version: string;
  filename: string;
  url: string;
  sha256: string;
}

export function readResticRelease(): ResticRelease {
  const file = path.resolve(import.meta.dirname, '../../restic-release.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ResticRelease>;
  if (!parsed.version || !parsed.url || !parsed.sha256 || !/^[a-f0-9]{64}$/.test(parsed.sha256)) {
    throw new Error('restic release pin is incomplete');
  }
  return {
    version: parsed.version,
    filename: parsed.filename ?? `restic_${parsed.version}_linux_amd64.bz2`,
    url: parsed.url,
    sha256: parsed.sha256,
  };
}

export function resolveResticBin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.QIJUAN_RESTIC_BIN?.trim();
  return configured || 'restic';
}

export function createSpawnRunner(bin: string): ResticRunner {
  return {
    run(args, options) {
      return spawnRestic(bin, args, options);
    },
  };
}

export function resticEnvironment(
  dataDir: string,
  destination: DestinationConfig,
  password: string,
): NodeJS.ProcessEnv {
  const cacheDir = path.join(dataDir, 'backup', 'cache');
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: cacheDir,
    LANG: 'C',
    RESTIC_PASSWORD: password,
    RESTIC_CACHE_DIR: cacheDir,
    AWS_ACCESS_KEY_ID: destination.accessKeyId,
    AWS_SECRET_ACCESS_KEY: destination.secretAccessKey,
    AWS_DEFAULT_REGION: destination.region,
    AWS_SHARED_CREDENTIALS_FILE: path.join(cacheDir, 'aws-none'),
    MINIO_SHARED_CREDENTIALS_FILE: path.join(cacheDir, 'minio-none'),
  };
}

function spawnRestic(bin: string, args: string[], options: ResticRunOptions): Promise<ResticRunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        env: options.env,
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'restic failed to start';
      resolve({ code: null, signal: null, stdout: '', stderr: message });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = tail(stdout + chunk, 1_000_000);
      options.onStdout?.(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = tail(stderr + chunk, 200_000);
    });
    child.on('error', (error) => {
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
      });
    });
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function tail(value: string, max: number): string {
  return value.length > max ? value.slice(value.length - max) : value;
}

export interface ResticMessages {
  snapshotId: string | null;
  errorMessage: string | null;
  percent: number | null;
}

export function parseResticMessages(stdout: string): ResticMessages {
  let snapshotId: string | null = null;
  let errorMessage: string | null = null;
  let percent: number | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (message.message_type === 'summary' && typeof message.snapshot_id === 'string') {
      snapshotId = message.snapshot_id;
    }
    if (message.message_type === 'status' && typeof message.percent_done === 'number') {
      percent = message.percent_done;
    }
    if (message.message_type === 'exit_error' && typeof message.message === 'string') {
      errorMessage = message.message;
    }
    if (message.message_type === 'error') {
      const nested = message.error;
      if (typeof nested === 'object' && nested !== null && 'message' in nested) {
        const text = (nested as { message?: unknown }).message;
        if (typeof text === 'string') errorMessage = text;
      }
    }
  }
  return { snapshotId, errorMessage, percent };
}
