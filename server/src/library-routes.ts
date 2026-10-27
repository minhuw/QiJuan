import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, listLibraries, requireLibraryAccess } from './accounts.js';
import { CatalogError } from './catalog.js';
import type { AppDatabase } from './db.js';
import { requireLiveEdition } from './editions.js';
import {
  type ReadingPatch,
  type ReadingStatus,
  addShelfItem,
  cleanShelfName,
  createShelf,
  findOwnShelf,
  listUserShelves,
  loadHome,
  presentLibraryEdition,
  removeShelfItem,
  searchLibrary,
  setReading,
} from './library.js';
import type { AuthUser } from './sessions.js';

const STATUSES = new Set<ReadingStatus>(['want', 'reading', 'finished', 'on_hold']);
const FORMATS = new Set(['epub', 'pdf']);

export function registerLibraryRoutes(app: FastifyInstance, deps: { db: AppDatabase }): void {
  app.get('/api/home', async (request, reply) => {
    const user = currentUser(request);
    reply.header('cache-control', 'no-store');
    return loadHome(deps.db, user.id, libraryIds(deps.db, user));
  });

  app.get('/api/library', async (request, reply) => {
    const user = currentUser(request);
    try {
      const parsed = parseLibraryQuery(request.query);
      if (parsed.shelfId != null && !findOwnShelf(deps.db, user.id, parsed.shelfId)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      reply.header('cache-control', 'no-store');
      return searchLibrary(deps.db, { ...parsed, userId: user.id, libraryIds: libraryIds(deps.db, user) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/shelves', async (request, reply) => {
    const user = currentUser(request);
    reply.header('cache-control', 'no-store');
    return { shelves: listUserShelves(deps.db, user.id, libraryIds(deps.db, user)) };
  });

  app.post('/api/shelves', async (request, reply) => {
    const user = currentUser(request);
    try {
      const body = asRecord(request.body);
      if (!body) return reply.code(400).send({ error: 'invalid_request' });
      const allowed = new Set(['name', 'editionId']);
      if (Object.keys(body).some((key) => !allowed.has(key))) return reply.code(400).send({ error: 'invalid_request' });
      const name = cleanShelfName(body.name);
      if (!name) return reply.code(400).send({ error: 'invalid_request' });
      let editionId: number | null = null;
      if (body.editionId !== undefined) {
        if (typeof body.editionId !== 'number') return reply.code(400).send({ error: 'invalid_request' });
        editionId = accessEdition(deps.db, user, body.editionId).id;
      }
      const shelf = createShelf(deps.db, user.id, name, editionId);
      reply.header('cache-control', 'no-store');
      if (editionId == null) return reply.code(201).send({ shelf });
      return reply.code(201).send({ shelf, edition: presentLibraryEdition(deps.db, user.id, editionId) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/shelves/:shelfId/items', async (request, reply) => {
    const user = currentUser(request);
    try {
      const shelfId = parseId((request.params as { shelfId?: string }).shelfId);
      const body = asRecord(request.body);
      if (!shelfId || !body || Object.keys(body).some((key) => key !== 'editionId') || typeof body.editionId !== 'number') {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const edition = accessEdition(deps.db, user, body.editionId);
      addShelfItem(deps.db, user.id, shelfId, edition.id);
      reply.header('cache-control', 'no-store');
      return { edition: presentLibraryEdition(deps.db, user.id, edition.id) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/api/shelves/:shelfId/items/:editionId', async (request, reply) => {
    const user = currentUser(request);
    try {
      const shelfId = parseId((request.params as { shelfId?: string }).shelfId);
      const edition = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      if (!shelfId) return reply.code(400).send({ error: 'invalid_request' });
      removeShelfItem(deps.db, user.id, shelfId, edition.id);
      reply.header('cache-control', 'no-store');
      return { edition: presentLibraryEdition(deps.db, user.id, edition.id) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/api/editions/:editionId/reading', async (request, reply) => {
    const user = currentUser(request);
    try {
      const edition = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const patch = parseReadingPatch(request.body);
      setReading(deps.db, user.id, edition.id, patch);
      reply.header('cache-control', 'no-store');
      return { edition: presentLibraryEdition(deps.db, user.id, edition.id) };
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function libraryIds(db: AppDatabase, user: AuthUser): number[] {
  return listLibraries(db, user).map((library) => library.id);
}

function accessEdition(db: AppDatabase, user: AuthUser, raw: unknown) {
  const editionId = typeof raw === 'number' ? (Number.isInteger(raw) && raw > 0 ? raw : null) : parseId(typeof raw === 'string' ? raw : undefined);
  if (!editionId) throw new CatalogError('invalid_request');
  const edition = requireLiveEdition(db, editionId);
  requireLibraryAccess(db, user, edition.libraryId);
  return edition;
}

function parseLibraryQuery(query: unknown): Omit<LibraryQueryShape, 'userId' | 'libraryIds'> {
  const record = asRecord(query);
  if (!record || typeof record.limit !== 'string') throw new CatalogError('invalid_request');
  const limit = parseBound(record.limit, 1, 60);
  if (record.offset !== undefined && typeof record.offset !== 'string') throw new CatalogError('invalid_request');
  const offset = record.offset === undefined ? 0 : parseBound(record.offset, 0, 1_000_000);
  if (limit == null || offset == null) throw new CatalogError('invalid_request');
  return {
    q: parseOptionalText(record.q, 200),
    language: parseOptionalText(record.language, 35),
    format: parseFormat(record.format),
    status: parseStatus(record.status),
    shelfId: parseOptionalId(record.shelfId),
    limit,
    offset,
  };
}

interface LibraryQueryShape {
  userId: number;
  libraryIds: number[];
  q: string | null;
  language: string | null;
  format: 'epub' | 'pdf' | null;
  status: ReadingStatus | null;
  shelfId: number | null;
  limit: number;
  offset: number;
}

function parseBound(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function parseOptionalText(value: unknown, max: number): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new CatalogError('invalid_request');
  const text = value.trim();
  if (!text) return null;
  if (Array.from(text).length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new CatalogError('invalid_request');
  return text;
}

function parseFormat(value: unknown): 'epub' | 'pdf' | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !FORMATS.has(value)) throw new CatalogError('invalid_request');
  return value as 'epub' | 'pdf';
}

function parseStatus(value: unknown): ReadingStatus | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !STATUSES.has(value as ReadingStatus)) throw new CatalogError('invalid_request');
  return value as ReadingStatus;
}

function parseOptionalId(value: unknown): number | null {
  if (value === undefined) return null;
  const id = parseId(typeof value === 'string' ? value : undefined);
  if (!id) throw new CatalogError('invalid_request');
  return id;
}

function parseReadingPatch(body: unknown): ReadingPatch {
  const record = asRecord(body);
  if (!record) throw new CatalogError('invalid_request');
  const allowed = new Set(['status', 'rating', 'favorite', 'queued']);
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) throw new CatalogError('invalid_request');
  const patch: ReadingPatch = {};
  if (Object.prototype.hasOwnProperty.call(record, 'status')) {
    if (record.status === null) patch.status = null;
    else if (typeof record.status === 'string' && STATUSES.has(record.status as ReadingStatus)) patch.status = record.status as ReadingStatus;
    else throw new CatalogError('invalid_request');
  }
  if (Object.prototype.hasOwnProperty.call(record, 'rating')) {
    if (record.rating === null) patch.rating = null;
    else if (typeof record.rating === 'number' && Number.isInteger(record.rating) && record.rating >= 1 && record.rating <= 5) {
      patch.rating = record.rating;
    } else throw new CatalogError('invalid_request');
  }
  if (Object.prototype.hasOwnProperty.call(record, 'favorite')) {
    if (typeof record.favorite !== 'boolean') throw new CatalogError('invalid_request');
    patch.favorite = record.favorite;
  }
  if (Object.prototype.hasOwnProperty.call(record, 'queued')) {
    if (typeof record.queued !== 'boolean') throw new CatalogError('invalid_request');
    patch.queued = record.queued;
  }
  return patch;
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
