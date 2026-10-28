import { classifyIdentifier } from '../../metadata.js';
import {
  cleanDescription,
  cleanIdentifierValue,
  cleanLanguage,
  cleanName,
  cleanPublishedDate,
  cleanPublisher,
  cleanScheme,
  cleanTitle,
} from '../../text.js';
import { normalizeIsbn, preferIsbn } from '../openLibrary.js';

export interface AssistantIdentifier {
  scheme: string;
  value: string;
}

export interface AssistantProposal {
  title: string;
  authors: string[];
  translators: string[];
  description: string;
  publisher: string;
  publishedDate: string;
  language: string;
  identifiers: AssistantIdentifier[];
  series: string | null;
  seriesOrder: number | null;
  coverId: number | null;
  isbn: string | null;
}

export type SubmissionResult =
  | { ok: true; proposal: AssistantProposal }
  | { ok: false; missing: string[] };

const REQUIRED_FIELDS = [
  'title',
  'authors',
  'language',
  'description',
  'publisher',
  'publishedDate',
  'identifiers',
] as const;

/**
 * Turns the model's submit_metadata arguments into a catalog proposal.
 * Invalid optional values become null; missing required values are reported by name.
 */
export function validateSubmission(input: unknown, now?: Date): SubmissionResult {
  void now;
  const record = asRecord(input);
  const title = cleanTitle(record?.title);
  const authors = cleanNames(record?.authors);
  const translators = cleanNames(record?.translators);
  const description = cleanDescription(record?.description);
  const publisher = cleanPublisher(record?.publisher);
  const publishedDate = cleanPublishedDate(record?.publishedDate);
  const language = cleanLanguage(record?.language);
  const identifiers = cleanIdentifiers(record?.identifiers);
  const series = cleanName(record?.series);
  const seriesOrder = cleanSeriesOrder(record?.seriesOrder);
  const coverId = cleanCoverId(record?.coverId);
  const explicitIsbn = typeof record?.isbn === 'string' ? normalizeIsbn(record.isbn) : null;
  const isbn = explicitIsbn ?? preferIsbn(identifiers);

  const missing: string[] = [];
  if (!title) missing.push('title');
  if (authors.length === 0) missing.push('authors');
  if (!language) missing.push('language');
  if (!description) missing.push('description');
  if (!publisher) missing.push('publisher');
  if (!publishedDate) missing.push('publishedDate');
  if (identifiers.length === 0) missing.push('identifiers');
  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    proposal: {
      title: title!,
      authors,
      translators,
      description: description!,
      publisher: publisher!,
      publishedDate: publishedDate!,
      language: language!,
      identifiers,
      series,
      seriesOrder,
      coverId,
      isbn,
    },
  };
}

export { REQUIRED_FIELDS };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function cleanNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = cleanName(item);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function cleanIdentifiers(value: unknown): AssistantIdentifier[] {
  if (!Array.isArray(value)) return [];
  const identifiers: AssistantIdentifier[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const rawValue = cleanIdentifierValue(record.value);
    if (!rawValue) continue;

    const suppliedScheme = record.scheme !== undefined && record.scheme !== null;
    const rawScheme = cleanScheme(record.scheme);
    if (suppliedScheme && !rawScheme) continue;
    const classified = classifyIdentifier(rawValue, rawScheme ?? undefined);
    let scheme = rawScheme ?? classified.scheme;
    const normalizedIsbn = normalizeIsbn(rawValue);
    if (!rawScheme && normalizedIsbn) scheme = 'isbn';
    if (scheme.toLowerCase() === 'isbn' && !normalizedIsbn) continue;

    const normalizedScheme = cleanScheme(scheme);
    if (!normalizedScheme) continue;
    const value = normalizedScheme === 'isbn' ? normalizedIsbn! : rawValue;
    const key = `${normalizedScheme}\0${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    identifiers.push({ scheme: normalizedScheme, value });
  }
  return identifiers;
}

function cleanSeriesOrder(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function cleanCoverId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return null;
  return value;
}
