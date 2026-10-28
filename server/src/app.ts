import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { registerAccessRoutes } from './access-routes.js';
import { installSessionGuard } from './auth.js';
import { registerBackupRoutes } from './backup-routes.js';
import { BackupService } from './backup/service.js';
import { createSpawnRunner, resolveResticBin, type ResticRunner } from './backup/restic-run.js';
import type { AppConfig } from './config.js';
import { openDatabase } from './db.js';
import { registerEditionRoutes } from './edition-routes.js';
import { registerImportRoutes } from './import-routes.js';
import { registerLibraryRoutes } from './library-routes.js';
import { registerOpdsRoutes } from './opds-routes.js';
import { registerReaderRoutes } from './reader-routes.js';
import type { OpenLibraryTransport } from './metadata/openLibrary.js';
import { requeueInterruptedJobs, startJobWorker } from './jobs.js';
import { redactOptions } from './logger.js';
import { defaultClientDist } from './paths.js';
import { resolveRevision } from './revision.js';

export interface BuildAppOptions {
  config: AppConfig;
  /** `null` skips static files. Omit to serve `client/dist` when it exists. */
  clientDist?: string | null;
  logger?: FastifyServerOptions['logger'];
  /** Defaults to the public Open Library endpoints. Tests pass a stub `fetch`. */
  openLibrary?: OpenLibraryTransport;
  /** Tests pass a fake restic. Production spawns the pinned binary. */
  restic?: ResticRunner;
  resticBin?: string;
  backupPollMs?: number;
}

export async function buildApp(options: BuildAppOptions) {
  mkdirSync(path.dirname(options.config.databasePath), { recursive: true });
  const opened = openDatabase(options.config.databasePath);
  const state = { sqlite: opened.sqlite, db: opened.db };
  const live = {
    get sqlite() {
      return state.sqlite;
    },
    get db() {
      return state.db;
    },
    dataDir: options.config.dataDir,
  };

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
  let stopBackup: (() => void) | null = null;
  app.addHook('onClose', async () => {
    stopBackup?.();
    stopBackup = null;
    stopWorker?.();
    stopWorker = null;
    if (closed) return;
    closed = true;
    state.sqlite.close();
  });

  const revision = resolveRevision();

  try {
    // Before every route, so later book, cover, download, search, annotation, and OPDS handlers cannot skip auth.
    installSessionGuard(app, live);

    app.get(
      '/health',
      {
        schema: {
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              required: ['ok', 'revision'],
              properties: {
                ok: { type: 'boolean' },
                revision: { type: 'string' },
              },
            },
          },
        },
      },
      async () => ({ ok: true as const, revision }),
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

    registerAccessRoutes(app, live);
    const openLibrary = {
      origin: options.config.openLibraryOrigin,
      ...options.openLibrary,
    };
    registerImportRoutes(app, {
      get db() {
        return state.db;
      },
      dataDir: options.config.dataDir,
      maxUploadBytes: options.config.maxUploadBytes,
    });
    registerEditionRoutes(app, {
      get db() {
        return state.db;
      },
      dataDir: options.config.dataDir,
    });
    registerLibraryRoutes(app, {
      get db() {
        return state.db;
      },
    });
    registerReaderRoutes(app, {
      get db() {
        return state.db;
      },
      dataDir: options.config.dataDir,
    });
    registerOpdsRoutes(app, {
      get db() {
        return state.db;
      },
      dataDir: options.config.dataDir,
    });
    const backup = new BackupService({
      source: live,
      dataDir: options.config.dataDir,
      databasePath: options.config.databasePath,
      migrationsDir: options.config.migrationsDir,
      openLibraryOrigin: options.config.openLibraryOrigin,
      runner: options.restic ?? createSpawnRunner(options.resticBin ?? resolveResticBin()),
      pollMs: options.backupPollMs,
      closeDatabase() {
        try {
          state.sqlite.pragma('wal_checkpoint(TRUNCATE)');
        } catch {
          // The file is replaced immediately after this.
        }
        state.sqlite.close();
      },
      openDatabase() {
        const next = openDatabase(options.config.databasePath);
        state.sqlite = next.sqlite;
        state.db = next.db;
      },
      log: {
        error(context, message) {
          app.log.error(context, message);
        },
      },
    });
    registerBackupRoutes(app, backup);

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

    requeueInterruptedJobs(state.db);
    const worker = startJobWorker({
      get db() {
        return state.db;
      },
      dataDir: options.config.dataDir,
      openLibrary,
      log: {
        error(context, message) {
          app.log.error(context, message);
        },
      },
    });
    stopWorker = worker.stop;
    stopBackup = backup.start().stop;

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
