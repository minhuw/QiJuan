import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type { AppConfig } from './config.js';
import { redactOptions } from './logger.js';
import { defaultClientDist } from './paths.js';

export interface BuildAppOptions {
  config: AppConfig;
  /** `null` skips static files. Omit to serve `client/dist` when it exists. */
  clientDist?: string | null;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(options: BuildAppOptions) {
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
}

function acceptsHtml(accept: string | undefined): boolean {
  if (!accept) return true;
  return accept.includes('text/html') || accept.includes('*/*');
}
