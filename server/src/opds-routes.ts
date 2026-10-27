import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, listLibraries, requireLibraryAccess } from './accounts.js';
import { CatalogError } from './catalog.js';
import type { AppDatabase } from './db.js';
import { coverAbsolute, latestCover } from './edition-fields.js';
import { requireLiveEdition } from './editions.js';
import {
  OPDS_ACQUISITION_TYPE,
  OPDS_NAVIGATION_TYPE,
  OPDS_SEARCH_TYPE,
  listOpdsEntries,
  renderLibraryFeed,
  renderNavigationFeed,
  renderOpenSearch,
  renderSearchFeed,
} from './opds.js';
import { createOpdsToken, listOpdsTokens, parseTokenLabel, revokeOpdsToken } from './opds-tokens.js';
import { contentDisposition, epubReadStream, openAssetStream, parseByteRange } from './reader.js';
import type { AuthUser } from './sessions.js';

export function registerOpdsRoutes(app: FastifyInstance, deps: { db: AppDatabase; dataDir: string }): void {
  app.get('/api/opds-tokens', async (request, reply) => {
    const user = currentUser(request);
    reply.header('cache-control', 'no-store');
    return { tokens: listOpdsTokens(deps.db, user.id) };
  });

  app.post('/api/opds-tokens', async (request, reply) => {
    const user = currentUser(request);
    const body = asRecord(request.body);
    if (!body || Object.keys(body).some((key) => key !== 'label')) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const label = parseTokenLabel(body.label);
    if (!label) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const created = createOpdsToken(deps.db, user.id, label);
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(created);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/api/opds-tokens/:tokenId', async (request, reply) => {
    const user = currentUser(request);
    const tokenId = parseId((request.params as { tokenId?: string }).tokenId);
    if (!tokenId) return reply.code(400).send({ error: 'invalid_request' });
    try {
      revokeOpdsToken(deps.db, user.id, tokenId);
      reply.header('cache-control', 'no-store');
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // OPDS 1.2 navigation and acquisition only. No reading-progress feed or route.
  app.get('/opds/catalog', async (request, reply) => {
    const user = currentUser(request);
    const updated = new Date().toISOString();
    const xml = renderNavigationFeed({
      origin: requestOrigin(request),
      updated,
      libraries: listLibraries(deps.db, user),
    });
    return sendXml(reply, OPDS_NAVIGATION_TYPE, xml);
  });

  app.get('/opds/libraries/:libraryId', async (request, reply) => {
    const user = currentUser(request);
    const libraryId = parseId((request.params as { libraryId?: string }).libraryId);
    if (!libraryId) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const offset = parseOffset(request.query);
      const library = requireLibraryAccess(deps.db, user, libraryId);
      const page = listOpdsEntries(deps.db, { userId: user.id, libraryIds: [library.id], q: null, offset });
      const xml = renderLibraryFeed({
        origin: requestOrigin(request),
        updated: new Date().toISOString(),
        library: { id: library.id, name: library.name },
        page,
        offset,
      });
      return sendXml(reply, OPDS_ACQUISITION_TYPE, xml);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/opds/search.xml', async (request, reply) => {
    currentUser(request);
    return sendXml(reply, OPDS_SEARCH_TYPE, renderOpenSearch(requestOrigin(request)));
  });

  app.get('/opds/search', async (request, reply) => {
    const user = currentUser(request);
    try {
      const parsed = parseSearch(request.query);
      const page = listOpdsEntries(deps.db, {
        userId: user.id,
        libraryIds: listLibraries(deps.db, user).map((library) => library.id),
        q: parsed.q,
        offset: parsed.offset,
      });
      const xml = renderSearchFeed({
        origin: requestOrigin(request),
        updated: new Date().toISOString(),
        q: parsed.q,
        page,
        offset: parsed.offset,
      });
      return sendXml(reply, OPDS_ACQUISITION_TYPE, xml);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/opds/editions/:editionId/cover', async (request, reply) => {
    const user = currentUser(request);
    try {
      const editionId = accessEdition(deps.db, user, (request.params as { editionId?: string }).editionId);
      const cover = latestCover(deps.db, editionId);
      if (!cover) return reply.code(404).send({ error: 'not_found' });
      const absolute = coverAbsolute(deps.dataDir, cover);
      if (!absolute) return reply.code(404).send({ error: 'not_found' });
      const bytes = readFileSync(absolute);
      return reply
        .header('cache-control', 'private, no-store')
        .header('vary', 'Authorization, Cookie')
        .header('x-content-type-options', 'nosniff')
        .type(cover.mediaType)
        .send(bytes);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/opds/editions/:editionId/assets/:assetId', async (request, reply) => {
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
      reply.header('vary', 'Authorization, Cookie');
      reply.header('x-content-type-options', 'nosniff');
      if (range === 'invalid') {
        reply.header('content-range', `bytes */${file.bytes}`);
        return reply.code(416).send({ error: 'invalid_request' });
      }
      reply.header('content-type', pdf ? 'application/pdf' : 'application/epub+zip');
      reply.header('content-disposition', attachmentDisposition(file.filename, pdf ? 'book.pdf' : 'book.epub'));
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
}

function sendXml(reply: FastifyReply, type: string, xml: string) {
  return reply
    .header('cache-control', 'private, no-store')
    .header('vary', 'Authorization, Cookie')
    .header('x-content-type-options', 'nosniff')
    .type(type)
    .send(Buffer.from(xml, 'utf8'));
}

function accessEdition(db: AppDatabase, user: AuthUser, raw: string | undefined): number {
  const editionId = parseId(raw);
  if (!editionId) throw new CatalogError('invalid_request');
  const edition = requireLiveEdition(db, editionId);
  requireLibraryAccess(db, user, edition.libraryId);
  return edition.id;
}

function requestOrigin(request: FastifyRequest): string {
  const host = request.headers.host;
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) return '';
  const named = /^[A-Za-z0-9.:-]+$/.test(host);
  const ipv6 = /^\[[0-9A-Fa-f:]+\](?::\d+)?$/.test(host);
  if (!named && !ipv6) return '';
  const protocol = request.protocol === 'https' ? 'https' : 'http';
  return `${protocol}://${host}`;
}

function parseSearch(query: unknown): { q: string | null; offset: number } {
  const record = asRecord(query) ?? {};
  const offset = parseOffset(query);
  if (record.q === undefined) return { q: null, offset };
  if (typeof record.q !== 'string') throw new CatalogError('invalid_request');
  const q = record.q.trim();
  if (q.length > 200) throw new CatalogError('invalid_request');
  return { q: q.length > 0 ? q : null, offset };
}

function parseOffset(query: unknown): number {
  const record = asRecord(query) ?? {};
  if (record.offset === undefined) return 0;
  if (typeof record.offset !== 'string' || !/^\d+$/.test(record.offset)) throw new CatalogError('invalid_request');
  const offset = Number(record.offset);
  if (!Number.isSafeInteger(offset) || offset > 1_000_000) throw new CatalogError('invalid_request');
  return offset;
}

function attachmentDisposition(filename: string, fallback: string): string {
  return contentDisposition(filename, fallback).replace(/^inline;/, 'attachment;');
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
