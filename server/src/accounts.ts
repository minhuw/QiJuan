import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { and, asc, eq } from 'drizzle-orm';
import type { AppDatabase } from './db.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { libraries, libraryGrants, users } from './schema.js';
import { createSession, type AuthUser, type Role } from './sessions.js';

const USERNAME_MAX = 64;
const LIBRARY_NAME_MAX = 120;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string) {
    super(code);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface PublicUser {
  id: number;
  username: string;
  role: Role;
}

export interface PublicLibrary {
  id: number;
  name: string;
  mode: 'managed' | 'indexed';
}

export interface ListedUser extends PublicUser {
  libraryIds: number[];
}

export interface SetupResult {
  user: PublicUser;
  library: PublicLibrary;
  sessionId: string;
}

export function parseUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const username = value.trim();
  if (username.length < 1 || username.length > USERNAME_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(username)) return null;
  return username;
}

export function parseLibraryName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (name.length < 1 || name.length > LIBRARY_NAME_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

export function parsePassword(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) return null;
  if (value.includes('\u0000')) return null;
  return value;
}

export function hasAdmin(db: AppDatabase): boolean {
  const row = db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).get();
  return Boolean(row);
}

export function managedLibraryRoot(dataDir: string, libraryId: number): string {
  if (!Number.isInteger(libraryId) || libraryId < 1) {
    throw new Error('Invalid library id');
  }
  const dataRoot = realpathSync(dataDir);
  const root = path.resolve(dataRoot, 'libraries', String(libraryId));
  const relative = path.relative(dataRoot, root);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Library root escapes the data directory');
  }
  return root;
}

export async function setupFirstRun(
  deps: { sqlite: Database.Database; db: AppDatabase; dataDir: string },
  input: { username: unknown; password: unknown; libraryName: unknown },
): Promise<SetupResult> {
  const username = parseUsername(input.username);
  const password = parsePassword(input.password);
  const libraryName = parseLibraryName(input.libraryName);
  if (!username || !password || !libraryName) throw new ApiError(400, 'invalid_request');
  if (hasAdmin(deps.db)) throw new ApiError(409, 'setup_complete');

  const passwordHash = await hashPassword(password);
  const now = new Date();

  try {
    return withImmediate(deps.sqlite, () => {
      if (hasAdmin(deps.db)) throw new ApiError(409, 'setup_complete');

      const user = deps.db
        .insert(users)
        .values({
          username,
          passwordHash,
          role: 'admin',
          createdAt: now.toISOString(),
        })
        .returning({ id: users.id, username: users.username, role: users.role })
        .get();
      if (!user) throw new Error('Admin insert failed');

      const library = deps.db
        .insert(libraries)
        .values({
          name: libraryName,
          mode: 'managed',
          rootPath: path.join(deps.dataDir, 'libraries', 'pending'),
          createdAt: now.toISOString(),
        })
        .returning({ id: libraries.id, name: libraries.name, mode: libraries.mode })
        .get();
      if (!library) throw new Error('Library insert failed');

      const rootPath = managedLibraryRoot(deps.dataDir, library.id);
      mkdirSync(rootPath, { recursive: true });
      deps.db.update(libraries).set({ rootPath }).where(eq(libraries.id, library.id)).run();
      deps.db.insert(libraryGrants).values({ userId: user.id, libraryId: library.id }).run();
      const session = createSession(deps.db, user.id, now);

      return {
        user: { id: user.id, username: user.username, role: 'admin' },
        library: { id: library.id, name: library.name, mode: 'managed' },
        sessionId: session.id,
      };
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isUniqueConstraint(error)) throw new ApiError(409, 'setup_complete');
    throw error;
  }
}

let dummyHash: Promise<string> | null = null;

function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword('dummy-password-not-used');
  return dummyHash;
}

export async function loginAccount(
  db: AppDatabase,
  input: { username: unknown; password: unknown },
): Promise<{ user: PublicUser; sessionId: string; libraries: PublicLibrary[] }> {
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const password =
    typeof input.password === 'string' && input.password.length <= PASSWORD_MAX ? input.password : '';
  const row = username
    ? db.select().from(users).where(eq(users.username, username)).get()
    : undefined;
  const hash = row?.passwordHash ?? (await dummyPasswordHash());
  const matches = await verifyPassword(password, hash);
  if (!row || !matches || (row.role !== 'admin' && row.role !== 'reader')) {
    throw new ApiError(401, 'invalid_credentials');
  }
  const user: AuthUser = { id: row.id, username: row.username, role: row.role };
  const session = createSession(db, user.id);
  return { user, sessionId: session.id, libraries: listLibraries(db, user) };
}

export async function createReader(
  db: AppDatabase,
  input: { username: unknown; password: unknown },
): Promise<PublicUser> {
  const username = parseUsername(input.username);
  const password = parsePassword(input.password);
  if (!username || !password) throw new ApiError(400, 'invalid_request');
  const passwordHash = await hashPassword(password);
  try {
    const inserted = db
      .insert(users)
      .values({
        username,
        passwordHash,
        role: 'reader',
        createdAt: new Date().toISOString(),
      })
      .returning({ id: users.id, username: users.username, role: users.role })
      .get();
    if (!inserted || inserted.role !== 'reader') throw new Error('Reader insert failed');
    return { id: inserted.id, username: inserted.username, role: 'reader' };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isUniqueConstraint(error)) throw new ApiError(409, 'username_taken');
    throw error;
  }
}

export function listUsers(db: AppDatabase): ListedUser[] {
  const rows = db
    .select({ id: users.id, username: users.username, role: users.role })
    .from(users)
    .orderBy(asc(users.id))
    .all();
  const grants = db.select().from(libraryGrants).all();
  const byUser = new Map<number, number[]>();
  for (const grant of grants) {
    const list = byUser.get(grant.userId) ?? [];
    list.push(grant.libraryId);
    byUser.set(grant.userId, list);
  }
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    role: asRole(row.role),
    libraryIds: (byUser.get(row.id) ?? []).sort((a, b) => a - b),
  }));
}

export function listLibraries(db: AppDatabase, user: AuthUser): PublicLibrary[] {
  const columns = {
    id: libraries.id,
    name: libraries.name,
    mode: libraries.mode,
  };
  const rows =
    user.role === 'admin'
      ? db.select(columns).from(libraries).orderBy(asc(libraries.id)).all()
      : db
          .select(columns)
          .from(libraries)
          .innerJoin(libraryGrants, eq(libraryGrants.libraryId, libraries.id))
          .where(eq(libraryGrants.userId, user.id))
          .orderBy(asc(libraries.id))
          .all();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    mode: row.mode === 'indexed' ? 'indexed' : 'managed',
  }));
}

export function grantLibrary(db: AppDatabase, userId: number, libraryId: number): void {
  const user = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  const library = db.select({ id: libraries.id }).from(libraries).where(eq(libraries.id, libraryId)).get();
  if (!user || !library) throw new ApiError(404, 'not_found');
  const existing = db
    .select({ userId: libraryGrants.userId })
    .from(libraryGrants)
    .where(and(eq(libraryGrants.userId, userId), eq(libraryGrants.libraryId, libraryId)))
    .get();
  if (existing) return;
  db.insert(libraryGrants).values({ userId, libraryId }).run();
}

export function revokeLibrary(db: AppDatabase, userId: number, libraryId: number): void {
  const library = db.select({ id: libraries.id }).from(libraries).where(eq(libraries.id, libraryId)).get();
  if (!library) throw new ApiError(404, 'not_found');
  db.delete(libraryGrants)
    .where(and(eq(libraryGrants.userId, userId), eq(libraryGrants.libraryId, libraryId)))
    .run();
}

function asRole(value: string): Role {
  if (value !== 'admin' && value !== 'reader') throw new Error(`Invalid role: ${value}`);
  return value;
}

function withImmediate<T>(sqlite: Database.Database, fn: () => T): T {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      sqlite.exec('ROLLBACK');
    } catch {
      // The transaction may already be closed.
    }
    throw error;
  }
}

function isUniqueConstraint(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  const message = 'message' in error ? String((error as { message: unknown }).message) : '';
  return code === 'SQLITE_CONSTRAINT' && message.includes('UNIQUE');
}
