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
    'Use the available tools when you need information: search_open_library, get_open_library_record, and submit_metadata.',
    'Do not invent identifiers, authors, publishers, dates, or other metadata. Prefer an ISBN found in the supplied file metadata or in an Open Library record. If no reliable value can be found, leave optional fields empty.',
    'Write the description in the book\'s language. Series, series order, and translators are optional.',
    'Call submit_metadata exactly once with the final answer. If it reports missing or invalid fields, correct them and submit again. Every submission must include a title, at least one author, language, description, publisher, published date, and at least one identifier.',
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
