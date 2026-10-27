import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, requireLibraryAccess } from './accounts.js';
import { CatalogError } from './catalog.js';
import type { AppDatabase } from './db.js';
import { requireLiveEdition } from './editions.js';
import {
  addBookmark,
  addHighlight,
  addNote,
  contentDisposition,
  epubReadStream,
  loadReadingPlace,
  openAssetStream,
  removeBookmark,
  removeHighlight,
  removeNote,
  saveReadingPosition,
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
      reply.header('content-type', pdf ? 'application/pdf' : 'application/epub+zip');
      reply.header('content-length', file.bytes);
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      reply.header('content-disposition', contentDisposition(file.filename, pdf ? 'book.pdf' : 'book.epub'));
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
      const body = parseAnchored(request.body, ['locator', 'assetId', 'label']);
      const bookmark = addBookmark(deps.db, {
        userId: user.id,
        editionId,
        assetId: body.assetId,
        locator: body.locator,
        label: body.label,
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
      if (!bookmarkId) return reply.code(400).send({ error: 'invalid_request' });
      removeBookmark(deps.db, user.id, editionId, bookmarkId);
      reply.header('cache-control', 'no-store');
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/editions/:editionId/highlights', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const body = parseAnchored(request.body, ['locator', 'assetId', 'quote']);
      const highlight = addHighlight(deps.db, {
        userId: user.id,
        editionId,
        assetId: body.assetId,
        locator: body.locator,
        quote: body.quote,
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
      if (!highlightId) return reply.code(400).send({ error: 'invalid_request' });
      removeHighlight(deps.db, user.id, editionId, highlightId);
      reply.header('cache-control', 'no-store');
      return reply.code(204).send();
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
      const note = updateNote(deps.db, { userId: user.id, editionId, noteId, body });
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
      if (!noteId) return reply.code(400).send({ error: 'invalid_request' });
      removeNote(deps.db, user.id, editionId, noteId);
      reply.header('cache-control', 'no-store');
      return reply.code(204).send();
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

function parsePosition(body: unknown): { locator: string; assetId: number } {
  const record = asRecord(body);
  if (!record) throw new CatalogError('invalid_request');
  assertKeys(record, ['locator', 'assetId']);
  if (typeof record.locator !== 'string') throw new CatalogError('invalid_request');
  const assetId = parseAssetId(record.assetId);
  return { locator: record.locator, assetId };
}

function parseAnchored(
  body: unknown,
  allowed: string[],
): { locator: string; assetId: number; label: string | null; quote: string | null } {
  const record = asRecord(body);
  if (!record) throw new CatalogError('invalid_request');
  assertKeys(record, allowed);
  if (typeof record.locator !== 'string') throw new CatalogError('invalid_request');
  const assetId = parseAssetId(record.assetId);
  const label = record.label === undefined || record.label === null ? null : stringField(record.label);
  const quote = record.quote === undefined || record.quote === null ? null : stringField(record.quote);
  return { locator: record.locator, assetId, label, quote };
}

function parseNoteCreate(body: unknown): { locator: string; assetId: number; body: string } {
  const record = asRecord(body);
  if (!record) throw new CatalogError('invalid_request');
  assertKeys(record, ['locator', 'assetId', 'body']);
  if (typeof record.locator !== 'string' || typeof record.body !== 'string') throw new CatalogError('invalid_request');
  return { locator: record.locator, assetId: parseAssetId(record.assetId), body: record.body };
}

function parseNoteUpdate(body: unknown): string {
  const record = asRecord(body);
  if (!record) throw new CatalogError('invalid_request');
  assertKeys(record, ['body']);
  if (typeof record.body !== 'string') throw new CatalogError('invalid_request');
  return record.body;
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
  if (error instanceof CatalogError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400;
    return reply.code(status).send({ error: error.code });
  }
  throw error;
}
