import {
  type DroppedIdentifier,
  classifyEmbeddedIdentifier,
  cleanSourceUrl,
  identifierKey,
  normalizeIdentifier,
  toIsbn13,
} from '../../identifiers.js';
import {
  cleanDescription,
  cleanIdentifierValue,
  cleanLanguage,
  cleanName,
  cleanPublishedDate,
  cleanPublisher,
  cleanTitle,
} from '../../text.js';

export interface AssistantIdentifier {
  scheme: string;
  value: string;
  /** Where the model found it, when it said so. */
  sourceUrl?: string | null;
}

/** A cover image the agent found. The server downloads and verifies it before use. */
export interface AssistantCover {
  url: string;
  sourceUrl: string | null;
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
  cover: AssistantCover | null;
}

export type SubmissionResult =
  | { ok: true; proposal: AssistantProposal; dropped: DroppedIdentifier[] }
  | { ok: false; missing: string[] };

const REQUIRED_FIELDS = [
  'title',
  'authors',
  'language',
  'description',
  'publisher',
  'publishedDate',
] as const;

/**
 * Turns the model's submit_metadata arguments into a catalog proposal.
 * Invalid optional values become null; missing required values are reported by name.
 * Identifiers are optional. One that fails its scheme's validation is dropped and
 * listed in `dropped` with the reason.
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
  const { identifiers, dropped } = cleanIdentifiers(record?.identifiers);
  const series = cleanName(record?.series);
  const seriesOrder = cleanSeriesOrder(record?.seriesOrder);
  const coverId = cleanCoverId(record?.coverId);
  const cover = cleanCover(record?.cover);
  const explicitIsbn = typeof record?.isbn === 'string' ? toIsbn13(record.isbn) : null;
  const isbn = explicitIsbn ?? identifiers.find((item) => item.scheme === 'isbn')?.value ?? null;

  const missing: string[] = [];
  if (!title) missing.push('title');
  if (authors.length === 0) missing.push('authors');
  if (!language) missing.push('language');
  if (!description) missing.push('description');
  if (!publisher) missing.push('publisher');
  if (!publishedDate) missing.push('publishedDate');
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
      cover,
    },
    dropped,
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

function cleanIdentifiers(value: unknown): { identifiers: AssistantIdentifier[]; dropped: DroppedIdentifier[] } {
  const identifiers: AssistantIdentifier[] = [];
  const dropped: DroppedIdentifier[] = [];
  if (!Array.isArray(value)) return { identifiers, dropped };
  const seen = new Set<string>();
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const rawValue = cleanIdentifierValue(record.value);
    const shown = typeof record.value === 'string' ? record.value.slice(0, 200) : '';
    const shownScheme = typeof record.scheme === 'string' ? record.scheme.slice(0, 40) : '';
    if (!rawValue) {
      dropped.push({ scheme: shownScheme, value: shown, reason: 'invalid_value' });
      continue;
    }
    const supplied = record.scheme !== undefined && record.scheme !== null && record.scheme !== '';
    const scheme = supplied ? record.scheme : classifyEmbeddedIdentifier(rawValue).scheme;
    const result = normalizeIdentifier(scheme, rawValue);
    if (!result.ok) {
      dropped.push({ scheme: shownScheme, value: shown, reason: result.reason });
      continue;
    }
    const key = identifierKey(result);
    if (seen.has(key)) continue;
    seen.add(key);
    const sourceUrl = cleanSourceUrl(record.sourceUrl);
    identifiers.push(sourceUrl ? { scheme: result.scheme, value: result.value, sourceUrl } : { scheme: result.scheme, value: result.value });
  }
  return { identifiers, dropped };
}

function cleanSeriesOrder(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/** An invalid or unsafe cover URL is dropped; the rest of the submission still counts. */
export function cleanCover(value: unknown): AssistantCover | null {
  const record = asRecord(value);
  if (!record) return null;
  const url = cleanSourceUrl(record.url);
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.username || parsed.password) return null;
  return { url, sourceUrl: cleanSourceUrl(record.sourceUrl) };
}

function cleanCoverId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return null;
  return value;
}
