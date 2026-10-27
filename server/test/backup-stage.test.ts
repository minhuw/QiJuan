import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installSnapshotFiles } from '../src/backup/stage.js';
import { makeTempDir } from './helpers.js';

function writeManifest(root: string, metadataOnly: boolean): void {
  const manifest = {
    format: 1,
    app: 'qijuan',
    appVersion: '0.0.0',
    schemaVersion: '0001_init.sql',
    createdAt: '2026-04-01T00:00:00.000Z',
    scope: metadataOnly ? 'metadata-only' : 'managed',
    metadataOnly,
    storageMap: {
      database: 'qijuan.sqlite',
      secret: 'session.secret',
      blobs: metadataOnly ? null : 'blobs',
      indexed: null,
      recover: 'recover.json',
      libraries: [],
    },
  };
  writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  writeFileSync(path.join(root, 'qijuan.sqlite'), 'snapshot-db');
  writeFileSync(path.join(root, 'session.secret'), 'snapshot-secret');
}

describe('installSnapshotFiles', () => {
  it('does not delete or replace managed blobs for a metadata-only snapshot', () => {
    const data = makeTempDir();
    const snapshot = makeTempDir();
    try {
      const live = path.join(data.dir, 'blobs', 'ab');
      mkdirSync(live, { recursive: true });
      writeFileSync(path.join(live, 'book'), 'live-book');
      mkdirSync(path.join(snapshot.dir, 'blobs', 'cd'), { recursive: true });
      writeFileSync(path.join(snapshot.dir, 'blobs', 'cd', 'other'), 'snapshot-book');
      writeFileSync(path.join(data.dir, 'qijuan.sqlite'), 'old-db');
      writeFileSync(path.join(data.dir, 'qijuan.sqlite-wal'), 'wal');
      writeManifest(snapshot.dir, true);

      installSnapshotFiles(snapshot.dir, data.dir, path.join(data.dir, 'qijuan.sqlite'));

      expect(readFileSync(path.join(data.dir, 'qijuan.sqlite'), 'utf8')).toBe('snapshot-db');
      expect(readFileSync(path.join(data.dir, 'session.secret'), 'utf8')).toBe('snapshot-secret');
      expect(existsSync(path.join(data.dir, 'qijuan.sqlite-wal'))).toBe(false);
      expect(readFileSync(path.join(live, 'book'), 'utf8')).toBe('live-book');
      expect(existsSync(path.join(data.dir, 'blobs', 'cd', 'other'))).toBe(false);
    } finally {
      data.cleanup();
      snapshot.cleanup();
    }
  });

  it('replaces managed blobs for a full snapshot', () => {
    const data = makeTempDir();
    const snapshot = makeTempDir();
    try {
      const live = path.join(data.dir, 'blobs', 'ab');
      mkdirSync(live, { recursive: true });
      writeFileSync(path.join(live, 'book'), 'live-book');
      mkdirSync(path.join(snapshot.dir, 'blobs', 'cd'), { recursive: true });
      writeFileSync(path.join(snapshot.dir, 'blobs', 'cd', 'other'), 'snapshot-book');
      writeFileSync(path.join(data.dir, 'qijuan.sqlite'), 'old-db');
      writeManifest(snapshot.dir, false);

      installSnapshotFiles(snapshot.dir, data.dir, path.join(data.dir, 'qijuan.sqlite'));

      expect(readFileSync(path.join(data.dir, 'qijuan.sqlite'), 'utf8')).toBe('snapshot-db');
      expect(existsSync(path.join(live, 'book'))).toBe(false);
      expect(readFileSync(path.join(data.dir, 'blobs', 'cd', 'other'), 'utf8')).toBe('snapshot-book');
    } finally {
      data.cleanup();
      snapshot.cleanup();
    }
  });

  it('leaves the data directory alone when the manifest cannot be read', () => {
    const data = makeTempDir();
    const snapshot = makeTempDir();
    try {
      const live = path.join(data.dir, 'blobs', 'ab');
      mkdirSync(live, { recursive: true });
      writeFileSync(path.join(live, 'book'), 'live-book');
      writeFileSync(path.join(data.dir, 'qijuan.sqlite'), 'old-db');
      writeFileSync(path.join(snapshot.dir, 'manifest.json'), '{');
      writeFileSync(path.join(snapshot.dir, 'qijuan.sqlite'), 'snapshot-db');
      writeFileSync(path.join(snapshot.dir, 'session.secret'), 'snapshot-secret');

      expect(() => installSnapshotFiles(snapshot.dir, data.dir, path.join(data.dir, 'qijuan.sqlite'))).toThrow(/manifest/);
      expect(readFileSync(path.join(data.dir, 'qijuan.sqlite'), 'utf8')).toBe('old-db');
      expect(readFileSync(path.join(live, 'book'), 'utf8')).toBe('live-book');
      expect(existsSync(path.join(data.dir, 'session.secret'))).toBe(false);
    } finally {
      data.cleanup();
      snapshot.cleanup();
    }
  });
});
