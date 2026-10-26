import { parseEpub } from './epub.js';
import { BookError, type BookMetadata } from './metadata.js';
import { parsePdf } from './pdf.js';

export function fileKind(filename: string): 'epub' | 'pdf' | 'unsupported' {
  const base = filename.replaceAll('\\', '/').split('/').pop() ?? filename;
  const lower = base.toLowerCase();
  if (lower.endsWith('.epub')) return 'epub';
  if (lower.endsWith('.pdf')) return 'pdf';
  return 'unsupported';
}

/** EPUB and PDF only. Other extensions are unsupported and must not be unpacked. */
export function parseBookFile(filename: string, filePath: string): BookMetadata {
  const kind = fileKind(filename);
  if (kind === 'unsupported') throw new BookError('unsupported');
  if (kind === 'epub') return parseEpub(filePath);
  return parsePdf(filePath);
}
