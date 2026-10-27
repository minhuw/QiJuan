import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, listLibraries, requireLibraryAccess } from './accounts.js';
import { CatalogError } from './catalog.js';
import type { AppDatabase } from './db.js';
import { coverAbsolute, latestCover } from './edition-fields.js';
import {
  type BatchPatch,
  type EditionPatch,
  batchEditEditions,
  cleanPatchText,
  listEditionSummaries,
  replaceEditionCover,
  requireLiveEdition,
  updateEdition,
  cleanDescription,
  cleanLanguage,
  cleanPublishedDate,
  cleanPublisher,
} from './editions.js';
import { createBackgroundJob } from './jobs.js';
import { PREVIEW_FIELDS, type PreviewField } from './metadata/apply.js';
import type { AuthUser } from './sessions.js';
import { presentLibraryEdition } from './library.js';
import { dismissSuggestion, findSuggestion } from './suggestions.js';

const MAX_COVER_BYTES = 8 * 1024 * 1024;
const MAX_BATCH = 100;

const PREVIEW_FIELD_SET = new Set<string>(PREVIEW_FIELDS);

export interface EditionRouteDeps {
  db: AppDatabase;
  dataDir: string;
}

export function registerEditionRoutes(app: FastifyInstance, deps: EditionRouteDeps): void {
  app.get('/api/editions', async (request, reply) => {
    const user = currentUser(request);
    const requested = (request.query as { libraryId?: string }).libraryId;
    let libraryIds = listLibraries(deps.db, user).map((library) => library.id);
    if (requested !== undefined) {
      const libraryId = parseId(requested);
      if (!libraryId) return reply.code(400).send({ error: 'invalid_request' });
      try {
        requireLibraryAccess(deps.db, user, libraryId);
      } catch (error) {
        return sendError(reply, error);
      }
      libraryIds = libraryIds.filter((id) => id === libraryId);
    }
    reply.header('cache-control', 'no-store');
    return { editions: listEditionSummaries(deps.db, libraryIds) };
  });

  app.post('/api/editions/batch', async (request, reply) => {
    const user = currentUser(request);
    let patch: BatchPatch;
    try {
      patch = parseBatch(request.body);
      for (const editionId of patch.editionIds) {
        const edition = requireLiveEdition(deps.db, editionId);
        requireLibraryAccess(deps.db, user, edition.libraryId);
      }
      const updated = batchEditEditions(deps.db, patch);
      reply.header('cache-control', 'no-store');
      return { updated };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/editions/:editionId', async (request, reply) => {
    const user = currentUser(request);
    try {
      const edition = await accessEdition(deps, user, (request.params as { editionId?: string }).editionId);
      reply.header('cache-control', 'no-store');
      return { edition: presentEdition(deps.db, user.id, edition.id) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/api/editions/:editionId', async (request, reply) => {
    const user = currentUser(request);
    try {
      const edition = await accessEdition(deps, user, (request.params as { editionId?: string }).editionId);
      const patch = parsePatch(request.body);
      if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'invalid_request' });
      updateEdition(deps.db, edition.id, patch);
      reply.header('cache-control', 'no-store');
      return { edition: presentEdition(deps.db, user.id, edition.id) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/editions/:editionId/cover', async (request, reply) => {
    const user = currentUser(request);
    try {
      const edition = await accessEdition(deps, user, (request.params as { editionId?: string }).editionId);
      const upload = await readCoverUpload(request);
      if (upload.tooLarge) return reply.code(413).send({ error: 'payload_too_large' });
      if (!upload.bytes) return reply.code(400).send({ error: 'invalid_request' });
      replaceEditionCover(deps.db, { dataDir: deps.dataDir, editionId: edition.id, bytes: upload.bytes });
      reply.header('cache-control', 'no-store');
      return { edition: presentEdition(deps.db, user.id, edition.id) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/editions/:editionId/cover', async (request, reply) => {
    const user = currentUser(request);
    try {
      const edition = await accessEdition(deps, user, (request.params as { editionId?: string }).editionId);
      const cover = latestCover(deps.db, edition.id);
      if (!cover) return reply.code(404).send({ error: 'not_found' });
      const absolute = coverAbsolute(deps.dataDir, cover);
      if (!absolute) return reply.code(404).send({ error: 'not_found' });
      const bytes = readFileSync(absolute);
      return reply.type(cover.mediaType).header('cache-control', 'private, no-store').send(bytes);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/editions/:editionId/refresh', async (request, reply) => {
    const user = currentUser(request);
    try {
      const edition = await accessEdition(deps, user, (request.params as { editionId?: string }).editionId);
      const job = createBackgroundJob(deps.db, {
        libraryId: edition.libraryId,
        userId: user.id,
        source: 'refresh',
        payload: { editionId: edition.id },
      });
      reply.header('cache-control', 'no-store');
      return reply.code(202).send({ job });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/editions/:editionId/metadata/lookup', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    try {
      const edition = await accessEdition(deps, user, (request.params as { editionId?: string }).editionId);
      const job = createBackgroundJob(deps.db, {
        libraryId: edition.libraryId,
        userId: user.id,
        source: 'lookup',
        payload: { editionId: edition.id },
      });
      reply.header('cache-control', 'no-store');
      return reply.code(202).send({ job });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/editions/:editionId/metadata/apply', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    try {
      const edition = await accessEdition(deps, user, (request.params as { editionId?: string }).editionId);
      const body = asRecord(request.body);
      const previewId = body && typeof body.previewId === 'number' ? body.previewId : null;
      const confirm = parseConfirm(body?.confirm);
      if (!previewId || !Number.isInteger(previewId) || previewId < 1 || !confirm) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const job = createBackgroundJob(deps.db, {
        libraryId: edition.libraryId,
        userId: user.id,
        source: 'apply',
        payload: { editionId: edition.id, previewId, confirm },
      });
      reply.header('cache-control', 'no-store');
      return reply.code(202).send({ job });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/suggestions/:suggestionId/dismiss', async (request, reply) => {
    const user = currentUser(request);
    const suggestionId = parseId((request.params as { suggestionId?: string }).suggestionId);
    if (!suggestionId) return reply.code(400).send({ error: 'invalid_request' });
    const suggestion = findSuggestion(deps.db, suggestionId);
    if (!suggestion) return reply.code(404).send({ error: 'not_found' });
    try {
      requireLibraryAccess(deps.db, user, suggestion.libraryId);
      dismissSuggestion(deps.db, suggestion.id, new Date().toISOString());
      reply.header('cache-control', 'no-store');
      return { dismissed: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function presentEdition(db: AppDatabase, userId: number, editionId: number) {
  return presentLibraryEdition(db, userId, editionId);
}

async function accessEdition(deps: EditionRouteDeps, user: AuthUser, raw: string | undefined) {
  const editionId = parseId(raw);
  if (!editionId) throw new CatalogError('invalid_request');
  const edition = requireLiveEdition(deps.db, editionId);
  requireLibraryAccess(deps.db, user, edition.libraryId);
  return edition;
}

function parsePatch(body: unknown): EditionPatch {
  const record = asRecord(body);
  if (!record) throw new CatalogError('invalid_request');
  const allowed = new Set([
    'title',
    'sortTitle',
    'alternateTitles',
    'authors',
    'translators',
    'description',
    'series',
    'seriesOrder',
    'publisher',
    'publishedDate',
    'language',
    'identifiers',
    'tags',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new CatalogError('invalid_request');
  }
  const patch: EditionPatch = {};
  if (has(record, 'title')) {
    if (typeof record.title !== 'string') throw new CatalogError('invalid_request');
    patch.title = record.title;
  }
  if (has(record, 'sortTitle')) {
    if (typeof record.sortTitle !== 'string') throw new CatalogError('invalid_request');
    patch.sortTitle = record.sortTitle;
  }
  if (has(record, 'description')) patch.description = cleanPatchText(record.description, cleanDescription);
  if (has(record, 'publisher')) patch.publisher = cleanPatchText(record.publisher, cleanPublisher);
  if (has(record, 'publishedDate')) patch.publishedDate = cleanPatchText(record.publishedDate, cleanPublishedDate);
  if (has(record, 'language')) patch.language = cleanPatchText(record.language, cleanLanguage);
  if (has(record, 'series')) {
    if (record.series === null) patch.series = null;
    else if (typeof record.series === 'string' && record.series.trim()) patch.series = record.series;
    else throw new CatalogError('invalid_request');
  }
  if (has(record, 'seriesOrder')) patch.seriesOrder = parseOrder(record.seriesOrder);
  if (has(record, 'alternateTitles')) patch.alternateTitles = parseAlternate(record.alternateTitles);
  if (has(record, 'authors')) patch.authors = parseStringList(record.authors);
  if (has(record, 'translators')) patch.translators = parseStringList(record.translators);
  if (has(record, 'tags')) patch.tags = parseStringList(record.tags);
  if (has(record, 'identifiers')) patch.identifiers = parseIdentifiers(record.identifiers);
  return patch;
}

function parseBatch(body: unknown): BatchPatch {
  const record = asRecord(body);
  if (!record) throw new CatalogError('invalid_request');
  const allowed = new Set(['editionIds', 'language', 'publisher', 'tags', 'series', 'seriesOrder']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new CatalogError('invalid_request');
  }
  if (!Array.isArray(record.editionIds) || record.editionIds.length === 0 || record.editionIds.length > MAX_BATCH) {
    throw new CatalogError('invalid_request');
  }
  const editionIds: number[] = [];
  const seen = new Set<number>();
  for (const id of record.editionIds) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) throw new CatalogError('invalid_request');
    if (seen.has(id)) continue;
    seen.add(id);
    editionIds.push(id);
  }
  const patch: BatchPatch = { editionIds };
  let fields = 0;
  if (has(record, 'language')) {
    patch.language = cleanPatchText(record.language, cleanLanguage);
    fields += 1;
  }
  if (has(record, 'publisher')) {
    patch.publisher = cleanPatchText(record.publisher, cleanPublisher);
    fields += 1;
  }
  if (has(record, 'tags')) {
    patch.tags = parseStringList(record.tags);
    fields += 1;
  }
  if (has(record, 'series')) {
    if (record.series === null) patch.series = null;
    else if (typeof record.series === 'string' && record.series.trim()) patch.series = record.series;
    else throw new CatalogError('invalid_request');
    fields += 1;
  }
  if (has(record, 'seriesOrder')) {
    patch.seriesOrder = parseOrder(record.seriesOrder);
    fields += 1;
  }
  if (fields === 0) throw new CatalogError('invalid_request');
  return patch;
}

function parseConfirm(value: unknown): PreviewField[] | null {
  if (!Array.isArray(value)) return null;
  const fields: PreviewField[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !PREVIEW_FIELD_SET.has(item)) return null;
    fields.push(item as PreviewField);
  }
  return fields;
}

function parseAlternate(value: unknown): Array<{ title: string; sortTitle: string | null }> {
  if (!Array.isArray(value)) throw new CatalogError('invalid_request');
  return value.map((item) => {
    const record = asRecord(item);
    if (!record || typeof record.title !== 'string') throw new CatalogError('invalid_request');
    if (record.sortTitle != null && typeof record.sortTitle !== 'string') throw new CatalogError('invalid_request');
    return { title: record.title, sortTitle: typeof record.sortTitle === 'string' ? record.sortTitle : null };
  });
}

function parseIdentifiers(value: unknown): Array<{ scheme: string; value: string }> {
  if (!Array.isArray(value)) throw new CatalogError('invalid_request');
  return value.map((item) => {
    const record = asRecord(item);
    if (!record || typeof record.scheme !== 'string' || typeof record.value !== 'string') {
      throw new CatalogError('invalid_request');
    }
    return { scheme: record.scheme, value: record.value };
  });
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new CatalogError('invalid_request');
  return value as string[];
}

function parseOrder(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CatalogError('invalid_request');
  return value;
}

async function readCoverUpload(request: FastifyRequest): Promise<{ bytes: Buffer | null; tooLarge: boolean }> {
  if (!request.isMultipart()) return { bytes: null, tooLarge: false };
  let bytes: Buffer | null = null;
  let tooLarge = false;
  for await (const part of request.parts()) {
    if (part.type !== 'file') continue;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of part.file) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > MAX_COVER_BYTES) {
        tooLarge = true;
      } else if (!tooLarge) {
        chunks.push(buffer);
      }
    }
    if (part.file.truncated) tooLarge = true;
    if (!bytes && !tooLarge) bytes = Buffer.concat(chunks);
  }
  if (tooLarge) return { bytes: null, tooLarge: true };
  if (!bytes || bytes.length === 0) return { bytes: null, tooLarge: false };
  return { bytes, tooLarge: false };
}

function currentUser(request: FastifyRequest): AuthUser {
  const user = request.authUser;
  if (!user) throw new ApiError(401, 'unauthorized');
  return user;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function parseId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id)) return null;
  return id;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
  if (error instanceof CatalogError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400;
    return reply.code(status).send({ error: error.code });
  }
  throw error;
}
