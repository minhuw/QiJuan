import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, type LibraryInfo } from './api';
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

export function BackupScreen({ onSignOut }: { onSignOut: () => void }) {
  const { t } = useLocale();
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
      <p className="tagline">{t('brand.tagline')}</p>
      <h1>{t('backup.title')}</h1>
      <div className="toolbar">
        <Link className="text-link" to="/">
          {t('backup.back')}
        </Link>
        <button type="button" className="button button-secondary" onClick={onSignOut}>
          {t('account.signOut')}
        </button>
      </div>
      {error ? (
        <p className="alert" role="alert">
          {reason || t(`errors.${error}`)}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {activated ? <p role="status">{t('backup.activated')}</p> : null}

      <section>
        <h2>{t('backup.destination')}</h2>
        <form className="form" onSubmit={(event) => void saveDestination(event)}>
          <div className="toolbar">
            <button type="button" className="button button-secondary" onClick={() => setDestination((current) => ({ ...current, preset: 'custom' }))}>
              {t('backup.presetCustom')}
            </button>
            <button type="button" className="button button-secondary" onClick={applyR2}>
              {t('backup.presetR2')}
            </button>
          </div>
          <p className="hint">{t('backup.guide')}</p>
          <p className="hint">{t('backup.r2Hint')}</p>
          <Field label={t('backup.endpoint')} value={destination.endpoint} onChange={(endpoint) => setDestination({ ...destination, endpoint })} />
          <Field label={t('backup.region')} value={destination.region} onChange={(region) => setDestination({ ...destination, region })} />
          <label className="field">
            <input
              type="checkbox"
              checked={destination.pathStyle}
              onChange={(event) => setDestination({ ...destination, pathStyle: event.target.checked })}
            />{' '}
            {t('backup.pathStyle')}
          </label>
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
          <button className="button" type="submit" disabled={pending}>
            {t('backup.saveDestination')}
          </button>
          <button className="button button-secondary" type="button" disabled={pending} onClick={() => void testConnection()}>
            {t('backup.test')}
          </button>
        </form>
      </section>

      <section>
        <h2>{t('backup.recovery')}</h2>
        <p className="hint">{t('backup.recoveryHint')}</p>
        {shownPassword ? (
          <p role="status">
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
          <Field label={t('backup.password')} type="password" value={password} autoComplete="new-password" onChange={setPassword} />
          <button className="button" type="submit" disabled={pending}>
            {t('backup.savePassword')}
          </button>
          <button className="button button-secondary" type="button" disabled={pending} onClick={() => void savePassword(true)}>
            {t('backup.generate')}
          </button>
          {status?.recovery.configured ? (
            <a className="text-link" href="/api/backup/recovery-file">
              {t('backup.download')}
            </a>
          ) : null}
        </form>
      </section>

      {schedule ? (
        <section>
          <h2>{t('backup.schedule')}</h2>
          <p className="hint">{t('backup.retentionHint')}</p>
          <form className="form" onSubmit={(event) => void saveSchedule(event)}>
            <label className="field">
              <input
                type="checkbox"
                checked={schedule.enabled}
                onChange={(event) => setSchedule({ ...schedule, enabled: event.target.checked })}
              />{' '}
              {t('backup.enabled')}
            </label>
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
            <fieldset className="field">
              <legend>{t('backup.scope')}</legend>
              <label>
                <input
                  type="radio"
                  name="scope"
                  checked={schedule.scope === 'managed'}
                  onChange={() => setSchedule({ ...schedule, scope: 'managed' })}
                />{' '}
                {t('backup.scopeManaged')}
              </label>
              <label>
                <input
                  type="radio"
                  name="scope"
                  checked={schedule.scope === 'metadata-only'}
                  onChange={() => setSchedule({ ...schedule, scope: 'metadata-only', indexedLibraryIds: [] })}
                />{' '}
                {t('backup.scopeMetadata')}
              </label>
            </fieldset>
            {indexed.length > 0 ? (
              <fieldset className="field">
                <legend>{t('backup.indexed')}</legend>
                <p className="hint">{t('backup.indexedHint')}</p>
                {indexed.map((library) => (
                  <label key={library.id}>
                    <input
                      type="checkbox"
                      checked={schedule.indexedLibraryIds.includes(library.id)}
                      disabled={schedule.scope === 'metadata-only'}
                      onChange={() => toggleIndexed(library.id)}
                    />{' '}
                    {library.name}
                  </label>
                ))}
              </fieldset>
            ) : null}
            <button className="button" type="submit" disabled={pending}>
              {t('backup.saveSchedule')}
            </button>
          </form>
          <div className="toolbar">
            <button className="button" type="button" disabled={pending} onClick={() => void runBackup('managed')}>
              {t('backup.run')}
            </button>
            <button className="button button-secondary" type="button" disabled={pending} onClick={() => void runBackup('metadata-only')}>
              {t('backup.runMetadata')}
            </button>
          </div>
          <p className="hint">{t('backup.metadataLabel')}</p>
          <p className="hint">
            {schedule.indexedLibraryIds.length > 0 && schedule.scope !== 'metadata-only'
              ? t('backup.indexedIncluded')
              : t('backup.indexedExcluded')}
          </p>
        </section>
      ) : null}

      <section>
        <h2>{t('backup.lastSuccess')}</h2>
        {status?.lastSuccess ? (
          <>
            <p>
              {status.lastSuccess.finishedAt}
              {status.lastSuccess.scope ? ` · ${status.lastSuccess.scope}` : ''}
            </p>
            <p>{scopeNote(status.lastSuccess.scope, t)}</p>
          </>
        ) : (
          <p className="placeholder">{t('backup.none')}</p>
        )}
        <h2>{t('backup.next')}</h2>
        <p>{status?.schedule.nextRunAt ?? t('backup.notScheduled')}</p>
        <h2>{t('backup.progress')}</h2>
        {status?.active && (status.active.status === 'queued' || status.active.status === 'running') ? (
          <p role="status">
            {status.active.scope} · {status.active.phase ?? status.active.status}
          </p>
        ) : (
          <p>{t('backup.idle')}</p>
        )}
        {status?.job?.status === 'failed' && status.job.reason ? (
          <>
            <h2>{t('backup.failure')}</h2>
            <p className="alert" role="alert">
              {status.job.scope === 'metadata-only' ? `${t('backup.scopeMetadata')}. ` : ''}
              {status.job.reason}
            </p>
          </>
        ) : null}
        {status?.job?.scope === 'metadata-only' && status.job.status === 'succeeded' ? (
          <p>{t('backup.metadataLabel')}</p>
        ) : null}
      </section>

      <section>
        <h2>{t('backup.usage')}</h2>
        <p>
          {t('backup.repositorySize')}: {formatBytes(status?.usage.repositoryBytes, t('backup.unavailable'))}
        </p>
        <p>
          {t('backup.transferred')}:{' '}
          {status?.usage.lastTransfer
            ? `${formatBytes(status.usage.lastTransfer.bytesAdded, t('backup.unavailable'))} / ${formatBytes(status.usage.lastTransfer.bytesProcessed, t('backup.unavailable'))}`
            : t('backup.unavailable')}
        </p>
        <h2>{t('backup.history')}</h2>
        <p className="hint">{t('backup.deletedKept')}</p>
        {status && status.history.length > 0 ? (
          <ul className="plain-list">
            {status.history.map((snapshot) => (
              <li key={snapshot.id}>
                {snapshot.shortId} · {snapshot.time}
                {snapshot.scope ? ` · ${snapshot.scope}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="placeholder">{t('backup.noSnapshots')}</p>
        )}
      </section>

      <section>
        <h2>{t('backup.integrity')}</h2>
        <p className="hint">{t('backup.integrityHint')}</p>
        <p>
          {t('backup.lastCheck')}: {status?.integrityCheck.finishedAt ?? t('backup.none')}
          {status?.integrityCheck.status ? ` · ${status.integrityCheck.status}` : ''}
        </p>
        {status?.integrityCheck.reason ? <p>{status.integrityCheck.reason}</p> : null}
        <p>
          {t('backup.nextCheck')}: {status?.integrityCheck.nextRunAt ?? t('backup.notScheduled')}
        </p>
        <h2>{t('backup.restoreTest')}</h2>
        <p className="hint">{t('backup.restoreTestHint')}</p>
        <p>
          {t('backup.lastRestoreTest')}: {status?.restoreTest.finishedAt ?? t('backup.none')}
          {status?.restoreTest.status ? ` · ${status.restoreTest.status}` : ''}
        </p>
        {status?.restoreTest.reason ? <p>{status.restoreTest.reason}</p> : null}
        <div className="toolbar">
          <button className="button button-secondary" type="button" disabled={pending} onClick={() => void runMaintenance('/api/backup/checks')}>
            {t('backup.checkNow')}
          </button>
          <button className="button button-secondary" type="button" disabled={pending} onClick={() => void runMaintenance('/api/backup/restore-tests')}>
            {t('backup.restoreTest')}
          </button>
        </div>
      </section>

      <section>
        <h2>{t('backup.restore')}</h2>
        <form
          className="form"
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
          <button className="button" type="submit" disabled={pending}>
            {t('backup.list')}
          </button>
        </form>
        {snapshots && snapshots.length > 0 ? (
          <form
            className="form"
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
                    {snapshot.shortId} · {snapshot.time}
                    {snapshot.scope ? ` · ${snapshot.scope}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <button className="button button-secondary" type="submit" disabled={pending}>
              {t('backup.prepare')}
            </button>
          </form>
        ) : null}
        {plan ? (
          <div>
            <h3>{t('backup.counts')}</h3>
            <p>
              {plan.scope}
              {plan.metadataOnly ? ` · ${t('backup.scopeMetadata')}` : ''}
            </p>
            <ul className="plain-list">
              <li>
                {plan.counts.editions} · {plan.counts.shelves} · {plan.counts.highlights} · {plan.counts.readingPositions}
              </li>
            </ul>
            <h3>{t('backup.replaces')}</h3>
            <ul className="plain-list">
              {plan.replaces.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            {plan.compatible ? null : <p className="alert">{plan.reason || t('backup.incompatible')}</p>}
            <label className="field">
              <input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} />{' '}
              {t('backup.confirm')}
            </label>
            <button className="button" type="button" disabled={pending || !confirm || !plan.compatible} onClick={() => void activate()}>
              {t('backup.activate')}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
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
