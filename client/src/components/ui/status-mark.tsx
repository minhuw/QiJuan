import type { ReactNode } from 'react';
import type { ReadingStatus } from '../../api';
import { useLocale } from '../../shell';

/** Reading status as small caps with a leading rule whose form carries the state. */
export function StatusMark({ status }: { status: ReadingStatus }) {
  const { t } = useLocale();
  return (
    <span className={`status-mark status-mark-${status}`}>
      <span className="status-mark-rule" aria-hidden="true" />
      <span className="status-mark-label">{t(`reading.${status}`)}</span>
    </span>
  );
}

/** Job and configuration state as small caps; colour is reserved for success, warning and failure. */
export function StateTag({
  tone,
  children,
}: {
  tone: 'success' | 'warning' | 'error' | 'quiet';
  children: ReactNode;
}) {
  return <span className={`state-tag state-tag-${tone}`}>{children}</span>;
}

export function jobTone(status: string): 'success' | 'warning' | 'error' | 'quiet' {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'running' || status === 'duplicate') return 'warning';
  return 'quiet';
}
