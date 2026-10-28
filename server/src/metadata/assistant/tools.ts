import {
  OPEN_LIBRARY_ORIGIN,
  buildIsbnUrl,
  buildSearchUrl,
  fetchOpenLibraryJson,
  normalizeIsbn,
  type OpenLibraryTransport,
} from '../openLibrary.js';
import { validateSubmission } from './submit.js';

export const SEARCH_RESULT_CHARS = 8_000;
export const RECORD_RESULT_CHARS = 12_000;

export const TOOL_NAMES = ['search_open_library', 'get_open_library_record', 'submit_metadata'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface MetadataToolDeps {
  /** The Open Library transport, carrying the configured origin. */
  openLibrary?: OpenLibraryTransport;
  /** Compatibility name for callers that pass the Open Library transport as `transport`. */
  transport?: OpenLibraryTransport;
  origin?: string;
  fetch?: typeof fetch;
  coversOrigin?: string;
  userAgent?: string;
}

interface ResolvedDeps {
  transport: OpenLibraryTransport;
  origin: string;
}

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_open_library',
      description:
        'Search Open Library by title, author, or ISBN. Supply at least one of title, author, or isbn.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Book title' },
          author: { type: 'string', description: 'Author name' },
          isbn: { type: 'string', description: 'ISBN-10 or ISBN-13, if known' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_open_library_record',
      description:
        'Read one Open Library work, edition, or ISBN record. The key must be /works/OL<digits>W, /books/OL<digits>M, or an ISBN.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'An Open Library work key, edition key, or ISBN-10/ISBN-13.',
          },
        },
        required: ['key'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_metadata',
      description: 'Submit the final book metadata. Call this exactly once with a complete answer.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          authors: { type: 'array', minItems: 1, items: { type: 'string' } },
          translators: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          publisher: { type: 'string' },
          publishedDate: { type: 'string' },
          language: { type: 'string' },
          identifiers: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                scheme: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['scheme', 'value'],
              additionalProperties: false,
            },
          },
          series: { type: ['string', 'null'] },
          seriesOrder: { type: ['number', 'null'] },
          coverId: { type: ['integer', 'null'] },
          isbn: { type: ['string', 'null'] },
        },
        required: ['title', 'authors', 'language', 'description', 'publisher', 'publishedDate', 'identifiers'],
        additionalProperties: false,
      },
    },
  },
] as const;

/** Aliases for callers that simply call the OpenAI-compatible tool list `tools`. */
export const AGENT_TOOLS = TOOL_DEFINITIONS;
export const TOOLS = TOOL_DEFINITIONS;

/**
 * Executes one of the three fixed Open Library operations.
 * Success and failure are both returned as JSON text for the model; this function never throws.
 */
export async function executeTool(name: string, args: unknown, deps: MetadataToolDeps): Promise<string> {
  try {
    const input = typeof args === 'string' ? parseArguments(args) : args;
    const record = asRecord(input);
    if (!record) return errorText('invalid_arguments', 'tool arguments must be a JSON object');

    if (name === 'search_open_library') return await search(record, resolveDeps(deps));
    if (name === 'get_open_library_record') return await getRecord(record, resolveDeps(deps));
    if (name === 'submit_metadata') {
      const submission = validateSubmission(record);
      if (!submission.ok) {
        return errorText('metadata_incomplete', `missing or invalid fields: ${submission.missing.join(', ')}`);
      }
      return JSON.stringify(submission.proposal);
    }
    return errorText('unknown_tool', 'the only tools are search_open_library, get_open_library_record, and submit_metadata');
  } catch (error) {
    return errorText('metadata_unavailable', error instanceof Error ? error.message : 'Open Library request failed');
  }
}

async function search(args: Record<string, unknown>, deps: ResolvedDeps): Promise<string> {
  const title = cleanArgument(args.title, 500);
  const author = cleanArgument(args.author, 300);
  const rawIsbn = cleanArgument(args.isbn, 50);
  const isbn = rawIsbn ? normalizeIsbn(rawIsbn) ?? rawIsbn : null;
  if (!title && !author && !isbn) {
    return errorText('invalid_arguments', 'supply at least one non-empty title, author, or isbn');
  }

  const url = buildSearchUrl({ title, author, isbn }, deps.origin);
  const body = await fetchOpenLibraryJson(deps.transport, url);
  if (body === null) return JSON.stringify({ results: [] });
  const root = asRecord(body);
  const docs = Array.isArray(root?.docs) ? root.docs : [];
  const results = docs
    .map(asRecord)
    .filter((doc): doc is Record<string, unknown> => doc !== null)
    .slice(0, 5)
    .map(compactSearchResult);
  return capSearchResults(results, SEARCH_RESULT_CHARS);
}

async function getRecord(args: Record<string, unknown>, deps: ResolvedDeps): Promise<string> {
  const key = cleanArgument(args.key, 200);
  if (!key) return errorText('invalid_arguments', 'key must be a work key, edition key, or ISBN');

  let url: URL;
  if (/^\/works\/OL\d+W$/.test(key) || /^\/books\/OL\d+M$/.test(key)) {
    url = new URL(`${key}.json`, deps.origin);
  } else {
    // Only an ISBN token is allowed here; URLs and paths never get normalized into one.
    if (!/^(?:urn:isbn:|isbn:)?[0-9xX][0-9xX\s-]*$/i.test(key)) {
      return errorText(
        'invalid_arguments',
        'key must be /works/OL<digits>W, /books/OL<digits>M, or a normalized ISBN-10/ISBN-13',
      );
    }
    const isbn = normalizeIsbn(key);
    if (!isbn) {
      return errorText(
        'invalid_arguments',
        'key must be /works/OL<digits>W, /books/OL<digits>M, or a normalized ISBN-10/ISBN-13',
      );
    }
    url = buildIsbnUrl(isbn, deps.origin);
  }

  const body = await fetchOpenLibraryJson(deps.transport, url);
  if (body === null) return errorText('not_found', 'Open Library record not found');
  const record = asRecord(body);
  if (!record) return errorText('metadata_unavailable', 'Open Library returned an invalid record');
  return capRecordJson(compactRecord(record), RECORD_RESULT_CHARS);
}

function resolveDeps(deps: MetadataToolDeps): ResolvedDeps {
  const supplied = deps.openLibrary ?? deps.transport ?? deps;
  const transport: OpenLibraryTransport = {
    ...supplied,
    fetch: supplied.fetch ?? deps.fetch,
    coversOrigin: supplied.coversOrigin ?? deps.coversOrigin,
    userAgent: supplied.userAgent ?? deps.userAgent,
  };
  return {
    transport,
    origin: deps.origin ?? supplied.origin ?? OPEN_LIBRARY_ORIGIN,
  };
}

function compactSearchResult(doc: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const key = asString(doc.key);
  const title = asString(doc.title);
  const authors = asStringList(doc.author_name);
  const firstYear = doc.first_publish_year;
  const isbn = asStringList(doc.isbn).slice(0, 3);
  const cover = positiveInteger(doc.cover_i);
  const editionKeys = asStringList(doc.edition_key);
  if (key) result.key = key;
  if (title) result.title = title;
  if (authors.length > 0) result.author_name = authors;
  if (typeof firstYear === 'number' && Number.isInteger(firstYear)) result.first_publish_year = firstYear;
  if (isbn.length > 0) result.isbn = isbn;
  if (cover !== null) result.cover_i = cover;
  if (editionKeys.length > 0) result.edition_key = editionKeys;
  return result;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  const key = asString(record.key);
  const title = asString(record.title);
  const authors = compactAuthors(record.authors);
  const description = asDescription(record.description);
  const publishers = asStringList(record.publishers).slice(0, 5);
  const publishDate =
    asString(record.publish_date) ?? asString(record.first_publish_date) ?? yearString(record.first_publish_year);
  const languages = compactLanguages(record.languages ?? record.language);
  const isbn10 = compactIsbns(record.isbn_10);
  const isbn13 = compactIsbns(record.isbn_13);
  const covers = compactCovers(record.covers);
  const contributors = compactContributors(record.contributors);
  const series = asStringList(record.series).slice(0, 3);

  if (key) compact.key = key;
  if (title) compact.title = title;
  if (authors.length > 0) compact.authors = authors;
  if (description) compact.description = description;
  if (publishers.length > 0) compact.publishers = publishers;
  if (publishDate) compact.publish_date = publishDate;
  if (languages.length > 0) compact.languages = languages;
  if (isbn10.length > 0) compact.isbn_10 = isbn10;
  if (isbn13.length > 0) compact.isbn_13 = isbn13;
  if (covers.length > 0) compact.covers = covers;
  if (contributors.length > 0) compact.contributors = contributors;
  if (series.length > 0) compact.series = series;
  return compact;
}

function compactAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const authors: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const name = asString(item);
      if (name) authors.push(name);
      continue;
    }
    const record = asRecord(item);
    if (!record) continue;
    const author = asRecord(record.author);
    const name =
      asString(record.name) ??
      asString(author?.name) ??
      asString(author?.key) ??
      asString(record.key);
    if (name) authors.push(name);
    if (authors.length >= 10) break;
  }
  return authors;
}

function compactLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const languages: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const raw = record ? asString(record.key) ?? asString(record.name) : asString(item);
    if (!raw) continue;
    const code = raw.split('/').filter(Boolean).pop() ?? raw;
    if (code) languages.push(code);
    if (languages.length >= 5) break;
  }
  return languages;
}

function compactIsbns(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const isbns: string[] = [];
  for (const item of values) {
    const normalized = typeof item === 'string' ? normalizeIsbn(item) : null;
    if (normalized) isbns.push(normalized);
    if (isbns.length >= 3) break;
  }
  return isbns;
}

function compactCovers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const covers: number[] = [];
  for (const item of value) {
    const id = positiveInteger(item);
    if (id !== null) covers.push(id);
    if (covers.length >= 3) break;
  }
  return covers;
}

function compactContributors(value: unknown): Array<{ name: string; role: string | null }> {
  if (!Array.isArray(value)) return [];
  const contributors: Array<{ name: string; role: string | null }> = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const name = asString(record.name);
    if (!name) continue;
    contributors.push({ name, role: asString(record.role) });
    if (contributors.length >= 10) break;
  }
  return contributors;
}

function asDescription(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  return record ? asString(record.value) : null;
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
  if (typeof value === 'string') {
    const item = asString(value);
    return item ? [item] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter((item): item is string => item !== null);
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

function yearString(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return String(value);
}

function cleanArgument(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

interface StringTarget {
  value: string;
  set: (next: string) => void;
}

/**
 * Caps a record as JSON rather than as raw text: the description is shortened first,
 * then optional arrays are trimmed, then long strings are shortened. The key, title,
 * ISBNs, publishers, publish date, and languages stay present (and are shortened last).
 */
function capRecordJson(record: Record<string, unknown>, max: number): string {
  if (jsonLength(record) <= max) return JSON.stringify(record);

  const candidate: Record<string, unknown> = { ...record, truncated: true };

  if (typeof candidate.description === 'string') {
    const description = shortenStringField(candidate, 'description', max);
    if (description.length === 0) delete candidate.description;
  }
  if (jsonLength(candidate) <= max) return JSON.stringify(candidate);

  for (const key of ['contributors', 'series', 'covers', 'isbn_10']) {
    const value = candidate[key];
    if (Array.isArray(value)) {
      while (value.length > 1 && jsonLength(candidate) > max) value.pop();
    }
    if (key in candidate && jsonLength(candidate) > max) delete candidate[key];
    if (jsonLength(candidate) <= max) return JSON.stringify(candidate);
  }

  while (jsonLength(candidate) > max && shrinkLongestString(candidate, max, false)) {
    // Shorten the longest non-key string one field at a time.
  }
  while (jsonLength(candidate) > max && shrinkLongestString(candidate, max, true)) {
    // A pathologically long key is the last thing to shorten.
  }

  if (jsonLength(candidate) > max) return JSON.stringify({ truncated: true });
  return JSON.stringify(candidate);
}

/** Keeps search output a valid, bounded `{ results: [...] }` object. */
function capSearchResults(results: Array<Record<string, unknown>>, max: number): string {
  const output: Record<string, unknown> = { results };
  if (jsonLength(output) <= max) return JSON.stringify(output);

  output.truncated = true;
  const cappedResults = output.results as Array<Record<string, unknown>>;
  while (cappedResults.length > 1 && jsonLength(output) > max) cappedResults.pop();
  while (jsonLength(output) > max && shrinkLongestString(output, max, true)) {
    // Shorten strings in the remaining results before dropping the last one.
  }
  if (jsonLength(output) > max) output.results = [];
  if (jsonLength(output) > max) return JSON.stringify({ results: [], truncated: true });
  return JSON.stringify(output);
}

function shortenStringField(object: Record<string, unknown>, key: string, max: number): string {
  const original = object[key];
  if (typeof original !== 'string') return '';

  let low = 0;
  let high = original.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    object[key] = original.slice(0, middle);
    if (jsonLength(object) <= max) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  object[key] = original.slice(0, best);
  return object[key] as string;
}

function shrinkLongestString(root: Record<string, unknown>, max: number, includeKey: boolean): boolean {
  const found: { target: StringTarget | null } = { target: null };
  const visit = (value: unknown, key: string | undefined, assign: ((next: string) => void) | null): void => {
    if (typeof value === 'string') {
      if (!includeKey && key === 'key') return;
      if (assign && (!found.target || value.length > found.target.value.length)) {
        found.target = { value, set: assign };
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        visit(item, key, (next) => {
          value[index] = next;
        });
      });
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    for (const [childKey, child] of Object.entries(record)) {
      visit(child, childKey, (next) => {
        record[childKey] = next;
      });
    }
  };
  visit(root, undefined, null);

  const target = found.target;
  if (!target || target.value.length === 0) return false;

  const original = target.value;
  let low = 0;
  let high = original.length - 1;
  let best = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    target.set(original.slice(0, middle));
    if (jsonLength(root) <= max) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  target.set(original.slice(0, Math.max(best, 0)));
  return true;
}

function jsonLength(value: unknown): number {
  return JSON.stringify(value).length;
}

function errorText(error: string, detail: string): string {
  return JSON.stringify({ error, detail });
}
