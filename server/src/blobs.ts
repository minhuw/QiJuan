import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

/** Two hex characters, matching `data/blobs/<prefix>/<sha256>`. */
export const BLOB_PREFIX_LENGTH = 2;

const SHA256_RE = /^[a-f0-9]{64}$/;

export class BlobStoreError extends Error {
  readonly code: 'invalid_sha256' | 'invalid_data_dir' | 'invalid_bytes' | 'blob_conflict' | 'blob_write_failed';

  constructor(code: BlobStoreError['code']) {
    super(code);
    this.name = 'BlobStoreError';
    this.code = code;
  }
}

export interface BlobLocation {
  sha256: string;
  bytes: number;
  relativePath: string;
  absolutePath: string;
  /** False when the hash was already stored and the existing file was left unchanged. */
  written: boolean;
}

export function normalizeSha256(value: string): string {
  const hash = value.trim().toLowerCase();
  if (!SHA256_RE.test(hash)) throw new BlobStoreError('invalid_sha256');
  return hash;
}

/** Path relative to the data directory: `blobs/<prefix>/<sha256>`. */
export function managedBlobRelativePath(sha256: string): string {
  const hash = normalizeSha256(sha256);
  return `blobs/${hash.slice(0, BLOB_PREFIX_LENGTH)}/${hash}`;
}

export function absoluteBlobPath(dataDir: string, sha256: string): string {
  const root = resolveDataDir(dataDir);
  const relativePath = managedBlobRelativePath(sha256);
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const rel = path.relative(root, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new BlobStoreError('invalid_sha256');
  return absolute;
}

/**
 * Writes content-addressed bytes. An existing blob is never opened for write,
 * truncated, or replaced.
 */
export function writeImmutableBlob(dataDir: string, body: Buffer): BlobLocation {
  if (!Buffer.isBuffer(body)) throw new BlobStoreError('invalid_bytes');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const relativePath = managedBlobRelativePath(sha256);
  const absolutePath = absoluteBlobPath(dataDir, sha256);
  mkdirSync(path.dirname(absolutePath), { recursive: true });

  if (existsSync(absolutePath)) {
    assertExistingBlob(absolutePath, body.length);
    return { sha256, bytes: body.length, relativePath, absolutePath, written: false };
  }

  const incoming = path.join(resolveDataDir(dataDir), 'blobs', '.incoming');
  mkdirSync(incoming, { recursive: true });
  const tempPath = path.join(incoming, `${sha256}.${process.pid}.${randomBytes(8).toString('hex')}`);
  const fd = openSync(tempPath, 'wx', 0o644);
  try {
    writeAll(fd, body);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(tempPath);
    throw error;
  }
  closeSync(fd);

  let written = false;
  try {
    try {
      linkSync(tempPath, absolutePath);
      written = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      assertExistingBlob(absolutePath, body.length);
    }
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }

  return { sha256, bytes: body.length, relativePath, absolutePath, written };
}

/** Removes one blob file. Symlinks are unlinked themselves and their targets are left alone. */
export function removeBlobFile(dataDir: string, sha256: string): boolean {
  const absolutePath = absoluteBlobPath(dataDir, sha256);
  if (!existsSync(absolutePath)) return false;
  const stat = lstatSync(absolutePath);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new BlobStoreError('blob_conflict');
  unlinkSync(absolutePath);
  return true;
}

export function hashFile(filePath: string): { sha256: string; bytes: number } {
  const hash = createHash('sha256');
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while (true) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
    return { sha256: hash.digest('hex'), bytes };
  } finally {
    closeSync(fd);
  }
}

function resolveDataDir(dataDir: string): string {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') throw new BlobStoreError('invalid_data_dir');
  return path.resolve(dataDir);
}

function assertExistingBlob(absolutePath: string, bytes: number): void {
  const stat = statSync(absolutePath);
  if (!stat.isFile() || stat.size !== bytes) throw new BlobStoreError('blob_conflict');
}

function writeAll(fd: number, body: Buffer): void {
  let offset = 0;
  while (offset < body.length) {
    const wrote = writeSync(fd, body, offset, body.length - offset);
    if (wrote <= 0) throw new BlobStoreError('blob_write_failed');
    offset += wrote;
  }
}
