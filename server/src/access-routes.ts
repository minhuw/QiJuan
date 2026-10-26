import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiError,
  createReader,
  grantLibrary,
  hasAdmin,
  listLibraries,
  listUsers,
  loginAccount,
  revokeLibrary,
  setupFirstRun,
  type PublicUser,
} from './accounts.js';
import { SESSION_TTL_SECONDS, clearSessionCookie, readCookie, serializeSessionCookie, SESSION_COOKIE } from './cookies.js';
import type { AppDatabase } from './db.js';
import { deleteSession } from './sessions.js';

export interface AccessDeps {
  sqlite: Database.Database;
  db: AppDatabase;
  dataDir: string;
}

export function registerAccessRoutes(app: FastifyInstance, deps: AccessDeps): void {
  app.get('/api/setup', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { needed: !hasAdmin(deps.db) };
  });

  app.post('/api/setup', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const body = asRecord(request.body);
    if (!body) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const result = await setupFirstRun(deps, {
        username: body.username,
        password: body.password,
        libraryName: body.libraryName,
      });
      reply.header('set-cookie', sessionCookie(result.sessionId, request));
      return reply.code(201).send({
        user: result.user,
        library: result.library,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/session/login', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const body = asRecord(request.body);
    if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    try {
      const result = await loginAccount(deps.db, { username: body.username, password: body.password });
      reply.header('set-cookie', sessionCookie(result.sessionId, request));
      return { user: result.user, libraries: result.libraries };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/session/logout', async (request, reply) => {
    const sessionId = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (sessionId) deleteSession(deps.db, sessionId);
    reply.header('set-cookie', clearSessionCookie(request.protocol === 'https'));
    reply.header('cache-control', 'no-store');
    return reply.code(204).send();
  });

  app.get('/api/me', async (request, reply) => {
    const user = currentUser(request);
    reply.header('cache-control', 'no-store');
    return { user, libraries: listLibraries(deps.db, user) };
  });

  app.get('/api/libraries', async (request, reply) => {
    const user = currentUser(request);
    reply.header('cache-control', 'no-store');
    return { libraries: listLibraries(deps.db, user) };
  });

  app.get('/api/users', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    reply.header('cache-control', 'no-store');
    return { users: listUsers(deps.db) };
  });

  app.post('/api/users', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const body = asRecord(request.body);
    if (!body || (body.role !== undefined && body.role !== 'reader')) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    try {
      const created = await createReader(deps.db, { username: body.username, password: body.password });
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({ user: created });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/libraries/:libraryId/grants', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const libraryId = parseId((request.params as { libraryId?: string }).libraryId);
    const body = asRecord(request.body);
    const userId = body && typeof body.userId === 'number' ? body.userId : null;
    if (!libraryId || !userId || !Number.isInteger(userId) || userId < 1) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    try {
      grantLibrary(deps.db, userId, libraryId);
      return reply.code(201).send({ userId, libraryId });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/api/libraries/:libraryId/grants/:userId', async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const params = request.params as { libraryId?: string; userId?: string };
    const libraryId = parseId(params.libraryId);
    const userId = parseId(params.userId);
    if (!libraryId || !userId) return reply.code(400).send({ error: 'invalid_request' });
    try {
      revokeLibrary(deps.db, userId, libraryId);
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function currentUser(request: FastifyRequest): PublicUser {
  const user = request.authUser;
  if (!user) throw new ApiError(401, 'unauthorized');
  return user;
}

function sessionCookie(sessionId: string, request: FastifyRequest): string {
  return serializeSessionCookie(sessionId, request.protocol === 'https', SESSION_TTL_SECONDS);
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
  if (error instanceof ApiError) {
    return reply.code(error.statusCode).send({ error: error.code });
  }
  throw error;
}
