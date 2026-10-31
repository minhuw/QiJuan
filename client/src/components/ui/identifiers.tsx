import type { EditionIdentifier } from '../../api';
import { useLocale } from '../../shell';

/** The catalog schemes, in the order the editor offers them. */
export const IDENTIFIER_SCHEMES = ['isbn', 'issn', 'doi', 'oclc', 'lccn', 'olid', 'google_books', 'douban'] as const;

/** The human name of a scheme; an unknown scheme (kept from an older import) shows as stored. */
export function schemeLabel(t: (key: string) => string, scheme: string): string {
  return (IDENTIFIER_SCHEMES as readonly string[]).includes(scheme) ? t(`identifiers.scheme.${scheme}`) : scheme;
}

/** An identifier value in tabular numerals, linked to its page when it has one. */
export function IdentifierValue({ identifier }: { identifier: Pick<EditionIdentifier, 'value' | 'url'> }) {
  if (identifier.url) {
    return (
      <a className="identifier-value num text-link" href={identifier.url} target="_blank" rel="noreferrer">
        {identifier.value}
      </a>
    );
  }
  return <span className="identifier-value num">{identifier.value}</span>;
}

/** The hostname of a source page, for a short link label. */
export function sourceHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** An edition with no catalog identifier: the status-mark grammar with a dotted rule. */
export function UnidentifiedMark() {
  const { t } = useLocale();
  return (
    <span className="status-mark status-mark-unidentified">
      <span className="status-mark-rule" aria-hidden="true" />
      <span className="status-mark-label">{t('identifiers.unidentified')}</span>
    </span>
  );
}
