import { sniffImage } from '../metadata.js';

/** Identifies this server to Open Library. No API key is sent. */
export const QIJUAN_USER_AGENT = 'QiJuan/0.0.0 (self-hosted personal ebook library)';

export const OPEN_LIBRARY_ORIGIN = 'https://openlibrary.org';
export const OPEN_LIBRARY_COVERS_ORIGIN = 'https://covers.openlibrary.org';

const COVER_BYTES = 2 * 1024 * 1024;
const JSON_CHARS = 1_000_000;
const DESCRIPTION_MAX = 10_000;

const LANGUAGE_MAP: Record<string, string> = {
  eng: 'en',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  rus: 'ru',
  jpn: 'ja',
  kor: 'ko',
  ara: 'ar',
  chi: 'zh',
  zho: 'zh',
  dut: 'nl',
  nld: 'nl',
  swe: 'sv',
  pol: 'pl',
  ces: 'cs',
  cze: 'cs',
};

export class OpenLibraryError extends Error {
  readonly code = 'metadata_unavailable';

  constructor() {
    super('metadata_unavailable');
    this.name = 'OpenLibraryError';
  }
}

export interface OpenLibraryTransport {
  fetch?: typeof fetch;
  origin?: string;
  coversOrigin?: string;
  userAgent?: string;
}

export interface OpenLibraryQuery {
  title?: string | null;
  author?: string | null;
  isbn?: string | null;
}

export interface OpenLibraryProposal {
  title: string | null;
  authors: string[];
  description: string | null;
  publisher: string | null;
  publishedDate: string | null;
  language: string | null;
  identifiers: Array<{ scheme: string; value: string }>;
  coverId: number | null;
  isbn: string | null;
}

export function buildSearchUrl(
  query: { title?: string | null; author?: string | null; isbn?: string | null },
  origin = OPEN_LIBRARY_ORIGIN,
): URL {
  const url = new URL('/search.json', origin);
  if (query.isbn) url.searchParams.set('isbn', query.isbn);
  if (query.title) url.searchParams.set('title', query.title);
  if (query.author) url.searchParams.set('author', query.author);
  url.searchParams.set('limit', '5');
  return url;
}

export function buildIsbnUrl(isbn: string, origin = OPEN_LIBRARY_ORIGIN): URL {
  return new URL(`/isbn/${encodeURIComponent(isbn)}.json`, origin);
}

export function buildCoverUrl(
  input: { coverId?: number | null; isbn?: string | null },
  origin = OPEN_LIBRARY_COVERS_ORIGIN,
): URL {
  const url = input.coverId
    ? new URL(`/b/id/${input.coverId}-L.jpg`, origin)
    : new URL(`/b/isbn/${encodeURIComponent(input.isbn ?? '')}-L.jpg`, origin);
  url.searchParams.set('default', 'false');
  return url;
}

export function normalizeIsbn(value: string): string | null {
  const stripped = value.trim().toLowerCase().replace(/^urn:isbn:/, '').replace(/^isbn:/, '').replace(/[^0-9x]/g, '');
  if (/^\d{13}$/.test(stripped) || /^\d{9}[\dx]$/.test(stripped)) return stripped.toUpperCase();
  return null;
}

export function preferIsbn(identifiers: Array<{ scheme: string; value: string }>): string | null {
  for (const identifier of identifiers) {
    if (identifier.scheme.toLowerCase() !== 'isbn') continue;
    const isbn = normalizeIsbn(identifier.value);
    if (isbn) return isbn;
  }
  return null;
}

/**
 * Looks up a work through search.json and, when an ISBN is known, the ISBN API.
 * Tests pass `fetch`. The default client is refused for live Open Library hosts under Vitest.
 */
export async function lookupOpenLibrary(
  transport: OpenLibraryTransport,
  query: OpenLibraryQuery,
): Promise<OpenLibraryProposal | null> {
  const isbn = query.isbn ? normalizeIsbn(query.isbn) : null;
  const origin = transport.origin ?? OPEN_LIBRARY_ORIGIN;
  const search = await fetchOpenLibraryJson(
    transport,
    buildSearchUrl({ title: query.title, author: query.author, isbn }, origin),
  );
  const isbnRecord = isbn ? await fetchOpenLibraryJson(transport, buildIsbnUrl(isbn, origin)) : null;
  const proposal = mergeProposal(search, isbnRecord, isbn);
  return proposal && hasSignal(proposal) ? proposal : null;
}

export async function fetchOpenLibraryCover(
  transport: OpenLibraryTransport,
  input: { coverId: number | null; isbn: string | null },
): Promise<{ bytes: Buffer; mediaType: string } | null> {
  const origin = transport.coversOrigin ?? OPEN_LIBRARY_COVERS_ORIGIN;
  const urls: URL[] = [];
  if (input.coverId && input.coverId > 0) urls.push(buildCoverUrl({ coverId: input.coverId }, origin));
  if (input.isbn) urls.push(buildCoverUrl({ isbn: input.isbn }, origin));
  for (const url of urls) {
    const response = await request(transport, url, 'image/*');
    if (response.status === 404) continue;
    if (!response.ok) throw new OpenLibraryError();
    const advertised = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertised) && advertised > COVER_BYTES) continue;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > COVER_BYTES) continue;
    const mediaType = sniffImage(bytes);
    if (!mediaType) continue;
    return { bytes, mediaType };
  }
  return null;
}

export async function fetchOpenLibraryJson(transport: OpenLibraryTransport, url: URL): Promise<unknown | null> {
  const response = await request(transport, url, 'application/json');
  if (response.status === 404) return null;
  if (!response.ok) throw new OpenLibraryError();
  const text = await response.text();
  if (text.length > JSON_CHARS) throw new OpenLibraryError();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OpenLibraryError();
  }
}

async function request(transport: OpenLibraryTransport, url: URL, accept: string): Promise<Response> {
  assertStubbedInTests(transport, url);
  const fetchImpl = transport.fetch ?? globalThis.fetch;
  try {
    return await fetchImpl(url, {
      method: 'GET',
      headers: {
        'user-agent': transport.userAgent ?? QIJUAN_USER_AGENT,
        accept,
      },
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof OpenLibraryError) throw error;
    throw new OpenLibraryError();
  }
}

function assertStubbedInTests(transport: OpenLibraryTransport, url: URL): void {
  if (transport.fetch) return;
  if (!process.env.VITEST) return;
  const host = url.hostname.toLowerCase();
  if (host === 'openlibrary.org' || host.endsWith('.openlibrary.org')) {
    throw new OpenLibraryError();
  }
}

function mergeProposal(search: unknown, isbnRecord: unknown, isbn: string | null): OpenLibraryProposal | null {
  const searchRecord = asRecord(search);
  const docs = Array.isArray(searchRecord?.docs) ? searchRecord.docs : [];
  const doc = pickDoc(docs, isbn);
  const isbnBody = asRecord(isbnRecord);
  if (!doc && !isbnBody) return null;

  const title = cleanShort(asString(isbnBody?.title) ?? asString(doc?.title), 500);
  const authors = cleanAuthors(asStringList(doc?.author_name));
  const description = cleanDescription(asDescription(isbnBody?.description));
  const publisher = cleanShort(
    asStringList(isbnBody?.publishers)[0] ?? asStringList(doc?.publisher)[0] ?? null,
    300,
  );
  const publishedDate = cleanShort(asString(isbnBody?.publish_date) ?? yearString(doc?.first_publish_year), 40);
  const language = mapLanguage(languageFromIsbn(isbnBody?.languages) ?? asStringList(doc?.language)[0] ?? null);
  const coverId = firstCoverId(isbnBody?.covers) ?? firstCoverId(doc?.cover_i);
  const foundIsbn = isbn ?? firstIsbn(asStringList(doc?.isbn));
  return {
    title,
    authors,
    description,
    publisher,
    publishedDate,
    language,
    identifiers: foundIsbn ? [{ scheme: 'isbn', value: foundIsbn }] : [],
    coverId,
    isbn: foundIsbn,
  };
}

function pickDoc(docs: unknown[], isbn: string | null): Record<string, unknown> | null {
  const records = docs.map(asRecord).filter((item): item is Record<string, unknown> => item !== null);
  if (isbn) {
    const match = records.find((doc) => asStringList(doc.isbn).some((item) => normalizeIsbn(item) === isbn));
    if (match) return match;
  }
  return records[0] ?? null;
}

function hasSignal(proposal: OpenLibraryProposal): boolean {
  return Boolean(
    proposal.title ||
      proposal.authors.length > 0 ||
      proposal.description ||
      proposal.publisher ||
      proposal.publishedDate ||
      proposal.language ||
      proposal.identifiers.length > 0 ||
      proposal.coverId ||
      proposal.isbn,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter((item): item is string => item !== null);
}

function asDescription(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  if (!record) return null;
  return asString(record.value);
}

function languageFromIsbn(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const record = asRecord(item);
    const key = record ? asString(record.key) : asString(item);
    if (!key) continue;
    const code = key.split('/').filter(Boolean).pop();
    if (code) return code;
  }
  return null;
}

function firstCoverId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item === 'number' && Number.isInteger(item) && item > 0) return item;
  }
  return null;
}

function firstIsbn(values: string[]): string | null {
  for (const value of values) {
    const isbn = normalizeIsbn(value);
    if (isbn) return isbn;
  }
  return null;
}

function yearString(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return String(value);
}

function mapLanguage(code: string | null): string | null {
  if (!code) return null;
  const lower = code.trim().toLowerCase();
  if (!lower || lower.length > 35 || /[\u0000-\u001f\u007f]/.test(lower)) return null;
  return LANGUAGE_MAP[lower] ?? lower;
}

function cleanAuthors(names: string[]): string[] {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const value = cleanShort(name, 300);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(value);
    if (cleaned.length >= 10) break;
  }
  return cleaned;
}

function cleanDescription(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  return trimmed.length > DESCRIPTION_MAX ? trimmed.slice(0, DESCRIPTION_MAX) : trimmed;
}

function cleanShort(value: string | null, max: number): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}
