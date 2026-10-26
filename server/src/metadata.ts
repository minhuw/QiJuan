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
  description: string | null;
  publisher: string | null;
}

export function sniffImage(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
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
