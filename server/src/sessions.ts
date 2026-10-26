import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { SESSION_TTL_SECONDS } from './cookies.js';
import type { AppDatabase } from './db.js';
import { sessions, users } from './schema.js';

export type Role = 'admin' | 'reader';

export interface AuthUser {
  id: number;
  username: string;
  role: Role;
}

export function createSession(db: AppDatabase, userId: number, now = new Date()): { id: string; expiresAt: string } {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  db.insert(sessions)
    .values({
      id,
      userId,
      expiresAt,
      createdAt: now.toISOString(),
    })
    .run();
  return { id, expiresAt };
}

export function readSessionUser(db: AppDatabase, sessionId: string, now = Date.now()): AuthUser | null {
  if (!sessionId || sessionId.length > 128) return null;
  const row = db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      username: users.username,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId))
    .get();
  if (!row) return null;

  const expires = Date.parse(row.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) {
    db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    return null;
  }
  if (row.role !== 'admin' && row.role !== 'reader') return null;
  return { id: row.userId, username: row.username, role: row.role };
}

export function deleteSession(db: AppDatabase, sessionId: string): void {
  db.delete(sessions).where(and(eq(sessions.id, sessionId))).run();
}
