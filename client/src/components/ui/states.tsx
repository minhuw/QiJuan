import type { ReactNode } from 'react';
import { AlertCircle, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { useLocale } from '../../shell';

export function LoadingState({ label }: { label?: string }) {
  const { t } = useLocale();
  return (
    <div className="state-block" role="status">
      <Loader2 className="spin" size={22} aria-hidden="true" />
      <p>{label ?? t('status.loading')}</p>
    </div>
  );
}

export function SkeletonGrid({ label, count = 8 }: { label?: string; count?: number }) {
  const { t } = useLocale();
  return (
    <div className="skeleton-wrap">
      <span className="visually-hidden" role="status">
        {label ?? t('status.loading')}
      </span>
      <div className="skeleton-grid" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <div className="skeleton-card" key={index}>
            <div className="skeleton skeleton-cover" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line skeleton-line-short" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ErrorNotice({
  message,
  onRetry,
  retryLabel,
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  const { t } = useLocale();
  return (
    <div className="alert alert-error" role="alert">
      <AlertCircle size={18} aria-hidden="true" />
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" />
          {retryLabel ?? t('status.retry')}
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'empty-state empty-state-compact' : 'empty-state'}>
      <span className="empty-state-icon" aria-hidden="true">
        {icon ?? <Inbox size={22} />}
      </span>
      <p className="empty-state-title">{title}</p>
      {description ? <p className="empty-state-description">{description}</p> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}
