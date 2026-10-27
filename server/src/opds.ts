import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { AppDatabase } from './db.js';
import { covers, editions, fileAssets, identifiers } from './schema.js';
import { searchLibrary } from './library.js';

export const OPDS_PAGE_SIZE = 48;
export const OPDS_NAVIGATION_TYPE = 'application/atom+xml;profile=opds-catalog;kind=navigation';
export const OPDS_ACQUISITION_TYPE = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
export const OPDS_SEARCH_TYPE = 'application/opensearchdescription+xml';

const ACQUIRE = 'http://opds-spec.org/acquisition/open-access';
const IMAGE = 'http://opds-spec.org/image';
const THUMB = 'http://opds-spec.org/image/thumbnail';
const SUMMARY_MAX = 4000;

export interface OpdsAsset {
  id: number;
  format: 'epub' | 'pdf';
}

export interface OpdsEntry {
  id: number;
  title: string;
  authors: string[];
  language: string | null;
  updatedAt: string;
  description: string | null;
  publisher: string | null;
  publishedDate: string | null;
  identifiers: Array<{ scheme: string; value: string }>;
  assets: OpdsAsset[];
  coverMediaType: string | null;
}

export interface OpdsPage {
  entries: OpdsEntry[];
  total: number;
}

interface FeedLink {
  rel: string;
  href: string;
  type: string;
}

/** Editions the account can already search, with acquisition files and cover types. */
export function listOpdsEntries(
  db: AppDatabase,
  input: { userId: number; libraryIds: number[]; q: string | null; offset: number },
): OpdsPage {
  if (input.libraryIds.length === 0) return { entries: [], total: 0 };
  const page = searchLibrary(db, {
    userId: input.userId,
    libraryIds: input.libraryIds,
    q: input.q,
    language: null,
    format: null,
    status: null,
    shelfId: null,
    limit: OPDS_PAGE_SIZE,
    offset: input.offset,
  });
  const ids = page.editions.map((edition) => edition.id);
  if (ids.length === 0) return { entries: [], total: page.total };

  const metaRows = db
    .select({
      id: editions.id,
      description: editions.description,
      publisher: editions.publisher,
      publishedDate: editions.publishedDate,
      updatedAt: editions.updatedAt,
    })
    .from(editions)
    .where(inArray(editions.id, ids))
    .all();
  const meta = new Map(metaRows.map((row) => [row.id, row]));

  const identifierRows = db
    .select({ editionId: identifiers.editionId, scheme: identifiers.scheme, value: identifiers.value })
    .from(identifiers)
    .where(inArray(identifiers.editionId, ids))
    .orderBy(asc(identifiers.id))
    .all();
  const identifierMap = new Map<number, Array<{ scheme: string; value: string }>>();
  for (const row of identifierRows) {
    const list = identifierMap.get(row.editionId) ?? [];
    list.push({ scheme: row.scheme, value: row.value });
    identifierMap.set(row.editionId, list);
  }

  const assetRows = db
    .select({
      id: fileAssets.id,
      editionId: fileAssets.editionId,
      format: fileAssets.format,
    })
    .from(fileAssets)
    .where(and(inArray(fileAssets.editionId, ids), isNull(fileAssets.trashedAt), eq(fileAssets.availability, 'present')))
    .orderBy(asc(fileAssets.id))
    .all();
  const assetMap = new Map<number, OpdsAsset[]>();
  for (const row of assetRows) {
    if (row.format !== 'epub' && row.format !== 'pdf') continue;
    const list = assetMap.get(row.editionId) ?? [];
    list.push({ id: row.id, format: row.format });
    assetMap.set(row.editionId, list);
  }

  const coverRows = db
    .select({ editionId: covers.editionId, mediaType: covers.mediaType })
    .from(covers)
    .where(inArray(covers.editionId, ids))
    .orderBy(desc(covers.id))
    .all();
  const coverMap = new Map<number, string>();
  for (const row of coverRows) {
    if (!coverMap.has(row.editionId)) coverMap.set(row.editionId, row.mediaType);
  }

  const entries: OpdsEntry[] = [];
  for (const card of page.editions) {
    const row = meta.get(card.id);
    if (!row) continue;
    entries.push({
      id: card.id,
      title: card.title,
      authors: card.authors,
      language: card.language,
      updatedAt: row.updatedAt,
      description: blankToNull(row.description),
      publisher: blankToNull(row.publisher),
      publishedDate: blankToNull(row.publishedDate),
      identifiers: identifierMap.get(card.id) ?? [],
      assets: assetMap.get(card.id) ?? [],
      coverMediaType: coverMap.get(card.id) ?? null,
    });
  }
  return { entries, total: page.total };
}

export function renderNavigationFeed(input: {
  origin: string;
  updated: string;
  libraries: Array<{ id: number; name: string }>;
}): string {
  const self = abs(input.origin, '/opds/catalog');
  const entries = input.libraries.map((library) =>
    navigationEntry({
      id: `urn:qijuan:library:${library.id}`,
      title: library.name,
      updated: input.updated,
      href: abs(input.origin, `/opds/libraries/${library.id}`),
    }),
  );
  return feedDocument({
    id: 'urn:qijuan:opds:catalog',
    title: 'QiJuan',
    updated: input.updated,
    kind: 'navigation',
    links: [
      { rel: 'self', href: self, type: OPDS_NAVIGATION_TYPE },
      { rel: 'start', href: self, type: OPDS_NAVIGATION_TYPE },
      ...searchLinks(input.origin),
    ],
    entries,
  });
}

export function renderLibraryFeed(input: {
  origin: string;
  updated: string;
  library: { id: number; name: string };
  page: OpdsPage;
  offset: number;
}): string {
  return acquisitionDocument({
    origin: input.origin,
    updated: input.updated,
    id: `urn:qijuan:opds:library:${input.library.id}`,
    title: input.library.name,
    selfPath: libraryPath(input.library.id, input.offset),
    nextPath:
      input.offset + input.page.entries.length < input.page.total
        ? libraryPath(input.library.id, input.offset + OPDS_PAGE_SIZE)
        : null,
    previousPath: input.offset > 0 ? libraryPath(input.library.id, Math.max(0, input.offset - OPDS_PAGE_SIZE)) : null,
    page: input.page,
    offset: input.offset,
  });
}

export function renderSearchFeed(input: {
  origin: string;
  updated: string;
  q: string | null;
  page: OpdsPage;
  offset: number;
}): string {
  const query = input.q ?? '';
  const id = `urn:qijuan:opds:search:${createHash('sha256').update(query).update('\0').update(String(input.offset)).digest('hex')}`;
  return acquisitionDocument({
    origin: input.origin,
    updated: input.updated,
    id,
    title: 'Search',
    selfPath: searchPath(query, input.offset),
    nextPath:
      input.offset + input.page.entries.length < input.page.total
        ? searchPath(query, input.offset + OPDS_PAGE_SIZE)
        : null,
    previousPath: input.offset > 0 ? searchPath(query, Math.max(0, input.offset - OPDS_PAGE_SIZE)) : null,
    page: input.page,
    offset: input.offset,
  });
}

export function renderOpenSearch(origin: string): string {
  const template = abs(origin, '/opds/search?q={searchTerms}');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">',
    '<ShortName>QiJuan</ShortName>',
    '<Description>Search books in the libraries this credential can read.</Description>',
    '<InputEncoding>UTF-8</InputEncoding>',
    '<OutputEncoding>UTF-8</OutputEncoding>',
    `<Url type="${xmlAttr(OPDS_ACQUISITION_TYPE)}" template="${xmlAttr(template)}"/>`,
    '</OpenSearchDescription>',
    '',
  ].join('\n');
}

function acquisitionDocument(input: {
  origin: string;
  updated: string;
  id: string;
  title: string;
  selfPath: string;
  nextPath: string | null;
  previousPath: string | null;
  page: OpdsPage;
  offset: number;
}): string {
  const start = abs(input.origin, '/opds/catalog');
  const links: FeedLink[] = [
    { rel: 'self', href: abs(input.origin, input.selfPath), type: OPDS_ACQUISITION_TYPE },
    { rel: 'start', href: start, type: OPDS_NAVIGATION_TYPE },
    { rel: 'up', href: start, type: OPDS_NAVIGATION_TYPE },
    ...searchLinks(input.origin),
  ];
  if (input.previousPath) links.push({ rel: 'previous', href: abs(input.origin, input.previousPath), type: OPDS_ACQUISITION_TYPE });
  if (input.nextPath) links.push({ rel: 'next', href: abs(input.origin, input.nextPath), type: OPDS_ACQUISITION_TYPE });
  return feedDocument({
    id: input.id,
    title: input.title,
    updated: input.updated,
    kind: 'acquisition',
    links,
    entries: input.page.entries.map((entry) => acquisitionEntry(entry, input.origin, input.updated)),
    opensearch: {
      total: input.page.total,
      startIndex: input.page.total === 0 ? 0 : input.offset + 1,
      perPage: OPDS_PAGE_SIZE,
    },
  });
}

function searchLinks(origin: string): FeedLink[] {
  return [
    { rel: 'search', href: abs(origin, '/opds/search.xml'), type: OPDS_SEARCH_TYPE },
    { rel: 'search', href: abs(origin, '/opds/search?q={searchTerms}'), type: OPDS_ACQUISITION_TYPE },
  ];
}

function navigationEntry(entry: { id: string; title: string; updated: string; href: string }): string {
  return [
    '<entry>',
    `<id>${xmlText(entry.id)}</id>`,
    `<title>${xmlText(entry.title)}</title>`,
    `<updated>${xmlText(entry.updated)}</updated>`,
    linkTag({ rel: 'subsection', href: entry.href, type: OPDS_ACQUISITION_TYPE }),
    '</entry>',
  ].join('\n');
}

function acquisitionEntry(entry: OpdsEntry, origin: string, updated: string): string {
  const lines = [
    '<entry>',
    `<id>urn:qijuan:edition:${entry.id}</id>`,
    `<title>${xmlText(entry.title)}</title>`,
    `<updated>${xmlText(atomDate(entry.updatedAt, updated))}</updated>`,
  ];
  for (const author of entry.authors) lines.push(`<author><name>${xmlText(author)}</name></author>`);
  if (entry.language) lines.push(`<dc:language>${xmlText(entry.language)}</dc:language>`);
  if (entry.publisher) lines.push(`<dc:publisher>${xmlText(entry.publisher)}</dc:publisher>`);
  if (entry.publishedDate) lines.push(`<dc:issued>${xmlText(entry.publishedDate)}</dc:issued>`);
  for (const identifier of entry.identifiers) {
    const text = identifierText(identifier);
    if (text) lines.push(`<dc:identifier>${xmlText(text)}</dc:identifier>`);
  }
  if (entry.description) lines.push(`<summary type="text">${xmlText(entry.description.slice(0, SUMMARY_MAX))}</summary>`);
  if (entry.coverMediaType) {
    const href = abs(origin, `/opds/editions/${entry.id}/cover`);
    lines.push(linkTag({ rel: IMAGE, href, type: entry.coverMediaType }));
    lines.push(linkTag({ rel: THUMB, href, type: entry.coverMediaType }));
  }
  for (const asset of entry.assets) {
    lines.push(
      linkTag({
        rel: ACQUIRE,
        href: abs(origin, `/opds/editions/${entry.id}/assets/${asset.id}`),
        type: asset.format === 'pdf' ? 'application/pdf' : 'application/epub+zip',
      }),
    );
  }
  lines.push('</entry>');
  return lines.join('\n');
}

function feedDocument(input: {
  id: string;
  title: string;
  updated: string;
  kind: 'navigation' | 'acquisition';
  links: FeedLink[];
  entries: string[];
  opensearch?: { total: number; startIndex: number; perPage: number };
}): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">',
    `<id>${xmlText(input.id)}</id>`,
    `<title>${xmlText(input.title)}</title>`,
    `<updated>${xmlText(input.updated)}</updated>`,
    '<author><name>QiJuan</name></author>',
    ...input.links.map(linkTag),
  ];
  if (input.opensearch) {
    lines.push(`<opensearch:totalResults>${input.opensearch.total}</opensearch:totalResults>`);
    lines.push(`<opensearch:startIndex>${input.opensearch.startIndex}</opensearch:startIndex>`);
    lines.push(`<opensearch:itemsPerPage>${input.opensearch.perPage}</opensearch:itemsPerPage>`);
  }
  lines.push(...input.entries, '</feed>', '');
  return lines.join('\n');
}

function linkTag(link: FeedLink): string {
  return `<link rel="${xmlAttr(link.rel)}" href="${xmlAttr(link.href)}" type="${xmlAttr(link.type)}"/>`;
}

function libraryPath(libraryId: number, offset: number): string {
  return offset > 0 ? `/opds/libraries/${libraryId}?offset=${offset}` : `/opds/libraries/${libraryId}`;
}

function searchPath(q: string, offset: number): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (offset > 0) params.set('offset', String(offset));
  const query = params.toString();
  return query ? `/opds/search?${query}` : '/opds/search';
}

function abs(origin: string, path: string): string {
  return origin ? `${origin}${path}` : path;
}

function blankToNull(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function identifierText(identifier: { scheme: string; value: string }): string {
  const scheme = identifier.scheme.trim();
  const value = identifier.value.trim();
  if (!value) return '';
  if (!scheme) return value;
  if (value.toLowerCase().startsWith(`${scheme.toLowerCase()}:`)) return value;
  return `${scheme}:${value}`;
}

function atomDate(value: string, fallback: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ? value : fallback;
}

function xmlText(value: string): string {
  return stripXml(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function xmlAttr(value: string): string {
  return xmlText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function stripXml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}
