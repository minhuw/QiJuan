/**
 * The only bibliographic fields the metadata assistant may see.
 * Book contents, OCR text, and file bytes are deliberately absent.
 */
export const PROMPT_FIELDS = [
  'title',
  'authors',
  'translators',
  'description',
  'publisher',
  'publishedDate',
  'language',
  'identifiers',
  'series',
  'seriesOrder',
] as const;

export type PromptField = (typeof PROMPT_FIELDS)[number];

/** Alias kept explicit for callers that describe this list as the agent's input. */
export const METADATA_FIELDS = PROMPT_FIELDS;

export interface MetadataPromptFields {
  title: string | null;
  authors: string[];
  translators: string[];
  description: string | null;
  publisher: string | null;
  publishedDate: string | null;
  language: string | null;
  identifiers: Array<{ scheme: string; value: string }>;
  series: string | null;
  seriesOrder: number | null;
}

export interface MetadataPromptInput {
  filename: string;
  format: 'epub' | 'pdf';
  fields: MetadataPromptFields;
}

export function buildSystemPrompt(): string {
  return [
    'You identify books for a personal ebook library and return catalog metadata.',
    'Tools: search_open_library, get_open_library_record, google_books, and submit_metadata; web_search, fetch_page, and page_images are also available when web search is enabled. Use only the tools you were given.',
    'Work identifier first: when the supplied metadata or filename contains an ISBN or another identifier, look it up directly (get_open_library_record or google_books with the ISBN) before searching by title or author.',
    'Open Library often lacks a book, especially Chinese books. Then use web_search to find an authoritative record (publisher pages, national library catalogues, Douban, Google Books) and read the best match with fetch_page. Douban is reached only this way, for example web_search with site:book.douban.com.',
    'Take the official title, authors, publisher, and date from the matched record, not from the filename. The filename is only a hint.',
    'Do not invent identifiers, authors, publishers, dates, or other metadata. If no reliable value can be found, leave optional fields empty.',
    'Write the description in the book\'s language. Series, series order, and translators are optional.',
    'Call submit_metadata exactly once with the final answer. If it reports missing or invalid fields, correct them and submit again. Every submission must include a title, at least one author, language, description, publisher, and published date.',
    'In identifiers, include every identifier you are confident about across all supported schemes (isbn, issn, doi, oclc, lccn, olid, google_books, douban), each with the sourceUrl of the page or record where you found it. Never invent an identifier or guess one from a pattern; an edition may have none.',
    'Cover: when you can, add cover { url, sourceUrl } to submit_metadata with an image of THIS edition. Match the ISBN, publisher, and edition; never use another printing, translation, or volume of the work. Good sources are the publisher\'s page, a Douban subject page (call page_images on the book.douban.com/subject/ page; its og:image is the cover), Google Books imageLinks, and national library catalogues. fetch_page returns no image URLs. Use only an image URL a tool returned, give the page it came from as sourceUrl, and never invent or edit a URL. Omit cover if you are unsure; the server checks the image and an admin confirms it.',
    'Never send book content, extracted text, OCR, or file bytes. Work only from the filename, format, and bibliographic fields supplied in the user message.',
  ].join('\n');
}

export function buildUserMessage(input: MetadataPromptInput): string {
  const fields = (input.fields ?? {}) as unknown as Record<string, unknown>;
  const selected: Record<string, unknown> = {};
  for (const field of PROMPT_FIELDS) selected[field] = selectField(field, fields[field]);
  return JSON.stringify(
    {
      filename: input.filename,
      format: input.format,
      fields: selected,
    },
    null,
    2,
  );
}

function selectField(field: PromptField, value: unknown): unknown {
  if (value === undefined) return null;
  if (field === 'authors' || field === 'translators') {
    if (!Array.isArray(value)) return value;
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (field === 'identifiers') {
    if (!Array.isArray(value)) return value;
    return value.flatMap((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
      const identifier = item as Record<string, unknown>;
      return [{ scheme: identifier.scheme, value: identifier.value }];
    });
  }
  return value;
}
