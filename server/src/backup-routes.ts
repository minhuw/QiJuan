import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './accounts.js';
import { BackupJobError, type BackupScopeChoice, type DestinationConfig } from './backup/model.js';
import { destinationFromInput } from './backup/destination.js';
import { freshRecoveryPassword, type BackupService } from './backup/service.js';
import type { AuthUser } from './sessions.js';

const HOUR_MAX = 24 * 365;

export function registerBackupRoutes(app: FastifyInstance, service: BackupService): void {
  app.get('/api/backup', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    return service.status();
  });

  app.put('/api/backup/destination', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    try {
      return { destination: service.saveDestination(request.body) };
    } catch (error) {
      return sendBackupError(reply, error);
    }
  });

  app.post('/api/backup/destination/test', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    try {
      await service.testConnection();
      return { ok: true as const };
    } catch (error) {
      return sendBackupError(reply, error, 'destination_unreachable');
    }
  });

  app.post('/api/backup/recovery', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    const body = asRecord(request.body) ?? {};
    const allowed = new Set(['password', 'generate']);
    if (Object.keys(body).some((key) => !allowed.has(key))) return reply.code(400).send({ error: 'invalid_request' });
    let password: string;
    if (body.generate === true) {
      password = freshRecoveryPassword();
    } else if (typeof body.password === 'string') {
      if (body.password.length < 8 || body.password.length > 200 || body.password.includes('\u0000')) {
        return reply.code(400).send({ error: 'password_short' });
      }
      password = body.password;
    } else {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const recoveryPassword = service.setRecoveryPassword(password);
    return reply.code(201).send({
      recoveryPassword,
      download: '/api/backup/recovery-file',
    });
  });

  app.get('/api/backup/recovery-file', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const text = service.recoveryFile();
    if (!text) return reply.code(404).send({ error: 'not_found' });
    reply.header('cache-control', 'no-store');
    reply.header('content-type', 'text/plain; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="qijuan-recovery.txt"');
    return reply.send(text);
  });

  app.put('/api/backup/schedule', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    const parsed = parseSchedule(request.body);
    if (!parsed) return reply.code(400).send({ error: 'invalid_request' });
    try {
      return { schedule: service.saveSchedule(parsed) };
    } catch (error) {
      return sendBackupError(reply, error);
    }
  });

  app.post('/api/backup/jobs', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    const parsed = parseManual(request.body);
    if (!parsed) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const job = service.startManual(parsed.scope, parsed.indexedLibraryIds);
      return reply.code(202).send({ job });
    } catch (error) {
      return sendBackupError(reply, error);
    }
  });

  app.post('/api/backup/checks', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    try {
      const job = service.startCheck();
      return reply.code(202).send({ job });
    } catch (error) {
      return sendBackupError(reply, error);
    }
  });

  app.post('/api/backup/restore-tests', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    try {
      const job = service.startRestoreTest();
      return reply.code(202).send({ job });
    } catch (error) {
      return sendBackupError(reply, error);
    }
  });

  app.post('/api/backup/restore/snapshots', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    try {
      const ready = restoreAuth(request.body, service.savedDestination());
      if (!ready) return reply.code(400).send({ error: 'invalid_request' });
      const snapshots = await service.listSnapshots(ready.destination, ready.password);
      return { snapshots };
    } catch (error) {
      return sendBackupError(reply, error);
    }
  });

  app.post('/api/backup/restore/plan', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    const body = asRecord(request.body);
    if (!body || typeof body.snapshotId !== 'string') return reply.code(400).send({ error: 'invalid_request' });
    try {
      const ready = restoreAuth(body, service.savedDestination());
      if (!ready) return reply.code(400).send({ error: 'invalid_request' });
      const plan = await service.createPlan(ready.destination, ready.password, body.snapshotId);
      return plan;
    } catch (error) {
      return sendBackupError(reply, error, 'incompatible_snapshot');
    }
  });

  app.post('/api/backup/restore/activate', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header('cache-control', 'no-store');
    const body = asRecord(request.body);
    if (!body || typeof body.planId !== 'string' || body.confirm !== true) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    try {
      await service.activate(body.planId, true);
      return { ok: true as const };
    } catch (error) {
      return sendBackupError(reply, error, 'incompatible_snapshot');
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

function parseSchedule(value: unknown): {
  enabled: boolean;
  intervalHours: number;
  retentionDaily: number;
  retentionWeekly: number;
  retentionMonthly: number;
  checkIntervalHours?: number;
  scope: BackupScopeChoice;
  indexedLibraryIds: number[];
} | null {
  const body = asRecord(value);
  if (!body) return null;
  const allowed = new Set([
    'enabled',
    'intervalHours',
    'retentionDaily',
    'retentionWeekly',
    'retentionMonthly',
    'checkIntervalHours',
    'scope',
    'indexedLibraryIds',
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (typeof body.enabled !== 'boolean') return null;
  const intervalHours = boundedInt(body.intervalHours, 1, HOUR_MAX);
  const retentionDaily = boundedInt(body.retentionDaily, 0, 10_000);
  const retentionWeekly = boundedInt(body.retentionWeekly, 0, 10_000);
  const retentionMonthly = boundedInt(body.retentionMonthly, 0, 10_000);
  const parsedCheck = body.checkIntervalHours === undefined ? undefined : boundedInt(body.checkIntervalHours, 1, HOUR_MAX);
  if (intervalHours === null || retentionDaily === null || retentionWeekly === null || retentionMonthly === null) return null;
  if (parsedCheck === null) return null;
  const checkIntervalHours = parsedCheck;
  if (body.scope !== 'metadata-only' && body.scope !== 'managed') return null;
  const indexedLibraryIds = idList(body.indexedLibraryIds);
  if (!indexedLibraryIds) return null;
  return {
    enabled: body.enabled,
    intervalHours,
    retentionDaily,
    retentionWeekly,
    retentionMonthly,
    ...(checkIntervalHours === undefined ? {} : { checkIntervalHours }),
    scope: body.scope,
    indexedLibraryIds,
  };
}

function parseManual(value: unknown): { scope: BackupScopeChoice; indexedLibraryIds: number[] } | null {
  const body = asRecord(value) ?? {};
  const allowed = new Set(['scope', 'indexedLibraryIds']);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  const scope = body.scope === undefined ? 'managed' : body.scope;
  if (scope !== 'metadata-only' && scope !== 'managed') return null;
  const indexedLibraryIds = body.indexedLibraryIds === undefined ? [] : idList(body.indexedLibraryIds);
  if (!indexedLibraryIds) return null;
  return { scope, indexedLibraryIds };
}

function restoreAuth(
  value: unknown,
  previous: DestinationConfig | null,
): { destination: DestinationConfig; password: string } | null {
  const body = asRecord(value);
  if (!body || typeof body.recoveryPassword !== 'string' || body.recoveryPassword.length < 1) return null;
  if (body.destination === undefined) return null;
  // A blank secret reuses the key already stored in backup/destination.json.
  // A fresh install has nothing stored, so the secret still has to be typed.
  const destination = destinationFromInput(body.destination, previous);
  if (!destination) return null;
  return { destination, password: body.recoveryPassword };
}

function idList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1) return null;
    ids.push(entry);
  }
  return [...new Set(ids)];
}

function boundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function sendBackupError(reply: FastifyReply, error: unknown, code = 'invalid_request') {
  if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
  if (error instanceof BackupJobError) {
    const status = /already running|already waiting/i.test(error.message) ? 409 : 400;
    const errorCode = status === 409 ? 'backup_in_progress' : code;
    return reply.code(status).send({ error: errorCode, reason: error.message });
  }
  throw error;
}

