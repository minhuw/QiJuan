import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { registerAccessRoutes } from './access-routes.js';
import { installSessionGuard } from './auth.js';
import type { AppConfig } from './config.js';
import { openDatabase } from './db.js';
import { registerEditionRoutes } from './edition-routes.js';
import { registerImportRoutes } from './import-routes.js';
import { registerLibraryRoutes } from './library-routes.js';
import { registerReaderRoutes } from './reader-routes.js';
import type { OpenLibraryTransport } from './metadata/openLibrary.js';
import { requeueInterruptedJobs, startJobWorker } from './jobs.js';
import { redactOptions } from './logger.js';
import { defaultClientDist } from './paths.js';

export interface BuildAppOptions {
  config: AppConfig;
  /** `null` skips static files. Omit to serve `client/dist` when it exists. */
  clientDist?: string | null;
  logger?: FastifyServerOptions['logger'];
  /** Defaults to the public Open Library endpoints. Tests pass a stub `fetch`. */
  openLibrary?: OpenLibraryTransport;
}

export async function buildApp(options: BuildAppOptions) {
  mkdirSync(path.dirname(options.config.databasePath), { recursive: true });
  const { sqlite, db } = openDatabase(options.config.databasePath);

  const app = Fastify({
    trustProxy: options.config.trustProxy,
    logger:
      options.logger === undefined
        ? {
            level: 'info',
            redact: redactOptions,
          }
        : options.logger,
  });

  let closed = false;
  let stopWorker: (() => void) | null = null;
  app.addHook('onClose', async () => {
    stopWorker?.();
    stopWorker = null;
    if (closed) return;
    closed = true;
    sqlite.close();
  });

  try {
    // Before every route, so later book, cover, download, search, annotation, and OPDS handlers cannot skip auth.
    installSessionGuard(app, db);

    app.get(
      '/health',
      {
        schema: {
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              required: ['ok'],
              properties: {
                ok: { type: 'boolean' },
              },
            },
          },
        },
      },
      async () => ({ ok: true as const }),
    );

    await app.register(multipart, {
      throwFileSizeLimit: false,
      limits: {
        fileSize: options.config.maxUploadBytes,
        files: 20,
        fields: 4,
        fieldSize: 8 * 1024,
        parts: 24,
      },
    });

    registerAccessRoutes(app, {
      sqlite,
      db,
      dataDir: options.config.dataDir,
    });
    registerImportRoutes(app, {
      db,
      dataDir: options.config.dataDir,
      maxUploadBytes: options.config.maxUploadBytes,
    });
    registerEditionRoutes(app, {
      db,
      dataDir: options.config.dataDir,
      openLibrary: {
        origin: options.config.openLibraryOrigin,
        ...options.openLibrary,
      },
    });
    registerLibraryRoutes(app, { db });
    registerReaderRoutes(app, { db, dataDir: options.config.dataDir });

    const clientDist = options.clientDist === undefined ? defaultClientDist() : options.clientDist;
    if (clientDist && existsSync(clientDist)) {
      await app.register(fastifyStatic, {
        root: clientDist,
        prefix: '/',
        wildcard: false,
        setHeaders(res, filePath) {
          if (filePath.endsWith('.mjs')) res.setHeader('content-type', 'text/javascript; charset=utf-8');
          else if (filePath.endsWith('.wasm')) res.setHeader('content-type', 'application/wasm');
        },
      });

      app.setNotFoundHandler((request, reply) => {
        if (request.method === 'GET' && acceptsHtml(request.headers.accept)) {
          return reply.sendFile('index.html');
        }
        return reply.code(404).send({ error: 'not_found' });
      });
    }

    requeueInterruptedJobs(db);
    const worker = startJobWorker({
      db,
      dataDir: options.config.dataDir,
      log: {
        error(context, message) {
          app.log.error(context, message);
        },
      },
    });
    stopWorker = worker.stop;

    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

function acceptsHtml(accept: string | undefined): boolean {
  if (!accept) return true;
  return accept.includes('text/html') || accept.includes('*/*');
}
