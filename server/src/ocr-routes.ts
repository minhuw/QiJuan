import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, requireLibraryAccess } from './accounts.js';
import { CatalogError, getEdition } from './catalog.js';
import type { AppDatabase } from './db.js';
import { OCR_LANGUAGES, requestOcr, removeOcr } from './ocr.js';
import type { AuthUser } from './sessions.js';

export interface OcrRouteDeps {
  db: AppDatabase;
  dataDir: string;
  /** Whether the OCR tool can run on this server. */
  available: () => boolean;
}

type Params = { editionId?: string; assetId?: string };

/** Requesting and removing text recognition of a PDF. Admins only; readers see only the result. */
export function registerOcrRoutes(app: FastifyInstance, deps: OcrRouteDeps): void {
  app.get('/api/ocr', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    reply.header('cache-control', 'no-store');
    return { available: deps.available(), languages: OCR_LANGUAGES.split('+') };
  });

  app.post('/api/editions/:editionId/assets/:assetId/ocr', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    try {
      const { editionId, assetId } = access(deps.db, user, request.params as Params);
      if (!deps.available()) return reply.code(409).send({ error: 'ocr_unavailable' });
      requestOcr(deps.db, editionId, assetId);
      reply.header('cache-control', 'no-store');
      return reply.code(202).send({ queued: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/api/editions/:editionId/assets/:assetId/ocr', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    try {
      const { editionId, assetId } = access(deps.db, user, request.params as Params);
      removeOcr(deps.db, deps.dataDir, editionId, assetId);
      reply.header('cache-control', 'no-store');
      return { deleted: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function access(db: AppDatabase, user: AuthUser, params: Params): { editionId: number; assetId: number } {
  const editionId = parseId(params.editionId);
  const assetId = parseId(params.assetId);
  if (!editionId || !assetId) throw new CatalogError('invalid_request');
  const edition = getEdition(db, editionId);
  if (!edition) throw new CatalogError('not_found');
  requireLibraryAccess(db, user, edition.libraryId);
  return { editionId, assetId };
}

function currentUser(request: FastifyRequest): AuthUser {
  const user = request.authUser;
  if (!user) throw new ApiError(401, 'unauthorized');
  return user;
}

function parseId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
  if (error instanceof CatalogError) {
    return reply.code(error.code === 'not_found' ? 404 : 400).send({ error: error.code });
  }
  throw error;
}
