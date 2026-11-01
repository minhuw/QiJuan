import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, listLibraries, requireLibraryAccess } from './accounts.js';
import { CatalogError, getEdition } from './catalog.js';
import type { AppDatabase } from './db.js';
import { presentLibraryEdition } from './library.js';
import type { AuthUser } from './sessions.js';
import {
  deleteEdition,
  deleteEditionAsset,
  listTrash,
  restoreEdition,
  restoreEditionAsset,
  trashEdition,
  trashEditionAsset,
} from './trash.js';

export interface TrashRouteDeps {
  db: AppDatabase;
  dataDir: string;
}

type Params = { editionId?: string; assetId?: string };

/** Removing, restoring and deleting books and files. Admins only. */
export function registerTrashRoutes(app: FastifyInstance, deps: TrashRouteDeps): void {
  app.get('/api/trash', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    reply.header('cache-control', 'no-store');
    return listTrash(deps.db, listLibraries(deps.db, user).map((library) => library.id));
  });

  app.post('/api/editions/:editionId/trash', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    try {
      const editionId = accessEdition(deps.db, user, request.params as Params);
      const edition = trashEdition(deps.db, deps.dataDir, editionId);
      reply.header('cache-control', 'no-store');
      return { edition };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/editions/:editionId/restore', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    try {
      const editionId = accessEdition(deps.db, user, request.params as Params);
      restoreEdition(deps.db, editionId);
      reply.header('cache-control', 'no-store');
      return { edition: presentLibraryEdition(deps.db, user, editionId) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/api/editions/:editionId', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    try {
      const editionId = accessEdition(deps.db, user, request.params as Params);
      deleteEdition(deps.db, deps.dataDir, editionId);
      reply.header('cache-control', 'no-store');
      return { deleted: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/editions/:editionId/assets/:assetId/trash', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    try {
      const params = request.params as Params;
      const editionId = accessEdition(deps.db, user, params);
      trashEditionAsset(deps.db, editionId, parseId(params.assetId) ?? 0);
      reply.header('cache-control', 'no-store');
      return { edition: presentLibraryEdition(deps.db, user, editionId) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/editions/:editionId/assets/:assetId/restore', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    try {
      const params = request.params as Params;
      const editionId = accessEdition(deps.db, user, params);
      restoreEditionAsset(deps.db, editionId, parseId(params.assetId) ?? 0);
      reply.header('cache-control', 'no-store');
      return { edition: presentLibraryEdition(deps.db, user, editionId) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/api/editions/:editionId/assets/:assetId', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    try {
      const params = request.params as Params;
      const editionId = accessEdition(deps.db, user, params);
      deleteEditionAsset(deps.db, deps.dataDir, editionId, parseId(params.assetId) ?? 0);
      reply.header('cache-control', 'no-store');
      return { deleted: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

/** Any edition, live or trashed, in a library the user can open. */
function accessEdition(db: AppDatabase, user: AuthUser, params: Params): number {
  const editionId = parseId(params.editionId);
  if (!editionId) throw new CatalogError('invalid_request');
  const edition = getEdition(db, editionId);
  if (!edition) throw new CatalogError('not_found');
  requireLibraryAccess(db, user, edition.libraryId);
  return edition.id;
}

function currentUser(request: FastifyRequest): AuthUser {
  const user = request.authUser;
  if (!user) throw new ApiError(401, 'unauthorized');
  return user;
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
    const status =
      error.code === 'not_found'
        ? 404
        : error.code === 'not_in_trash' || error.code === 'last_asset' || error.code === 'conflict'
          ? 409
          : 400;
    return reply.code(status).send({ error: error.code });
  }
  throw error;
}
