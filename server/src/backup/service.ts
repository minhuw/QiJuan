import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, asc, desc, eq, or } from 'drizzle-orm';
import { managedLibraryRoot } from '../accounts.js';
import type { AppDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { backupJobs, backupSettings, libraries } from '../schema.js';
import { holder, release, tryAcquire } from '../work-gate.js';
import {
  destinationFromInput,
  generateRecoveryPassword,
  markRecoveryPasswordShown,
  publicDestination,
  readDestination,
  readRecoveryPassword,
  recoveryFileText,
  recoveryPasswordWasShown,
  writeDestination,
  writeRecoveryPassword,
} from './destination.js';
import {
  BackupJobError,
  CHECK_INTERVAL_HOURS,
  METADATA_ONLY_SCOPE,
  R2_PRESET,
  RETENTION_DAILY,
  RETENTION_MONTHLY,
  RETENTION_WEEKLY,
  TRANSIENT_ATTEMPTS,
  type BackupJobView,
  type BackupScopeChoice,
  type DestinationConfig,
  type PublicDestination,
  type ScheduleView,
  type SnapshotInfo,
  isTransientResticFailure,
  keptSnapshotReason,
  resticOptions,
  scopeLabel,
  scrubSecrets,
} from './model.js';
import {
  parseResticMessages,
  parseResticStats,
  readResticRelease,
  resticEnvironment,
  type ResticRunResult,
  type ResticRunner,
} from './restic-run.js';
import { S3ProbeError, probeDestination } from './s3.js';
import {
  findSnapshotRoot,
  inspectSnapshot,
  installSnapshotFiles,
  removeStage,
  restoreIndexedFiles,
  stageBackup,
  type RestoreInspection,
} from './stage.js';

interface JobDetail {
  scope: BackupScopeChoice;
  indexedLibraryIds: number[];
}

export interface BackupStatus {
  destination: PublicDestination | null;
  r2Preset: { endpoint: string; region: string; pathStyle: true };
  recovery: { configured: boolean };
  schedule: ScheduleView;
  lastSuccess: { finishedAt: string; snapshotId: string | null; scope: string } | null;
  job: BackupJobView | null;
  active: BackupJobView | null;
  history: SnapshotInfo[];
  usage: {
    repositoryBytes: number | null;
    lastTransfer: { bytesAdded: number | null; bytesProcessed: number | null } | null;
  };
  integrityCheck: MaintenanceView & { nextRunAt: string | null };
  restoreTest: MaintenanceView;
}

export interface MaintenanceView {
  status: BackupJobView['status'] | null;
  phase: string | null;
  reason: string | null;
  finishedAt: string | null;
  snapshotId: string | null;
}

export type { SnapshotInfo };

export interface RestorePlanView {
  planId: string;
  snapshotId: string;
  compatible: boolean;
  reason: string | null;
  scope: string;
  metadataOnly: boolean;
  schemaVersion: string;
  appVersion: string;
  counts: {
    users: number;
    editions: number;
    shelves: number;
    highlights: number;
    notes: number;
    bookmarks: number;
    readingPositions: number;
    managedFiles: number;
    missingFiles: number;
  };
  missingFiles: string[];
  replaces: string[];
}

interface StoredPlan {
  id: string;
  snapshotId: string;
  stagingParent: string;
  snapshotRoot: string;
  inspection: RestoreInspection;
  destination: DestinationConfig;
  recoveryPassword: string;
  createdAt: number;
}

export interface DatabaseSource {
  readonly sqlite: import('better-sqlite3').Database;
  readonly db: AppDatabase;
}

export interface BackupServiceOptions {
  source: DatabaseSource;
  dataDir: string;
  databasePath: string;
  migrationsDir: string;
  openLibraryOrigin: string;
  runner: ResticRunner;
  pollMs?: number;
  now?: () => Date;
  closeDatabase: () => void;
  openDatabase: () => void;
  log?: { error(context: Record<string, unknown>, message: string): void };
}

export class BackupService {
  private readonly pollMs: number;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lock = false;
  private plans = new Map<string, StoredPlan>();

  constructor(private readonly options: BackupServiceOptions) {
    this.pollMs = options.pollMs ?? 1000;
    this.now = options.now ?? (() => new Date());
  }

  start(): { stop: () => void } {
    this.failInterruptedJobs();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    this.timer.unref?.();
    return {
      stop: () => {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        for (const plan of this.plans.values()) rmSync(plan.stagingParent, { recursive: true, force: true });
        this.plans.clear();
      },
    };
  }

  status(): BackupStatus {
    const destination = readDestination(this.options.dataDir);
    const schedule = this.readSchedule();
    const history = this.readHistory();
    return {
      destination: destination ? publicDestination(destination) : null,
      r2Preset: { endpoint: R2_PRESET.endpoint, region: R2_PRESET.region, pathStyle: true },
      recovery: {
        configured: Boolean(readRecoveryPassword(this.options.dataDir)),
      },
      schedule,
      lastSuccess: this.lastSuccess(),
      job: this.latestJob('backup'),
      active: this.activeJob(),
      history: history.snapshots,
      usage: {
        repositoryBytes: history.repositoryBytes,
        lastTransfer: this.lastTransfer(),
      },
      integrityCheck: { ...this.latestMaintenance('check'), nextRunAt: schedule.nextCheckAt },
      restoreTest: this.latestMaintenance('restore-test'),
    };
  }

  saveDestination(input: unknown): PublicDestination {
    const saved = destinationFromInput(input, readDestination(this.options.dataDir));
    if (!saved) throw new BackupJobError('Check the endpoint, region, bucket, prefix, and keys.');
    writeDestination(this.options.dataDir, saved);
    return publicDestination(saved);
  }

  /** Destination saved on disk, including the secret the administrator screen no longer displays. */
  savedDestination(): DestinationConfig | null {
    return readDestination(this.options.dataDir);
  }

  setRecoveryPassword(password: string): string {
    writeRecoveryPassword(this.options.dataDir, password);
    markRecoveryPasswordShown(this.options.dataDir);
    return password;
  }

  recoveryFile(): string | null {
    return recoveryFileText(this.options.dataDir);
  }

  recoveryConfigured(): boolean {
    return Boolean(readRecoveryPassword(this.options.dataDir));
  }

  passwordShown(): boolean {
    return recoveryPasswordWasShown(this.options.dataDir);
  }

  saveSchedule(input: {
    enabled: boolean;
    intervalHours: number;
    retentionDaily: number;
    retentionWeekly: number;
    retentionMonthly: number;
    checkIntervalHours?: number;
    scope: BackupScopeChoice;
    indexedLibraryIds: number[];
  }): ScheduleView {
    this.assertIndexedSelection(input.scope, input.indexedLibraryIds);
    const previous = this.readSchedule();
    const checkIntervalHours = input.checkIntervalHours ?? previous.checkIntervalHours;
    const stamp = this.now().toISOString();
    const nextRunAt = input.enabled ? new Date(this.now().getTime() + input.intervalHours * 60 * 60 * 1000).toISOString() : null;
    const nextCheckAt =
      checkIntervalHours !== previous.checkIntervalHours || !previous.nextCheckAt
        ? new Date(this.now().getTime() + checkIntervalHours * 60 * 60 * 1000).toISOString()
        : previous.nextCheckAt;
    this.options.source.db
      .update(backupSettings)
      .set({
        scheduleEnabled: input.enabled ? 1 : 0,
        intervalHours: input.intervalHours,
        nextRunAt,
        retentionDaily: input.retentionDaily,
        retentionWeekly: input.retentionWeekly,
        retentionMonthly: input.retentionMonthly,
        checkIntervalHours,
        nextCheckAt,
        scope: input.scope,
        indexedLibraryIds: JSON.stringify(input.indexedLibraryIds),
        updatedAt: stamp,
      })
      .where(eq(backupSettings.id, 1))
      .run();
    return this.readSchedule();
  }

  async testConnection(): Promise<void> {
    if (this.lock) {
      throw new BackupJobError('A backup is already running. Wait for it to finish, then test the connection again.');
    }
    this.lock = true;
    try {
      const ready = this.requireReady();
      try {
        await probeDestination(ready.destination);
      } catch (error) {
        const message = error instanceof S3ProbeError || error instanceof Error ? error.message : 'The destination could not be reached.';
        throw new BackupJobError(
          `${scrubSecrets(message, this.secrets(ready))} Check the endpoint, region, bucket, prefix, and credentials, then run the connection test again.`,
        );
      }
      await this.ensureRepository(ready.destination, ready.password);
    } finally {
      this.lock = false;
    }
  }

  startManual(scope: BackupScopeChoice, indexedLibraryIds: number[]): BackupJobView {
    this.assertIndexedSelection(scope, indexedLibraryIds);
    if (!readDestination(this.options.dataDir) || !readRecoveryPassword(this.options.dataDir)) {
      throw new BackupJobError('Set a destination and a recovery password before starting a backup.');
    }
    if (this.hasActiveJob()) {
      throw new BackupJobError('A backup is already running or waiting. Wait for it to finish, then retry.');
    }
    const id = this.insertJob('backup', scope, indexedLibraryIds);
    const view = this.jobById(id);
    if (!view) throw new BackupJobError('The backup job could not be stored.');
    return view;
  }

  startCheck(): BackupJobView {
    return this.startMaintenance('check');
  }

  startRestoreTest(): BackupJobView {
    return this.startMaintenance('restore-test');
  }

  private startMaintenance(kind: 'check' | 'restore-test'): BackupJobView {
    if (!readDestination(this.options.dataDir) || !readRecoveryPassword(this.options.dataDir)) {
      throw new BackupJobError('Set a destination and a recovery password before starting a backup.');
    }
    if (this.hasActiveJob()) {
      throw new BackupJobError('A backup is already running or waiting. Wait for it to finish, then retry.');
    }
    const id = this.insertJob(kind, 'managed', []);
    const view = this.jobById(id);
    if (!view) throw new BackupJobError('The backup job could not be stored.');
    return view;
  }

  async listSnapshots(destination: DestinationConfig, password: string): Promise<SnapshotInfo[]> {
    const result = await this.restic(destination, password, [...resticOptions(destination), 'snapshots', '--json', '--tag', 'qijuan']);
    if (result.code !== 0) {
      throw new BackupJobError(this.resticFailure('Snapshots could not be listed', result.stdout, result.stderr, destination, password));
    }
    return parseSnapshots(result.stdout);
  }

  async createPlan(destination: DestinationConfig, password: string, snapshotId: string): Promise<RestorePlanView> {
    if (!/^[a-f0-9]{8,64}$/i.test(snapshotId)) {
      throw new BackupJobError('Choose a snapshot id from the list.');
    }
    this.discardPlans();
    const stagingParent = mkdtempSync(path.join(tmpdir(), 'qijuan-restore-'));
    const result = await this.restic(destination, password, [
      ...resticOptions(destination),
      'restore',
      snapshotId,
      '--target',
      stagingParent,
    ]);
    if (result.code !== 0) {
      rmSync(stagingParent, { recursive: true, force: true });
      throw new BackupJobError(this.resticFailure('The snapshot could not be restored', result.stdout, result.stderr, destination, password));
    }
    const snapshotRoot = findSnapshotRoot(stagingParent);
    if (!snapshotRoot) {
      rmSync(stagingParent, { recursive: true, force: true });
      throw new BackupJobError('The snapshot did not contain a QiJuan manifest. Choose a different snapshot.');
    }
    let inspection: RestoreInspection;
    try {
      inspection = inspectSnapshot(snapshotRoot, this.options.migrationsDir);
    } catch (error) {
      rmSync(stagingParent, { recursive: true, force: true });
      throw error;
    }
    const plan: StoredPlan = {
      id: randomBytes(16).toString('hex'),
      snapshotId,
      stagingParent,
      snapshotRoot,
      inspection,
      destination,
      recoveryPassword: password,
      createdAt: this.now().getTime(),
    };
    this.plans.set(plan.id, plan);
    return toPlanView(plan);
  }

  async activate(planId: string, confirm: boolean): Promise<void> {
    if (confirm !== true) throw new BackupJobError('Confirm the restore before activating it.');
    const plan = this.plans.get(planId);
    if (!plan) throw new BackupJobError('That restore plan expired. List snapshots and prepare it again.');
    if (this.now().getTime() - plan.createdAt > 30 * 60 * 1000) {
      this.discardPlans();
      throw new BackupJobError('That restore plan expired. List snapshots and prepare it again.');
    }
    if (!plan.inspection.compatible) {
      throw new BackupJobError(plan.inspection.reason ?? 'This snapshot is not compatible. Choose a different snapshot.');
    }
    if (this.lock) throw new BackupJobError('A backup is already running. Wait for it to finish, then activate the restore.');
    if (!tryAcquire('backup')) {
      throw new BackupJobError(this.busyReason());
    }
    this.lock = true;
    let closed = false;
    try {
      writeDestination(this.options.dataDir, plan.destination);
      writeRecoveryPassword(this.options.dataDir, plan.recoveryPassword);
      markRecoveryPasswordShown(this.options.dataDir);
      this.options.closeDatabase();
      closed = true;
      installSnapshotFiles(plan.snapshotRoot, this.options.dataDir, this.options.databasePath);
      migrate({ databasePath: this.options.databasePath, migrationsDir: this.options.migrationsDir });
      this.options.openDatabase();
      closed = false;
      restoreIndexedFiles(plan.snapshotRoot, this.options.source.db);
      this.rewriteManagedRoots();
      this.plans.delete(plan.id);
      rmSync(plan.stagingParent, { recursive: true, force: true });
    } catch (error) {
      if (closed) {
        try {
          this.options.openDatabase();
        } catch {
          // The caller still receives the activation error.
        }
      }
      if (!(error instanceof BackupJobError)) {
        this.options.log?.error({ name: error instanceof Error ? error.name : 'Error' }, 'restore activation failed');
      }
      throw error instanceof BackupJobError
        ? error
        : new BackupJobError('The snapshot could not be activated. The staging copy was kept so you can try again.');
    } finally {
      this.lock = false;
      release('backup');
    }
  }

  private async tick(): Promise<void> {
    if (this.lock) return;
    if (!tryAcquire('backup')) return;
    this.lock = true;
    try {
      this.enqueueSchedule();
      this.enqueueCheck();
      const id = this.claimJob();
      if (id !== null) await this.runJob(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/closed|not open/i.test(message)) return;
      this.options.log?.error({ name: error instanceof Error ? error.name : 'Error' }, 'backup loop failed');
    } finally {
      this.lock = false;
      release('backup');
    }
  }

  private enqueueSchedule(): void {
    const schedule = this.readSchedule();
    if (!schedule.enabled || !schedule.nextRunAt) return;
    if (Date.parse(schedule.nextRunAt) > this.now().getTime()) return;
    if (this.hasActiveJob()) return;
    if (!readDestination(this.options.dataDir) || !readRecoveryPassword(this.options.dataDir)) return;
    this.insertJob('backup', schedule.scope, schedule.indexedLibraryIds);
    const next = new Date(this.now().getTime() + schedule.intervalHours * 60 * 60 * 1000).toISOString();
    this.options.source.db
      .update(backupSettings)
      .set({ nextRunAt: next, updatedAt: this.now().toISOString() })
      .where(eq(backupSettings.id, 1))
      .run();
  }

  private enqueueCheck(): void {
    if (!readDestination(this.options.dataDir) || !readRecoveryPassword(this.options.dataDir)) return;
    const schedule = this.readSchedule();
    if (!schedule.nextCheckAt) {
      this.setNextCheck(schedule.checkIntervalHours);
      return;
    }
    if (Date.parse(schedule.nextCheckAt) > this.now().getTime()) return;
    if (!this.lastSuccess() || this.hasActiveJob()) return;
    this.insertJob('check', 'managed', []);
    this.setNextCheck(schedule.checkIntervalHours);
  }

  private setNextCheck(intervalHours: number): void {
    const next = new Date(this.now().getTime() + intervalHours * 60 * 60 * 1000).toISOString();
    this.options.source.db
      .update(backupSettings)
      .set({ nextCheckAt: next, updatedAt: this.now().toISOString() })
      .where(eq(backupSettings.id, 1))
      .run();
  }

  private async runJob(id: number): Promise<void> {
    const row = this.options.source.db.select().from(backupJobs).where(eq(backupJobs.id, id)).get();
    if (!row || row.status !== 'running') return;
    if (row.kind === 'check') return this.runCheck(id);
    if (row.kind === 'restore-test') return this.runRestoreTest(id);
    const detail = parseDetail(row.detail);
    let stage: string | null = null;
    let partialSnapshot: string | null = null;
    let ready: { destination: DestinationConfig; password: string } | null = null;
    try {
      ready = this.requireReady();
      await this.restic(ready.destination, ready.password, [...resticOptions(ready.destination), 'unlock']);
      this.setPhase(id, 'snapshot-database');
      const staged = await stageBackup({
        sqlite: this.options.source.sqlite,
        db: this.options.source.db,
        dataDir: this.options.dataDir,
        migrationsDir: this.options.migrationsDir,
        openLibraryOrigin: this.options.openLibraryOrigin,
        scope: detail.scope,
        indexedLibraryIds: detail.indexedLibraryIds,
      });
      stage = staged.root;
      const uploaded = await this.uploadSnapshot(id, ready, stage, staged.label);
      partialSnapshot = uploaded.partialSnapshot;
      if (uploaded.error) throw uploaded.error;
      const messages = uploaded.messages;
      if (!messages?.snapshotId) {
        throw new BackupJobError(keptSnapshotReason('The backup failed before a snapshot was stored'));
      }
      this.setPhase(id, 'retention');
      let retentionWarning: string | null = null;
      try {
        await this.retain(ready.destination, ready.password);
      } catch (error) {
        retentionWarning =
          error instanceof BackupJobError
            ? error.message
            : 'Retention did not finish. The new snapshot was kept.';
      }
      const stamp = this.now().toISOString();
      this.options.source.db
        .update(backupJobs)
        .set({
          status: 'succeeded',
          phase: 'succeeded',
          reason: retentionWarning,
          snapshotId: messages.snapshotId,
          bytesAdded: messages.bytesAdded,
          bytesProcessed: messages.bytesProcessed,
          finishedAt: stamp,
          updatedAt: stamp,
        })
        .where(eq(backupJobs.id, id))
        .run();
      try {
        await this.refreshHistory(ready.destination, ready.password);
      } catch {
        // The snapshot is stored. Size and history are reported when restic provides them.
      }
    } catch (error) {
      if (ready && partialSnapshot) {
        await this.forgetSnapshot(ready.destination, ready.password, partialSnapshot);
      } else if (ready) {
        await this.restic(ready.destination, ready.password, [...resticOptions(ready.destination), 'unlock']);
      }
      const reason =
        error instanceof BackupJobError
          ? error.message
          : keptSnapshotReason('The backup failed before a snapshot was stored');
      const stamp = this.now().toISOString();
      try {
        this.options.source.db
          .update(backupJobs)
          .set({ status: 'failed', phase: 'failed', reason, finishedAt: stamp, updatedAt: stamp })
          .where(eq(backupJobs.id, id))
          .run();
      } catch {
        // The database may already be closed during shutdown.
      }
      this.options.log?.error({ jobId: id }, 'backup job failed');
    } finally {
      removeStage(stage);
    }
  }

  private async retain(destination: DestinationConfig, password: string): Promise<void> {
    const schedule = this.readSchedule();
    if (schedule.retentionDaily + schedule.retentionWeekly + schedule.retentionMonthly <= 0) return;
    const result = await this.restic(destination, password, [
      ...resticOptions(destination),
      'forget',
      '--json',
      '--keep-daily',
      String(schedule.retentionDaily),
      '--keep-weekly',
      String(schedule.retentionWeekly),
      '--keep-monthly',
      String(schedule.retentionMonthly),
      '--prune',
    ]);
    if (result.code !== 0) {
      throw new BackupJobError(
        keptSnapshotReason(
          `Retention could not finish (${scrubSecrets(result.stderr || result.stdout, this.secrets({ destination, password }))}). The new snapshot was kept`,
        ),
      );
    }
  }

  private async forgetSnapshot(destination: DestinationConfig, password: string, snapshotId: string): Promise<void> {
    await this.restic(destination, password, [...resticOptions(destination), 'unlock']);
    await this.restic(destination, password, [...resticOptions(destination), 'forget', snapshotId, '--prune']);
  }

  private async uploadSnapshot(
    id: number,
    ready: { destination: DestinationConfig; password: string },
    stage: string,
    label: string,
  ): Promise<{
    partialSnapshot: string | null;
    error: BackupJobError | null;
    messages: ReturnType<typeof parseResticMessages> | null;
  }> {
    let lastProgress = 0;
    for (let attempt = 1; attempt <= TRANSIENT_ATTEMPTS; attempt += 1) {
      this.setPhase(id, attempt === 1 ? 'uploading' : 'retrying');
      const backup = await this.restic(
        ready.destination,
        ready.password,
        [
          ...resticOptions(ready.destination),
          'backup',
          '--json',
          '--host',
          'qijuan',
          '--tag',
          'qijuan',
          '--tag',
          `scope=${label}`,
          stage,
        ],
        (chunk) => {
          const parsed = parseResticMessages(chunk);
          const nowMs = Date.now();
          if (parsed.percent === null || nowMs - lastProgress < 400) return;
          lastProgress = nowMs;
          this.setPhase(id, `uploading ${Math.round(parsed.percent * 100)}%`);
        },
      );
      const messages = parseResticMessages(`${backup.stdout}\n${backup.stderr}`);
      if (backup.signal) {
        return {
          partialSnapshot: messages.snapshotId,
          error: new BackupJobError(keptSnapshotReason('The backup was interrupted before restic finished')),
          messages,
        };
      }
      if (this.missingBinary(backup.stderr) || this.missingBinary(backup.stdout)) {
        const pinned = readResticRelease();
        return {
          partialSnapshot: null,
          error: new BackupJobError(
            keptSnapshotReason(
              `The restic ${pinned.version} program was not found. Install that release or set QIJUAN_RESTIC_BIN to the verified binary`,
            ),
          ),
          messages,
        };
      }
      if (backup.code === 3) {
        return {
          partialSnapshot: messages.snapshotId,
          error: new BackupJobError(
            keptSnapshotReason(
              `Restic could not read every selected file${messages.errorMessage ? ` (${scrubSecrets(messages.errorMessage, this.secrets(ready))})` : ''}`,
            ),
          ),
          messages,
        };
      }
      if (backup.code === 0 && messages.snapshotId) {
        return { partialSnapshot: null, error: null, messages };
      }
      const detailText = messages.errorMessage || backup.stderr || backup.stdout || 'restic exited without a snapshot';
      const transient = isTransientResticFailure(detailText);
      if (transient && messages.snapshotId && attempt < TRANSIENT_ATTEMPTS) {
        await this.forgetSnapshot(ready.destination, ready.password, messages.snapshotId);
      }
      if (transient && attempt < TRANSIENT_ATTEMPTS) {
        await this.restic(ready.destination, ready.password, [...resticOptions(ready.destination), 'unlock']);
        await this.pause(attempt);
        continue;
      }
      const tried = transient ? ` Tried ${TRANSIENT_ATTEMPTS} times.` : '';
      return {
        partialSnapshot: messages.snapshotId,
        error: new BackupJobError(
          keptSnapshotReason(
            `The backup could not reach the destination (${scrubSecrets(detailText, this.secrets(ready))}). Check the endpoint, bucket, and credentials.${tried}`,
          ),
        ),
        messages,
      };
    }
    return {
      partialSnapshot: null,
      error: new BackupJobError(keptSnapshotReason('The backup failed before a snapshot was stored')),
      messages: null,
    };
  }

  private async runCheck(id: number): Promise<void> {
    try {
      const ready = this.requireReady();
      await this.restic(ready.destination, ready.password, [...resticOptions(ready.destination), 'unlock']);
      let result: ResticRunResult | null = null;
      for (let attempt = 1; attempt <= TRANSIENT_ATTEMPTS; attempt += 1) {
        this.setPhase(id, attempt === 1 ? 'checking' : 'retrying');
        result = await this.restic(ready.destination, ready.password, [...resticOptions(ready.destination), 'check']);
        if (result.code === 0 && !result.signal) break;
        const detail = `${result.stdout}\n${result.stderr}`;
        if (result.signal || attempt === TRANSIENT_ATTEMPTS || !isTransientResticFailure(detail)) {
          throw new BackupJobError(
            result.signal
              ? 'The integrity check was interrupted. This was not a restore test, and the library was not changed.'
              : this.resticFailure('The repository integrity check failed', result.stdout, result.stderr, ready.destination, ready.password),
          );
        }
        await this.pause(attempt);
      }
      try {
        await this.refreshHistory(ready.destination, ready.password);
      } catch {
        // A passed check still stands when the size report is unavailable.
      }
      this.finishJob(
        id,
        'succeeded',
        'Integrity check passed. This only reads the restic repository. It did not restore a snapshot, so it does not show that a restore will succeed.',
        null,
      );
    } catch (error) {
      const reason = error instanceof BackupJobError ? error.message : 'The repository integrity check failed. The library was not changed.';
      this.finishJob(id, 'failed', reason, null);
      this.options.log?.error({ jobId: id }, 'backup check failed');
    }
  }

  private async runRestoreTest(id: number): Promise<void> {
    let stageParent: string | null = null;
    try {
      const ready = this.requireReady();
      this.setPhase(id, 'listing');
      const snapshots = await this.listSnapshots(ready.destination, ready.password);
      const latest = [...snapshots].sort((left, right) => Date.parse(right.time) - Date.parse(left.time))[0];
      if (!latest) {
        throw new BackupJobError(
          'There is no snapshot to restore. Make a backup first. The library was not changed. This is not an integrity check.',
        );
      }
      this.setPhase(id, 'restoring');
      stageParent = mkdtempSync(path.join(tmpdir(), 'qijuan-restore-test-'));
      const restored = await this.restic(ready.destination, ready.password, [
        ...resticOptions(ready.destination),
        'restore',
        latest.id,
        '--target',
        stageParent,
      ]);
      if (restored.code !== 0 || restored.signal) {
        throw new BackupJobError(
          `${this.resticFailure('The restore test could not copy the snapshot', restored.stdout, restored.stderr, ready.destination, ready.password)} The library was not changed.`,
        );
      }
      const root = findSnapshotRoot(stageParent);
      if (!root) throw new BackupJobError('The restore test did not find a QiJuan manifest. The library was not changed.');
      const inspection = inspectSnapshot(root, this.options.migrationsDir);
      if (!inspection.compatible) {
        throw new BackupJobError(`${inspection.reason ?? 'The snapshot is not compatible.'} The library was not changed.`);
      }
      const files = inspection.manifest.metadataOnly ? ' It is metadata-only and has no book files.' : '';
      this.finishJob(
        id,
        'succeeded',
        `Restore test passed for snapshot ${latest.shortId}.${files} The snapshot was restored to a temporary directory and inspected. The library was not replaced. This is not an integrity check.`,
        latest.id,
      );
    } catch (error) {
      const reason = error instanceof BackupJobError ? error.message : 'The restore test failed. The library was not changed.';
      this.finishJob(id, 'failed', reason, null);
      this.options.log?.error({ jobId: id }, 'restore test failed');
    } finally {
      if (stageParent) rmSync(stageParent, { recursive: true, force: true });
    }
  }

  private finishJob(id: number, status: 'succeeded' | 'failed', reason: string, snapshotId: string | null): void {
    const stamp = this.now().toISOString();
    try {
      this.options.source.db
        .update(backupJobs)
        .set({ status, phase: status, reason, snapshotId, finishedAt: stamp, updatedAt: stamp })
        .where(eq(backupJobs.id, id))
        .run();
    } catch {
      // The database may already be closed during shutdown.
    }
  }

  private async refreshHistory(destination: DestinationConfig, password: string): Promise<void> {
    const listed = await this.restic(destination, password, [...resticOptions(destination), 'snapshots', '--json', '--tag', 'qijuan']);
    const stats = await this.restic(destination, password, [...resticOptions(destination), 'stats', '--json', '--mode', 'raw-data']);
    const current = this.readHistory();
    const snapshots = listed.code === 0 ? parseSnapshots(listed.stdout) : current.snapshots;
    const repositoryBytes = stats.code === 0 ? parseResticStats(stats.stdout) : current.repositoryBytes;
    const file = path.join(this.options.dataDir, 'backup', 'history.json');
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify({ snapshots, repositoryBytes })}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  private readHistory(): { snapshots: SnapshotInfo[]; repositoryBytes: number | null } {
    try {
      const parsed = JSON.parse(readFileSync(path.join(this.options.dataDir, 'backup', 'history.json'), 'utf8')) as {
        snapshots?: unknown;
        repositoryBytes?: unknown;
      };
      const snapshots = Array.isArray(parsed.snapshots)
        ? parsed.snapshots.flatMap((entry) => {
            if (typeof entry !== 'object' || entry === null) return [];
            const record = entry as Partial<SnapshotInfo>;
            if (typeof record.id !== 'string' || typeof record.time !== 'string') return [];
            return [
              {
                id: record.id,
                shortId: typeof record.shortId === 'string' ? record.shortId : record.id.slice(0, 8),
                time: record.time,
                hostname: typeof record.hostname === 'string' ? record.hostname : '',
                tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [],
                scope: typeof record.scope === 'string' ? record.scope : null,
              },
            ];
          })
        : [];
      return {
        snapshots,
        repositoryBytes: typeof parsed.repositoryBytes === 'number' ? parsed.repositoryBytes : null,
      };
    } catch {
      return { snapshots: [], repositoryBytes: null };
    }
  }

  private pause(attempt: number): Promise<void> {
    const delay = this.pollMs >= 200 ? 2_000 * attempt : 0;
    if (delay === 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  private busyReason(): string {
    if (holder() === 'library') {
      return 'A library import or maintenance job is running. Wait for it to finish, then try again.';
    }
    return 'A backup is already running. Wait for it to finish, then try again.';
  }

  private async ensureRepository(destination: DestinationConfig, password: string): Promise<void> {
    const listed = await this.restic(destination, password, [...resticOptions(destination), 'snapshots', '--json', '--tag', 'qijuan']);
    if (listed.code === 0) return;
    const listedMessage = `${listed.stdout}\n${listed.stderr}`;
    if (/wrong password|no key found/i.test(listedMessage)) {
      throw new BackupJobError('The recovery password does not open this repository. Use the password that was saved outside the server.');
    }
    if (!/does not exist|config file/i.test(listedMessage)) {
      throw new BackupJobError(this.resticFailure('The repository could not be opened', listed.stdout, listed.stderr, destination, password));
    }
    const created = await this.restic(destination, password, [...resticOptions(destination), 'init']);
    if (created.code === 0) return;
    const initMessage = `${created.stdout}\n${created.stderr}`;
    if (/already initialized|config already/i.test(initMessage)) {
      throw new BackupJobError('The repository is already initialized. Use the recovery password that was saved outside the server.');
    }
    throw new BackupJobError(this.resticFailure('The repository could not be created', created.stdout, created.stderr, destination, password));
  }

  private restic(
    destination: DestinationConfig,
    password: string,
    args: string[],
    onStdout?: (chunk: string) => void,
  ) {
    return this.options.runner.run(args, {
      env: resticEnvironment(this.options.dataDir, destination, password),
      onStdout,
    });
  }

  private resticFailure(
    prefix: string,
    stdout: string,
    stderr: string,
    destination: DestinationConfig,
    password: string,
  ): string {
    const parsed = parseResticMessages(stdout);
    const detail = scrubSecrets(parsed.errorMessage || stderr || stdout || 'unknown restic error', [
      password,
      destination.secretAccessKey,
      destination.accessKeyId,
    ]);
    return `${prefix}: ${detail}`;
  }

  private secrets(ready: { destination: DestinationConfig; password: string }): string[] {
    return [ready.password, ready.destination.secretAccessKey, ready.destination.accessKeyId];
  }

  private missingBinary(text: string): boolean {
    return /ENOENT|not found/i.test(text);
  }

  private requireReady(): { destination: DestinationConfig; password: string } {
    const destination = readDestination(this.options.dataDir);
    const password = readRecoveryPassword(this.options.dataDir);
    if (!destination || !password) {
      throw new BackupJobError('Set a destination and a recovery password before using backup.');
    }
    return { destination, password };
  }

  private assertIndexedSelection(scope: BackupScopeChoice, indexedLibraryIds: number[]): void {
    if (scope === 'metadata-only' && indexedLibraryIds.length > 0) {
      throw new BackupJobError('A metadata-only backup cannot include indexed folders.');
    }
    if (indexedLibraryIds.length === 0) return;
    const rows = this.options.source.db.select({ id: libraries.id, mode: libraries.mode }).from(libraries).all();
    for (const id of indexedLibraryIds) {
      const row = rows.find((library) => library.id === id);
      if (!row || row.mode !== 'indexed') {
        throw new BackupJobError('Choose only indexed libraries when including original folders.');
      }
    }
  }

  private insertJob(
    kind: 'backup' | 'check' | 'restore-test',
    scope: BackupScopeChoice,
    indexedLibraryIds: number[],
  ): number {
    const stamp = this.now().toISOString();
    const inserted = this.options.source.db
      .insert(backupJobs)
      .values({
        kind,
        status: 'queued',
        scope: kind === 'backup' ? scopeLabel(scope, indexedLibraryIds) : kind,
        phase: 'queued',
        detail: JSON.stringify({ scope, indexedLibraryIds: kind === 'backup' ? indexedLibraryIds : [] } satisfies JobDetail),
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning({ id: backupJobs.id })
      .get();
    if (!inserted) throw new BackupJobError('The backup job could not be stored.');
    return inserted.id;
  }

  private claimJob(): number | null {
    const stamp = this.now().toISOString();
    return this.options.source.db.transaction((tx) => {
      const next = tx
        .select({ id: backupJobs.id })
        .from(backupJobs)
        .where(eq(backupJobs.status, 'queued'))
        .orderBy(asc(backupJobs.id))
        .get();
      if (!next) return null;
      const updated = tx
        .update(backupJobs)
        .set({ status: 'running', phase: 'preparing', startedAt: stamp, updatedAt: stamp })
        .where(and(eq(backupJobs.id, next.id), eq(backupJobs.status, 'queued')))
        .returning({ id: backupJobs.id })
        .get();
      return updated?.id ?? null;
    }, { behavior: 'immediate' });
  }

  private hasActiveJob(): boolean {
    const row = this.options.source.db
      .select({ id: backupJobs.id })
      .from(backupJobs)
      .where(or(eq(backupJobs.status, 'queued'), eq(backupJobs.status, 'running')))
      .get();
    return Boolean(row);
  }

  private setPhase(id: number, phase: string): void {
    this.options.source.db
      .update(backupJobs)
      .set({ phase, updatedAt: this.now().toISOString() })
      .where(eq(backupJobs.id, id))
      .run();
  }

  private failInterruptedJobs(): void {
    const stamp = this.now().toISOString();
    this.options.source.db
      .update(backupJobs)
      .set({
        status: 'failed',
        phase: 'interrupted',
        reason: keptSnapshotReason('The backup was interrupted before restic finished'),
        finishedAt: stamp,
        updatedAt: stamp,
      })
      .where(eq(backupJobs.status, 'running'))
      .run();
  }

  private readSchedule(): ScheduleView {
    const row = this.options.source.db.select().from(backupSettings).where(eq(backupSettings.id, 1)).get();
    if (!row) {
      return {
        enabled: false,
        intervalHours: 24,
        nextRunAt: null,
        retentionDaily: RETENTION_DAILY,
        retentionWeekly: RETENTION_WEEKLY,
        retentionMonthly: RETENTION_MONTHLY,
        checkIntervalHours: CHECK_INTERVAL_HOURS,
        nextCheckAt: null,
        scope: 'managed',
        indexedLibraryIds: [],
      };
    }
    return {
      enabled: row.scheduleEnabled === 1,
      intervalHours: row.intervalHours,
      nextRunAt: row.scheduleEnabled === 1 ? row.nextRunAt : null,
      retentionDaily: row.retentionDaily,
      retentionWeekly: row.retentionWeekly,
      retentionMonthly: row.retentionMonthly,
      checkIntervalHours: row.checkIntervalHours,
      nextCheckAt: row.nextCheckAt,
      scope: row.scope === 'metadata-only' ? 'metadata-only' : 'managed',
      indexedLibraryIds: parseIdList(row.indexedLibraryIds),
    };
  }

  private lastSuccess(): BackupStatus['lastSuccess'] {
    const row = this.options.source.db
      .select()
      .from(backupJobs)
      .where(and(eq(backupJobs.status, 'succeeded'), eq(backupJobs.kind, 'backup')))
      .orderBy(desc(backupJobs.id))
      .get();
    if (!row?.finishedAt) return null;
    return { finishedAt: row.finishedAt, snapshotId: row.snapshotId, scope: row.scope };
  }

  private latestJob(kind: 'backup' | 'check' | 'restore-test'): BackupJobView | null {
    const row = this.options.source.db
      .select()
      .from(backupJobs)
      .where(eq(backupJobs.kind, kind))
      .orderBy(desc(backupJobs.id))
      .get();
    return row ? toJobView(row) : null;
  }

  private activeJob(): BackupJobView | null {
    const row = this.options.source.db
      .select()
      .from(backupJobs)
      .where(or(eq(backupJobs.status, 'queued'), eq(backupJobs.status, 'running')))
      .orderBy(asc(backupJobs.id))
      .get();
    return row ? toJobView(row) : null;
  }

  private latestMaintenance(kind: 'check' | 'restore-test'): MaintenanceView {
    const row = this.options.source.db
      .select()
      .from(backupJobs)
      .where(eq(backupJobs.kind, kind))
      .orderBy(desc(backupJobs.id))
      .get();
    if (!row) return { status: null, phase: null, reason: null, finishedAt: null, snapshotId: null };
    return {
      status: row.status,
      phase: row.phase,
      reason: row.reason,
      finishedAt: row.finishedAt,
      snapshotId: row.snapshotId,
    };
  }

  private lastTransfer(): BackupStatus['usage']['lastTransfer'] {
    const row = this.options.source.db
      .select()
      .from(backupJobs)
      .where(and(eq(backupJobs.kind, 'backup'), eq(backupJobs.status, 'succeeded')))
      .orderBy(desc(backupJobs.id))
      .get();
    if (!row || (row.bytesAdded === null && row.bytesProcessed === null)) return null;
    return { bytesAdded: row.bytesAdded, bytesProcessed: row.bytesProcessed };
  }

  private jobById(id: number): BackupJobView | null {
    const row = this.options.source.db.select().from(backupJobs).where(eq(backupJobs.id, id)).get();
    return row ? toJobView(row) : null;
  }

  private rewriteManagedRoots(): void {
    const rows = this.options.source.db.select().from(libraries).all();
    for (const row of rows) {
      if (row.mode !== 'managed') continue;
      const root = managedLibraryRoot(this.options.dataDir, row.id);
      mkdirSync(root, { recursive: true });
      this.options.source.db.update(libraries).set({ rootPath: root }).where(eq(libraries.id, row.id)).run();
    }
  }

  private discardPlans(): void {
    for (const plan of this.plans.values()) rmSync(plan.stagingParent, { recursive: true, force: true });
    this.plans.clear();
  }
}

export function freshRecoveryPassword(): string {
  return generateRecoveryPassword();
}

function toJobView(row: typeof backupJobs.$inferSelect): BackupJobView {
  return {
    id: row.id,
    status: row.status,
    scope: row.scope,
    phase: row.phase,
    reason: row.reason,
    snapshotId: row.snapshotId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function toPlanView(plan: StoredPlan): RestorePlanView {
  const inspection = plan.inspection;
  const replaces = [
    'the QiJuan database, including users, grants, shelves, annotations, and reading positions',
    'the application secret',
  ];
  if (!inspection.manifest.metadataOnly) replaces.push('managed books and custom covers');
  if (inspection.manifest.scope.includes('indexed')) replaces.push('the selected indexed folders');
  return {
    planId: plan.id,
    snapshotId: plan.snapshotId,
    compatible: inspection.compatible,
    reason: inspection.reason,
    scope: inspection.manifest.scope,
    metadataOnly: inspection.manifest.metadataOnly,
    schemaVersion: inspection.manifest.schemaVersion,
    appVersion: inspection.manifest.appVersion,
    counts: {
      users: inspection.users,
      editions: inspection.editions,
      shelves: inspection.shelves,
      highlights: inspection.highlights,
      notes: inspection.notes,
      bookmarks: inspection.bookmarks,
      readingPositions: inspection.readingPositions,
      managedFiles: inspection.managedFiles,
      missingFiles: inspection.missingFiles.length,
    },
    missingFiles: inspection.missingFiles.slice(0, 20),
    replaces,
  };
}

function parseDetail(value: string): JobDetail {
  try {
    const parsed = JSON.parse(value) as Partial<JobDetail>;
    const scope = parsed.scope === 'metadata-only' ? 'metadata-only' : 'managed';
    const indexedLibraryIds = Array.isArray(parsed.indexedLibraryIds)
      ? parsed.indexedLibraryIds.filter((id): id is number => Number.isInteger(id) && id > 0)
      : [];
    return { scope, indexedLibraryIds };
  } catch {
    return { scope: 'managed', indexedLibraryIds: [] };
  }
}

function parseIdList(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is number => Number.isInteger(id) && id > 0);
  } catch {
    return [];
  }
}

function parseSnapshots(stdout: string): SnapshotInfo[] {
  const start = stdout.indexOf('[');
  if (start < 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const snapshots: SnapshotInfo[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.time !== 'string') continue;
    const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    const scopeTag = tags.find((tag) => tag.startsWith('scope='));
    snapshots.push({
      id: record.id,
      shortId: typeof record.short_id === 'string' ? record.short_id : record.id.slice(0, 8),
      time: record.time,
      hostname: typeof record.hostname === 'string' ? record.hostname : '',
      tags,
      scope: scopeTag ? scopeTag.slice('scope='.length) : null,
    });
  }
  return snapshots;
}

export function isMetadataOnlyScope(scope: string): boolean {
  return scope === METADATA_ONLY_SCOPE;
}
