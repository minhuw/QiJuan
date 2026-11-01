import { rmSync } from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, or } from 'drizzle-orm';
import { listLibraries } from './accounts.js';
import { CatalogError, checkIndexedLibrary } from './catalog.js';
import type { AppDatabase } from './db.js';
import { type IdentifierSource, identifierKey, normalizeIdentifierList } from './identifiers.js';
import { commitPreparedImport, prepareImportedFile, type ImportMetadata, type IncomingSummary, type PreparedImport } from './ingest.js';
import { resolveInsideRoot } from './library-files.js';
import { BookError, type BookMetadata } from './metadata.js';
import {
  PREVIEW_FIELDS,
  type PreviewField,
  applyMetadataPreview,
  createMetadataPreview,
  coverSourcePages,
  fetchAgentCover,
  fetchFallbackCover,
  fetchSourcePageCover,
} from './metadata/apply.js';
import { webSearchAvailable } from './metadata/assistant/web-tools.js';
import { runMetadataAgent } from './metadata/assistant/agent.js';
import {
  AssistantError,
  type AssistantConfig,
  type AssistantTransport,
} from './metadata/assistant/client.js';
import type { MetadataPromptFields } from './metadata/assistant/prompt.js';
import { cleanCover, type AssistantCover, type AssistantProposal } from './metadata/assistant/submit.js';
import { readAssistantSettings } from './metadata/assistant-settings.js';
import { isEditionPrivate } from './metadata/privacy.js';
import { pruneTrajectories, startTrajectory, trajectoryRefs, type TrajectoryRecorder } from './metadata/trajectory.js';
import {
  OpenLibraryError,
  type OpenLibraryTransport,
} from './metadata/openLibrary.js';
import { refreshEditionMetadata, refreshLibraryMetadata } from './refresh.js';
import { MERGE_CONFLICTS, type MergeConflict } from './merge.js';
import { editions, jobItems, jobs, libraries } from './schema.js';
import type { AuthUser } from './sessions.js';
import { release, tryAcquire } from './work-gate.js';
import { ZipError } from './zip.js';

const POLL_MS = 50;

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type JobSource = 'upload' | 'folder' | 'lookup' | 'apply' | 'refresh' | 'rescan';
export type ItemStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'duplicate' | 'needs_confirmation';
export type ItemResolution = 'merge' | 'separate';

const IMPORT_SOURCES = new Set<JobSource>(['upload', 'folder']);
const PREVIEW_FIELD_SET = new Set<string>(PREVIEW_FIELDS);

export interface JobSummary {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  duplicate: number;
  needs_confirmation: number;
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
  /** The edition this file matched by identifier. Set while it needs confirmation, and kept after. */
  candidateEditionId: number | null;
  /** Why the match was not merged automatically. */
  conflicts: MergeConflict[];
  /** True when the file joined an existing edition instead of creating one. */
  merged: boolean;
  /** The admin's decision on a needs_confirmation item. */
  resolution: ItemResolution | null;
  /** Admins only, while the item needs confirmation: what the file brings. */
  incoming?: IncomingSummary;
  /** Admins only: the metadata assistant run for this file. */
  trajectoryId?: number;
  trajectoryStepCount?: number;
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
  /** Admins only: the metadata assistant run of a lookup job. */
  trajectoryId?: number;
  trajectoryStepCount?: number;
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
    /** Keep every file of the batch private from the metadata assistant. */
    metadataPrivate?: boolean;
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
          metadataPrivate: input.metadataPrivate === true,
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
    .map((row) => toView(db, row, user.role === 'admin'));
}

export function getVisibleJob(db: AppDatabase, user: AuthUser, jobId: number): JobView | null {
  if (!Number.isInteger(jobId) || jobId < 1) return null;
  const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!row || !libraryIds(db, user).has(row.libraryId)) return null;
  return toView(db, row, user.role === 'admin');
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
  try {
    pruneTrajectories(options.db);
  } catch {
    // Pruning runs again whenever a new trajectory starts.
  }
  const timer = setInterval(() => {
    if (stopped || active) return;
    active = true;
    // One job at a time. Lookup and apply await external metadata requests; do not claim the next row until that finishes.
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
      const stored = db
        .select({ sourcePath: jobItems.sourcePath, status: jobItems.status })
        .from(jobItems)
        .where(eq(jobItems.jobId, jobId))
        .all();
      // A file waiting for an admin's decision keeps its staged copy until it is resolved.
      const waiting = stored.filter((row) => row.status === 'needs_confirmation').map((row) => row.sourcePath);
      cleanupUploads(dataDir, stored.map((row) => row.sourcePath), waiting);
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
  if (job.source === 'lookup') return runLookup(db, dataDir, openLibrary, assistant, job);
  if (job.source === 'apply') return runApply(db, dataDir, job);
  if (job.source === 'refresh') return runRefresh(db, dataDir, job);
  if (job.source === 'rescan') return runRescan(db, dataDir, job);
  throw new CatalogError('invalid_request');
}

async function runLookup(
  db: AppDatabase,
  dataDir: string,
  openLibrary: OpenLibraryTransport,
  assistant: AssistantTransport,
  job: typeof jobs.$inferSelect,
): Promise<{ preview: { previewId: number; fields: unknown[]; source: 'assistant'; model: string } | null }> {
  const editionId = readEditionId(readPayload(job.payload));
  assertEdition(db, job.libraryId, editionId);
  if (isEditionPrivate(db, editionId)) throw new AssistantError('metadata_private');
  if (!readAssistantSettings(dataDir)) throw new AssistantError('metadata_assistant_unconfigured');
  const preview = await createMetadataPreview(db, dataDir, assistant, openLibrary, editionId, { jobId: job.id });
  return { preview: preview ?? null };
}

async function runApply(
  db: AppDatabase,
  dataDir: string,
  job: typeof jobs.$inferSelect,
): Promise<{ applied: true }> {
  const payload = readPayload(job.payload);
  const editionId = readEditionId(payload);
  const previewId = readPositiveInt(payload.previewId);
  if (!previewId) throw new CatalogError('invalid_request');
  const confirm = readConfirm(payload);
  assertEdition(db, job.libraryId, editionId);
  await applyMetadataPreview(db, dataDir, { editionId, previewId, confirm });
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
  if (error instanceof AssistantError) return error.code;
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

interface PendingUpload {
  metadata: Omit<ImportMetadata, 'cover'>;
  cover: CoverRef;
}

/**
 * Where an upload's cover may come from, in order: the agent's image, then Open Library, then
 * the record pages the proposal cites.
 */
interface CoverRef {
  coverId: number | null;
  isbn: string | null;
  agent?: AssistantCover | null;
  pages?: string[];
}

async function processItem(
  db: AppDatabase,
  dataDir: string,
  job: { id: number; libraryId: number; source: 'upload' | 'folder' },
  item: typeof jobItems.$inferSelect,
  context: ImportJobContext,
  log?: JobLogger,
): Promise<void> {
  const stamp = new Date().toISOString();
  db.update(jobItems).set({ status: 'running', updatedAt: stamp }).where(eq(jobItems.id, item.id)).run();
  const resolution = item.resolution
    ? { action: item.resolution, candidateEditionId: item.candidateEditionId }
    : undefined;
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
      const metadataPrivate = item.metadataPrivate;
      if (prepared.duplicate) {
        commitPreparedImport(db, prepared, null, { metadataPrivate });
        return;
      }
      if (metadataPrivate) {
        // Nothing goes to the assistant or any lookup service: the file's own metadata and cover only.
        const metadata = folderMetadata(prepared);
        if (!metadata) throw new BookError('malformed');
        commitPreparedImport(db, prepared, metadata, { resolution, metadataPrivate });
        return;
      }
      if (resolution) {
        // The agent already ran for this file. Finish it from the kept proposal.
        const pending = decodePending(item.pending);
        if (!pending) throw new BookError('malformed');
        const cover =
          resolution.action === 'separate' ? await uploadCover(context, pending.cover, prepared.metadata?.cover ?? null, null) : null;
        commitPreparedImport(db, prepared, { ...pending.metadata, cover }, { resolution });
        return;
      }
      const config = context.assistantConfig;
      if (!config) throw new AssistantError('metadata_assistant_unconfigured');
      const embedded = prepared.metadata;
      if (!embedded) throw new BookError('malformed');
      const trajectory = startTrajectory(db, { jobId: job.id, jobItemId: item.id, model: config.model });
      const embeddedIds = embeddedIdentifiers(embedded, trajectory);
      const result = await runMetadataAgent({
        transport: context.assistant,
        openLibrary: context.openLibrary,
        config,
        metadataPrivate: item.metadataPrivate,
        input: {
          filename: item.filename,
          format: prepared.kind,
          fields: promptFields(embedded, embeddedIds),
        },
        onStep: trajectory.onStep,
      });
      const metadata = await proposalMetadata(result.proposal, context, embeddedIds, embedded.cover, trajectory);
      const { cover: _cover, ...kept } = metadata;
      void _cover;
      const pending: PendingUpload = {
        metadata: kept,
        cover: {
          coverId: result.proposal.coverId,
          isbn: result.proposal.isbn,
          agent: result.proposal.cover,
          pages: coverSourcePages(result.proposal.identifiers),
        },
      };
      commitPreparedImport(db, prepared, metadata, { pending });
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
    commitPreparedImport(db, prepared, folderMetadata(prepared), { resolution, metadataPrivate: item.metadataPrivate });
  } catch (error) {
    const code = failureCode(error);
    db.update(jobItems)
      .set({ status: 'failed', error: code, pending: null, updatedAt: new Date().toISOString() })
      .where(eq(jobItems.id, item.id))
      .run();
    log?.error({ jobId: job.id, itemId: item.id, code }, 'import file failed');
  }
}

/** Embedded identifiers, normalized. Invalid ones are dropped and noted in the trajectory, if any. */
function embeddedIdentifiers(
  metadata: BookMetadata,
  trajectory: TrajectoryRecorder | null,
): Array<{ scheme: string; value: string }> {
  const { identifiers, dropped } = normalizeIdentifierList(metadata.identifiers);
  if (dropped.length > 0) trajectory?.note('identifiers_dropped', { origin: 'embedded', dropped });
  return identifiers.map(({ scheme, value }) => ({ scheme, value }));
}

function folderMetadata(prepared: PreparedImport): ImportMetadata | null {
  if (!prepared.metadata) return null;
  return {
    ...prepared.metadata,
    identifiers: embeddedIdentifiers(prepared.metadata, null).map((item) => ({ ...item, source: 'embedded' as const })),
  };
}

function decodeIncoming(value: string | null): IncomingSummary | null {
  const parsed = decodeJson(value);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const incoming = (parsed as { incoming?: Partial<IncomingSummary> }).incoming;
  if (typeof incoming !== 'object' || incoming === null) return null;
  const identifier = incoming.identifier;
  if (
    (incoming.format !== 'epub' && incoming.format !== 'pdf') ||
    typeof identifier?.scheme !== 'string' ||
    typeof identifier.value !== 'string'
  ) {
    return null;
  }
  return {
    title: typeof incoming.title === 'string' ? incoming.title : null,
    authors: Array.isArray(incoming.authors) ? incoming.authors.filter((name): name is string => typeof name === 'string') : [],
    format: incoming.format,
    identifier: { scheme: identifier.scheme, value: identifier.value },
  };
}

function decodePending(value: string | null): PendingUpload | null {
  const parsed = decodeJson(value);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Partial<PendingUpload>;
  if (typeof record.metadata !== 'object' || record.metadata === null || !Array.isArray(record.metadata.identifiers)) {
    return null;
  }
  return {
    metadata: record.metadata,
    cover: {
      coverId: typeof record.cover?.coverId === 'number' ? record.cover.coverId : null,
      isbn: typeof record.cover?.isbn === 'string' ? record.cover.isbn : null,
      agent: cleanCover(record.cover?.agent),
      pages: Array.isArray(record.cover?.pages)
        ? coverSourcePages(
            record.cover.pages.filter((page): page is string => typeof page === 'string').map((sourceUrl) => ({ sourceUrl })),
          )
        : [],
    },
  };
}

/**
 * An upload's cover: the agent's verified image first, then Open Library's (only when it returns
 * an image), then, when web access is on, a cited record page's cover, then the cover embedded in
 * the file. Every step is optional and never fails the import.
 */
async function uploadCover(
  context: ImportJobContext,
  ref: CoverRef,
  fileCover: { bytes: Buffer; mediaType: string } | null,
  trajectory: TrajectoryRecorder | null,
): Promise<{ bytes: Buffer; mediaType: string } | null> {
  const found =
    (await fetchAgentCover(ref.agent ?? null, context.assistant, trajectory)) ??
    (await fetchFallbackCover(context.openLibrary, ref, trajectory)) ??
    (ref.pages?.length && context.assistantConfig && webSearchAvailable(context.assistantConfig)
      ? await fetchSourcePageCover(ref.pages, context.assistant, trajectory)
      : null);
  if (found) return { bytes: found.bytes, mediaType: found.mediaType };
  if (fileCover) trajectory?.note('Cover taken from the file', { cover: { status: 'file', mediaType: fileCover.mediaType } });
  return fileCover;
}

function promptFields(metadata: BookMetadata, identifiers: Array<{ scheme: string; value: string }>): MetadataPromptFields {
  return {
    title: metadata.title,
    authors: metadata.creators.filter((creator) => creator.role === 'author').map((creator) => creator.name),
    translators: metadata.creators.filter((creator) => creator.role === 'translator').map((creator) => creator.name),
    description: metadata.description,
    publisher: metadata.publisher,
    publishedDate: null,
    language: metadata.language,
    identifiers,
    series: null,
    seriesOrder: null,
  };
}

/**
 * Builds import metadata from the agent's proposal. An identifier the file
 * itself carried keeps 'embedded' as its source; the rest are 'agent'.
 */
async function proposalMetadata(
  proposal: AssistantProposal,
  context: ImportJobContext,
  embedded: Array<{ scheme: string; value: string }>,
  fileCover: { bytes: Buffer; mediaType: string } | null,
  trajectory: TrajectoryRecorder | null,
): Promise<ImportMetadata> {
  assertCompleteProposal(proposal);
  const cover = await uploadCover(
    context,
    { coverId: proposal.coverId, isbn: proposal.isbn, agent: proposal.cover, pages: coverSourcePages(proposal.identifiers) },
    fileCover,
    trajectory,
  );
  const fromFile = new Set(embedded.map(identifierKey));
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
    identifiers: proposal.identifiers.map((identifier) => ({
      scheme: identifier.scheme,
      value: identifier.value,
      source: (fromFile.has(identifierKey(identifier)) ? 'embedded' : 'agent') as IdentifierSource,
      sourceUrl: identifier.sourceUrl ?? null,
    })),
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
    !proposal.publishedDate
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

function cleanupUploads(dataDir: string, sourcePaths: string[], keep: string[] = []): void {
  const dirs = new Set<string>();
  for (const sourcePath of sourcePaths) {
    const absolute = resolveUploadPath(dataDir, sourcePath);
    if (absolute) dirs.add(path.dirname(absolute));
  }
  for (const sourcePath of keep) {
    const absolute = resolveUploadPath(dataDir, sourcePath);
    if (absolute) dirs.delete(path.dirname(absolute));
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
  return row ? toView(db, row, false) : null;
}

/**
 * `admin` adds trajectory ids and step counts, and what a waiting file brings.
 * Readers never receive them.
 */
function toView(db: AppDatabase, row: typeof jobs.$inferSelect, admin: boolean): JobView {
  const refs = admin ? trajectoryRefs(db, row.id) : null;
  const items = db
    .select()
    .from(jobItems)
    .where(eq(jobItems.jobId, row.id))
    .orderBy(asc(jobItems.position))
    .all();
  const summary: JobSummary = {
    total: items.length,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    duplicate: 0,
    needs_confirmation: 0,
  };
  const views: JobItemView[] = items.map((item) => {
    const status = item.status as ItemStatus;
    summary[status] += 1;
    const view: JobItemView = {
      id: item.id,
      position: item.position,
      filename: item.filename,
      status,
      error: item.error,
      editionId: item.editionId,
      assetId: item.assetId,
      sha256: item.sha256,
      candidateEditionId: item.candidateEditionId,
      conflicts: decodeConflicts(item.conflicts),
      merged: item.merged,
      resolution: item.resolution,
    };
    if (admin && status === 'needs_confirmation') {
      const incoming = decodeIncoming(item.pending);
      if (incoming) view.incoming = incoming;
    }
    const ref = refs?.items.get(item.id);
    return ref ? { ...view, ...ref } : view;
  });
  const view: JobView = {
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
  return refs?.job ? { ...view, ...refs.job } : view;
}

function decodeConflicts(value: string | null): MergeConflict[] {
  const parsed = decodeJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is MergeConflict => MERGE_CONFLICTS.includes(item as MergeConflict));
}

/**
 * An admin's decision on an item that needs confirmation: merge the file into
 * the candidate edition, or keep it as a separate edition. The item and its job
 * are queued again and the worker finishes the file. Refused while the job is
 * still queued or running.
 */
export function resolveImportItem(
  db: AppDatabase,
  user: AuthUser,
  input: { jobId: number; itemId: number; resolution: ItemResolution },
  now = new Date(),
): JobView {
  if (user.role !== 'admin') throw new CatalogError('not_found');
  const stamp = now.toISOString();
  db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    const job = query.select().from(jobs).where(eq(jobs.id, input.jobId)).get();
    if (!job || !IMPORT_SOURCES.has(job.source) || !libraryIds(query, user).has(job.libraryId)) {
      throw new CatalogError('not_found');
    }
    const item = query
      .select()
      .from(jobItems)
      .where(and(eq(jobItems.id, input.itemId), eq(jobItems.jobId, job.id)))
      .get();
    if (!item) throw new CatalogError('not_found');
    if (job.status === 'queued' || job.status === 'running' || item.status !== 'needs_confirmation') {
      throw new CatalogError('conflict');
    }
    if (input.resolution === 'merge') {
      const candidate = item.candidateEditionId
        ? query
            .select({ libraryId: editions.libraryId, trashedAt: editions.trashedAt })
            .from(editions)
            .where(eq(editions.id, item.candidateEditionId))
            .get()
        : undefined;
      if (!candidate || candidate.trashedAt || candidate.libraryId !== job.libraryId) throw new CatalogError('not_found');
    }
    query
      .update(jobItems)
      .set({ status: 'queued', resolution: input.resolution, error: null, updatedAt: stamp })
      .where(eq(jobItems.id, item.id))
      .run();
    query
      .update(jobs)
      .set({ status: 'queued', result: null, finishedAt: null, updatedAt: stamp })
      .where(eq(jobs.id, job.id))
      .run();
  }, { behavior: 'immediate' });
  const view = getVisibleJob(db, user, input.jobId);
  if (!view) throw new CatalogError('not_found');
  return view;
}

function decodeJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
