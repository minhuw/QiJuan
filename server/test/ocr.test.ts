import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { absoluteBlobPath } from '../src/blobs.js';
import { addManagedAsset, createEdition } from '../src/catalog.js';
import { openDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { checkNextPdf, OcrRunError, popplerDetector, requeueInterruptedOcr, type OcrDetector, type OcrRunner } from '../src/ocr.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { assetOcr } from '../src/schema.js';
import { makeTempDir, tempConfig } from './helpers.js';
import { buildEpub, buildImagePdf, buildTextPdf } from './fixtures.js';

const cleanups: Array<() => void> = [];
const password = 'correct horse battery staple';
const readerPassword = 'another long reader passphrase';
const MARK = Buffer.from('\n%qijuan-ocr-test\n');

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type App = Awaited<ReturnType<typeof buildApp>>;

/** A stand-in for OCRmyPDF: the "recognized" copy is the input with a marker appended. */
const copyRunner: OcrRunner = async ({ inputPath, outputPath }) => {
  writeFileSync(outputPath, Buffer.concat([readFileSync(inputPath), MARK]));
};

function cookieFrom(response: { headers: { 'set-cookie'?: string | string[] | undefined } }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(';')[0] ?? '';
}

async function startApp(options: { runner?: OcrRunner; available?: boolean; detector?: OcrDetector } = {}) {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  const config = tempConfig(temp.dir);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  const app = await buildApp({
    config,
    clientDist: null,
    logger: false,
    openLibrary: { fetch: async () => { throw new Error('network disabled in test'); } },
    ratings: { worker: false },
    ocr: {
      runner: options.runner ?? copyRunner,
      available: () => options.available ?? true,
      pollMs: 15,
      auto: options.detector !== undefined,
      detector: options.detector,
    },
  });
  cleanups.push(() => { void app.close(); });
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'ada', password, libraryName: 'Home' } });
  expect(setup.statusCode).toBe(201);
  const libraryId = setup.json().library.id as number;
  const opened = openDatabase(config.databasePath);
  const edition = createEdition(opened.db, { libraryId, title: 'A Scanned Book' });
  const original = buildImagePdf();
  const pdf = addManagedAsset(opened.db, { dataDir: config.dataDir, editionId: edition.id, bytes: original, originalFilename: 'scan.pdf' });
  const epub = addManagedAsset(opened.db, { dataDir: config.dataDir, editionId: edition.id, bytes: buildEpub(), originalFilename: 'book.epub' });
  opened.sqlite.close();
  return { app, config, cookie: cookieFrom(setup), libraryId, editionId: edition.id, pdfId: pdf.id, epubId: epub.id, original };
}

async function call(app: App, cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string) {
  return app.inject({ method, url, headers: { cookie } });
}

async function ocrOf(app: App, cookie: string, editionId: number, assetId: number) {
  const response = await call(app, cookie, 'GET', `/api/editions/${editionId}`);
  expect(response.statusCode).toBe(200);
  return (response.json().edition.assets as Array<{ id: number; ocr: unknown }>).find((asset) => asset.id === assetId)?.ocr;
}

async function waitForOcr(app: App, cookie: string, editionId: number, assetId: number, status: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ocr = (await ocrOf(app, cookie, editionId, assetId)) as { status: string } | null;
    if (ocr?.status === status) return ocr;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`OCR did not reach ${status}`);
}

function ocrRow(databasePath: string, assetId: number) {
  const opened = openDatabase(databasePath);
  try {
    return opened.db.select().from(assetOcr).all().find((row) => row.assetId === assetId) ?? null;
  } finally {
    opened.sqlite.close();
  }
}

describe('automatic ocr', () => {
  it('queues scans and remembers PDFs that already have text, without asking', async () => {
    const checked: string[] = [];
    const detector: OcrDetector = async (pdfPath) => {
      checked.push(pdfPath);
      return true;
    };
    const { app, config, cookie, editionId, pdfId } = await startApp({ detector });
    // The scan is found, queued and recognized by itself; the EPUB is never checked.
    expect(await waitForOcr(app, cookie, editionId, pdfId, 'succeeded')).toMatchObject({ ready: true });
    expect(checked).toHaveLength(1);

    // Removing it turns it off for good: the automatic check does not bring it back.
    expect((await call(app, cookie, 'DELETE', `/api/editions/${editionId}/assets/${pdfId}/ocr`)).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ocrRow(config.databasePath, pdfId)).toMatchObject({ status: 'off' });
    expect(checked).toHaveLength(1);
    // An admin can still ask again.
    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/assets/${pdfId}/ocr`)).statusCode).toBe(202);
    await waitForOcr(app, cookie, editionId, pdfId, 'succeeded');
  });

  it('marks a PDF with text as not needed and shows nothing for it', async () => {
    const { app, config, cookie, editionId, pdfId } = await startApp({ detector: async () => false });
    for (let attempt = 0; attempt < 100 && !ocrRow(config.databasePath, pdfId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(ocrRow(config.databasePath, pdfId)).toMatchObject({ status: 'not_needed', sha256: null });
    expect(await ocrOf(app, cookie, editionId, pdfId)).toBeNull();
    const file = await call(app, cookie, 'GET', `/api/editions/${editionId}/assets/${pdfId}/file`);
    expect(file.headers['x-qijuan-ocr']).toBe('0');
  });

  it('leaves a PDF unchecked when it cannot tell, and never runs without being turned on', async () => {
    const { app, config, cookie } = await startApp();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const opened = openDatabase(config.databasePath);
    try {
      expect(opened.db.select().from(assetOcr).all()).toEqual([]);
      expect(await checkNextPdf(opened.db, config.dataDir, async () => null)).toBe(true);
      expect(opened.db.select().from(assetOcr).all()).toEqual([]);
      // The unreadable file is not tried again in this process.
      expect(await checkNextPdf(opened.db, config.dataDir, async () => true)).toBe(false);
    } finally {
      opened.sqlite.close();
    }
    void app;
    void cookie;
  });

  const poppler = spawnSync('pdftotext', ['-v']).status === 0;
  it.skipIf(!poppler)('tells a text PDF from an image-only one with Poppler', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const text = path.join(temp.dir, 'text.pdf');
    const image = path.join(temp.dir, 'image.pdf');
    writeFileSync(text, buildTextPdf());
    writeFileSync(image, buildImagePdf());
    expect(await popplerDetector(text)).toBe(false);
    expect(await popplerDetector(image)).toBe(true);
    expect(await popplerDetector(path.join(temp.dir, 'missing.pdf'))).toBeNull();
  });
});

describe('ocr', () => {
  it('recognizes a PDF in the background and serves the copy to the reader, never to downloads', async () => {
    const { app, config, cookie, editionId, pdfId, original } = await startApp();
    expect((await call(app, cookie, 'GET', '/api/ocr')).json()).toEqual({ available: true, languages: ['chi_sim', 'eng'] });
    expect(await ocrOf(app, cookie, editionId, pdfId)).toBeNull();

    const queued = await call(app, cookie, 'POST', `/api/editions/${editionId}/assets/${pdfId}/ocr`);
    expect(queued.statusCode).toBe(202);
    const done = await waitForOcr(app, cookie, editionId, pdfId, 'succeeded');
    expect(done).toMatchObject({ status: 'succeeded', ready: true, error: null });

    const reader = await call(app, cookie, 'GET', `/api/editions/${editionId}/assets/${pdfId}/file`);
    expect(reader.headers['x-qijuan-ocr']).toBe('1');
    expect(reader.rawPayload.equals(Buffer.concat([original, MARK]))).toBe(true);
    // Byte ranges work on the copy, which pdf.js uses for large files.
    const ranged = await app.inject({
      method: 'GET', url: `/api/editions/${editionId}/assets/${pdfId}/file`, headers: { cookie, range: 'bytes=0-3' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-range']).toBe(`bytes 0-3/${original.length + MARK.length}`);
    for (const query of ['download=1', 'original=1']) {
      const plain = await call(app, cookie, 'GET', `/api/editions/${editionId}/assets/${pdfId}/file?${query}`);
      expect(plain.headers['x-qijuan-ocr'], query).toBe('0');
      expect(plain.rawPayload.equals(original), query).toBe(true);
    }

    // Removing it releases the copy; the reader is back on the original.
    const copyPath = absoluteBlobPath(config.dataDir, ocrRow(config.databasePath, pdfId)!.sha256!);
    expect(existsSync(copyPath)).toBe(true);
    expect((await call(app, cookie, 'DELETE', `/api/editions/${editionId}/assets/${pdfId}/ocr`)).statusCode).toBe(200);
    expect(existsSync(copyPath)).toBe(false);
    expect(await ocrOf(app, cookie, editionId, pdfId)).toBeNull();
    const after = await call(app, cookie, 'GET', `/api/editions/${editionId}/assets/${pdfId}/file`);
    expect(after.rawPayload.equals(original)).toBe(true);
  });

  it('falls back to the original when the copy is missing, as after a restore', async () => {
    const { app, config, cookie, editionId, pdfId, original } = await startApp();
    await call(app, cookie, 'POST', `/api/editions/${editionId}/assets/${pdfId}/ocr`);
    await waitForOcr(app, cookie, editionId, pdfId, 'succeeded');
    const row = ocrRow(config.databasePath, pdfId)!;
    // Backups leave the copy out; simulate a restored data directory without it.
    unlinkSync(absoluteBlobPath(config.dataDir, row.sha256!));
    const file = await call(app, cookie, 'GET', `/api/editions/${editionId}/assets/${pdfId}/file`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['x-qijuan-ocr']).toBe('0');
    expect(file.rawPayload.equals(original)).toBe(true);
  });

  it('records a failure with a code and keeps serving the original', async () => {
    const failing: OcrRunner = async () => {
      throw new OcrRunError('ocr_failed', 'tesseract: language data missing');
    };
    const { app, cookie, editionId, pdfId, original } = await startApp({ runner: failing });
    await call(app, cookie, 'POST', `/api/editions/${editionId}/assets/${pdfId}/ocr`);
    expect(await waitForOcr(app, cookie, editionId, pdfId, 'failed')).toMatchObject({ ready: false, error: 'ocr_failed' });
    const file = await call(app, cookie, 'GET', `/api/editions/${editionId}/assets/${pdfId}/file`);
    expect(file.rawPayload.equals(original)).toBe(true);
    // A retry is allowed after a failure.
    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/assets/${pdfId}/ocr`)).statusCode).toBe(202);
  });

  it('stops a running recognition when it is removed, and stores nothing', async () => {
    let started = false;
    const waiting: OcrRunner = ({ signal }) => {
      started = true;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new OcrRunError('ocr_cancelled')));
      });
    };
    const { app, config, cookie, editionId, pdfId } = await startApp({ runner: waiting });
    await call(app, cookie, 'POST', `/api/editions/${editionId}/assets/${pdfId}/ocr`);
    await waitForOcr(app, cookie, editionId, pdfId, 'running');
    expect(started).toBe(true);
    expect((await call(app, cookie, 'DELETE', `/api/editions/${editionId}/assets/${pdfId}/ocr`)).statusCode).toBe(200);
    // The worker notices within its watch interval and gives up.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(ocrRow(config.databasePath, pdfId)).toMatchObject({ status: 'off', sha256: null });
    expect(await ocrOf(app, cookie, editionId, pdfId)).toBeNull();
  }, 10_000);

  it('refuses EPUBs, unavailable tools and readers', async () => {
    const { app, cookie, libraryId, editionId, pdfId, epubId } = await startApp({ available: false });
    expect((await call(app, cookie, 'GET', '/api/ocr')).json()).toMatchObject({ available: false });
    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/assets/${pdfId}/ocr`)).json()).toEqual({ error: 'ocr_unavailable' });

    const created = await app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username: 'bea', password: readerPassword } });
    await app.inject({ method: 'POST', url: `/api/libraries/${libraryId}/grants`, headers: { cookie }, payload: { userId: created.json().user.id } });
    const reader = cookieFrom(await app.inject({ method: 'POST', url: '/api/session/login', payload: { username: 'bea', password: readerPassword } }));
    expect((await call(app, reader, 'GET', '/api/ocr')).statusCode).toBe(403);
    expect((await call(app, reader, 'POST', `/api/editions/${editionId}/assets/${pdfId}/ocr`)).statusCode).toBe(403);
    expect((await call(app, reader, 'DELETE', `/api/editions/${editionId}/assets/${pdfId}/ocr`)).statusCode).toBe(403);
    void epubId;
  });

  it('refuses an EPUB and releases the copy when the book is deleted from Trash', async () => {
    const { app, config, cookie, editionId, pdfId, epubId } = await startApp();
    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/assets/${epubId}/ocr`)).statusCode).toBe(400);
    await call(app, cookie, 'POST', `/api/editions/${editionId}/assets/${pdfId}/ocr`);
    await waitForOcr(app, cookie, editionId, pdfId, 'succeeded');
    const copyPath = absoluteBlobPath(config.dataDir, ocrRow(config.databasePath, pdfId)!.sha256!);
    expect((await call(app, cookie, 'POST', `/api/editions/${editionId}/trash`)).statusCode).toBe(200);
    expect(existsSync(copyPath)).toBe(true);
    expect((await call(app, cookie, 'DELETE', `/api/editions/${editionId}`)).statusCode).toBe(200);
    expect(existsSync(copyPath)).toBe(false);
  });

  it('requeues a run cut off by a restart', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = tempConfig(temp.dir);
    migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
    const opened = openDatabase(config.databasePath);
    try {
      const sqlite = opened.sqlite;
      sqlite.prepare("INSERT INTO libraries (name, mode, root_path, created_at) VALUES ('Home', 'managed', ?, 'x')").run(config.dataDir);
      const edition = createEdition(opened.db, { libraryId: 1, title: 'T' });
      const pdf = addManagedAsset(opened.db, { dataDir: config.dataDir, editionId: edition.id, bytes: buildImagePdf(), originalFilename: 'a.pdf' });
      opened.db.insert(assetOcr).values({
        assetId: pdf.id, status: 'running', languages: 'chi_sim+eng', requestedAt: 'x', startedAt: 'y', updatedAt: 'y',
      }).run();
      requeueInterruptedOcr(opened.db);
      expect(opened.db.select().from(assetOcr).get()).toMatchObject({ status: 'queued', startedAt: null });
    } finally {
      opened.sqlite.close();
    }
  });
});
