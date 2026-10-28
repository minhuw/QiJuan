import { rmSync } from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, or } from 'drizzle-orm';
import { listLibraries } from './accounts.js';
import { CatalogError, checkIndexedLibrary } from './catalog.js';
import type { AppDatabase } from './db.js';
import { commitPreparedImport, prepareImportedFile, type ImportMetadata } from './ingest.js';
import { resolveInsideRoot } from './library-files.js';
import { BookError, type BookMetadata } from './metadata.js';
import { PREVIEW_FIELDS, type PreviewField, applyMetadataPreview, createMetadataPreview } from './metadata/apply.js';
import { runMetadataAgent } from './metadata/assistant/agent.js';
import {
  AssistantError,
  type AssistantConfig,
  type AssistantTransport,
} from './metadata/assistant/client.js';
import type { MetadataPromptFields } from './metadata/assistant/prompt.js';
import type { AssistantProposal } from './metadata/assistant/submit.js';
import { readAssistantSettings } from './metadata/assistant-settings.js';
import {
  fetchOpenLibraryCover,
  OpenLibraryError,
  type OpenLibraryTransport,
} from './metadata/openLibrary.js';
import { refreshEditionMetadata, refreshLibraryMetadata } from './refresh.js';
import { editions, jobItems, jobs, libraries } from './schema.js';
import type { AuthUser } from './sessions.js';
import { release, tryAcquire } from './work-gate.js';
import { ZipError } from './zip.js';

const POLL_MS = 50;

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type JobSource = 'upload' | 'folder' | 'lookup' | 'apply' | 'refresh' | 'rescan';
export type ItemStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'duplicate';

const IMPORT_SOURCES = new Set<JobSource>(['upload', 'folder']);
const PREVIEW_FIELD_SET = new Set<string>(PREVIEW_FIELDS);

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
  source: JobSource;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Small JSON document: a metadata preview, a rescan count, or `{ error }` . */
  result: unknown;
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

/** Queues lookup, apply, refresh, or rescan. The worker performs the work. */
export function createBackgroundJob(
  db: AppDatabase,
  input: {
    libraryId: number;
    userId: number;
    source: 'lookup' | 'apply' | 'refresh' | 'rescan';
    payload: unknown;
  },
  now = new Date(),
): JobView {
  const stamp = now.toISOString();
  const inserted = db
    .insert(jobs)
    .values({
      libraryId: input.libraryId,
      createdBy: input.userId,
      source: input.source,
      status: 'queued',
      payload: JSON.stringify(input.payload),
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning({ id: jobs.id })
    .get();
  if (!inserted) throw new Error('job insert failed');
  const view = getJobById(db, inserted.id);
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
    .filter((row) => allowed.has(row.libraryId) && IMPORT_SOURCES.has(row.source))
    .slice(0, 20)
    .map((row) => toView(db, row));
}

export function getVisibleJob(db: AppDatabase, user: AuthUser, jobId: number): JobView | null {
  if (!Number.isInteger(jobId) || jobId < 1) return null;
  const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!row || !libraryIds(db, user).has(row.libraryId)) return null;
  return toView(db, row);
}

export function startJobWorker(options: {
  db: AppDatabase;
  dataDir: string;
  openLibrary: OpenLibraryTransport;
  assistant?: AssistantTransport;
  log?: JobLogger;
}): { stop: () => void } {
  let stopped = false;
  let active = false;
  const timer = setInterval(() => {
    if (stopped || active) return;
    active = true;
    // One job at a time. Lookup and apply await Open Library; do not claim the next row until that finishes.
    void workNext().finally(() => {
      active = false;
    });
  }, POLL_MS);
  timer.unref();

  async function workNext(): Promise<void> {
    if (stopped || !tryAcquire('library')) return;
    try {
      const jobId = claimNextJob(options.db);
      if (jobId !== null) {
        await runJob(options.db, options.dataDir, options.openLibrary, options.assistant ?? {}, jobId, options.log);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/closed|not open/i.test(message)) {
        stopped = true;
        clearInterval(timer);
        return;
      }
      options.log?.error({ name: error instanceof Error ? error.name : 'Error' }, 'job worker failed');
    } finally {
      release('library');
    }
  }

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

async function runJob(
  db: AppDatabase,
  dataDir: string,
  openLibrary: OpenLibraryTransport,
  assistant: AssistantTransport,
  jobId: number,
  log?: JobLogger,
): Promise<void> {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job || job.status !== 'running') return;
  try {
    const result = await performJob(db, dataDir, openLibrary, assistant, job, log);
    finishJob(db, jobId, 'succeeded', result);
  } catch (error) {
    const code = jobFailureCode(error);
    finishJob(db, jobId, 'failed', { error: code });
    log?.error({ jobId, code }, 'job failed');
  } finally {
    if (job.source === 'upload') {
      const stored = db.select({ sourcePath: jobItems.sourcePath }).from(jobItems).where(eq(jobItems.jobId, jobId)).all();
      cleanupUploads(dataDir, stored.map((row) => row.sourcePath));
    }
  }
}

async function performJob(
  db: AppDatabase,
  dataDir: string,
  openLibrary: OpenLibraryTransport,
  assistant: AssistantTransport,
  job: typeof jobs.$inferSelect,
  log?: JobLogger,
): Promise<unknown> {
  if (job.source === 'upload' || job.source === 'folder') {
    const items = db
      .select()
      .from(jobItems)
      .where(and(eq(jobItems.jobId, job.id), or(eq(jobItems.status, 'queued'), eq(jobItems.status, 'running'))))
      .orderBy(asc(jobItems.position))
      .all();
    const assistantConfig = job.source === 'upload' ? readAssistantSettings(dataDir) : null;
    for (const item of items) {
      await processItem(
        db,
        dataDir,
        { id: job.id, libraryId: job.libraryId, source: job.source },
        item,
        { openLibrary, assistant, assistantConfig },
        log,
      );
    }
    return undefined;
  }
  if (job.source === 'lookup') return runLookup(db, openLibrary, job);
  if (job.source === 'apply') return runApply(db, dataDir, openLibrary, job);
  if (job.source === 'refresh') return runRefresh(db, dataDir, job);
  if (job.source === 'rescan') return runRescan(db, dataDir, job);
  throw new CatalogError('invalid_request');
}

async function runLookup(
  db: AppDatabase,
  transport: OpenLibraryTransport,
  job: typeof jobs.$inferSelect,
): Promise<{ preview: { previewId: number; fields: unknown[] } | null }> {
  const editionId = readEditionId(readPayload(job.payload));
  assertEdition(db, job.libraryId, editionId);
  const preview = await createMetadataPreview(db, transport, editionId);
  return { preview: preview ?? null };
}

async function runApply(
  db: AppDatabase,
  dataDir: string,
  transport: OpenLibraryTransport,
  job: typeof jobs.$inferSelect,
): Promise<{ applied: true }> {
  const payload = readPayload(job.payload);
  const editionId = readEditionId(payload);
  const previewId = readPositiveInt(payload.previewId);
  if (!previewId) throw new CatalogError('invalid_request');
  const confirm = readConfirm(payload);
  assertEdition(db, job.libraryId, editionId);
  await applyMetadataPreview(db, dataDir, transport, { editionId, previewId, confirm });
  return { applied: true };
}

function runRefresh(db: AppDatabase, dataDir: string, job: typeof jobs.$inferSelect): { changed: boolean } {
  const editionId = readEditionId(readPayload(job.payload));
  assertEdition(db, job.libraryId, editionId);
  return { changed: refreshEditionMetadata(db, dataDir, editionId) };
}

function runRescan(
  db: AppDatabase,
  dataDir: string,
  job: typeof jobs.$inferSelect,
): { checked: number; present: number; missing: number; refreshed: number } {
  const checked = checkIndexedLibrary(db, job.libraryId);
  const refreshed = refreshLibraryMetadata(db, dataDir, job.libraryId);
  return { ...checked, refreshed: refreshed.refreshed };
}

function finishJob(db: AppDatabase, jobId: number, status: 'succeeded' | 'failed', result: unknown): void {
  const stamp = new Date().toISOString();
  db.update(jobs)
    .set({
      status,
      result: result === undefined ? null : JSON.stringify(result),
      finishedAt: stamp,
      updatedAt: stamp,
    })
    .where(eq(jobs.id, jobId))
    .run();
}

function readPayload(value: string | null): Record<string, unknown> {
  if (!value) throw new CatalogError('invalid_request');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CatalogError('invalid_request');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CatalogError('invalid_request');
  return parsed as Record<string, unknown>;
}

function readEditionId(payload: Record<string, unknown>): number {
  const editionId = readPositiveInt(payload.editionId);
  if (!editionId) throw new CatalogError('invalid_request');
  return editionId;
}

function readPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function readConfirm(payload: Record<string, unknown>): PreviewField[] {
  if (!Array.isArray(payload.confirm)) throw new CatalogError('invalid_request');
  const fields: PreviewField[] = [];
  for (const item of payload.confirm) {
    if (typeof item !== 'string' || !PREVIEW_FIELD_SET.has(item)) throw new CatalogError('invalid_request');
    fields.push(item as PreviewField);
  }
  return fields;
}

function assertEdition(db: AppDatabase, libraryId: number, editionId: number): void {
  const edition = db
    .select({ libraryId: editions.libraryId, trashedAt: editions.trashedAt })
    .from(editions)
    .where(eq(editions.id, editionId))
    .get();
  if (!edition || edition.trashedAt || edition.libraryId !== libraryId) throw new CatalogError('not_found');
}

function jobFailureCode(error: unknown): string {
  if (error instanceof OpenLibraryError) return error.code;
  if (error instanceof CatalogError) return error.code;
  if (error instanceof BookError) return error.code;
  if (error instanceof ZipError) return 'malformed';
  return 'internal';
}

interface ImportJobContext {
  openLibrary: OpenLibraryTransport;
  assistant: AssistantTransport;
  assistantConfig: AssistantConfig | null;
}

async function processItem(
  db: AppDatabase,
  dataDir: string,
  job: { id: number; libraryId: number; source: 'upload' | 'folder' },
  item: { id: number; filename: string; sourcePath: string },
  context: ImportJobContext,
  log?: JobLogger,
): Promise<void> {
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
      const prepared = prepareImportedFile(db, {
        dataDir,
        libraryId: job.libraryId,
        storage: 'managed',
        absolutePath: absolute,
        relativePath: null,
        originalFilename: item.filename,
        itemId: item.id,
        maxBytes: null,
      });
      if (prepared.duplicate) {
        commitPreparedImport(db, prepared, null);
        return;
      }
      const config = context.assistantConfig;
      if (!config) throw new AssistantError('metadata_assistant_unconfigured');
      const embedded = prepared.metadata;
      if (!embedded) throw new BookError('malformed');
      const result = await runMetadataAgent({
        transport: context.assistant,
        openLibrary: context.openLibrary,
        config,
        input: {
          filename: item.filename,
          format: prepared.kind,
          fields: promptFields(embedded),
        },
      });
      const metadata = await proposalMetadata(result.proposal, context.openLibrary);
      commitPreparedImport(db, prepared, metadata);
      return;
    }
    if (library.mode !== 'indexed') throw new BookError('malformed');
    const absolute = resolveInsideRoot(library.rootPath, item.sourcePath);
    if (!absolute) throw new BookError('missing');
    const prepared = prepareImportedFile(db, {
      dataDir,
      libraryId: job.libraryId,
      storage: 'indexed',
      absolutePath: absolute,
      relativePath: item.sourcePath,
      originalFilename: item.filename,
      itemId: item.id,
      maxBytes: null,
    });
    commitPreparedImport(db, prepared, prepared.metadata);
  } catch (error) {
    const code = failureCode(error);
    db.update(jobItems)
      .set({ status: 'failed', error: code, updatedAt: new Date().toISOString() })
      .where(eq(jobItems.id, item.id))
      .run();
    log?.error({ jobId: job.id, itemId: item.id, code }, 'import file failed');
  }
}

function promptFields(metadata: BookMetadata): MetadataPromptFields {
  return {
    title: metadata.title,
    authors: metadata.creators.filter((creator) => creator.role === 'author').map((creator) => creator.name),
    translators: metadata.creators.filter((creator) => creator.role === 'translator').map((creator) => creator.name),
    description: metadata.description,
    publisher: metadata.publisher,
    publishedDate: null,
    language: metadata.language,
    identifiers: metadata.identifiers.map((identifier) => ({ ...identifier })),
    series: null,
    seriesOrder: null,
  };
}

async function proposalMetadata(
  proposal: AssistantProposal,
  openLibrary: OpenLibraryTransport,
): Promise<ImportMetadata> {
  assertCompleteProposal(proposal);
  let cover: { bytes: Buffer; mediaType: string } | null = null;
  if (proposal.coverId !== null || proposal.isbn !== null) {
    try {
      cover = await fetchOpenLibraryCover(openLibrary, { coverId: proposal.coverId, isbn: proposal.isbn });
    } catch {
      // A selected cover is optional. The completed metadata still creates the edition.
      cover = null;
    }
  }
  return {
    title: proposal.title,
    language: proposal.language,
    publisher: proposal.publisher,
    publishedDate: proposal.publishedDate,
    description: proposal.description,
    creators: [
      ...proposal.authors.map((name) => ({ name, role: 'author' as const })),
      ...proposal.translators.map((name) => ({ name, role: 'translator' as const })),
    ],
    identifiers: proposal.identifiers,
    cover,
    series: proposal.series,
    seriesOrder: proposal.seriesOrder,
  };
}

function assertCompleteProposal(proposal: AssistantProposal): void {
  if (
    !proposal.title ||
    proposal.authors.length === 0 ||
    !proposal.language ||
    !proposal.description ||
    !proposal.publisher ||
    !proposal.publishedDate ||
    proposal.identifiers.length === 0
  ) {
    throw new AssistantError('metadata_incomplete' as never);
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
  if (error instanceof AssistantError) return error.code;
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
    result: decodeJson(row.result),
    summary,
    items: views,
  };
}

function decodeJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
