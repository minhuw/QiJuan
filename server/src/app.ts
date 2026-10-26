import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { registerAccessRoutes } from './access-routes.js';
import { installSessionGuard } from './auth.js';
import type { AppConfig } from './config.js';
import { openDatabase } from './db.js';
import { redactOptions } from './logger.js';
import { defaultClientDist } from './paths.js';

export interface BuildAppOptions {
  config: AppConfig;
  /** `null` skips static files. Omit to serve `client/dist` when it exists. */
  clientDist?: string | null;
  logger?: FastifyServerOptions['logger'];
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
  app.addHook('onClose', async () => {
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

    registerAccessRoutes(app, {
      sqlite,
      db,
      dataDir: options.config.dataDir,
    });

    const clientDist = options.clientDist === undefined ? defaultClientDist() : options.clientDist;
    if (clientDist && existsSync(clientDist)) {
      await app.register(fastifyStatic, {
        root: clientDist,
        prefix: '/',
        wildcard: false,
      });

      app.setNotFoundHandler((request, reply) => {
        if (request.method === 'GET' && acceptsHtml(request.headers.accept)) {
          return reply.sendFile('index.html');
        }
        return reply.code(404).send({ error: 'not_found' });
      });
    }

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
