import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  R2_PRESET,
  type DestinationConfig,
  type DestinationPreset,
  type PublicDestination,
  repositoryUrl,
} from './model.js';

const DIRECTORY = 'backup';
const DESTINATION_FILE = 'destination.json';
const PASSWORD_FILE = 'recovery-password';
const SHOWN_FILE = 'recovery-shown';

export function backupDir(dataDir: string): string {
  return path.join(dataDir, DIRECTORY);
}

function ensureDir(dataDir: string): string {
  const dir = backupDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function writePrivate(file: string, body: string): void {
  writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
  chmodSync(file, 0o600);
}

export function readDestination(dataDir: string): DestinationConfig | null {
  const file = path.join(backupDir(dataDir), DESTINATION_FILE);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  return parseDestination(parsed);
}

export function writeDestination(dataDir: string, destination: DestinationConfig): void {
  const dir = ensureDir(dataDir);
  writePrivate(path.join(dir, DESTINATION_FILE), `${JSON.stringify(destination)}\n`);
}

export function publicDestination(destination: DestinationConfig): PublicDestination {
  const hint = destination.accessKeyId.slice(-4);
  return {
    preset: destination.preset,
    endpoint: destination.endpoint,
    region: destination.region,
    pathStyle: destination.pathStyle,
    bucket: destination.bucket,
    prefix: destination.prefix,
    accessKeyConfigured: true,
    accessKeyHint: hint.length > 0 ? hint : 'saved',
    secretConfigured: true,
  };
}

export function readRecoveryPassword(dataDir: string): string | null {
  const file = path.join(backupDir(dataDir), PASSWORD_FILE);
  if (!existsSync(file)) return null;
  chmodSync(file, 0o600);
  const password = readFileSync(file, 'utf8').trim();
  return password.length > 0 ? password : null;
}

/** Stores the password outside SQLite. The route shows that value once. */
export function writeRecoveryPassword(dataDir: string, password: string): void {
  const dir = ensureDir(dataDir);
  writePrivate(path.join(dir, PASSWORD_FILE), `${password}\n`);
  writePrivate(path.join(dir, SHOWN_FILE), '');
}

export function recoveryPasswordWasShown(dataDir: string): boolean {
  const marker = path.join(backupDir(dataDir), SHOWN_FILE);
  if (!existsSync(marker)) return false;
  return readFileSync(marker, 'utf8').trim() === 'shown';
}

export function markRecoveryPasswordShown(dataDir: string): void {
  const dir = ensureDir(dataDir);
  writePrivate(path.join(dir, SHOWN_FILE), 'shown\n');
}

export function generateRecoveryPassword(): string {
  return randomBytes(24).toString('base64url');
}

export function recoveryFileText(dataDir: string): string | null {
  const password = readRecoveryPassword(dataDir);
  const destination = readDestination(dataDir);
  if (!password) return null;
  const lines = [
    '# QiJuan recovery file',
    '# Keep this outside the server. It is not stored in the QiJuan database.',
    '# The recovery password is the restic repository password.',
    `recovery-password: ${password}`,
  ];
  if (destination) {
    lines.push(
      `repository: ${repositoryUrl(destination)}`,
      `endpoint: ${destination.endpoint}`,
      `region: ${destination.region}`,
      `path-style: ${destination.pathStyle ? 'true' : 'false'}`,
      `bucket: ${destination.bucket}`,
      `prefix: ${destination.prefix}`,
      `access-key-id: ${destination.accessKeyId}`,
      `secret-access-key: ${destination.secretAccessKey}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function parseDestination(value: unknown): DestinationConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const preset = record.preset === 'r2' ? 'r2' : record.preset === 'custom' ? 'custom' : null;
  const endpoint = cleanEndpoint(record.endpoint);
  const region = cleanToken(record.region, 64);
  const bucket = cleanBucket(record.bucket);
  const prefix = cleanPrefix(record.prefix);
  const accessKeyId = cleanSecret(record.accessKeyId);
  const secretAccessKey = cleanSecret(record.secretAccessKey);
  const pathStyle = record.pathStyle;
  if (!preset || !endpoint || !region || !bucket || prefix === null || !accessKeyId || !secretAccessKey) return null;
  if (typeof pathStyle !== 'boolean') return null;
  return { preset, endpoint, region, pathStyle, bucket, prefix, accessKeyId, secretAccessKey };
}

export function destinationFromInput(value: unknown, previous: DestinationConfig | null): DestinationConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const preset: DestinationPreset = record.preset === 'r2' ? 'r2' : 'custom';
  const filled = preset === 'r2' ? R2_PRESET : null;
  const endpoint = cleanEndpoint(record.endpoint === undefined && filled ? filled.endpoint : record.endpoint);
  const region = cleanToken(record.region === undefined && filled ? filled.region : record.region, 64);
  const pathStyle =
    typeof record.pathStyle === 'boolean' ? record.pathStyle : filled ? filled.pathStyle : null;
  const bucket = cleanBucket(record.bucket);
  const prefix = cleanPrefix(record.prefix);
  const accessRaw = record.accessKeyId;
  const accessKeyId =
    typeof accessRaw === 'string' && accessRaw.trim() === '' && previous
      ? previous.accessKeyId
      : cleanSecret(accessRaw);
  const secretRaw = record.secretAccessKey;
  const secretAccessKey =
    typeof secretRaw === 'string' && secretRaw.trim() === '' && previous
      ? previous.secretAccessKey
      : cleanSecret(secretRaw);
  if (!endpoint || !region || pathStyle === null || !bucket || prefix === null || !accessKeyId || !secretAccessKey) {
    return null;
  }
  return { preset, endpoint, region, pathStyle, bucket, prefix, accessKeyId, secretAccessKey };
}

function cleanEndpoint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 300 || /[\u0000-\u001f\u007f\s]/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

function cleanToken(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f\u007f\s]/.test(trimmed)) return null;
  return trimmed;
}

function cleanBucket(value: unknown): string | null {
  const token = cleanToken(value, 63);
  if (!token || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(token)) return null;
  return token;
}

function cleanPrefix(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed.length > 200 || /[\u0000-\u001f\u007f\\]/.test(trimmed) || trimmed.split('/').includes('..')) return null;
  if (trimmed && !/^[A-Za-z0-9._/-]+$/.test(trimmed)) return null;
  return trimmed;
}

function cleanSecret(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length < 1 || value.length > 200 || value.includes('\u0000') || /^\s|\s$/.test(value)) return null;
  return value;
}
