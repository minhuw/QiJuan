import { ChevronDown } from 'lucide-react';
import { useLocale } from '../shell';
import type { ReaderFlow } from './epub/settings';

export function ReaderFlowSelect({
  value,
  disabled,
  onChange,
}: {
  value: ReaderFlow;
  disabled: boolean;
  onChange: (flow: ReaderFlow) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="reader-flow-select">
      <select
        aria-label={t('reader.mode')}
        title={t('reader.mode')}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = event.currentTarget.value;
          onChange(next === 'continuous' || next === 'spread' ? next : 'paginated');
        }}
      >
        <option value="paginated">{t('reader.paginated')}</option>
        <option value="spread">{t('reader.spread')}</option>
        <option value="continuous">{t('reader.scrolled')}</option>
      </select>
      <ChevronDown size={12} aria-hidden="true" />
    </div>
  );
}
