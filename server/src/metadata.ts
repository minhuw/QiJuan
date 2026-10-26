export class BookError extends Error {
  readonly code: 'unsupported' | 'malformed' | 'missing';

  constructor(code: BookError['code']) {
    super(code);
    this.name = 'BookError';
    this.code = code;
  }
}

export interface BookCreator {
  name: string;
  role: 'author' | 'translator';
}

export interface BookIdentifier {
  scheme: string;
  value: string;
}

export interface BookCover {
  bytes: Buffer;
  mediaType: string;
}

export interface BookMetadata {
  title: string | null;
  language: string | null;
  creators: BookCreator[];
  identifiers: BookIdentifier[];
  cover: BookCover | null;
}

export function classifyIdentifier(raw: string, schemeAttr?: string): BookIdentifier {
  const value = raw.trim();
  const attr = schemeAttr?.trim().toLowerCase();
  if (attr && /^[a-z0-9:+._-]{1,40}$/.test(attr)) return { scheme: attr, value };
  const lower = value.toLowerCase();
  if (lower.startsWith('urn:uuid:')) return { scheme: 'uuid', value };
  if (lower.startsWith('urn:isbn:') || lower.startsWith('isbn:')) return { scheme: 'isbn', value };
  return { scheme: 'other', value };
}
