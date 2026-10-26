import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, requireLibraryAccess } from './accounts.js';
import { CatalogError, checkIndexedLibrary } from './catalog.js';
import type { AppDatabase } from './db.js';
import { createImportJob, getVisibleJob, listVisibleJobs } from './jobs.js';
import { listLibraryFiles } from './library-files.js';
import type { AuthUser } from './sessions.js';

const MAX_IMPORT_FILES = 20;

export interface ImportRouteDeps {
  db: AppDatabase;
  dataDir: string;
  maxUploadBytes: number;
}

export function registerImportRoutes(app: FastifyInstance, deps: ImportRouteDeps): void {
  app.get('/api/jobs', async (request, reply) => {
    const user = currentUser(request);
    reply.header('cache-control', 'no-store');
    return { jobs: listVisibleJobs(deps.db, user) };
  });

  app.get('/api/jobs/:jobId', async (request, reply) => {
    const user = currentUser(request);
    const jobId = parseId((request.params as { jobId?: string }).jobId);
    if (!jobId) return reply.code(400).send({ error: 'invalid_request' });
    const job = getVisibleJob(deps.db, user, jobId);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    reply.header('cache-control', 'no-store');
    return { job };
  });

  app.post('/api/imports', async (request, reply) => {
    const user = currentUser(request);
    const libraryId = parseId((request.query as { libraryId?: string }).libraryId);
    if (!libraryId) return reply.code(400).send({ error: 'invalid_request' });
    let library;
    try {
      library = requireLibraryAccess(deps.db, user, libraryId);
    } catch (error) {
      return sendError(reply, error);
    }
    if (library.mode !== 'managed') return reply.code(400).send({ error: 'library_mode' });
    if (!request.isMultipart()) return reply.code(400).send({ error: 'invalid_request' });

    const token = randomBytes(16).toString('hex');
    const directory = path.join(deps.dataDir, 'incoming', token);
    mkdirSync(directory, { recursive: true });
    const staged: Array<{ filename: string; sourcePath: string }> = [];
    let total = 0;
    let tooLarge = false;
    const batchCap = Math.min(deps.maxUploadBytes * MAX_IMPORT_FILES, 512 * 1024 * 1024);
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue;
        if (staged.length >= MAX_IMPORT_FILES) {
          tooLarge = true;
          part.file.resume();
          continue;
        }
        const filename = safeFilename(part.filename);
        const stored = `${staged.length}-${filename}`;
        const absolute = path.join(directory, stored);
        await pipeline(part.file, createWriteStream(absolute));
        const size = statSync(absolute).size;
        total += size;
        if (part.file.truncated || size > deps.maxUploadBytes || total > batchCap) tooLarge = true;
        staged.push({ filename, sourcePath: `incoming/${token}/${stored}` });
      }
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      if (isTooLarge(error)) return reply.code(413).send({ error: 'payload_too_large' });
      throw error;
    }
    if (tooLarge) {
      rmSync(directory, { recursive: true, force: true });
      return reply.code(413).send({ error: 'payload_too_large' });
    }
    if (staged.length === 0) {
      rmSync(directory, { recursive: true, force: true });
      return reply.code(400).send({ error: 'invalid_request' });
    }
    try {
      const job = createImportJob(deps.db, {
        libraryId: library.id,
        userId: user.id,
        source: 'upload',
        items: staged,
      });
      reply.header('cache-control', 'no-store');
      return reply.code(202).send({ job });
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  });

  app.post('/api/imports/folder', async (request, reply) => {
    const user = currentUser(request);
    const body = asRecord(request.body);
    const libraryId = body && typeof body.libraryId === 'number' ? body.libraryId : null;
    const folder = body && typeof body.path === 'string' ? body.path : null;
    if (!libraryId || folder === null) return reply.code(400).send({ error: 'invalid_request' });
    let library;
    try {
      library = requireLibraryAccess(deps.db, user, libraryId);
    } catch (error) {
      return sendError(reply, error);
    }
    if (library.mode !== 'indexed') return reply.code(400).send({ error: 'library_mode' });
    const located = listLibraryFiles(library.rootPath, folder);
    if (!located.ok) {
      const status = located.reason === 'not_found' ? 404 : 400;
      const code = located.reason === 'too_many' ? 'invalid_request' : located.reason;
      return reply.code(status).send({ error: code });
    }
    if (located.files.length === 0) return reply.code(400).send({ error: 'invalid_request' });
    const job = createImportJob(deps.db, {
      libraryId: library.id,
      userId: user.id,
      source: 'folder',
      items: located.files.map((file) => ({ filename: file.relativePath, sourcePath: file.relativePath })),
    });
    reply.header('cache-control', 'no-store');
    return reply.code(202).send({ job });
  });

  app.post('/api/libraries/:libraryId/rescan', async (request, reply) => {
    const user = currentUser(request);
    const libraryId = parseId((request.params as { libraryId?: string }).libraryId);
    if (!libraryId) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const library = requireLibraryAccess(deps.db, user, libraryId);
      if (library.mode !== 'indexed') return reply.code(400).send({ error: 'library_mode' });
      const result = checkIndexedLibrary(deps.db, library.id);
      reply.header('cache-control', 'no-store');
      return result;
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function currentUser(request: FastifyRequest): AuthUser {
  const user = request.authUser;
  if (!user) throw new ApiError(401, 'unauthorized');
  return user;
}

function safeFilename(input: string): string {
  const base = path.posix.basename((input || 'file').replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '');
  const trimmed = base.trim().slice(0, 180);
  if (!trimmed || trimmed === '.' || trimmed === '..') return 'file';
  return trimmed;
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

function isTooLarge(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = 'statusCode' in error ? Number((error as { statusCode: unknown }).statusCode) : 0;
  const code = 'code' in error ? String((error as { code: unknown }).code) : '';
  return status === 413 || code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT';
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
  if (error instanceof CatalogError) {
    const status = error.code === 'not_found' || error.code === 'file_missing' ? 404 : 400;
    return reply.code(status).send({ error: error.code });
  }
  throw error;
}
