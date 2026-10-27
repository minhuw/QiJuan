import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const RETENTION_DAILY = 7;
export const RETENTION_WEEKLY = 4;
export const RETENTION_MONTHLY = 6;

/** Shown in the manifest and the UI for a run that omits book files. */
export const METADATA_ONLY_SCOPE = 'metadata-only';

/**
 * Cloudflare R2 preset. It only fills the endpoint template, region `auto`,
 * and path-style addressing. Live R2 was not tested.
 */
export const R2_PRESET = {
  preset: 'r2' as const,
  endpoint: 'https://accountid.r2.cloudflarestorage.com',
  region: 'auto',
  pathStyle: true,
};

export type DestinationPreset = 'custom' | 'r2';
export type BackupScopeChoice = 'metadata-only' | 'managed';

export interface DestinationConfig {
  preset: DestinationPreset;
  endpoint: string;
  region: string;
  pathStyle: boolean;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface PublicDestination {
  preset: DestinationPreset;
  endpoint: string;
  region: string;
  pathStyle: boolean;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretConfigured: true;
}

export interface BackupJobView {
  id: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  scope: string;
  phase: string | null;
  reason: string | null;
  snapshotId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ScheduleView {
  enabled: boolean;
  intervalHours: number;
  nextRunAt: string | null;
  retentionDaily: number;
  retentionWeekly: number;
  retentionMonthly: number;
  scope: BackupScopeChoice;
  indexedLibraryIds: number[];
}

export interface LibraryMapEntry {
  id: number;
  name: string;
  mode: 'managed' | 'indexed';
  rootPath: string;
  included: boolean;
}

export interface BackupManifest {
  format: 1;
  app: 'qijuan';
  appVersion: string;
  schemaVersion: string;
  createdAt: string;
  scope: string;
  metadataOnly: boolean;
  storageMap: {
    database: 'qijuan.sqlite';
    secret: 'session.secret';
    blobs: 'blobs' | null;
    indexed: 'indexed' | null;
    recover: 'recover.json';
    libraries: LibraryMapEntry[];
  };
}

export function scopeLabel(scope: BackupScopeChoice, indexedLibraryIds: number[]): string {
  if (scope === 'metadata-only') return METADATA_ONLY_SCOPE;
  return indexedLibraryIds.length > 0 ? 'managed+indexed' : 'managed';
}

export function repositoryUrl(destination: DestinationConfig): string {
  const endpoint = destination.endpoint.replace(/\/+$/, '');
  const prefix = destination.prefix.replace(/^\/+|\/+$/g, '');
  return prefix ? `s3:${endpoint}/${destination.bucket}/${prefix}` : `s3:${endpoint}/${destination.bucket}`;
}

export function resticOptions(destination: DestinationConfig): string[] {
  return [
    '-o',
    `s3.bucket-lookup=${destination.pathStyle ? 'path' : 'dns'}`,
    '-o',
    `s3.region=${destination.region}`,
    '-r',
    repositoryUrl(destination),
  ];
}

export function appVersion(): string {
  const here = import.meta.dirname;
  const candidates = [path.resolve(here, '../../../package.json'), path.resolve(here, '../../../../package.json')];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version.trim();
    } catch {
      // Try the next layout (src vs dist).
    }
  }
  return '0.0.0';
}

export function migrationNames(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));
}

export function latestSchemaVersion(migrationsDir: string): string {
  const names = migrationNames(migrationsDir);
  const latest = names[names.length - 1];
  if (!latest) throw new Error('No schema migrations are packaged');
  return latest;
}

export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text.replace(/\s+/g, ' ').trim();
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join('[Redacted]');
  }
  if (out.length > 500) out = `${out.slice(0, 500)}…`;
  return out;
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export class BackupJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupJobError';
  }
}

export function keptSnapshotReason(detail: string): string {
  const text = detail.trim().replace(/\s+/g, ' ');
  const core = text.endsWith('.') ? text : `${text}.`;
  return `${core} Retry the backup. The last successful snapshot was kept.`;
}
