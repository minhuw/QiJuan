import type { FastifyInstance } from 'fastify';
import { listLibraries } from './accounts.js';
import type { AppDatabase } from './db.js';
import { getTrajectory } from './metadata/trajectory.js';

export interface TrajectoryRouteDeps {
  db: AppDatabase;
}

/** Metadata assistant trajectories are for admins only. Pruned or missing rows are 404. */
export function registerTrajectoryRoutes(app: FastifyInstance, deps: TrajectoryRouteDeps): void {
  app.get('/api/metadata/trajectories/:trajectoryId', async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    reply.header('cache-control', 'no-store');
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const trajectoryId = parseId((request.params as { trajectoryId?: string }).trajectoryId);
    if (!trajectoryId) return reply.code(400).send({ error: 'invalid_request' });
    const found = getTrajectory(deps.db, trajectoryId);
    const visible = found && listLibraries(deps.db, user).some((library) => library.id === found.libraryId);
    if (!found || !visible) return reply.code(404).send({ error: 'not_found' });
    return { trajectory: found.trajectory };
  });
}

function parseId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id)) return null;
  return id;
}
