import { asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db.js';
import { jobs, metadataTrajectories, metadataTrajectorySteps } from '../schema.js';
import type { AgentOutcome, AgentStep, AgentStepKind } from './assistant/agent.js';

/** Trajectories are deleted this long after they were created. */
export const TRAJECTORY_RETENTION_DAYS = 30;
/** Total step data kept for one run. Steps beyond it are shortened, then dropped. */
export const TRAJECTORY_MAX_BYTES = 256 * 1024;
/** Room kept for shortened steps and the final `end` step once the cap is near. */
const RESERVED_BYTES = 8 * 1024;
const SHORT_STRING_CHARS = 300;

export interface TrajectoryLink {
  jobId: number;
  jobItemId?: number | null;
  editionId?: number | null;
  model: string;
}

export interface TrajectoryRecorder {
  id: number;
  onStep: (step: AgentStep) => void;
  /** Appends a `note` step, numbered after every step recorded so far. Best effort. */
  note: (message: string, data?: Record<string, unknown>) => void;
}

export interface TrajectoryStepView {
  seq: number;
  kind: AgentStepKind;
  at: string;
  data: Record<string, unknown>;
}

export interface TrajectoryView {
  id: number;
  jobId: number;
  jobItemId: number | null;
  editionId: number | null;
  previewId: number | null;
  model: string | null;
  outcome: AgentOutcome | null;
  error: string | null;
  summary: { turns: number; toolCalls: number; totalMs: number } | null;
  truncated: boolean;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
  steps: TrajectoryStepView[];
}

export interface TrajectoryRef {
  trajectoryId: number;
  trajectoryStepCount: number;
}

/** Starts a trajectory row and returns an `onStep` observer that appends to it. Prunes old rows first. */
export function startTrajectory(db: AppDatabase, link: TrajectoryLink, now = new Date()): TrajectoryRecorder {
  pruneTrajectories(db, now);
  const stamp = now.toISOString();
  const inserted = db
    .insert(metadataTrajectories)
    .values({
      jobId: link.jobId,
      jobItemId: link.jobItemId ?? null,
      editionId: link.editionId ?? null,
      model: link.model,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning({ id: metadataTrajectories.id })
    .get();
  if (!inserted) throw new Error('trajectory insert failed');
  const id = inserted.id;
  // The recorder numbers steps itself, so notes added around an agent run never collide with its steps.
  let seq = 0;
  return {
    id,
    onStep: (step) => {
      seq += 1;
      appendTrajectoryStep(db, id, { ...step, seq });
    },
    note: (message, data = {}) => {
      seq += 1;
      try {
        appendTrajectoryStep(db, id, { ...data, kind: 'note', message, seq, at: new Date().toISOString() } as AgentStep);
      } catch {
        // A note is informational. The import continues without it.
      }
    },
  };
}

/**
 * Appends one step in its own transaction, so a poll sees it at once.
 * Near the size cap a step keeps only its short fields; past the cap it is dropped.
 */
export function appendTrajectoryStep(db: AppDatabase, trajectoryId: number, step: AgentStep): void {
  const { seq, at, kind, ...body } = step;
  db.transaction((tx) => {
    const row = tx
      .select({ storedBytes: metadataTrajectories.storedBytes, truncated: metadataTrajectories.truncated })
      .from(metadataTrajectories)
      .where(eq(metadataTrajectories.id, trajectoryId))
      .get();
    if (!row) return;

    let data = JSON.stringify(body);
    let bytes = Buffer.byteLength(data, 'utf8');
    let truncated = row.truncated;
    const limit = kind === 'end' ? TRAJECTORY_MAX_BYTES : TRAJECTORY_MAX_BYTES - RESERVED_BYTES;
    if (row.storedBytes + bytes > limit) {
      truncated = true;
      data = JSON.stringify(shortenStep(body));
      bytes = Buffer.byteLength(data, 'utf8');
    }
    const fits = row.storedBytes + bytes <= TRAJECTORY_MAX_BYTES;
    const stamp = new Date().toISOString();
    if (fits) {
      tx.insert(metadataTrajectorySteps).values({ trajectoryId, seq, kind, createdAt: at, data }).run();
    }
    const values: Partial<typeof metadataTrajectories.$inferInsert> = { truncated: truncated || !fits, updatedAt: stamp };
    if (fits) {
      values.stepCount = sql`${metadataTrajectories.stepCount} + 1` as unknown as number;
      values.storedBytes = sql`${metadataTrajectories.storedBytes} + ${bytes}` as unknown as number;
    }
    if (step.kind === 'end') {
      values.outcome = step.outcome;
      values.error = step.error;
      values.summary = JSON.stringify({ turns: step.turns, toolCalls: step.toolCalls, totalMs: step.totalMs });
    }
    tx.update(metadataTrajectories).set(values).where(eq(metadataTrajectories.id, trajectoryId)).run();
  }, { behavior: 'immediate' });
}

export function linkTrajectoryPreview(db: AppDatabase, trajectoryId: number, previewId: number): void {
  db.update(metadataTrajectories)
    .set({ previewId })
    .where(eq(metadataTrajectories.id, trajectoryId))
    .run();
}

/** Deletes trajectories created more than 30 days before `now`. Returns how many were removed. */
export function pruneTrajectories(db: AppDatabase, now = new Date()): number {
  const cutoff = new Date(now.getTime() - TRAJECTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return db.transaction((tx) => {
    const old = tx
      .select({ id: metadataTrajectories.id })
      .from(metadataTrajectories)
      .where(lt(metadataTrajectories.createdAt, cutoff))
      .all()
      .map((row) => row.id);
    if (old.length === 0) return 0;
    tx.delete(metadataTrajectorySteps).where(inArray(metadataTrajectorySteps.trajectoryId, old)).run();
    tx.delete(metadataTrajectories).where(inArray(metadataTrajectories.id, old)).run();
    return old.length;
  }, { behavior: 'immediate' });
}

/** The trajectory with every step, and the library it belongs to (for access checks). */
export function getTrajectory(
  db: AppDatabase,
  trajectoryId: number,
): { libraryId: number; trajectory: TrajectoryView } | null {
  const row = db
    .select({ trajectory: metadataTrajectories, libraryId: jobs.libraryId })
    .from(metadataTrajectories)
    .innerJoin(jobs, eq(jobs.id, metadataTrajectories.jobId))
    .where(eq(metadataTrajectories.id, trajectoryId))
    .get();
  if (!row) return null;
  const steps = db
    .select()
    .from(metadataTrajectorySteps)
    .where(eq(metadataTrajectorySteps.trajectoryId, trajectoryId))
    .orderBy(asc(metadataTrajectorySteps.seq))
    .all()
    .map((step) => ({ seq: step.seq, kind: step.kind, at: step.createdAt, data: decodeObject(step.data) }));
  const t = row.trajectory;
  return {
    libraryId: row.libraryId,
    trajectory: {
      id: t.id,
      jobId: t.jobId,
      jobItemId: t.jobItemId,
      editionId: t.editionId,
      previewId: t.previewId,
      model: t.model,
      outcome: t.outcome,
      error: t.error,
      summary: decodeSummary(t.summary),
      truncated: t.truncated,
      stepCount: t.stepCount,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      steps,
    },
  };
}

/** The latest trajectory for each item of a job, and the latest job-level one (lookup jobs). */
export function trajectoryRefs(
  db: AppDatabase,
  jobId: number,
): { job: TrajectoryRef | null; items: Map<number, TrajectoryRef> } {
  const rows = db
    .select({
      id: metadataTrajectories.id,
      jobItemId: metadataTrajectories.jobItemId,
      stepCount: metadataTrajectories.stepCount,
    })
    .from(metadataTrajectories)
    .where(eq(metadataTrajectories.jobId, jobId))
    .orderBy(desc(metadataTrajectories.id))
    .all();
  const items = new Map<number, TrajectoryRef>();
  let job: TrajectoryRef | null = null;
  for (const row of rows) {
    const ref = { trajectoryId: row.id, trajectoryStepCount: row.stepCount };
    if (row.jobItemId === null) job ??= ref;
    else if (!items.has(row.jobItemId)) items.set(row.jobItemId, ref);
  }
  return { job, items };
}

/** Keeps numbers, booleans, short strings, short string lists, and the result summary. */
function shortenStep(body: Record<string, unknown>): Record<string, unknown> {
  const short: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') short[key] = value;
    else if (typeof value === 'string' && value.length <= SHORT_STRING_CHARS) short[key] = value;
    else if (key === 'summary' || key === 'limits') short[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string') && value.length <= 20) {
      short[key] = value;
    }
  }
  short.omitted = true;
  return short;
}

function decodeObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Fall through to an empty step.
  }
  return {};
}

function decodeSummary(value: string | null): TrajectoryView['summary'] {
  if (!value) return null;
  const parsed = decodeObject(value);
  if (typeof parsed.turns !== 'number' || typeof parsed.toolCalls !== 'number' || typeof parsed.totalMs !== 'number') {
    return null;
  }
  return { turns: parsed.turns, toolCalls: parsed.toolCalls, totalMs: parsed.totalMs };
}
