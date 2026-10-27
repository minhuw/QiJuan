import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { ApiError } from './accounts.js';
import type { AppDatabase } from './db.js';
import { opdsTokens, users } from './schema.js';
import type { AuthUser } from './sessions.js';

const LABEL_MAX = 80;
const ACTIVE_LIMIT = 32;
const SECRET_MAX = 500;

export interface PublicOpdsToken {
  id: number;
  label: string;
  createdAt: string;
}

/** SHA-256 hex of the token. The account password is never stored in this column. */
export function hashOpdsToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

const DUMMY_HASH = hashOpdsToken('qjt_dummy');

export function parseTokenLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  if (label.length < 1 || label.length > LABEL_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(label)) return null;
  return label;
}

export function listOpdsTokens(db: AppDatabase, userId: number): PublicOpdsToken[] {
  return db
    .select({ id: opdsTokens.id, label: opdsTokens.label, createdAt: opdsTokens.createdAt })
    .from(opdsTokens)
    .where(and(eq(opdsTokens.userId, userId), isNull(opdsTokens.revokedAt)))
    .orderBy(asc(opdsTokens.id))
    .all();
}

/** Returns the secret once. Later responses and the database keep only the hash. */
export function createOpdsToken(
  db: AppDatabase,
  userId: number,
  label: string,
  now = new Date(),
): { token: PublicOpdsToken; secret: string } {
  const active = db
    .select({ id: opdsTokens.id })
    .from(opdsTokens)
    .where(and(eq(opdsTokens.userId, userId), isNull(opdsTokens.revokedAt)))
    .all();
  if (active.length >= ACTIVE_LIMIT) throw new ApiError(409, 'conflict');

  const secret = `qjt_${randomBytes(32).toString('base64url')}`;
  const createdAt = now.toISOString();
  const inserted = db
    .insert(opdsTokens)
    .values({ userId, label, tokenHash: hashOpdsToken(secret), createdAt })
    .returning({ id: opdsTokens.id, label: opdsTokens.label, createdAt: opdsTokens.createdAt })
    .get();
  if (!inserted) throw new ApiError(400, 'invalid_request');
  return { token: inserted, secret };
}

export function revokeOpdsToken(db: AppDatabase, userId: number, tokenId: number, now = new Date()): void {
  if (!Number.isInteger(tokenId) || tokenId < 1) throw new ApiError(400, 'invalid_request');
  const row = db
    .select({ id: opdsTokens.id, revokedAt: opdsTokens.revokedAt })
    .from(opdsTokens)
    .where(and(eq(opdsTokens.id, tokenId), eq(opdsTokens.userId, userId)))
    .get();
  if (!row) throw new ApiError(404, 'not_found');
  if (row.revokedAt) return;
  db.update(opdsTokens).set({ revokedAt: now.toISOString() }).where(eq(opdsTokens.id, tokenId)).run();
}

/**
 * HTTP Basic for OPDS. `password` must be a live client token for `username`.
 * The account password is not accepted.
 */
export function authenticateOpdsToken(db: AppDatabase, username: string, secret: string): AuthUser | null {
  const name = username.trim();
  if (!name || name.length > 64 || !secret || secret.length > SECRET_MAX) return null;
  const hash = hashOpdsToken(secret);
  const user = db
    .select({ id: users.id, username: users.username, role: users.role })
    .from(users)
    .where(eq(users.username, name))
    .get();
  const row = user
    ? db
        .select({ tokenHash: opdsTokens.tokenHash })
        .from(opdsTokens)
        .where(and(eq(opdsTokens.userId, user.id), eq(opdsTokens.tokenHash, hash), isNull(opdsTokens.revokedAt)))
        .get()
    : undefined;
  const stored = Buffer.from(row?.tokenHash ?? DUMMY_HASH);
  const presented = Buffer.from(hash);
  if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) return null;
  if (!user || !row) return null;
  if (user.role !== 'admin' && user.role !== 'reader') return null;
  return { id: user.id, username: user.username, role: user.role };
}

/** `Authorization: Basic base64(username:password)`. The password may contain colons. */
export function readBasicAuthorization(header: string | undefined): { username: string; password: string } | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep <= 0) return null;
  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  if (!username || !password) return null;
  return { username, password };
}
