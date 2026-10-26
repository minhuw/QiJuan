import { rmSync } from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, or } from 'drizzle-orm';
import { CatalogError } from './catalog.js';
import type { AppDatabase } from './db.js';
import { commitImportedFile } from './ingest.js';
import { resolveInsideRoot } from './library-files.js';
import { BookError } from './metadata.js';
import { ZipError } from './zip.js';
import { listLibraries } from './accounts.js';
import { jobItems, jobs, libraries } from './schema.js';
import type { AuthUser } from './sessions.js';

const POLL_MS = 50;

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type ItemStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'duplicate';

export interface JobSummary {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  duplicate: number;
}

export interface JobItemView {
  id: number;
  position: number;
  filename: string;
  status: ItemStatus;
  error: string | null;
  editionId: number | null;
  assetId: number | null;
  sha256: string | null;
}

export interface JobView {
  id: number;
  libraryId: number;
  source: 'upload' | 'folder';
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  summary: JobSummary;
  items: JobItemView[];
}

export interface JobLogger {
  error(context: Record<string, unknown>, message: string): void;
}

export function requeueInterruptedJobs(db: AppDatabase, now = new Date()): void {
  const stamp = now.toISOString();
  db.transaction((tx) => {
    tx.update(jobItems)
      .set({ status: 'queued', updatedAt: stamp })
      .where(eq(jobItems.status, 'running'))
      .run();
    tx.update(jobs)
      .set({ status: 'queued', updatedAt: stamp })
      .where(eq(jobs.status, 'running'))
      .run();
  }, { behavior: 'immediate' });
}

export function createImportJob(
  db: AppDatabase,
  input: {
    libraryId: number;
    userId: number;
    source: 'upload' | 'folder';
    items: Array<{ filename: string; sourcePath: string }>;
  },
  now = new Date(),
): JobView {
  const stamp = now.toISOString();
  const jobId = db.transaction((tx) => {
    const inserted = tx
      .insert(jobs)
      .values({
        libraryId: input.libraryId,
        createdBy: input.userId,
        source: input.source,
        status: 'queued',
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning({ id: jobs.id })
      .get();
    if (!inserted) throw new Error('job insert failed');
    input.items.forEach((item, position) => {
      tx.insert(jobItems)
        .values({
          jobId: inserted.id,
          position,
          filename: item.filename,
          sourcePath: item.sourcePath,
          status: 'queued',
          createdAt: stamp,
          updatedAt: stamp,
        })
        .run();
    });
    return inserted.id;
  }, { behavior: 'immediate' });
  const view = getJobById(db, jobId);
  if (!view) throw new Error('job missing');
  return view;
}

export function listVisibleJobs(db: AppDatabase, user: AuthUser): JobView[] {
  const allowed = libraryIds(db, user);
  if (allowed.size === 0) return [];
  return db
    .select()
    .from(jobs)
    .orderBy(desc(jobs.id))
    .limit(50)
    .all()
    .filter((row) => allowed.has(row.libraryId))
    .slice(0, 20)
    .map((row) => toView(db, row));
}

export function getVisibleJob(db: AppDatabase, user: AuthUser, jobId: number): JobView | null {
  if (!Number.isInteger(jobId) || jobId < 1) return null;
  const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!row || !libraryIds(db, user).has(row.libraryId)) return null;
  return toView(db, row);
}

export function startJobWorker(options: { db: AppDatabase; dataDir: string; log?: JobLogger }): { stop: () => void } {
  let stopped = false;
  let active = false;
  const timer = setInterval(() => {
    if (stopped || active) return;
    active = true;
    try {
      const jobId = claimNextJob(options.db);
      if (jobId !== null) runJob(options.db, options.dataDir, jobId, options.log);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/closed|not open/i.test(message)) {
        stopped = true;
        clearInterval(timer);
        return;
      }
      options.log?.error({ name: error instanceof Error ? error.name : 'Error' }, 'job worker failed');
    } finally {
      active = false;
    }
  }, POLL_MS);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function claimNextJob(db: AppDatabase, now = new Date()): number | null {
  const stamp = now.toISOString();
  return db.transaction((tx) => {
    const next = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.status, 'queued'))
      .orderBy(asc(jobs.id))
      .get();
    if (!next) return null;
    const updated = tx
      .update(jobs)
      .set({ status: 'running', startedAt: stamp, updatedAt: stamp })
      .where(and(eq(jobs.id, next.id), eq(jobs.status, 'queued')))
      .returning({ id: jobs.id })
      .get();
    return updated?.id ?? null;
  }, { behavior: 'immediate' });
}

function runJob(db: AppDatabase, dataDir: string, jobId: number, log?: JobLogger): void {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job || job.status !== 'running') return;
  const items = db
    .select()
    .from(jobItems)
    .where(and(eq(jobItems.jobId, jobId), or(eq(jobItems.status, 'queued'), eq(jobItems.status, 'running'))))
    .orderBy(asc(jobItems.position))
    .all();
  try {
    for (const item of items) {
      processItem(db, dataDir, job, item, log);
    }
    const stamp = new Date().toISOString();
    db.update(jobs)
      .set({ status: 'succeeded', finishedAt: stamp, updatedAt: stamp })
      .where(eq(jobs.id, jobId))
      .run();
  } catch (error) {
    const stamp = new Date().toISOString();
    db.update(jobs)
      .set({ status: 'failed', finishedAt: stamp, updatedAt: stamp })
      .where(eq(jobs.id, jobId))
      .run();
    log?.error({ jobId, name: error instanceof Error ? error.name : 'Error' }, 'import job failed');
  } finally {
    const finished = db.select({ source: jobs.source }).from(jobs).where(eq(jobs.id, jobId)).get();
    if (finished?.source === 'upload') {
      const stored = db.select({ sourcePath: jobItems.sourcePath }).from(jobItems).where(eq(jobItems.jobId, jobId)).all();
      cleanupUploads(dataDir, stored.map((row) => row.sourcePath));
    }
  }
}

function processItem(
  db: AppDatabase,
  dataDir: string,
  job: { id: number; libraryId: number; source: 'upload' | 'folder' },
  item: { id: number; filename: string; sourcePath: string },
  log?: JobLogger,
): void {
  const stamp = new Date().toISOString();
  db.update(jobItems).set({ status: 'running', updatedAt: stamp }).where(eq(jobItems.id, item.id)).run();
  try {
    const library = db
      .select({ mode: libraries.mode, rootPath: libraries.rootPath })
      .from(libraries)
      .where(eq(libraries.id, job.libraryId))
      .get();
    if (!library) throw new BookError('missing');
    if (job.source === 'upload') {
      const absolute = resolveUploadPath(dataDir, item.sourcePath);
      if (!absolute) throw new BookError('missing');
      commitImportedFile(db, {
        dataDir,
        libraryId: job.libraryId,
        storage: 'managed',
        absolutePath: absolute,
        relativePath: null,
        originalFilename: item.filename,
        itemId: item.id,
        maxBytes: null,
      });
      return;
    }
    if (library.mode !== 'indexed') throw new BookError('malformed');
    const absolute = resolveInsideRoot(library.rootPath, item.sourcePath);
    if (!absolute) throw new BookError('missing');
    commitImportedFile(db, {
      dataDir,
      libraryId: job.libraryId,
      storage: 'indexed',
      absolutePath: absolute,
      relativePath: item.sourcePath,
      originalFilename: item.filename,
      itemId: item.id,
      maxBytes: null,
    });
  } catch (error) {
    const code = failureCode(error);
    db.update(jobItems)
      .set({ status: 'failed', error: code, updatedAt: new Date().toISOString() })
      .where(eq(jobItems.id, item.id))
      .run();
    log?.error({ jobId: job.id, itemId: item.id, code }, 'import file failed');
  }
}

export function resolveUploadPath(dataDir: string, sourcePath: string): string | null {
  if (!sourcePath.startsWith('incoming/') || sourcePath.includes('\\') || sourcePath.includes('\0')) {
    return null;
  }
  // A filename may contain ".." (Edition..epub). Only an actual parent segment is unsafe.
  const segments = sourcePath.split('/');
  if (segments.some((segment) => segment === '..')) return null;
  const root = path.resolve(dataDir, 'incoming');
  const absolute = path.resolve(dataDir, ...segments);
  const rel = path.relative(root, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return absolute;
}

function cleanupUploads(dataDir: string, sourcePaths: string[]): void {
  const dirs = new Set<string>();
  for (const sourcePath of sourcePaths) {
    const absolute = resolveUploadPath(dataDir, sourcePath);
    if (absolute) dirs.add(path.dirname(absolute));
  }
  const incoming = path.resolve(dataDir, 'incoming');
  for (const dir of dirs) {
    if (path.resolve(dir, '..') !== incoming) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Staging is disposable once the job has reached a terminal state.
    }
  }
}

function failureCode(error: unknown): string {
  if (error instanceof BookError) return error.code;
  if (error instanceof ZipError) return 'malformed';
  if (error instanceof CatalogError) {
    if (error.code === 'file_missing') return 'missing';
    return 'malformed';
  }
  return 'malformed';
}

function libraryIds(db: AppDatabase, user: AuthUser): Set<number> {
  return new Set(listLibraries(db, user).map((library) => library.id));
}

function getJobById(db: AppDatabase, jobId: number): JobView | null {
  const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  return row ? toView(db, row) : null;
}

function toView(db: AppDatabase, row: typeof jobs.$inferSelect): JobView {
  const items = db
    .select()
    .from(jobItems)
    .where(eq(jobItems.jobId, row.id))
    .orderBy(asc(jobItems.position))
    .all();
  const summary: JobSummary = { total: items.length, queued: 0, running: 0, succeeded: 0, failed: 0, duplicate: 0 };
  const views: JobItemView[] = items.map((item) => {
    const status = item.status as ItemStatus;
    summary[status] += 1;
    return {
      id: item.id,
      position: item.position,
      filename: item.filename,
      status,
      error: item.error,
      editionId: item.editionId,
      assetId: item.assetId,
      sha256: item.sha256,
    };
  });
  return {
    id: row.id,
    libraryId: row.libraryId,
    source: row.source,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    summary,
    items: views,
  };
}
