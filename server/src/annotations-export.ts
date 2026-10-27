import { and, asc, eq } from 'drizzle-orm';
import type { AppDatabase } from './db.js';
import { loadIdentifiers, loadNames } from './edition-fields.js';
import { requireLiveEdition } from './editions.js';
import { highlights, notes } from './schema.js';

export interface AnnotationExport {
  book: {
    id: number;
    title: string;
    authors: string[];
    identifiers: Array<{ scheme: string; value: string }>;
  };
  highlights: Array<{ text: string; locator: string }>;
  notes: Array<{ text: string; locator: string | null }>;
}

/** Highlights and notes belonging to this user, with the edition's title, authors, and identifiers. */
export function exportAnnotations(db: AppDatabase, userId: number, editionId: number): AnnotationExport {
  const edition = requireLiveEdition(db, editionId);
  const highlightRows = db
    .select({ quote: highlights.quote, locator: highlights.locator })
    .from(highlights)
    .where(and(eq(highlights.userId, userId), eq(highlights.editionId, editionId)))
    .orderBy(asc(highlights.createdAt), asc(highlights.id))
    .all();
  const noteRows = db
    .select({ body: notes.body, locator: notes.locator })
    .from(notes)
    .where(and(eq(notes.userId, userId), eq(notes.editionId, editionId)))
    .orderBy(asc(notes.createdAt), asc(notes.id))
    .all();
  return {
    book: {
      id: edition.id,
      title: edition.title,
      authors: loadNames(db, edition.id, 'author'),
      identifiers: loadIdentifiers(db, edition.id),
    },
    highlights: highlightRows.map((row) => ({ text: row.quote ?? '', locator: row.locator })),
    notes: noteRows.map((row) => ({ text: row.body, locator: row.locator })),
  };
}

/** Obsidian-friendly Markdown: front matter, the book heading, then one section per highlight or note. */
export function annotationsMarkdown(document: AnnotationExport): string {
  const lines: string[] = ['---', `title: ${yamlString(document.book.title)}`, 'authors:'];
  if (document.book.authors.length === 0) lines.push('  []');
  else for (const author of document.book.authors) lines.push(`  - ${yamlString(author)}`);
  lines.push('---', '', `# ${singleLine(document.book.title)}`, '');
  if (document.book.authors.length > 0) {
    lines.push(`Authors: ${document.book.authors.join(', ')}`, '');
  }
  for (const highlight of document.highlights) {
    lines.push('## Highlight', '', highlight.text, '', `Location: ${highlight.locator}`, '');
  }
  for (const note of document.notes) {
    lines.push('## Note', '', note.text, '');
    if (note.locator) lines.push(`Location: ${note.locator}`, '');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function singleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}
