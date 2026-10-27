import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, requireLibraryAccess } from './accounts.js';
import { CatalogError } from './catalog.js';
import type { AppDatabase } from './db.js';
import { requireLiveEdition } from './editions.js';
import { exportAnnotations, annotationsMarkdown } from './annotations-export.js';
import {
  addBookmark,
  addHighlight,
  addNote,
  contentDisposition,
  epubReadStream,
  loadReadingPlace,
  openAssetStream,
  parseByteRange,
  removeBookmark,
  removeHighlight,
  removeNote,
  RevisionConflict,
  saveReadingPosition,
  updateBookmark,
  updateHighlight,
  updateNote,
} from './reader.js';
import type { AuthUser } from './sessions.js';

export function registerReaderRoutes(app: FastifyInstance, deps: { db: AppDatabase; dataDir: string }): void {
  app.get('/api/editions/:editionId/assets/:assetId/file', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const assetId = parseId((request.params as { assetId?: string }).assetId);
      if (!assetId) return reply.code(400).send({ error: 'invalid_request' });
      const file = openAssetStream(deps.db, deps.dataDir, editionId, assetId);
      const pdf = file.format === 'pdf';
      const rawRange = request.headers.range;
      const range = parseByteRange(Array.isArray(rawRange) ? rawRange[0] : rawRange, file.bytes);
      reply.header('accept-ranges', 'bytes');
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      if (range === 'invalid') {
        reply.header('content-range', `bytes */${file.bytes}`);
        return reply.code(416).send({ error: 'invalid_request' });
      }
      reply.header('content-type', pdf ? 'application/pdf' : 'application/epub+zip');
      reply.header('content-disposition', contentDisposition(file.filename, pdf ? 'book.pdf' : 'book.epub'));
      if (range) {
        reply.header('content-range', `bytes ${range.start}-${range.end}/${file.bytes}`);
        reply.header('content-length', range.end - range.start + 1);
        return reply.code(206).send(epubReadStream(file.absolutePath, range));
      }
      reply.header('content-length', file.bytes);
      return reply.send(epubReadStream(file.absolutePath));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/editions/:editionId/reading-place', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      reply.header('cache-control', 'no-store');
      return loadReadingPlace(deps.db, user.id, editionId);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put('/api/editions/:editionId/reading-place', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const body = parsePosition(request.body);
      const position = saveReadingPosition(deps.db, { userId: user.id, editionId, ...body });
      reply.header('cache-control', 'no-store');
      return { position };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/editions/:editionId/bookmarks', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const body = parseAnchored(request.body, ['locator', 'assetId', 'label', 'revision']);
      const bookmark = addBookmark(deps.db, {
        userId: user.id,
        editionId,
        assetId: body.assetId,
        locator: body.locator,
        label: body.label,
        revision: body.revision,
      });
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({ bookmark });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/api/editions/:editionId/bookmarks/:bookmarkId', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const bookmarkId = parseId((request.params as { bookmarkId?: string }).bookmarkId);
      const revision = parseDeleteRevision(request.body);
      if (!bookmarkId) return reply.code(400).send({ error: 'invalid_request' });
      removeBookmark(deps.db, user.id, editionId, bookmarkId, revision);
      reply.header('cache-control', 'no-store');
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/api/editions/:editionId/bookmarks/:bookmarkId', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const bookmarkId = parseId((request.params as { bookmarkId?: string }).bookmarkId);
      const body = parseBookmarkPatch(request.body);
      if (!bookmarkId) return reply.code(400).send({ error: 'invalid_request' });
      const bookmark = updateBookmark(deps.db, { userId: user.id, editionId, bookmarkId, ...body });
      reply.header('cache-control', 'no-store');
      return { bookmark };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/editions/:editionId/highlights', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const body = parseAnchored(request.body, ['locator', 'assetId', 'quote', 'revision']);
      const highlight = addHighlight(deps.db, {
        userId: user.id,
        editionId,
        assetId: body.assetId,
        locator: body.locator,
        quote: body.quote,
        revision: body.revision,
      });
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({ highlight });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/api/editions/:editionId/highlights/:highlightId', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const highlightId = parseId((request.params as { highlightId?: string }).highlightId);
      const revision = parseDeleteRevision(request.body);
      if (!highlightId) return reply.code(400).send({ error: 'invalid_request' });
      removeHighlight(deps.db, user.id, editionId, highlightId, revision);
      reply.header('cache-control', 'no-store');
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/api/editions/:editionId/highlights/:highlightId', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const highlightId = parseId((request.params as { highlightId?: string }).highlightId);
      const body = parseHighlightPatch(request.body);
      if (!highlightId) return reply.code(400).send({ error: 'invalid_request' });
      const highlight = updateHighlight(deps.db, { userId: user.id, editionId, highlightId, ...body });
      reply.header('cache-control', 'no-store');
      return { highlight };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/editions/:editionId/notes', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const body = parseNoteCreate(request.body);
      const note = addNote(deps.db, { userId: user.id, editionId, ...body });
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({ note });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/api/editions/:editionId/notes/:noteId', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const noteId = parseId((request.params as { noteId?: string }).noteId);
      const body = parseNoteUpdate(request.body);
      if (!noteId) return reply.code(400).send({ error: 'invalid_request' });
      const note = updateNote(deps.db, { userId: user.id, editionId, noteId, body: body.body, revision: body.revision });
      reply.header('cache-control', 'no-store');
      return { note };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/api/editions/:editionId/notes/:noteId', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const noteId = parseId((request.params as { noteId?: string }).noteId);
      const revision = parseDeleteRevision(request.body);
      if (!noteId) return reply.code(400).send({ error: 'invalid_request' });
      removeNote(deps.db, user.id, editionId, noteId, revision);
      reply.header('cache-control', 'no-store');
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/editions/:editionId/annotations', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const format = parseExportFormat((request.query as { format?: string }).format);
      const document = exportAnnotations(deps.db, user.id, editionId);
      reply.header('cache-control', 'no-store');
      reply.header('x-content-type-options', 'nosniff');
      if (format === 'markdown') {
        reply.header('content-type', 'text/markdown; charset=utf-8');
        reply.header('content-disposition', 'attachment; filename="annotations.md"');
        return reply.send(annotationsMarkdown(document));
      }
      reply.header('content-type', 'application/json; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="annotations.json"');
      return document;
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function accessEdition(db: AppDatabase, user: AuthUser, raw: string | undefined): number {
  const editionId = parseId(raw);
  if (!editionId) throw new CatalogError('invalid_request');
  const edition = requireLiveEdition(db, editionId);
  requireLibraryAccess(db, user, edition.libraryId);
  return edition.id;
}

function parsePosition(body: unknown): { locator: string; assetId: number; revision: number } {
  const record = asRecord(body);
  if (!record) throw new CatalogError('invalid_request');
  assertKeys(record, ['locator', 'assetId', 'revision']);
  if (typeof record.locator !== 'string') throw new CatalogError('invalid_request');
  return { locator: record.locator, assetId: parseAssetId(record.assetId), revision: parseRevision(record.revision) };
}

function parseAnchored(
  body: unknown,
  allowed: string[],
): { locator: string; assetId: number; label: string | null; quote: string | null; revision: number } {
  const record = asRecord(body);
  if (!record) throw new CatalogError('invalid_request');
  assertKeys(record, allowed);
  if (typeof record.locator !== 'string') throw new CatalogError('invalid_request');
  const assetId = parseAssetId(record.assetId);
  const label = record.label === undefined || record.label === null ? null : stringField(record.label);
  const quote = record.quote === undefined || record.quote === null ? null : stringField(record.quote);
  return { locator: record.locator, assetId, label, quote, revision: parseRevision(record.revision) };
}

function parseBookmarkPatch(body: unknown): { revision: number; label?: string | null; locator?: string } {
  const record = asRecord(body);
  if (!record) throw new CatalogError('invalid_request');
  assertKeys(record, ['revision', 'label', 'locator']);
  const revision = parseRevision(record.revision);
  const hasLabel = Object.prototype.hasOwnProperty.call(record, 'label');
  const hasLocator = Object.prototype.hasOwnProperty.call(record, 'locator');
  if (!hasLabel && !hasLocator) throw new CatalogError('invalid_request');
  const patch: { revision: number; label?: string | null; locator?: string } = { revision };
  if (hasLabel) patch.label = record.label === null ? null : stringField(record.label);
  if (hasLocator) patch.locator = stringField(record.locator);
  return patch;
}

function parseHighlightPatch(body: unknown): { revision: number; quote?: string | null; locator?: string } {
  const record = asRecord(body);
  if (!record) throw new CatalogError('invalid_request');
  assertKeys(record, ['revision', 'quote', 'locator']);
  const revision = parseRevision(record.revision);
  const hasQuote = Object.prototype.hasOwnProperty.call(record, 'quote');
  const hasLocator = Object.prototype.hasOwnProperty.call(record, 'locator');
  if (!hasQuote && !hasLocator) throw new CatalogError('invalid_request');
  const patch: { revision: number; quote?: string | null; locator?: string } = { revision };
  if (hasQuote) patch.quote = record.quote === null ? null : stringField(record.quote);
  if (hasLocator) patch.locator = stringField(record.locator);
  return patch;
}

function parseNoteCreate(body: unknown): { locator: string; assetId: number; body: string; revision: number } {
  const record = asRecord(body);
  if (!record) throw new CatalogError('invalid_request');
  assertKeys(record, ['locator', 'assetId', 'body', 'revision']);
  if (typeof record.locator !== 'string' || typeof record.body !== 'string') throw new CatalogError('invalid_request');
  return {
    locator: record.locator,
    assetId: parseAssetId(record.assetId),
    body: record.body,
    revision: parseRevision(record.revision),
  };
}

function parseNoteUpdate(body: unknown): { body: string; revision: number } {
  const record = asRecord(body);
  if (!record) throw new CatalogError('invalid_request');
  assertKeys(record, ['body', 'revision']);
  if (typeof record.body !== 'string') throw new CatalogError('invalid_request');
  return { body: record.body, revision: parseRevision(record.revision) };
}

function parseDeleteRevision(body: unknown): number {
  const record = asRecord(body);
  if (!record) throw new CatalogError('invalid_request');
  assertKeys(record, ['revision']);
  return parseRevision(record.revision);
}

function parseExportFormat(value: string | undefined): 'markdown' | 'json' {
  if (value === 'markdown' || value === 'json') return value;
  throw new CatalogError('invalid_request');
}

function parseRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new CatalogError('invalid_request');
  }
  return value;
}

function stringField(value: unknown): string {
  if (typeof value !== 'string') throw new CatalogError('invalid_request');
  return value;
}

function parseAssetId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new CatalogError('invalid_request');
  return value;
}

function assertKeys(record: Record<string, unknown>, allowed: string[]): void {
  const ok = new Set(allowed);
  if (Object.keys(record).some((key) => !ok.has(key))) throw new CatalogError('invalid_request');
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

function parseId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id)) return null;
  return id;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
  if (error instanceof RevisionConflict) return reply.code(409).send({ error: 'conflict', ...error.payload });
  if (error instanceof CatalogError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400;
    return reply.code(status).send({ error: error.code });
  }
  throw error;
}
