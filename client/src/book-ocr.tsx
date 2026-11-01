import { useEffect, useId, useState, type ReactNode } from 'react';
import { Loader2, ScanText } from 'lucide-react';
import { api, type AssetOcr, type EditionAsset, type EditionDetail } from './api';
import { ConfirmDialog } from './components/ui/confirm-dialog';
import { useLocale } from './shell';

const POLL_MS = 4000;

/** Whether this server can run OCR, asked once per page load and shared by every file row. */
let availability: Promise<boolean> | null = null;
function ocrAvailable(): Promise<boolean> {
  availability ??= api<{ available: boolean }>('/api/ocr').then((result) => result.data?.available === true);
  return availability;
}

/** Test hook: forget the cached answer. */
export function resetOcrAvailability() {
  availability = null;
}

function elapsed(locale: string, from: string | null): string | null {
  if (!from) return null;
  const minutes = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 60_000));
  return new Intl.NumberFormat(locale).format(minutes);
}

/**
 * Text recognition of one PDF in the Files list. Readers see whether a recognized copy is in use;
 * admins can start, follow, cancel, retry and remove it. The original file is never changed.
 */
export function PdfOcrControl({
  editionId,
  asset,
  admin,
  onEdition,
}: {
  editionId: number;
  asset: EditionAsset;
  admin: boolean;
  onEdition: (edition: EditionDetail) => void;
}) {
  const { t, locale } = useLocale();
  const baseId = useId();
  const ocr = asset.ocr ?? null;
  const active = ocr?.status === 'queued' || ocr?.status === 'running';
  const [available, setAvailable] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!admin) return;
    let alive = true;
    void ocrAvailable().then((value) => {
      if (alive) setAvailable(value);
    });
    return () => {
      alive = false;
    };
  }, [admin]);

  // Follow a queued or running recognition until it finishes.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void api<{ edition: EditionDetail }>(`/api/editions/${editionId}`).then((result) => {
        if (result.data?.edition) onEdition(result.data.edition);
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, editionId, onEdition]);

  async function change(method: 'POST' | 'DELETE'): Promise<boolean> {
    setPending(true);
    setError(null);
    const result = await api(`/api/editions/${editionId}/assets/${asset.id}/ocr`, { method });
    if (result.error) {
      setPending(false);
      setError(result.error === 'ocr_unavailable' ? t('book.ocr.unavailable') : t('book.ocr.actionFailed'));
      return false;
    }
    const reloaded = await api<{ edition: EditionDetail }>(`/api/editions/${editionId}`);
    setPending(false);
    if (reloaded.data?.edition) onEdition(reloaded.data.edition);
    return true;
  }

  if (asset.format !== 'pdf') return null;
  if (!admin) {
    return ocr?.ready ? (
      <span className="format-ocr">
        <ScanText size={13} strokeWidth={1.5} aria-hidden="true" />
        {t('book.ocr.ready')}
      </span>
    ) : null;
  }

  const removeId = `${baseId}-remove`;
  let state: ReactNode;
  if (active) {
    const minutes = ocr?.status === 'running' ? elapsed(locale, ocr.startedAt) : null;
    state = (
      <span className="format-ocr-state" role="status">
        <Loader2 className="spin" size={13} strokeWidth={1.5} aria-hidden="true" />
        {ocr?.status === 'queued' ? t('book.ocr.queued') : t('book.ocr.running').replace('{minutes}', minutes ?? '0')}
      </span>
    );
  } else if (ocr?.status === 'failed') {
    state = <span className="format-ocr-state format-ocr-failed">{t(ocr.error === 'file_missing' ? 'book.ocr.fileMissing' : 'book.ocr.failed')}</span>;
  } else if (ocr?.ready) {
    state = (
      <span className="format-ocr-state">
        <ScanText size={13} strokeWidth={1.5} aria-hidden="true" />
        {t('book.ocr.ready')}
      </span>
    );
  } else {
    state = null;
  }

  const canStart = available === true && !active && !pending && asset.availability === 'present';
  return (
    <span className="format-ocr">
      {state}
      {!active && !ocr?.ready ? (
        <button
          type="button"
          className="btn btn-sm"
          disabled={!canStart}
          title={available === false ? t('book.ocr.unavailable') : t('book.ocr.hint')}
          onClick={() => void change('POST')}
        >
          <ScanText size={14} strokeWidth={1.5} aria-hidden="true" />
          {ocr?.status === 'failed' ? t('book.ocr.retry') : t('book.ocr.start')}
        </button>
      ) : null}
      {active ? (
        <button type="button" className="link-button" disabled={pending} onClick={() => void change('DELETE')}>
          {t('book.ocr.cancel')}
        </button>
      ) : null}
      {ocr && !active && (ocr.ready || ocr.status === 'failed') ? (
        <button
          type="button"
          id={removeId}
          className="link-button"
          aria-haspopup="dialog"
          disabled={pending}
          onClick={() => setConfirming(true)}
        >
          {t('book.ocr.remove')}
        </button>
      ) : null}
      {available === false && !ocr ? <span className="format-ocr-note">{t('book.ocr.unavailable')}</span> : null}
      {error && !confirming ? (
        <span className="format-ocr-failed" role="alert">
          {error}
        </span>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title={t('book.ocr.removeTitle')}
          text={t('book.ocr.removeConfirm')}
          action={t('book.ocr.remove')}
          cancel={t('trash.cancel')}
          pending={pending}
          error={error}
          dismissOnBackdrop
          returnFocusId={removeId}
          onConfirm={() => {
            void change('DELETE').then((ok) => {
              if (ok) setConfirming(false);
            });
          }}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </span>
  );
}

/**
 * The reader's shortcut to OCR, shown to admins next to the "scan" notices: start recognition
 * without going back to the Files tab. Renders nothing when OCR cannot run here.
 */
export function ReaderOcrAction({ editionId, assetId, initial }: { editionId: number; assetId: number; initial: AssetOcr | null }) {
  const { t } = useLocale();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [status, setStatus] = useState<AssetOcr['status'] | null>(initial?.status ?? null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void ocrAvailable().then((value) => {
      if (alive) setAvailable(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!available) return null;
  if (status === 'queued' || status === 'running') {
    return <span className="reader-ocr-note">{t('book.ocr.readerRunning')}</span>;
  }
  return (
    <>
      <button
        type="button"
        className="link-button"
        disabled={pending}
        title={t('book.ocr.hint')}
        onClick={() => {
          setPending(true);
          setFailed(false);
          void api(`/api/editions/${editionId}/assets/${assetId}/ocr`, { method: 'POST' }).then((result) => {
            setPending(false);
            if (result.error) setFailed(true);
            else setStatus('queued');
          });
        }}
      >
        {t('book.ocr.start')}
      </button>
      {failed ? <span className="format-ocr-failed" role="alert">{t('book.ocr.actionFailed')}</span> : null}
    </>
  );
}
