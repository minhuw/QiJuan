import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { migrate } from '../../src/migrate.js';
import { defaultMigrationsDir } from '../../src/paths.js';
import { buildEpub } from '../fixtures.js';
import { makeTempDir, tempConfig } from '../helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '../..');
const resticPin = JSON.parse(readFileSync(path.join(serverRoot, 'restic-release.json'), 'utf8')) as {
  version: string;
  url: string;
  sha256: string;
};
const minioPin = JSON.parse(readFileSync(path.join(serverRoot, 'minio-release.json'), 'utf8')) as {
  version: string;
  url: string;
  sha256: string;
};

const cacheDir = path.join(tmpdir(), 'qijuan-acceptance-bin');
const password = 'correct-horse-battery';
const recoveryPassword = 'acceptance-recovery-password';
const accessKey = 'qijuanadmin';
const secretKey = 'qijuan-secret-key';

let resticBin = '';
let minioBin = '';
let minio: ChildProcess | null = null;
let endpoint = '';
const bucket = 'qijuan-accept';
const prefix = `run-${process.pid}`;

beforeAll(async () => {
  mkdirSync(cacheDir, { recursive: true });
  resticBin = await installRestic();
  minioBin = await installMinio();
  const apiPort = await freePort();
  const consolePort = await freePort();
  const data = path.join(cacheDir, `minio-data-${process.pid}`);
  mkdirSync(data, { recursive: true });
  minio = spawn(minioBin, ['server', data, '--address', `127.0.0.1:${apiPort}`, '--console-address', `127.0.0.1:${consolePort}`], {
    env: {
      ...process.env,
      MINIO_ROOT_USER: accessKey,
      MINIO_ROOT_PASSWORD: secretKey,
      MINIO_BROWSER: 'off',
    },
    stdio: 'ignore',
  });
  endpoint = `http://127.0.0.1:${apiPort}`;
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/minio/health/live`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // MinIO is still binding the port.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('MinIO did not become ready');
}, 180_000);

afterAll(async () => {
  if (minio && minio.pid) {
    minio.kill('SIGTERM');
    await new Promise((resolve) => minio?.once('exit', resolve));
  }
});

it(
  'restores a library from a local restic repository and retries an unreadable backup',
  async () => {
    const first = await bootLibrary();
    const edition = await importBook(first.app, first.cookie, first.libraryId);
    const shelf = await first.app.inject({
      method: 'POST',
      url: '/api/shelves',
      headers: { cookie: first.cookie },
      payload: { name: 'Night shelf', editionId: edition.editionId },
    });
    expect(shelf.statusCode).toBe(201);
    const position = await first.app.inject({
      method: 'PUT',
      url: `/api/editions/${edition.editionId}/reading-place`,
      headers: { cookie: first.cookie },
      payload: { locator: 'epubcfi(/6/4!/4/2:10)', assetId: edition.assetId, revision: 0 },
    });
    expect(position.statusCode).toBe(200);
    const highlight = await first.app.inject({
      method: 'POST',
      url: `/api/editions/${edition.editionId}/highlights`,
      headers: { cookie: first.cookie },
      payload: {
        locator: 'epubcfi(/6/4!/4/2:10)',
        assetId: edition.assetId,
        quote: '书有归处',
        revision: 0,
      },
    });
    expect(highlight.statusCode).toBe(201);

    const destination = {
      preset: 'custom',
      endpoint,
      region: 'us-east-1',
      pathStyle: true,
      bucket,
      prefix,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    };
    const saved = await first.app.inject({
      method: 'PUT',
      url: '/api/backup/destination',
      headers: { cookie: first.cookie },
      payload: destination,
    });
    expect(saved.statusCode).toBe(200);
    const recovery = await first.app.inject({
      method: 'POST',
      url: '/api/backup/recovery',
      headers: { cookie: first.cookie },
      payload: { password: recoveryPassword },
    });
    expect(recovery.statusCode).toBe(201);
    const tested = await first.app.inject({
      method: 'POST',
      url: '/api/backup/destination/test',
      headers: { cookie: first.cookie },
    });
    expect(tested.statusCode, tested.body).toBe(200);

    const good = await runBackup(first.app, first.cookie, 'managed');
    expect(good.status).toBe('succeeded');
    const before = await listSnapshots(first.app, first.cookie, destination);
    expect(before.some((snapshot) => snapshot.id === good.snapshotId)).toBe(true);

    const blob = managedBlob(first.config.databasePath, first.config.dataDir);
    const aside = `${blob}.aside`;
    copyFileSync(blob, aside);
    rmSync(blob);
    const broken = await runBackup(first.app, first.cookie, 'managed');
    expect(broken.status).toBe('failed');
    expect(broken.reason ?? '').toMatch(/Cannot read the selected file/);
    const during = await listSnapshots(first.app, first.cookie, destination);
    expect(during.map((snapshot) => snapshot.id)).toEqual(before.map((snapshot) => snapshot.id));
    copyFileSync(aside, blob);

    const retried = await runBackup(first.app, first.cookie, 'managed');
    expect(retried.status).toBe('succeeded');
    expect(retried.snapshotId).toBeTruthy();
    expect(retried.snapshotId).not.toBe(good.snapshotId);

    await first.app.close();
    rmSync(first.config.dataDir, { recursive: true, force: true });

    const freshDir = makeTempDir();
    const freshConfig = tempConfig(freshDir.dir);
    migrate({ databasePath: freshConfig.databasePath, migrationsDir: defaultMigrationsDir() });
    const fresh = await buildApp({
      config: freshConfig,
      clientDist: null,
      logger: false,
      resticBin,
      backupPollMs: 200,
    });
    try {
      const setup = await fresh.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { username: 'temp-admin', password, libraryName: 'Temporary' },
      });
      expect(setup.statusCode).toBe(201);
      const cookie = cookieFrom(setup);
      const listed = await fresh.inject({
        method: 'POST',
        url: '/api/backup/restore/snapshots',
        headers: { cookie },
        payload: { recoveryPassword, destination },
      });
      expect(listed.statusCode, listed.body).toBe(200);
      const snapshots = listed.json().snapshots as Array<{ id: string }>;
      expect(snapshots.some((snapshot) => snapshot.id === retried.snapshotId)).toBe(true);
      const plan = await fresh.inject({
        method: 'POST',
        url: '/api/backup/restore/plan',
        headers: { cookie },
        payload: { recoveryPassword, destination, snapshotId: retried.snapshotId },
      });
      expect(plan.statusCode, plan.body).toBe(200);
      const prepared = plan.json() as {
        planId: string;
        compatible: boolean;
        scope: string;
        counts: { editions: number; shelves: number; highlights: number; readingPositions: number };
        replaces: string[];
      };
      expect(prepared.compatible).toBe(true);
      expect(prepared.scope).not.toBe('metadata-only');
      expect(prepared.counts.editions).toBeGreaterThan(0);
      expect(prepared.counts.shelves).toBeGreaterThan(0);
      expect(prepared.counts.highlights).toBeGreaterThan(0);
      expect(prepared.counts.readingPositions).toBeGreaterThan(0);
      expect(prepared.replaces.join(' ')).toMatch(/shelves|annotations|reading/i);
      const refused = await fresh.inject({
        method: 'POST',
        url: '/api/backup/restore/activate',
        headers: { cookie },
        payload: { planId: prepared.planId, confirm: false },
      });
      expect(refused.statusCode).toBe(400);
      const activated = await fresh.inject({
        method: 'POST',
        url: '/api/backup/restore/activate',
        headers: { cookie },
        payload: { planId: prepared.planId, confirm: true },
      });
      expect(activated.statusCode, activated.body).toBe(200);

      const login = await fresh.inject({
        method: 'POST',
        url: '/api/session/login',
        payload: { username: 'ada', password },
      });
      expect(login.statusCode).toBe(200);
      const restoredCookie = cookieFrom(login);
      const library = await fresh.inject({
        method: 'GET',
        url: '/api/library?limit=20',
        headers: { cookie: restoredCookie },
      });
      expect(library.statusCode).toBe(200);
      const editions = library.json().editions as Array<{ id: number; title: string }>;
      expect(editions.some((row) => row.title.includes('栖卷'))).toBe(true);
      const shelves = await fresh.inject({
        method: 'GET',
        url: '/api/shelves',
        headers: { cookie: restoredCookie },
      });
      expect(shelves.statusCode).toBe(200);
      expect(shelves.json().shelves).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Night shelf' })]),
      );
      const place = await fresh.inject({
        method: 'GET',
        url: `/api/editions/${edition.editionId}/reading-place`,
        headers: { cookie: restoredCookie },
      });
      expect(place.statusCode).toBe(200);
      const reading = place.json() as {
        position: { locator: string } | null;
        highlights: Array<{ quote: string | null }>;
      };
      expect(reading.position?.locator).toBe('epubcfi(/6/4!/4/2:10)');
      expect(reading.highlights.some((row) => row.quote === '书有归处')).toBe(true);
      const file = await fresh.inject({
        method: 'GET',
        url: `/api/editions/${edition.editionId}/assets/${edition.assetId}/file`,
        headers: { cookie: restoredCookie },
      });
      expect(file.statusCode).toBe(200);
      expect(file.rawPayload.subarray(0, 2).toString('utf8')).toBe('PK');
    } finally {
      await fresh.close();
      freshDir.cleanup();
    }
  },
  180_000,
);

async function bootLibrary() {
  const temp = makeTempDir();
  const config = tempConfig(temp.dir);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  const app = await buildApp({ config, clientDist: null, logger: false, resticBin, backupPollMs: 100 });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { username: 'ada', password, libraryName: 'Home' },
  });
  expect(setup.statusCode).toBe(201);
  return { app, config, cookie: cookieFrom(setup), libraryId: setup.json().library.id as number, cleanup: temp.cleanup };
}

async function importBook(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, libraryId: number) {
  const epub = buildEpub();
  const boundary = '----qijuanboundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tale.epub"\r\nContent-Type: application/epub+zip\r\n\r\n`,
    ),
    epub,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const created = await app.inject({
    method: 'POST',
    url: `/api/imports?libraryId=${libraryId}`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  expect(created.statusCode).toBe(202);
  const jobId = created.json().job.id as number;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } });
    const job = response.json().job as {
      status: string;
      items: Array<{ status: string; editionId: number | null; assetId: number | null }>;
    };
    if (job.status === 'succeeded' || job.status === 'failed') {
      expect(job.status).toBe('succeeded');
      const item = job.items[0];
      expect(item?.editionId).toBeTruthy();
      expect(item?.assetId).toBeTruthy();
      return { editionId: item?.editionId ?? 0, assetId: item?.assetId ?? 0 };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('import did not finish');
}

async function runBackup(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, scope: 'managed' | 'metadata-only') {
  const started = await app.inject({
    method: 'POST',
    url: '/api/backup/jobs',
    headers: { cookie },
    payload: { scope },
  });
  expect(started.statusCode, started.body).toBe(202);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: '/api/backup', headers: { cookie } });
    const job = response.json().job as { status: string; reason: string | null; snapshotId: string | null };
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('backup did not finish');
}

async function listSnapshots(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  destination: Record<string, unknown>,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/backup/restore/snapshots',
    headers: { cookie },
    payload: { recoveryPassword, destination },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().snapshots as Array<{ id: string }>;
}

function managedBlob(databasePath: string, dataDir: string): string {
  const sqlite = new Database(databasePath, { readonly: true });
  try {
    const row = sqlite.prepare(`SELECT relative_path AS relativePath FROM file_assets WHERE storage = 'managed' LIMIT 1`).get() as
      | { relativePath: string }
      | undefined;
    if (!row) throw new Error('managed blob missing');
    return path.join(dataDir, row.relativePath);
  } finally {
    sqlite.close();
  }
}

function cookieFrom(response: { headers: { 'set-cookie'?: string | string[] | undefined } }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(';')[0] ?? '';
}

async function installRestic(): Promise<string> {
  const archive = path.join(cacheDir, `restic-${resticPin.sha256}.bz2`);
  const binary = path.join(cacheDir, `restic-${resticPin.sha256}`);
  await downloadVerified(resticPin.url, archive, resticPin.sha256);
  if (!existsSync(binary)) {
    const unpacked = spawnSync('bzip2', ['-dc', archive], { maxBuffer: 80 * 1024 * 1024 });
    if (unpacked.status !== 0) {
      throw new Error(`bzip2 could not unpack the pinned restic binary: ${unpacked.stderr?.toString() ?? ''}`);
    }
    writeFileSync(binary, unpacked.stdout);
    chmodSync(binary, 0o755);
  }
  return binary;
}

async function installMinio(): Promise<string> {
  const binary = path.join(cacheDir, `minio-${minioPin.sha256}`);
  await downloadVerified(minioPin.url, binary, minioPin.sha256);
  chmodSync(binary, 0o755);
  return binary;
}

async function downloadVerified(url: string, dest: string, sha256: string): Promise<void> {
  if (existsSync(dest)) {
    const existing = createHash('sha256').update(readFileSync(dest)).digest('hex');
    if (existing === sha256) return;
    rmSync(dest);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) {
    throw new Error(`Checksum mismatch for ${url}: expected ${sha256}, got ${actual}`);
  }
  writeFileSync(dest, bytes);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
