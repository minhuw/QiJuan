import { cleanIdentifierValue, cleanScheme } from './text.js';

/**
 * Catalog identifier schemes. Each has a normalized form and, where one exists,
 * a canonical page. Other schemes (uuid, other, ...) are stored as given, have
 * no link, and never merge an import into an existing edition.
 */
export const IDENTIFIER_SCHEMES = ['isbn', 'issn', 'doi', 'oclc', 'lccn', 'olid', 'google_books', 'douban'] as const;
export type IdentifierScheme = (typeof IDENTIFIER_SCHEMES)[number];

/** A match on one of these joins a new file to an existing edition. */
export const STRONG_SCHEMES: ReadonlySet<string> = new Set(['isbn', 'issn', 'doi', 'oclc', 'lccn']);
/** Platform record ids. They merge only on the same scheme and value. */
export const PLATFORM_SCHEMES: ReadonlySet<string> = new Set(['olid', 'google_books', 'douban']);

export type IdentifierSource = 'embedded' | 'agent' | 'manual';
export const IDENTIFIER_SOURCES: readonly IdentifierSource[] = ['embedded', 'agent', 'manual'];

export type IdentifierDropReason = 'invalid_scheme' | 'invalid_value' | 'invalid_format' | 'invalid_checksum';

export interface NormalizedIdentifier {
  scheme: string;
  value: string;
}

export type IdentifierResult =
  | { ok: true; scheme: string; value: string }
  | { ok: false; reason: IdentifierDropReason };

const SOURCE_URL_MAX = 2000;

const ALIASES: Record<string, IdentifierScheme> = {
  isbn: 'isbn',
  isbn10: 'isbn',
  isbn13: 'isbn',
  'isbn-10': 'isbn',
  'isbn-13': 'isbn',
  isbn_10: 'isbn',
  isbn_13: 'isbn',
  issn: 'issn',
  eissn: 'issn',
  doi: 'doi',
  oclc: 'oclc',
  oclcnum: 'oclc',
  worldcat: 'oclc',
  lccn: 'lccn',
  olid: 'olid',
  openlibrary: 'olid',
  open_library: 'olid',
  google_books: 'google_books',
  googlebooks: 'google_books',
  'google-books': 'google_books',
  google: 'google_books',
  douban: 'douban',
};

export function isKnownScheme(scheme: string): scheme is IdentifierScheme {
  return (IDENTIFIER_SCHEMES as readonly string[]).includes(scheme);
}

/** True for schemes whose match can merge a new file into an existing edition. */
export function isMergeScheme(scheme: string): boolean {
  return STRONG_SCHEMES.has(scheme) || PLATFORM_SCHEMES.has(scheme);
}

/** Maps a supplied scheme name to its catalog scheme. Unknown names are kept as cleaned. */
export function canonicalScheme(raw: unknown): string | null {
  const scheme = cleanScheme(raw);
  if (!scheme) return null;
  return ALIASES[scheme] ?? scheme;
}

/**
 * Validates and normalizes one identifier. Known schemes must parse and pass
 * their checksum; unknown schemes need only a clean value.
 */
export function normalizeIdentifier(rawScheme: unknown, rawValue: unknown): IdentifierResult {
  const scheme = canonicalScheme(rawScheme);
  if (!scheme) return { ok: false, reason: 'invalid_scheme' };
  const cleaned = cleanIdentifierValue(rawValue);
  if (!cleaned) return { ok: false, reason: 'invalid_value' };
  if (!isKnownScheme(scheme)) return { ok: true, scheme, value: cleaned };
  const normalized = NORMALIZERS[scheme](cleaned);
  if (typeof normalized !== 'string') return { ok: false, reason: normalized.reason };
  return { ok: true, scheme, value: normalized };
}

/**
 * Guesses the scheme of an embedded identifier that came without a usable one
 * (PDF XMP, or an EPUB identifier with no opf:scheme).
 */
export function classifyEmbeddedIdentifier(raw: string, schemeAttr?: string): NormalizedIdentifier {
  const value = raw.trim();
  const lower = value.toLowerCase();
  // A URN names its own scheme, even under a generic opf:scheme such as "uuid".
  if (lower.startsWith('urn:isbn:')) return { scheme: 'isbn', value };
  if (lower.startsWith('urn:issn:')) return { scheme: 'issn', value };
  if (lower.startsWith('urn:doi:')) return { scheme: 'doi', value };
  const attr = schemeAttr?.trim().toLowerCase();
  if (attr && /^[a-z0-9:+._-]{1,40}$/.test(attr)) return { scheme: ALIASES[attr] ?? attr, value };
  if (lower.startsWith('urn:uuid:')) return { scheme: 'uuid', value };
  if (lower.startsWith('isbn:')) return { scheme: 'isbn', value };
  if (lower.startsWith('issn:')) return { scheme: 'issn', value };
  if (lower.startsWith('urn:doi:') || lower.startsWith('doi:') || /^(?:https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\//.test(lower)) {
    return { scheme: 'doi', value };
  }
  if (/^[0-9][0-9\s\u2013\u2014-]{8,16}[0-9xX]$/.test(value) && typeof normalizeIsbn(value) === 'string') {
    return { scheme: 'isbn', value };
  }
  return { scheme: 'other', value };
}

/** ISBN-13 for a valid ISBN-10 or ISBN-13, else null. */
export function toIsbn13(value: string): string | null {
  const result = normalizeIsbn(value);
  return typeof result === 'string' ? result : null;
}

/** The canonical page for an identifier, or null when the scheme has none. */
export function identifierUrl(scheme: string, value: string): string | null {
  const v = encodeURIComponent(value);
  switch (scheme) {
    case 'isbn':
      // ISBN has no resolver. Mainland Chinese ISBNs (978-7) go to Douban, which covers them far better;
      // everything else goes to WorldCat's union catalogue, the closest neutral record page.
      if (value.startsWith('9787')) return `https://book.douban.com/isbn/${v}/`;
      return `https://search.worldcat.org/search?q=bn:${v}`;
    case 'doi':
      return `https://doi.org/${value.split('/').map(encodeURIComponent).join('/')}`;
    case 'issn':
      return `https://portal.issn.org/resource/ISSN/${v}`;
    case 'oclc':
      return `https://www.worldcat.org/oclc/${v}`;
    case 'lccn':
      return `https://lccn.loc.gov/${v}`;
    case 'olid':
      return value.endsWith('W') ? `https://openlibrary.org/works/${v}` : `https://openlibrary.org/books/${v}`;
    case 'google_books':
      return `https://books.google.com/books?id=${v}`;
    case 'douban':
      return `https://book.douban.com/subject/${v}/`;
    default:
      return null;
  }
}

/** The dc:identifier text for feeds: URNs where they exist, otherwise the canonical URL or `scheme:value`. */
export function identifierUrn(scheme: string, value: string): string {
  if (scheme === 'isbn' || scheme === 'issn' || scheme === 'doi') return `urn:${scheme}:${value}`;
  const url = identifierUrl(scheme, value);
  if (url) return url;
  if (value.toLowerCase().startsWith(`${scheme.toLowerCase()}:`)) return value;
  return `${scheme}:${value}`;
}

/** Only an absolute http(s) URL is kept as an identifier's source. */
export function cleanSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > SOURCE_URL_MAX || /[\u0000-\u001f\u007f\s]/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href;
  } catch {
    return null;
  }
}

export interface DroppedIdentifier {
  scheme: string;
  value: string;
  reason: IdentifierDropReason;
}

/**
 * Normalizes a list from embedded metadata or the agent. Invalid values are
 * dropped and returned with a reason; duplicates collapse to the first.
 */
export function normalizeIdentifierList<T extends { scheme: unknown; value: unknown }>(
  items: readonly T[],
): { identifiers: Array<T & NormalizedIdentifier>; dropped: DroppedIdentifier[] } {
  const identifiers: Array<T & NormalizedIdentifier> = [];
  const dropped: DroppedIdentifier[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const result = normalizeIdentifier(item.scheme, item.value);
    if (!result.ok) {
      dropped.push({ scheme: shortText(item.scheme), value: shortText(item.value), reason: result.reason });
      continue;
    }
    const key = identifierKey(result);
    if (seen.has(key)) continue;
    seen.add(key);
    identifiers.push({ ...item, scheme: result.scheme, value: result.value });
  }
  return { identifiers, dropped };
}

/** Comparison key. Values of known schemes are already normalized; others compare case-insensitively. */
export function identifierKey(identifier: NormalizedIdentifier): string {
  const value = isKnownScheme(identifier.scheme) ? identifier.value : identifier.value.toLowerCase();
  return `${identifier.scheme}\0${value}`;
}

function shortText(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 200) : '';
}

type Normalized = string | { reason: IdentifierDropReason };

const NORMALIZERS: Record<IdentifierScheme, (value: string) => Normalized> = {
  isbn: normalizeIsbn,
  issn: normalizeIssn,
  doi: normalizeDoi,
  oclc: normalizeOclc,
  lccn: normalizeLccn,
  olid: normalizeOlid,
  google_books: normalizeGoogleBooks,
  douban: normalizeDouban,
};

/** ISBN-13 digits. ISBN-10 is converted; both checksums are checked. */
function normalizeIsbn(input: string): Normalized {
  const compact = input
    .trim()
    .replace(/^urn:isbn:/i, '')
    .replace(/^isbn(?:-1[03])?:?/i, '')
    .replace(/[\s\u2013\u2014-]/g, '')
    .toUpperCase();
  if (/^\d{9}[\dX]$/.test(compact)) {
    let sum = 0;
    for (let i = 0; i < 10; i += 1) {
      const char = compact[i]!;
      sum += (10 - i) * (char === 'X' ? 10 : Number(char));
    }
    if (sum % 11 !== 0) return { reason: 'invalid_checksum' };
    const body = `978${compact.slice(0, 9)}`;
    return `${body}${isbn13Check(body)}`;
  }
  if (/^97[89]\d{10}$/.test(compact)) {
    if (isbn13Check(compact.slice(0, 12)) !== compact[12]) return { reason: 'invalid_checksum' };
    return compact;
  }
  return { reason: 'invalid_format' };
}

function isbn13Check(body: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

/** `NNNN-NNNC`, with the mod-11 check character. */
function normalizeIssn(input: string): Normalized {
  const compact = input
    .trim()
    .replace(/^urn:issn:/i, '')
    .replace(/^e?issn:?/i, '')
    .replace(/[\s\u2013\u2014-]/g, '')
    .toUpperCase();
  if (!/^\d{7}[\dX]$/.test(compact)) return { reason: 'invalid_format' };
  let sum = 0;
  for (let i = 0; i < 7; i += 1) sum += Number(compact[i]) * (8 - i);
  const check = (11 - (sum % 11)) % 11;
  if ((check === 10 ? 'X' : String(check)) !== compact[7]) return { reason: 'invalid_checksum' };
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/** Lowercase `10.prefix/suffix`, without a resolver URL or `doi:` prefix. */
function normalizeDoi(input: string): Normalized {
  let value = input.trim().replace(/^(?:urn:)?doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  if (value.includes('%')) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return { reason: 'invalid_format' };
    }
  }
  value = value.toLowerCase();
  if (!/^10\.\d{4,9}\/\S+$/.test(value)) return { reason: 'invalid_format' };
  return value;
}

/** Digits without leading zeros; `(OCoLC)`, `ocm`, `ocn`, and `on` prefixes are removed. */
function normalizeOclc(input: string): Normalized {
  const value = input
    .trim()
    .replace(/^\(ocolc\)\s*/i, '')
    .replace(/^oclc:?\s*/i, '')
    .replace(/^(?:ocm|ocn|on)/i, '')
    .trim();
  if (!/^\d{1,12}$/.test(value)) return { reason: 'invalid_format' };
  const stripped = value.replace(/^0+(?=\d)/, '');
  if (stripped === '0') return { reason: 'invalid_value' };
  return stripped;
}

/** The Library of Congress normalization: no spaces, no revision, serial padded to six digits. */
function normalizeLccn(input: string): Normalized {
  let value = input
    .trim()
    .replace(/^https?:\/\/lccn\.loc\.gov\//i, '')
    .replace(/^lccn:?/i, '')
    .replace(/\s+/g, '')
    .toLowerCase();
  const slash = value.indexOf('/');
  if (slash >= 0) value = value.slice(0, slash);
  const hyphen = value.indexOf('-');
  if (hyphen >= 0) {
    const head = value.slice(0, hyphen);
    const serial = value.slice(hyphen + 1);
    if (!/^\d{1,6}$/.test(serial)) return { reason: 'invalid_format' };
    value = `${head}${serial.padStart(6, '0')}`;
  }
  if (!/^[a-z]{0,3}(?:\d{8}|\d{10})$/.test(value)) return { reason: 'invalid_format' };
  return value;
}

/** An Open Library edition (`OL…M`) or work (`OL…W`) key. */
function normalizeOlid(input: string): Normalized {
  const value = input
    .trim()
    .replace(/^https?:\/\/(?:www\.)?openlibrary\.org/i, '')
    .replace(/^\/?(?:books|works)\//i, '')
    .replace(/\/.*$/, '')
    .toUpperCase();
  if (!/^OL[1-9]\d{0,11}[MW]$/.test(value)) return { reason: 'invalid_format' };
  return value;
}

/** A Google Books volume id. Case is significant and kept. */
function normalizeGoogleBooks(input: string): Normalized {
  let value = input.trim();
  const fromUrl = /[?&]id=([A-Za-z0-9_-]+)/.exec(value) ?? /\/books\/edition\/[^/]*\/([A-Za-z0-9_-]+)/.exec(value);
  if (/^https?:\/\//i.test(value)) {
    if (!fromUrl?.[1]) return { reason: 'invalid_format' };
    value = fromUrl[1];
  }
  if (!/^[A-Za-z0-9_-]{8,20}$/.test(value)) return { reason: 'invalid_format' };
  return value;
}

/** A Douban book subject id. */
function normalizeDouban(input: string): Normalized {
  let value = input.trim();
  const fromUrl = /douban\.com\/subject\/(\d+)/i.exec(value);
  if (fromUrl?.[1]) value = fromUrl[1];
  if (!/^[1-9]\d{0,11}$/.test(value)) return { reason: 'invalid_format' };
  return value;
}
