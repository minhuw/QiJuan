import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clearSessionCookie, readCookie, SESSION_COOKIE } from './cookies.js';
import type { AppDatabase } from './db.js';
import { authenticateOpdsToken, readBasicAuthorization } from './opds-tokens.js';
import { readSessionUser, type AuthUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

const PUBLIC_ROUTES = new Set([
  'GET /health',
  'GET /api/setup',
  'POST /api/setup',
  'POST /api/session/login',
]);

/** Book surfaces stay on this list so a later route cannot be added without a session. */
const PROTECTED_PREFIXES = ['/api', '/opds', '/books', '/covers', '/downloads', '/search', '/annotations'];

/**
 * Path without a query, decoded the way the router matches routes.
 * `null` means the percent-encoding is malformed (`decodeURI` threw `URIError`).
 */
export function canonicalPath(url: string): string | null {
  const withoutQuery = url.split('?')[0] ?? url;
  let decoded: string;
  try {
    // find-my-way matches on decodeURI of unreserved escapes such as %61.
    // The raw request URL must not be compared to the allowlist.
    decoded = decodeURI(withoutQuery);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
  const path = decoded.startsWith('/') ? decoded : `/${decoded}`;
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

/**
 * Setup, login, and health are public. Every other `/api` route needs a session,
 * as do later book, cover, download, search, annotation, and OPDS routes.
 * OPDS also accepts HTTP Basic with a revocable client token, not the account password.
 * A malformed escape is not public.
 */
export function routeRequiresSession(method: string, url: string): boolean {
  const path = canonicalPath(url);
  if (path === null) return true;
  if (PUBLIC_ROUTES.has(`${method.toUpperCase()} ${path}`)) return false;
  return PROTECTED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function installSessionGuard(app: FastifyInstance, source: { readonly db: AppDatabase }): void {
  app.addHook('preHandler', async (request, reply) => {
    // Unknown URLs use the not-found handler, which inherits this hook. Leave those as 404.
    if (request.is404) return;
    if (!routeRequiresSession(request.method, request.url)) return;
    const sessionId = readCookie(request.headers.cookie, SESSION_COOKIE);
    const sessionUser = sessionId ? readSessionUser(source.db, sessionId) : null;
    if (sessionUser) {
      request.authUser = sessionUser;
      return;
    }
    if (isOpdsPath(request.url)) {
      const basic = readBasicAuthorization(request.headers.authorization);
      const tokenUser = basic ? authenticateOpdsToken(source.db, basic.username, basic.password) : null;
      if (tokenUser) {
        request.authUser = tokenUser;
        return;
      }
      if (sessionId) reply.header('set-cookie', clearSessionCookie(request.protocol === 'https'));
      reply.header('www-authenticate', 'Basic realm="QiJuan OPDS", charset="UTF-8"');
      reply.header('cache-control', 'no-store');
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (sessionId) reply.header('set-cookie', clearSessionCookie(request.protocol === 'https'));
    return reply.code(401).send({ error: 'unauthorized' });
  });
}

function isOpdsPath(url: string): boolean {
  const path = canonicalPath(url);
  if (!path) return false;
  return path === '/opds' || path.startsWith('/opds/');
}

export function requireUser(request: FastifyRequest, reply: FastifyReply): AuthUser | null {
  if (request.authUser) return request.authUser;
  reply.code(401).send({ error: 'unauthorized' });
  return null;
}
