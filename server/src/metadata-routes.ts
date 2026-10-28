import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthUser } from './sessions.js';
import { AssistantError, testAssistant, type AssistantTransport } from './metadata/assistant/client.js';
import {
  AssistantSettingsError,
  clearAssistantSettings,
  publicAssistantSettings,
  readAssistantSettings,
  writeAssistantSettings,
} from './metadata/assistant-settings.js';

export interface MetadataRouteOptions {
  dataDir: string;
  transport?: AssistantTransport;
}

export function registerMetadataRoutes(app: FastifyInstance, options: MetadataRouteOptions): void {
  app.get('/api/metadata/assistant', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    return { assistant: publicAssistantSettings(readAssistantSettings(options.dataDir)) };
  });

  app.put('/api/metadata/assistant', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    const body = asRecord(request.body);
    if (!body) return reply.code(400).send({ error: 'invalid_request' });
    if (Object.keys(body).some((key) => key !== 'baseUrl' && key !== 'model' && key !== 'apiKey')) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    try {
      return { assistant: writeAssistantSettings(options.dataDir, body) };
    } catch (error) {
      if (error instanceof AssistantSettingsError) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      throw error;
    }
  });

  app.delete('/api/metadata/assistant', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    clearAssistantSettings(options.dataDir);
    return { assistant: publicAssistantSettings(null) };
  });

  app.post('/api/metadata/assistant/test', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    const config = readAssistantSettings(options.dataDir);
    if (!config) {
      return reply.code(400).send({ error: 'metadata_assistant_unconfigured' });
    }
    try {
      const result = await testAssistant(options.transport ?? {}, config);
      return { ok: true as const, model: result.model };
    } catch (error) {
      return sendAssistantError(reply, error);
    }
  });
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply): AuthUser | null {
  const user = request.authUser;
  if (!user) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  if (user.role !== 'admin') {
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return user;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function sendAssistantError(reply: FastifyReply, error: unknown) {
  if (error instanceof AssistantError) {
    const status = error.code === 'metadata_assistant_unconfigured' ? 400 : 502;
    return reply.code(status).send({ error: error.code });
  }
  throw error;
}
