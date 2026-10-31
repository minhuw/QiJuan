import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FlaskConical,
  KeyRound,
  Loader2,
  Play,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { api, type LibraryInfo } from './api';
import { Entry } from './components/ui/entry';
import { PageHeader } from './components/ui/page-header';
import { StateTag, jobTone } from './components/ui/status-mark';
import { EmptyState, ErrorNotice, LoadingState } from './components/ui/states';
import { useLocale } from './shell';

interface DestinationForm {
  preset: 'custom' | 'r2';
  endpoint: string;
  region: string;
  pathStyle: boolean;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

interface BackupJob {
  id: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  scope: string;
  phase: string | null;
  reason: string | null;
}

interface MaintenanceView {
  status: BackupJob['status'] | null;
  phase: string | null;
  reason: string | null;
  finishedAt: string | null;
  snapshotId: string | null;
}

interface BackupStatus {
  destination: Omit<DestinationForm, 'secretAccessKey' | 'accessKeyId'> & {
    accessKeyConfigured: true;
    accessKeyHint: string;
    secretConfigured: true;
  } | null;
  r2Preset: { endpoint: string; region: string; pathStyle: true };
  recovery: { configured: boolean };
  schedule: {
    enabled: boolean;
    intervalHours: number;
    nextRunAt: string | null;
    retentionDaily: number;
    retentionWeekly: number;
    retentionMonthly: number;
    checkIntervalHours: number;
    nextCheckAt: string | null;
    scope: 'metadata-only' | 'managed';
    indexedLibraryIds: number[];
  };
  lastSuccess: { finishedAt: string; snapshotId: string | null; scope: string } | null;
  job: BackupJob | null;
  active: BackupJob | null;
  history: SnapshotInfo[];
  usage: {
    repositoryBytes: number | null;
    lastTransfer: { bytesAdded: number | null; bytesProcessed: number | null } | null;
  };
  integrityCheck: MaintenanceView & { nextRunAt: string | null };
  restoreTest: MaintenanceView;
}

interface SnapshotInfo {
  id: string;
  shortId: string;
  time: string;
  scope: string | null;
}

interface RestorePlan {
  planId: string;
  snapshotId: string;
  compatible: boolean;
  reason: string | null;
  scope: string;
  metadataOnly: boolean;
  counts: {
    users: number;
    editions: number;
    shelves: number;
    highlights: number;
    readingPositions: number;
    managedFiles: number;
    missingFiles: number;
  };
  replaces: string[];
}

const EMPTY_DESTINATION: DestinationForm = {
  preset: 'custom',
  endpoint: '',
  region: 'us-east-1',
  pathStyle: true,
  bucket: '',
  prefix: '',
  accessKeyId: '',
  secretAccessKey: '',
};

export function BackupScreen() {
  const { t, locale } = useLocale();
  const when = (value: string | null | undefined, fallback: string) => <When value={value} locale={locale} fallback={fallback} />;
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [destination, setDestination] = useState<DestinationForm>(EMPTY_DESTINATION);
  const [secretConfigured, setSecretConfigured] = useState(false);
  const [accessConfigured, setAccessConfigured] = useState(false);
  const [password, setPassword] = useState('');
  const [shownPassword, setShownPassword] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<BackupStatus['schedule'] | null>(null);
  const [indexed, setIndexed] = useState<LibraryInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[] | null>(null);
  const [snapshotId, setSnapshotId] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [activated, setActivated] = useState(false);

  async function load() {
    const result = await api<BackupStatus & { libraries?: LibraryInfo[] }>('/api/backup');
    if (result.error || !result.data) {
      setError(result.error);
      setReason(result.reason ?? null);
      return;
    }
    setError(null);
    setReason(null);
    setStatus(result.data);
    setSchedule(result.data.schedule);
    if (result.data.destination) {
      setDestination({
        preset: result.data.destination.preset,
        endpoint: result.data.destination.endpoint,
        region: result.data.destination.region,
        pathStyle: result.data.destination.pathStyle,
        bucket: result.data.destination.bucket,
        prefix: result.data.destination.prefix,
        accessKeyId: '',
        secretAccessKey: '',
      });
      setSecretConfigured(true);
      setAccessConfigured(true);
    }
    const libraries = await api<{ libraries: LibraryInfo[] }>('/api/libraries');
    if (libraries.data) setIndexed(libraries.data.libraries.filter((library) => library.mode === 'indexed'));
  }

  useEffect(() => {
    let active = true;
    void load().then(() => {
      if (!active) return;
    });
    return () => {
      active = false;
    };
    // The screen loads once, then polls while a job is running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const running = status?.active?.status === 'queued' || status?.active?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void load();
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);

  function applyR2() {
    if (!status) return;
    setDestination((current) => ({
      ...current,
      preset: 'r2',
      endpoint: status.r2Preset.endpoint,
      region: status.r2Preset.region,
      pathStyle: true,
    }));
  }

  async function saveDestination(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setNotice(null);
    const result = await api('/api/backup/destination', {
      method: 'PUT',
      body: destination,
    });
    setPending(false);
    if (result.error) {
      setError(result.error);
      setReason(result.reason ?? null);
      return;
    }
    setSecretConfigured(true);
    setDestination((current) => ({ ...current, secretAccessKey: '', accessKeyId: '' }));
    setAccessConfigured(true);
    await load();
  }

  async function testConnection() {
    setPending(true);
    setNotice(null);
    const result = await api('/api/backup/destination/test', { method: 'POST', body: {} });
    setPending(false);
    if (result.error) {
      setError(result.error);
      setReason(result.reason ?? null);
      return;
    }
    setError(null);
    setReason(null);
    setNotice(t('backup.testOk'));
  }

  async function savePassword(generate: boolean) {
    setPending(true);
    setNotice(null);
    const result = await api<{ recoveryPassword: string }>('/api/backup/recovery', {
      method: 'POST',
      body: generate ? { generate: true } : { password },
    });
    setPending(false);
    if (result.error || !result.data) {
      setError(result.error);
      setReason(result.reason ?? null);
      return;
    }
    setShownPassword(result.data.recoveryPassword);
    setPassword('');
    setError(null);
    setReason(null);
    await load();
  }

  async function saveSchedule(event: FormEvent) {
    event.preventDefault();
    if (!schedule) return;
    setPending(true);
    const result = await api('/api/backup/schedule', {
      method: 'PUT',
      body: {
        enabled: schedule.enabled,
        intervalHours: schedule.intervalHours,
        retentionDaily: schedule.retentionDaily,
        retentionWeekly: schedule.retentionWeekly,
        retentionMonthly: schedule.retentionMonthly,
        checkIntervalHours: schedule.checkIntervalHours,
        scope: schedule.scope,
        indexedLibraryIds: schedule.indexedLibraryIds,
      },
    });
    setPending(false);
    if (result.error) {
      setError(result.error);
      setReason(result.reason ?? null);
      return;
    }
    await load();
  }

  async function runBackup(scope: 'managed' | 'metadata-only') {
    if (!schedule) return;
    setPending(true);
    setNotice(null);
    const result = await api('/api/backup/jobs', {
      method: 'POST',
      body: {
        scope,
        indexedLibraryIds: scope === 'metadata-only' ? [] : schedule.indexedLibraryIds,
      },
    });
    setPending(false);
    if (result.error) {
      setError(result.error);
      setReason(result.reason ?? null);
      return;
    }
    setError(null);
    setReason(null);
    await load();
  }

  async function runMaintenance(path: '/api/backup/checks' | '/api/backup/restore-tests') {
    setPending(true);
    setNotice(null);
    const result = await api(path, { method: 'POST', body: {} });
    setPending(false);
    if (result.error) {
      setError(result.error);
      setReason(result.reason ?? null);
      return;
    }
    setError(null);
    setReason(null);
    await load();
  }

  async function listSnapshots() {
    setPending(true);
    setPlan(null);
    const result = await api<{ snapshots: SnapshotInfo[] }>('/api/backup/restore/snapshots', {
      method: 'POST',
      body: { recoveryPassword: restorePassword, destination },
    });
    setPending(false);
    if (result.error || !result.data) {
      setError(result.error);
      setReason(result.reason ?? null);
      return;
    }
    setSnapshots(result.data.snapshots);
    setSnapshotId(result.data.snapshots[0]?.id ?? '');
    setError(null);
    setReason(null);
  }

  async function prepare() {
    setPending(true);
    const result = await api<RestorePlan>('/api/backup/restore/plan', {
      method: 'POST',
      body: { recoveryPassword: restorePassword, destination, snapshotId },
    });
    setPending(false);
    if (result.error || !result.data) {
      setError(result.error);
      setReason(result.reason ?? null);
      setPlan(null);
      return;
    }
    setPlan(result.data);
    setConfirm(false);
    setError(null);
    setReason(result.data.reason);
  }

  async function activate() {
    if (!plan || !confirm) return;
    setPending(true);
    const result = await api('/api/backup/restore/activate', {
      method: 'POST',
      body: { planId: plan.planId, confirm: true },
    });
    setPending(false);
    if (result.error) {
      setError(result.error);
      setReason(result.reason ?? null);
      return;
    }
    setActivated(true);
  }

  function toggleIndexed(id: number) {
    setSchedule((current) => {
      if (!current) return current;
      const has = current.indexedLibraryIds.includes(id);
      return {
        ...current,
        indexedLibraryIds: has
          ? current.indexedLibraryIds.filter((value) => value !== id)
          : [...current.indexedLibraryIds, id],
      };
    });
  }

  return (
    <div className="backup-page">
      <PageHeader
        title={t('backup.title')}
        description={t('backup.subtitle')}
        actions={
          <div className="header-actions">
            <button
              className="btn btn-primary"
              type="button"
              disabled={pending || !schedule}
              onClick={() => void runBackup('managed')}
            >
              <Play size={15} strokeWidth={1.5} aria-hidden="true" />
              {t('backup.run')}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={pending || !schedule}
              onClick={() => void runBackup('metadata-only')}
            >
              {t('backup.runMetadata')}
            </button>
          </div>
        }
      />

      {error ? <ErrorNotice message={reason || t(`errors.${error}`)} /> : null}
      {notice ? (
        <p className="alert alert-success" role="status">
          <CheckCircle2 size={16} aria-hidden="true" />
          {notice}
        </p>
      ) : null}
      {activated ? (
        <p className="alert alert-success" role="status">
          <CheckCircle2 size={16} aria-hidden="true" />
          {t('backup.activated')}
        </p>
      ) : null}

      <Entry title={t('backup.overview')} className="backup-overview">
        <dl className="detail-list">
          <div>
            <dt>{t('backup.lastSuccess')}</dt>
            <dd>
              {when(status?.lastSuccess?.finishedAt, t('backup.none'))}
              {status?.lastSuccess ? <span className="detail-note">{scopeNote(status.lastSuccess.scope, t)}</span> : null}
            </dd>
          </div>
          <div>
            <dt>{t('backup.next')}</dt>
            <dd>{when(status?.schedule.nextRunAt, t('backup.notScheduled'))}</dd>
          </div>
          <div>
            <dt>{t('backup.repositorySize')}</dt>
            <dd className="num">{formatBytes(status?.usage.repositoryBytes, t('backup.unavailable'))}</dd>
          </div>
          <div>
            <dt>{t('backup.transferred')}</dt>
            <dd className="num">
              {status?.usage.lastTransfer
                ? `${formatBytes(status.usage.lastTransfer.bytesAdded, t('backup.unavailable'))} / ${formatBytes(
                    status.usage.lastTransfer.bytesProcessed,
                    t('backup.unavailable'),
                  )}`
                : t('backup.unavailable')}
            </dd>
          </div>
        </dl>
      </Entry>

      <div className="backup-layout">
        <Entry
          title={t('backup.destination')}
          className="backup-panel"
          meta={
            <StateTag tone={status?.destination ? 'success' : 'quiet'}>
              {status?.destination ? t('backup.configured') : t('backup.notConfigured')}
            </StateTag>
          }
        >
          <p className="hint">{t('backup.guide')}</p>
          <form className="form" onSubmit={(event) => void saveDestination(event)}>
            <div className="preset-row">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setDestination((current) => ({ ...current, preset: 'custom' }))}
              >
                {t('backup.presetCustom')}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={applyR2}>
                {t('backup.presetR2')}
              </button>
            </div>
            <p className="hint">{t('backup.r2Hint')}</p>
            <div className="field-grid">
              <Field label={t('backup.endpoint')} value={destination.endpoint} onChange={(endpoint) => setDestination({ ...destination, endpoint })} />
              <Field label={t('backup.region')} value={destination.region} onChange={(region) => setDestination({ ...destination, region })} />
              <Field label={t('backup.bucket')} value={destination.bucket} onChange={(bucket) => setDestination({ ...destination, bucket })} />
              <Field label={t('backup.prefix')} value={destination.prefix} onChange={(prefix) => setDestination({ ...destination, prefix })} />
              <Field
                label={t('backup.accessKey')}
                type="password"
                value={destination.accessKeyId}
                autoComplete="off"
                onChange={(accessKeyId) => setDestination({ ...destination, accessKeyId })}
                hint={
                  accessConfigured
                    ? `${t('backup.accessKept')}${status?.destination?.accessKeyHint ? ` · ${status.destination.accessKeyHint}` : ''}`
                    : undefined
                }
              />
              <Field
                label={t('backup.secretKey')}
                type="password"
                value={destination.secretAccessKey}
                autoComplete="off"
                onChange={(secretAccessKey) => setDestination({ ...destination, secretAccessKey })}
                hint={secretConfigured ? t('backup.secretKept') : undefined}
              />
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={destination.pathStyle}
                onChange={(event) => setDestination({ ...destination, pathStyle: event.target.checked })}
              />
              <span>{t('backup.pathStyle')}</span>
            </label>
            <div className="form-footer">
              <button className="btn btn-primary" type="submit" disabled={pending}>
                <Save size={15} aria-hidden="true" />
                {t('backup.saveDestination')}
              </button>
              <button className="btn btn-secondary" type="button" disabled={pending} onClick={() => void testConnection()}>
                {t('backup.test')}
              </button>
            </div>
          </form>
        </Entry>

        <Entry
          title={t('backup.progress')}
          className="backup-panel"
          meta={
            status?.active ? <StateTag tone={jobTone(status.active.status)}>{status.active.status}</StateTag> : null
          }
        >
          {status?.active && (status.active.status === 'queued' || status.active.status === 'running') ? (
            <p className="alert alert-info" role="status">
              <Loader2 className="spin" size={16} aria-hidden="true" />
              {status.active.scope} · {status.active.phase ?? status.active.status}
            </p>
          ) : (
            <p className="hint">{t('backup.idle')}</p>
          )}
          {status?.job?.status === 'failed' && status.job.reason ? (
            <div className="alert alert-error" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <p>
                {status.job.scope === 'metadata-only' ? `${t('backup.scopeMetadata')}. ` : ''}
                {status.job.reason}
              </p>
            </div>
          ) : null}
          {status?.job?.scope === 'metadata-only' && status.job.status === 'succeeded' ? (
            <p className="hint">{t('backup.metadataLabel')}</p>
          ) : null}
          <div className="progress-track progress-track-lg" aria-hidden="true">
            <span
              className="progress-fill progress-succeeded"
              style={{
                width:
                  status?.active?.status === 'running'
                    ? '64%'
                    : status?.active?.status === 'queued'
                      ? '18%'
                      : status?.lastSuccess
                        ? '100%'
                        : '0%',
              }}
            />
          </div>
        </Entry>

        <Entry title={t('backup.recovery')} className="backup-panel">
          <p className="hint">{t('backup.recoveryHint')}</p>
          {shownPassword ? (
            <p className="alert alert-warning" role="status">
              <KeyRound size={16} aria-hidden="true" />
              {t('backup.shown')} <code>{shownPassword}</code>
            </p>
          ) : null}
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void savePassword(false);
            }}
          >
            <Field
              label={t('backup.password')}
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={setPassword}
            />
            <div className="form-footer">
              <button className="btn btn-primary" type="submit" disabled={pending}>
                {t('backup.savePassword')}
              </button>
              <button className="btn btn-secondary" type="button" disabled={pending} onClick={() => void savePassword(true)}>
                {t('backup.generate')}
              </button>
              {status?.recovery.configured ? (
                <a className="btn btn-ghost" href="/api/backup/recovery-file">
                  <Download size={15} aria-hidden="true" />
                  {t('backup.download')}
                </a>
              ) : null}
            </div>
          </form>
        </Entry>

        <Entry
          title={t('backup.schedule')}
          className="backup-panel"
          meta={
            schedule ? (
            <StateTag tone={schedule.enabled ? 'success' : 'quiet'}>
              {schedule.enabled ? t('backup.active') : t('backup.paused')}
            </StateTag>
          ) : null
          }
        >
          <p className="hint">{t('backup.retentionHint')}</p>
          {schedule ? (
            <form className="form" onSubmit={(event) => void saveSchedule(event)}>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={schedule.enabled}
                  onChange={(event) => setSchedule({ ...schedule, enabled: event.target.checked })}
                />
                <span>{t('backup.enabled')}</span>
              </label>
              <div className="field-grid">
                <NumberField
                  label={t('backup.interval')}
                  value={schedule.intervalHours}
                  onChange={(intervalHours) => setSchedule({ ...schedule, intervalHours })}
                />
                <NumberField
                  label={t('backup.daily')}
                  value={schedule.retentionDaily}
                  onChange={(retentionDaily) => setSchedule({ ...schedule, retentionDaily })}
                />
                <NumberField
                  label={t('backup.weekly')}
                  value={schedule.retentionWeekly}
                  onChange={(retentionWeekly) => setSchedule({ ...schedule, retentionWeekly })}
                />
                <NumberField
                  label={t('backup.monthly')}
                  value={schedule.retentionMonthly}
                  onChange={(retentionMonthly) => setSchedule({ ...schedule, retentionMonthly })}
                />
                <NumberField
                  label={t('backup.checkInterval')}
                  value={schedule.checkIntervalHours}
                  onChange={(checkIntervalHours) => setSchedule({ ...schedule, checkIntervalHours })}
                />
              </div>
              <fieldset className="field radio-field">
                <legend>{t('backup.scope')}</legend>
                <label className="check-row">
                  <input
                    type="radio"
                    name="scope"
                    checked={schedule.scope === 'managed'}
                    onChange={() => setSchedule({ ...schedule, scope: 'managed' })}
                  />
                  <span>{t('backup.scopeManaged')}</span>
                </label>
                <label className="check-row">
                  <input
                    type="radio"
                    name="scope"
                    checked={schedule.scope === 'metadata-only'}
                    onChange={() => setSchedule({ ...schedule, scope: 'metadata-only', indexedLibraryIds: [] })}
                  />
                  <span>{t('backup.scopeMetadata')}</span>
                </label>
              </fieldset>
              {indexed.length > 0 ? (
                <fieldset className="field radio-field">
                  <legend>{t('backup.indexed')}</legend>
                  <p className="hint">{t('backup.indexedHint')}</p>
                  {indexed.map((library) => (
                    <label key={library.id} className="check-row">
                      <input
                        type="checkbox"
                        checked={schedule.indexedLibraryIds.includes(library.id)}
                        disabled={schedule.scope === 'metadata-only'}
                        onChange={() => toggleIndexed(library.id)}
                      />
                      <span>{library.name}</span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <div className="form-footer">
                <button className="btn btn-primary" type="submit" disabled={pending}>
                  <Save size={15} aria-hidden="true" />
                  {t('backup.saveSchedule')}
                </button>
              </div>
            </form>
          ) : (
            <LoadingState />
          )}
          {schedule?.scope === 'metadata-only' ? <p className="hint">{t('backup.metadataLabel')}</p> : null}
          <p className="hint">
            {schedule && schedule.indexedLibraryIds.length > 0 && schedule.scope !== 'metadata-only'
              ? t('backup.indexedIncluded')
              : t('backup.indexedExcluded')}
          </p>
        </Entry>

        <Entry title={t('backup.history')} className="backup-panel">
          <p className="hint">{t('backup.deletedKept')}</p>
          {status && status.history.length > 0 ? (
            <ul className="snapshot-list">
              {status.history.map((snapshot) => (
                <li key={snapshot.id} className="snapshot-row">
                  <span className="snapshot-copy">
                    <span className="snapshot-id num">{snapshot.shortId}</span>
                    <span className="hint">{when(snapshot.time, snapshot.time)}</span>
                  </span>
                  {snapshot.scope ? <span className="tag">{snapshot.scope}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact title={t('backup.noSnapshots')} />
          )}
        </Entry>

        <Entry title={t('backup.integrity')} className="backup-panel">
          <p className="hint">{t('backup.integrityHint')}</p>
          <dl className="detail-list">
            <div>
              <dt>{t('backup.lastCheck')}</dt>
              <dd>
                {when(status?.integrityCheck.finishedAt, t('backup.none'))}
                {status?.integrityCheck.status ? ` · ${status.integrityCheck.status}` : ''}
              </dd>
            </div>
            {status?.integrityCheck.reason ? (
              <div>
                <dt>{t('backup.failure')}</dt>
                <dd>{status.integrityCheck.reason}</dd>
              </div>
            ) : null}
            <div>
              <dt>{t('backup.nextCheck')}</dt>
              <dd>{when(status?.integrityCheck.nextRunAt, t('backup.notScheduled'))}</dd>
            </div>
            <div>
              <dt>{t('backup.lastRestoreTest')}</dt>
              <dd>
                {when(status?.restoreTest.finishedAt, t('backup.none'))}
                {status?.restoreTest.status ? ` · ${status.restoreTest.status}` : ''}
              </dd>
            </div>
          </dl>
          <p className="hint">{t('backup.restoreTestHint')}</p>
          <div className="form-footer">
            <button
              className="btn btn-secondary"
              type="button"
              disabled={pending}
              onClick={() => void runMaintenance('/api/backup/checks')}
            >
              <ShieldCheck size={15} aria-hidden="true" />
              {t('backup.checkNow')}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={pending}
              onClick={() => void runMaintenance('/api/backup/restore-tests')}
            >
              <FlaskConical size={15} aria-hidden="true" />
              {t('backup.restoreTest')}
            </button>
          </div>
        </Entry>

        <Entry title={t('backup.restore')} className="backup-panel backup-restore">
          <form
            className="form restore-form"
            onSubmit={(event) => {
              event.preventDefault();
              void listSnapshots();
            }}
          >
            <Field
              label={t('backup.password')}
              type="password"
              value={restorePassword}
              autoComplete="off"
              onChange={setRestorePassword}
            />
            <button className="btn btn-secondary" type="submit" disabled={pending}>
              {t('backup.list')}
            </button>
          </form>
          {snapshots && snapshots.length > 0 ? (
            <form
              className="form restore-form"
              onSubmit={(event) => {
                event.preventDefault();
                void prepare();
              }}
            >
              <label className="field">
                <span>{t('backup.list')}</span>
                <select value={snapshotId} onChange={(event) => setSnapshotId(event.target.value)}>
                  {snapshots.map((snapshot) => (
                    <option key={snapshot.id} value={snapshot.id}>
                      {snapshot.shortId} · {formatDateTime(snapshot.time, locale) ?? snapshot.time}
                      {snapshot.scope ? ` · ${snapshot.scope}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn btn-secondary" type="submit" disabled={pending}>
                {t('backup.prepare')}
              </button>
            </form>
          ) : null}
          {plan ? (
            <div className="restore-plan">
              <h3>{t('backup.counts')}</h3>
              <p className="hint">
                {plan.scope}
                {plan.metadataOnly ? ` · ${t('backup.scopeMetadata')}` : ''}
              </p>
              <dl className="restore-counts">
                <div>
                  <dt>{t('catalog.books')}</dt>
                  <dd>{plan.counts.editions}</dd>
                </div>
                <div>
                  <dt>{t('library.shelves')}</dt>
                  <dd>{plan.counts.shelves}</dd>
                </div>
                <div>
                  <dt>{t('reader.highlights')}</dt>
                  <dd>{plan.counts.highlights}</dd>
                </div>
                <div>
                  <dt>{t('reading.reading')}</dt>
                  <dd>{plan.counts.readingPositions}</dd>
                </div>
              </dl>
              <h3>{t('backup.replaces')}</h3>
              <ul className="plain-list">
                {plan.replaces.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              {plan.compatible ? null : (
                <div className="alert alert-error" role="alert">
                  {plan.reason || t('backup.incompatible')}
                </div>
              )}
              <label className="check-row">
                <input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} />
                <span>{t('backup.confirm')}</span>
              </label>
              <button
                className="btn btn-danger"
                type="button"
                disabled={pending || !confirm || !plan.compatible}
                onClick={() => void activate()}
              >
                {t('backup.activate')}
              </button>
            </div>
          ) : null}
        </Entry>
      </div>
    </div>
  );
}

/** Locale date and time for an ISO timestamp; null when the value does not parse. */
function formatDateTime(value: string, locale: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function When({ value, locale, fallback }: { value: string | null | undefined; locale: string; fallback: string }) {
  const text = value ? formatDateTime(value, locale) : null;
  if (!value || !text) return <>{value || fallback}</>;
  return <time dateTime={value}>{text}</time>;
}

function scopeNote(scope: string, t: (key: string) => string): string {
  if (scope === 'metadata-only') return t('backup.metadataLabel');
  if (scope.includes('indexed')) return t('backup.indexedIncluded');
  return t('backup.indexedExcluded');
}

function formatBytes(value: number | null | undefined, unavailable: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return unavailable;
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = size >= 10 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete = 'off',
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  autoComplete?: string;
  hint?: string;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
