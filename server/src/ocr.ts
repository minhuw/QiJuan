import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { absoluteBlobPath, managedBlobRelativePath, writeImmutableBlob } from './blobs.js';
import { CatalogError } from './catalog.js';
import type { AppDatabase } from './db.js';
import { releaseUnreferenced } from './edition-fields.js';
import { openAssetStream } from './reader.js';
import { assetOcr, editions, fileAssets } from './schema.js';
import { holder } from './work-gate.js';

/**
 * Text recognition for scanned PDFs. OCRmyPDF adds an invisible text layer to each page that has
 * none and leaves the page images and geometry as they are, so the reader can search and select
 * the text and existing highlights keep their places. Everything runs on this server.
 */

/** Simplified Chinese and English, in that order of preference. */
export const OCR_LANGUAGES = 'chi_sim+eng';
const OCR_POLL_MS = 2000;
const STDERR_TAIL = 4000;

export type OcrStatus = 'queued' | 'running' | 'succeeded' | 'failed';
/** Stored only: the PDF has text already, or an admin removed its OCR. Neither is shown or run automatically. */
type QuietStatus = 'not_needed' | 'off';

/** Runs one recognition from `inputPath` to `outputPath`. Rejects on failure; aborts on `signal`. */
export type OcrRunner = (input: { inputPath: string; outputPath: string; languages: string; signal: AbortSignal }) => Promise<void>;

export interface OcrView {
  status: OcrStatus;
  /** A recognized copy is in place and the reader opens it. Can be true while a new run is queued. */
  ready: boolean;
  /** failed only: a short code, never tool output. */
  error: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export class OcrRunError extends Error {
  constructor(readonly code: 'ocr_failed' | 'ocr_unavailable' | 'ocr_cancelled', readonly detail = '') {
    super(code);
    this.name = 'OcrRunError';
  }
}

/** The OCRmyPDF command, overridable for installs that keep it off PATH. */
export function ocrCommand(): string {
  return process.env.QIJUAN_OCRMYPDF?.trim() || 'ocrmypdf';
}

let cachedAvailable: { command: string; available: boolean } | null = null;

/** Whether OCRmyPDF answers `--version`. Checked once per command. */
export function ocrAvailable(command = ocrCommand()): boolean {
  if (cachedAvailable?.command === command) return cachedAvailable.available;
  let available = false;
  try {
    available = spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 15_000 }).status === 0;
  } catch {
    available = false;
  }
  cachedAvailable = { command, available };
  return available;
}

/** Half the cores, so reading and serving stay responsive during a long run. */
function ocrJobs(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

export function createOcrmypdfRunner(command = ocrCommand()): OcrRunner {
  return ({ inputPath, outputPath, languages, signal }) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        command,
        [
          '--language', languages,
          // Pages that already carry text are left alone; only image pages are recognized.
          '--skip-text',
          '--output-type', 'pdf',
          // Keep page images untouched, and never rotate or deskew: highlight positions depend on it.
          '--optimize', '0',
          '--jobs', String(ocrJobs()),
          '--quiet',
          inputPath,
          outputPath,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], signal },
      );
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.name === 'AbortError') reject(new OcrRunError('ocr_cancelled'));
        else if (error.code === 'ENOENT') reject(new OcrRunError('ocr_unavailable'));
        else reject(new OcrRunError('ocr_failed', error.message));
      });
      child.on('close', (code) => {
        if (signal.aborted) reject(new OcrRunError('ocr_cancelled'));
        else if (code === 0) resolve();
        else reject(new OcrRunError('ocr_failed', `exit ${code}: ${stderr.trim()}`));
      });
    });
}

/** Without a data directory, `ready` means a copy is recorded; the file route checks the disk. */
function presentRow(row: typeof assetOcr.$inferSelect & { status: OcrStatus }, dataDir?: string): OcrView {
  return {
    status: row.status,
    ready: dataDir === undefined ? Boolean(row.sha256) : copyPath(dataDir, row) !== null,
    error: row.status === 'failed' ? row.error ?? 'ocr_failed' : null,
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/** OCR state of each asset of an edition that has any, keyed by asset id. */
export function editionOcr(db: AppDatabase, editionId: number, dataDir?: string): Map<number, OcrView> {
  const rows = db
    .select({ ocr: assetOcr })
    .from(assetOcr)
    .innerJoin(fileAssets, eq(fileAssets.id, assetOcr.assetId))
    .where(eq(fileAssets.editionId, editionId))
    .all();
  return new Map(
    rows.flatMap(({ ocr }) => (isQuiet(ocr.status) ? [] : [[ocr.assetId, presentRow({ ...ocr, status: ocr.status }, dataDir)] as const])),
  );
}

function isQuiet(status: OcrStatus | QuietStatus): status is QuietStatus {
  return status === 'not_needed' || status === 'off';
}

function copyPath(dataDir: string, row: { sha256: string | null; relativePath: string | null }): string | null {
  if (!row.sha256 || row.relativePath !== managedBlobRelativePath(row.sha256)) return null;
  try {
    const absolute = absoluteBlobPath(dataDir, row.sha256);
    return existsSync(absolute) ? absolute : null;
  } catch {
    return null;
  }
}

/** The recognized copy of an asset, when one is stored and present on disk. */
export function ocrCopy(db: AppDatabase, dataDir: string, assetId: number): { absolutePath: string; bytes: number } | null {
  const row = db.select().from(assetOcr).where(eq(assetOcr.assetId, assetId)).get();
  if (!row) return null;
  const absolute = copyPath(dataDir, row);
  return absolute && row.bytes != null ? { absolutePath: absolute, bytes: row.bytes } : null;
}

function requirePdfAsset(db: AppDatabase, editionId: number, assetId: number) {
  const row = db
    .select({ id: fileAssets.id, format: fileAssets.format, trashedAt: fileAssets.trashedAt, editionTrashedAt: editions.trashedAt })
    .from(fileAssets)
    .innerJoin(editions, eq(editions.id, fileAssets.editionId))
    .where(and(eq(fileAssets.id, assetId), eq(fileAssets.editionId, editionId)))
    .get();
  if (!row || row.trashedAt || row.editionTrashedAt) throw new CatalogError('not_found');
  if (row.format !== 'pdf') throw new CatalogError('invalid_request');
  return row;
}

/**
 * Queues recognition of one PDF. A previous copy stays in use until the new run succeeds.
 * Asking again while it is queued or running changes nothing.
 */
export function requestOcr(db: AppDatabase, editionId: number, assetId: number, now = new Date()): void {
  requirePdfAsset(db, editionId, assetId);
  const stamp = now.toISOString();
  const existing = db.select().from(assetOcr).where(eq(assetOcr.assetId, assetId)).get();
  if (existing?.status === 'queued' || existing?.status === 'running') return;
  if (existing) {
    db.update(assetOcr)
      .set({ status: 'queued', languages: OCR_LANGUAGES, error: null, requestedAt: stamp, startedAt: null, finishedAt: null, updatedAt: stamp })
      .where(eq(assetOcr.assetId, assetId))
      .run();
    return;
  }
  db.insert(assetOcr)
    .values({ assetId, status: 'queued', languages: OCR_LANGUAGES, requestedAt: stamp, updatedAt: stamp })
    .run();
}

/**
 * Cancels a queued or running recognition and removes any copy. The original is untouched. The row
 * stays as `off`, so automatic OCR does not recognize the file again unless an admin asks.
 */
export function removeOcr(db: AppDatabase, dataDir: string, editionId: number, assetId: number): void {
  const owned = db
    .select({ id: fileAssets.id })
    .from(fileAssets)
    .where(and(eq(fileAssets.id, assetId), eq(fileAssets.editionId, editionId)))
    .get();
  if (!owned) throw new CatalogError('not_found');
  const row = db.select().from(assetOcr).where(eq(assetOcr.assetId, assetId)).get();
  if (!row) throw new CatalogError('not_found');
  if (isQuiet(row.status)) throw new CatalogError('not_found');
  const stamp = new Date().toISOString();
  db.update(assetOcr)
    .set({ status: 'off', error: null, sha256: null, bytes: null, relativePath: null, startedAt: null, finishedAt: null, updatedAt: stamp })
    .where(eq(assetOcr.assetId, assetId))
    .run();
  if (row.sha256) releaseUnreferenced(db, dataDir, [row.sha256]);
}

/** A run cut off by a restart starts again from the beginning. */
export function requeueInterruptedOcr(db: AppDatabase, now = new Date()): void {
  db.update(assetOcr)
    .set({ status: 'queued', startedAt: null, updatedAt: now.toISOString() })
    .where(eq(assetOcr.status, 'running'))
    .run();
}

/** Runs the oldest queued recognition, if any. Returns whether one ran. */
export async function runNextOcr(db: AppDatabase, dataDir: string, runner: OcrRunner, now = () => new Date()): Promise<boolean> {
  const next = db.select().from(assetOcr).where(eq(assetOcr.status, 'queued')).orderBy(asc(assetOcr.requestedAt)).get();
  if (!next) return false;
  const asset = db.select().from(fileAssets).where(eq(fileAssets.id, next.assetId)).get();
  const startedAt = now().toISOString();
  db.update(assetOcr)
    .set({ status: 'running', startedAt, error: null, updatedAt: startedAt })
    .where(and(eq(assetOcr.assetId, next.assetId), eq(assetOcr.status, 'queued')))
    .run();

  const fail = (code: string) => {
    const stamp = now().toISOString();
    db.update(assetOcr)
      .set({ status: 'failed', error: code, finishedAt: stamp, updatedAt: stamp })
      .where(and(eq(assetOcr.assetId, next.assetId), eq(assetOcr.status, 'running'), eq(assetOcr.startedAt, startedAt)))
      .run();
  };

  let inputPath: string;
  try {
    if (!asset) throw new CatalogError('not_found');
    inputPath = openAssetStream(db, dataDir, asset.editionId, asset.id).absolutePath;
  } catch {
    fail('file_missing');
    return true;
  }

  const work = path.join(dataDir, 'ocr-work');
  mkdirSync(work, { recursive: true });
  const outputPath = path.join(work, `${next.assetId}-${process.pid}-${Date.now()}.pdf`);
  const controller = new AbortController();
  // Removing the OCR (or the file) while it runs stops the tool.
  const watch = setInterval(() => {
    const current = db.select({ status: assetOcr.status, startedAt: assetOcr.startedAt }).from(assetOcr).where(eq(assetOcr.assetId, next.assetId)).get();
    if (!current || current.status !== 'running' || current.startedAt !== startedAt) controller.abort();
  }, OCR_POLL_MS);
  watch.unref();
  try {
    await runner({ inputPath, outputPath, languages: next.languages, signal: controller.signal });
    if (controller.signal.aborted) return true;
    const blob = writeImmutableBlob(dataDir, readFileSync(outputPath));
    const stamp = now().toISOString();
    let previous: string | null = null;
    const kept = db.transaction((tx) => {
      const current = tx.select().from(assetOcr).where(eq(assetOcr.assetId, next.assetId)).get();
      if (!current || current.status !== 'running' || current.startedAt !== startedAt) return false;
      previous = current.sha256 && current.sha256 !== blob.sha256 ? current.sha256 : null;
      tx.update(assetOcr)
        .set({
          status: 'succeeded',
          error: null,
          sha256: blob.sha256,
          bytes: blob.bytes,
          relativePath: blob.relativePath,
          finishedAt: stamp,
          updatedAt: stamp,
        })
        .where(eq(assetOcr.assetId, next.assetId))
        .run();
      return true;
    }, { behavior: 'immediate' });
    const released = kept ? (previous ? [previous] : []) : [blob.sha256];
    if (released.length > 0) releaseUnreferenced(db, dataDir, released);
  } catch (error) {
    if (!(error instanceof OcrRunError && error.code === 'ocr_cancelled')) {
      fail(error instanceof OcrRunError ? error.code : 'ocr_failed');
      if (error instanceof OcrRunError && error.detail) throw new Error(`ocr ${error.code}: ${error.detail}`);
    }
  } finally {
    clearInterval(watch);
    rmSync(outputPath, { force: true });
  }
  return true;
}

/**
 * Whether a PDF needs OCR: true when most sampled pages have no text, false when it has a text
 * layer, null when it cannot tell (Poppler's pdfinfo/pdftotext missing or the file unreadable).
 */
export type OcrDetector = (pdfPath: string) => Promise<boolean | null>;

const SAMPLE_PAGES = 8;
const TEXT_PAGE_CHARS = 10;

function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

/** Samples up to eight pages spread over the book with Poppler and counts the text on each. */
export const popplerDetector: OcrDetector = async (pdfPath) => {
  const info = await run(process.env.QIJUAN_PDFINFO?.trim() || 'pdfinfo', [pdfPath]);
  const pages = Number(/^Pages:\s+(\d+)/m.exec(info ?? '')?.[1]);
  if (!Number.isInteger(pages) || pages < 1) return null;
  const sample = [...new Set(Array.from({ length: Math.min(SAMPLE_PAGES, pages) }, (_, index) =>
    Math.min(pages, 1 + Math.floor((index * pages) / Math.min(SAMPLE_PAGES, pages)))))];
  let withText = 0;
  for (const page of sample) {
    const text = await run(process.env.QIJUAN_PDFTOTEXT?.trim() || 'pdftotext', ['-q', '-f', String(page), '-l', String(page), pdfPath, '-']);
    if (text === null) return null;
    if (text.replace(/\s+/g, '').length >= TEXT_PAGE_CHARS) withText += 1;
  }
  return withText * 2 < sample.length;
};

/** PDFs the automatic check could not read in this process; tried again after a restart. */
const unreadable = new Set<number>();

/**
 * Automatic OCR: checks one live PDF that has never been checked, then queues it or marks it
 * not_needed. Returns whether a file was checked. Removed OCR (`off`) is never queued again.
 */
export async function checkNextPdf(db: AppDatabase, dataDir: string, detector: OcrDetector, now = () => new Date()): Promise<boolean> {
  const candidates = db
    .select({ id: fileAssets.id, editionId: fileAssets.editionId })
    .from(fileAssets)
    .innerJoin(editions, eq(editions.id, fileAssets.editionId))
    .leftJoin(assetOcr, eq(assetOcr.assetId, fileAssets.id))
    .where(and(eq(fileAssets.format, 'pdf'), eq(fileAssets.availability, 'present'), isNull(fileAssets.trashedAt), isNull(editions.trashedAt), isNull(assetOcr.assetId)))
    .orderBy(asc(fileAssets.id))
    .all()
    .filter((row) => !unreadable.has(row.id));
  const next = candidates[0];
  if (!next) return false;
  let needs: boolean | null = null;
  try {
    needs = await detector(openAssetStream(db, dataDir, next.editionId, next.id).absolutePath);
  } catch {
    needs = null;
  }
  if (needs === null) {
    unreadable.add(next.id);
    return true;
  }
  const stamp = now().toISOString();
  db.insert(assetOcr)
    .values({ assetId: next.id, status: needs ? 'queued' : 'not_needed', languages: OCR_LANGUAGES, requestedAt: stamp, updatedAt: stamp })
    .onConflictDoNothing()
    .run();
  return true;
}

export function startOcrWorker(options: {
  db: AppDatabase;
  dataDir: string;
  runner: OcrRunner;
  /** Check new and existing PDFs and queue scans by themselves. Needs `available` and `detector`. */
  auto?: { available: () => boolean; detector: OcrDetector };
  pollMs?: number;
  log?: { error: (context: Record<string, unknown>, message: string) => void };
}): { stop: () => void } {
  let stopped = false;
  let active = false;
  try {
    requeueInterruptedOcr(options.db);
  } catch {
    // Tried again at the next start.
  }
  const timer = setInterval(() => {
    // A backup reads the blob store; recognition waits for it.
    if (stopped || active || holder() === 'backup') return;
    active = true;
    void runNextOcr(options.db, options.dataDir, options.runner)
      .then((ran) => {
        // Between recognitions, check one more PDF for automatic OCR.
        const auto = options.auto;
        if (ran || !auto || !auto.available()) return;
        return checkNextPdf(options.db, options.dataDir, auto.detector).then(() => undefined);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : '';
        if (/closed|not open/i.test(message)) return;
        options.log?.error({ detail: message.slice(0, 600) }, 'ocr failed');
      })
      .finally(() => {
        active = false;
      });
  }, options.pollMs ?? OCR_POLL_MS);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
