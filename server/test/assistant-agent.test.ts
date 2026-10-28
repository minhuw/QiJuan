import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_MAX_TOOL_CALLS,
  AGENT_MAX_TURNS,
  AGENT_TIMEOUT_MS,
  runMetadataAgent,
  type RunMetadataAgentOptions,
} from '../src/metadata/assistant/agent.js';
import {
  AssistantError,
  type AssistantConfig,
  type AssistantTransport,
} from '../src/metadata/assistant/client.js';
import {
  METADATA_FIELDS,
  PROMPT_FIELDS,
  buildSystemPrompt,
  buildUserMessage,
  type MetadataPromptFields,
} from '../src/metadata/assistant/prompt.js';
import { validateSubmission, type AssistantProposal } from '../src/metadata/assistant/submit.js';
import {
  RECORD_RESULT_CHARS,
  SEARCH_RESULT_CHARS,
  TOOL_DEFINITIONS,
  executeTool,
} from '../src/metadata/assistant/tools.js';
import type { OpenLibraryTransport } from '../src/metadata/openLibrary.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

const config: AssistantConfig = {
  baseUrl: 'https://model.example/v1',
  model: 'scripted-model',
  apiKey: null,
};

const origin = 'https://ol.example';

const fields: MetadataPromptFields = {
  title: 'Embedded Title',
  authors: ['Embedded Author'],
  translators: [],
  description: 'Embedded description',
  publisher: null,
  publishedDate: null,
  language: 'en',
  identifiers: [{ scheme: 'isbn', value: '9780140328721' }],
  series: null,
  seriesOrder: null,
};

const validSubmission = {
  title: 'The Book',
  authors: ['Ada Lovelace'],
  translators: ['Lin Qiao'],
  description: 'A book about a quiet library.',
  publisher: 'Quiet Press',
  publishedDate: '1843',
  language: 'en',
  identifiers: [{ scheme: 'isbn', value: '9780140328721' }],
  series: 'Quiet Library',
  seriesOrder: 2.5,
  coverId: 42,
  isbn: '9780140328721',
};

interface ScriptedReply {
  content?: string | null;
  tool_calls?: Array<{ id?: string; name: string; arguments: string | unknown }>;
}

function assistantTransport(script: (body: Record<string, unknown>, index: number) => ScriptedReply) {
  const bodies: Array<Record<string, unknown>> = [];
  const transport: AssistantTransport = {
    async fetch(_input, init) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const reply = script(body, bodies.length - 1);
      const calls = reply.tool_calls?.map((call, index) => ({
        id: call.id ?? `call_${index + 1}`,
        type: 'function',
        function: {
          name: call.name,
          arguments:
            typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
        },
      }));
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: reply.content ?? null,
              ...(calls && calls.length > 0 ? { tool_calls: calls } : {}),
            },
          },
        ],
      });
    },
  };
  return { transport, bodies };
}

function openLibraryTransport(handler: (url: URL) => unknown) {
  const urls: string[] = [];
  const transport: OpenLibraryTransport = {
    origin,
    async fetch(input) {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      urls.push(url.href);
      return Response.json(handler(url));
    },
  };
  return { transport, urls };
}

function agentOptions(
  transport: AssistantTransport,
  openLibrary: OpenLibraryTransport = { origin },
): RunMetadataAgentOptions {
  return {
    transport,
    openLibrary,
    config,
    input: { filename: 'quiet-book.epub', format: 'epub', fields },
  };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AssistantError);
    return (error as AssistantError).code;
  }
  throw new Error('expected the agent to fail');
}

describe('metadata assistant prompt', () => {
  it('describes the three tools and never adds input fields outside the allowed list', () => {
    expect([...PROMPT_FIELDS]).toEqual([
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
    ]);
    expect(METADATA_FIELDS).toBe(PROMPT_FIELDS);

    const system = buildSystemPrompt();
    for (const name of ['search_open_library', 'get_open_library_record', 'submit_metadata']) {
      expect(system).toContain(name);
    }
    expect(system).toContain('Never send book content');
    expect(system).toContain('Do not invent identifiers');

    const dirtyFields = {
      ...fields,
      text: 'SECRET BOOK TEXT',
      bytes: 'U0VDUkVUIEZJTEUgQllURVM=',
    } as unknown as MetadataPromptFields;
    const message = buildUserMessage({ filename: 'quiet-book.epub', format: 'epub', fields: dirtyFields });
    expect(message).toContain('quiet-book.epub');
    expect(message).toContain('Embedded Title');
    expect(message).not.toContain('SECRET BOOK TEXT');
    expect(message).not.toContain('U0VDUkVUIEZJTEUgQllURVM=');

    const parsed = JSON.parse(message) as {
      filename: string;
      format: string;
      fields: Record<string, unknown>;
    };
    expect(parsed.filename).toBe('quiet-book.epub');
    expect(parsed.format).toBe('epub');
    expect(Object.keys(parsed.fields).sort()).toEqual([...PROMPT_FIELDS].sort());
  });
});

describe('metadata assistant tools', () => {
  it('exposes exactly the three tool definitions', () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.function.name)).toEqual([
      'search_open_library',
      'get_open_library_record',
      'submit_metadata',
    ]);
  });

  it('searches the configured origin with limit 5 and returns compact results', async () => {
    const { transport, urls } = openLibraryTransport(() => ({
      docs: [
        {
          key: '/works/OL1W',
          title: 'Found Title',
          author_name: ['Ada Lovelace'],
          first_publish_year: 1843,
          isbn: ['9780140328721', '0140328726', '0000000000', '1111111111'],
          cover_i: 42,
          edition_key: ['/books/OL2M'],
        },
      ],
    }));
    const text = await executeTool('search_open_library', { title: 'Found' }, { openLibrary: transport });
    const result = JSON.parse(text) as { results: Array<Record<string, unknown>> };
    expect(urls).toEqual([`${origin}/search.json?title=Found&limit=5`]);
    expect(result.results[0]).toEqual({
      key: '/works/OL1W',
      title: 'Found Title',
      author_name: ['Ada Lovelace'],
      first_publish_year: 1843,
      isbn: ['9780140328721', '0140328726', '0000000000'],
      cover_i: 42,
      edition_key: ['/books/OL2M'],
    });
  });

  it('refuses absolute urls and unknown record keys without fetching', async () => {
    const { transport, urls } = openLibraryTransport(() => ({ title: 'never' }));
    for (const key of [
      'https://evil.example/works/OL1W',
      'https://openlibrary.org/isbn/9780140328721',
      'openlibrary.org/isbn/9780140328721',
      'http://ol.example/books/OL1M',
      '/works/OL1X',
      '/books/123M',
      '/authors/OL1A',
      '/works/OL1W?x=1',
    ]) {
      const text = await executeTool('get_open_library_record', { key }, { openLibrary: transport });
      expect(JSON.parse(text)).toMatchObject({ error: 'invalid_arguments' });
    }
    expect(urls).toEqual([]);
  });

  it('fetches work, edition, and ISBN records from the configured origin and compacts them', async () => {
    const { transport, urls } = openLibraryTransport((url) => {
      if (url.pathname.startsWith('/isbn/')) {
        return {
          title: 'ISBN Record',
          publishers: ['Press'],
          publish_date: '1843',
          description: { value: 'From the record.' },
          languages: [{ key: '/languages/eng' }],
          isbn_10: ['0140328726'],
          isbn_13: ['9780140328721'],
          covers: [42, 43],
          contributors: [{ name: 'Lin Qiao', role: 'Translator' }],
          series: ['Quiet Library'],
        };
      }
      return {
        key: url.pathname.replace(/\.json$/, ''),
        title: 'Work Record',
        authors: [{ author: { key: '/authors/OL9A' }, type: { key: '/type/author_role' } }],
        description: 'A work description.',
        first_publish_year: 1843,
      };
    });

    const work = JSON.parse(
      await executeTool('get_open_library_record', { key: '/works/OL123W' }, { openLibrary: transport }),
    ) as Record<string, unknown>;
    expect(work).toMatchObject({ key: '/works/OL123W', title: 'Work Record' });
    expect(work).toMatchObject({ title: 'Work Record', authors: ['/authors/OL9A'], description: 'A work description.' });

    const edition = JSON.parse(
      await executeTool('get_open_library_record', { key: '/books/OL456M' }, { openLibrary: transport }),
    ) as Record<string, unknown>;
    expect(edition).toMatchObject({ key: '/books/OL456M', title: 'Work Record' });

    const byIsbn = JSON.parse(
      await executeTool('get_open_library_record', { key: 'urn:isbn:9780140328721' }, { openLibrary: transport }),
    ) as Record<string, unknown>;
    expect(byIsbn).toMatchObject({
      title: 'ISBN Record',
      publishers: ['Press'],
      publish_date: '1843',
      description: 'From the record.',
      languages: ['eng'],
      isbn_10: ['0140328726'],
      isbn_13: ['9780140328721'],
      covers: [42, 43],
      contributors: [{ name: 'Lin Qiao', role: 'Translator' }],
      series: ['Quiet Library'],
    });
    expect(urls).toEqual([
      `${origin}/works/OL123W.json`,
      `${origin}/books/OL456M.json`,
      `${origin}/isbn/9780140328721.json`,
    ]);
  });

  it('caps a long record as valid JSON and keeps the fields the agent needs', async () => {
    const { transport } = openLibraryTransport(() => ({
      key: '/works/OL1W',
      title: 'Long Record',
      description: 'd'.repeat(30_000),
      publishers: Array.from({ length: 30 }, (_, index) => `Publisher ${index} ${'p'.repeat(300)}`),
      publish_date: '1843',
      languages: [{ key: '/languages/eng' }],
      isbn_13: ['9780140328721'],
    }));

    const record = await executeTool('get_open_library_record', { key: '/works/OL1W' }, { openLibrary: transport });
    expect(record.length).toBeLessThanOrEqual(RECORD_RESULT_CHARS);

    const parsed = JSON.parse(record) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      key: '/works/OL1W',
      title: 'Long Record',
      isbn_13: ['9780140328721'],
      publish_date: '1843',
      languages: ['eng'],
      truncated: true,
    });
    expect(Array.isArray(parsed.publishers)).toBe(true);
    expect((parsed.publishers as string[])[0]).toContain('Publisher 0');
    expect(typeof parsed.description).toBe('string');
    expect((parsed.description as string).length).toBeGreaterThan(0);
    expect((parsed.description as string).length).toBeLessThan(30_000);
  });

  it('caps long search results as valid JSON with a results array', async () => {
    const { transport } = openLibraryTransport(() => ({
      docs: Array.from({ length: 20 }, (_, index) => ({
        key: `/works/OL${index}W`,
        title: `Title ${index} ${'x'.repeat(20_000)}`,
        author_name: [`Author ${index} ${'y'.repeat(20_000)}`],
        isbn: ['9780140328721'],
      })),
    }));

    const search = await executeTool('search_open_library', { author: 'Ada' }, { openLibrary: transport });
    expect(search.length).toBeLessThanOrEqual(SEARCH_RESULT_CHARS);
    const parsed = JSON.parse(search) as { results: Array<Record<string, unknown>>; truncated?: boolean };
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.truncated).toBe(true);
  });

  it('returns submit_metadata as a tool error or the validated proposal', async () => {
    const invalid = JSON.parse(
      await executeTool(
        'submit_metadata',
        { ...validSubmission, title: '', identifiers: [{ scheme: 'isbn', value: 'bad' }] },
        {},
      ),
    ) as { error: string; detail: string };
    expect(invalid.error).toBe('metadata_incomplete');
    expect(invalid.detail).toContain('title');
    expect(invalid.detail).toContain('identifiers');

    const validated = validateSubmission(validSubmission);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const text = await executeTool('submit_metadata', validSubmission, {});
    expect(JSON.parse(text)).toEqual(validated.proposal);
  });

  it('returns not found as a tool error instead of throwing', async () => {
    const transport: OpenLibraryTransport = {
      origin,
      async fetch() {
        return new Response('missing', { status: 404 });
      },
    };
    const text = await executeTool('get_open_library_record', { key: '/works/OL1W' }, { openLibrary: transport });
    expect(JSON.parse(text)).toMatchObject({ error: 'not_found' });
  });
});

describe('metadata submission validation', () => {
  it('cleans and keeps every optional field', () => {
    const result = validateSubmission({
      ...validSubmission,
      title: '  The   Book  ',
      authors: [' Ada Lovelace ', 'ada lovelace'],
      translators: [' Lin Qiao '],
      identifiers: [
        { scheme: 'ISBN', value: 'urn:isbn:9780140328721' },
        { scheme: 'uuid', value: 'urn:uuid:6f1b1c2a-9a0e-4d3b-8c55-1a2b3c4d5e6f' },
      ],
      series: '  Quiet   Library ',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal).toEqual({
      title: 'The Book',
      authors: ['Ada Lovelace'],
      translators: ['Lin Qiao'],
      description: validSubmission.description,
      publisher: validSubmission.publisher,
      publishedDate: validSubmission.publishedDate,
      language: 'en',
      identifiers: [
        { scheme: 'isbn', value: '9780140328721' },
        { scheme: 'uuid', value: 'urn:uuid:6f1b1c2a-9a0e-4d3b-8c55-1a2b3c4d5e6f' },
      ],
      series: 'Quiet Library',
      seriesOrder: 2.5,
      coverId: 42,
      isbn: '9780140328721',
    } satisfies AssistantProposal);
  });

  it('reports every required field by name', () => {
    for (const field of ['title', 'authors', 'language', 'description', 'publisher', 'publishedDate', 'identifiers']) {
      const input = { ...validSubmission } as Record<string, unknown>;
      delete input[field];
      const result = validateSubmission(input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.missing).toContain(field);
    }

    const emptyAuthors = validateSubmission({ ...validSubmission, authors: [] });
    expect(emptyAuthors).toEqual({ ok: false, missing: ['authors'] });
    const emptyIdentifiers = validateSubmission({ ...validSubmission, identifiers: [] });
    expect(emptyIdentifiers).toEqual({ ok: false, missing: ['identifiers'] });
  });

  it('drops invalid ISBNs but allows other identifier schemes', () => {
    const invalidIsbn = validateSubmission({
      ...validSubmission,
      identifiers: [{ scheme: 'isbn', value: 'not-an-isbn' }],
    });
    expect(invalidIsbn).toEqual({ ok: false, missing: ['identifiers'] });

    const other = validateSubmission({
      ...validSubmission,
      isbn: 'not-an-isbn',
      identifiers: [{ scheme: 'oclc', value: '12345' }],
    });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.proposal.identifiers).toEqual([{ scheme: 'oclc', value: '12345' }]);
    expect(other.proposal.isbn).toBeNull();
  });

  it('clamps invalid optional values to null', () => {
    const result = validateSubmission({
      ...validSubmission,
      seriesOrder: Number.POSITIVE_INFINITY,
      coverId: -4,
      series: '   ',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.seriesOrder).toBeNull();
    expect(result.proposal.coverId).toBeNull();
    expect(result.proposal.series).toBeNull();
  });
});

describe('metadata agent loop', () => {
  it('drives search, record, and submit with only the three tools', async () => {
    const { transport, bodies } = assistantTransport((_body, index) => {
      if (index === 0) {
        return { tool_calls: [{ name: 'search_open_library', arguments: { title: 'The Book' } }] };
      }
      if (index === 1) {
        return { tool_calls: [{ name: 'get_open_library_record', arguments: { key: '/works/OL123W' } }] };
      }
      return { tool_calls: [{ name: 'submit_metadata', arguments: validSubmission }] };
    });
    const { transport: openLibrary, urls } = openLibraryTransport((url) =>
      url.pathname === '/search.json'
        ? { docs: [{ key: '/works/OL123W', title: 'The Book' }] }
        : { key: '/works/OL123W', title: 'The Book', description: 'Record description.' },
    );

    const result = await runMetadataAgent(agentOptions(transport, openLibrary));
    expect(result.model).toBe('scripted-model');
    expect(result.turns).toBe(3);
    expect(result.toolCalls).toBe(3);
    expect(result.proposal).toEqual({
      title: 'The Book',
      authors: ['Ada Lovelace'],
      translators: ['Lin Qiao'],
      description: 'A book about a quiet library.',
      publisher: 'Quiet Press',
      publishedDate: '1843',
      language: 'en',
      identifiers: [{ scheme: 'isbn', value: '9780140328721' }],
      series: 'Quiet Library',
      seriesOrder: 2.5,
      coverId: 42,
      isbn: '9780140328721',
    });
    expect(urls).toEqual([`${origin}/search.json?title=The+Book&limit=5`, `${origin}/works/OL123W.json`]);

    const first = bodies[0] as {
      tools: Array<{ function: { name: string } }>;
      tool_choice: string;
      temperature: number;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    expect(first.tools.map((tool) => tool.function.name)).toEqual([
      'search_open_library',
      'get_open_library_record',
      'submit_metadata',
    ]);
    expect(first.tool_choice).toBe('auto');
    expect(first.temperature).toBe(0.2);
    expect(first.stream).toBe(false);
    expect(first.messages[1]?.content).toContain('quiet-book.epub');
    expect(first.messages[1]?.content).not.toContain('SECRET');

    const second = bodies[1] as { messages: Array<Record<string, unknown>> };
    const toolMessage = second.messages.find((message) => message.role === 'tool');
    expect(toolMessage).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(JSON.parse(String(toolMessage?.content))).toMatchObject({
      results: [{ key: '/works/OL123W', title: 'The Book' }],
    });
  });

  it('forwards capped tool results as parseable JSON', async () => {
    const { transport, bodies } = assistantTransport((_body, index) =>
      index === 0
        ? { tool_calls: [{ name: 'search_open_library', arguments: { title: 'Long' } }] }
        : { tool_calls: [{ name: 'submit_metadata', arguments: validSubmission }] },
    );
    const { transport: openLibrary } = openLibraryTransport(() => ({
      docs: Array.from({ length: 20 }, (_, index) => ({
        key: `/works/OL${index}W`,
        title: `Title ${index} ${'x'.repeat(20_000)}`,
        author_name: [`Author ${index} ${'y'.repeat(20_000)}`],
        isbn: ['9780140328721'],
      })),
    }));

    const result = await runMetadataAgent(agentOptions(transport, openLibrary));
    expect(result.proposal.title).toBe('The Book');

    const second = bodies[1] as { messages: Array<Record<string, unknown>> };
    const toolMessage = second.messages.find((message) => message.role === 'tool');
    const content = String(toolMessage?.content);
    expect(content.length).toBeLessThanOrEqual(SEARCH_RESULT_CHARS);
    const parsed = JSON.parse(content) as { results: Array<Record<string, unknown>>; truncated?: boolean };
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.truncated).toBe(true);
  });

  it('accepts a direct submit on the first turn', async () => {
    const { transport } = assistantTransport(() => ({
      tool_calls: [{ name: 'submit_metadata', arguments: validSubmission }],
    }));
    const result = await runMetadataAgent(agentOptions(transport));
    expect(result.turns).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(result.proposal.title).toBe('The Book');
  });

  it('returns an invalid submit as a tool error and accepts the corrected answer', async () => {
    const { transport, bodies } = assistantTransport((_body, index) =>
      index === 0
        ? {
            tool_calls: [
              {
                name: 'submit_metadata',
                arguments: { ...validSubmission, title: '', identifiers: [{ scheme: 'isbn', value: 'bad' }] },
              },
            ],
          }
        : { tool_calls: [{ name: 'submit_metadata', arguments: validSubmission }] },
    );
    const result = await runMetadataAgent(agentOptions(transport));
    expect(result.turns).toBe(2);
    expect(result.toolCalls).toBe(2);

    const second = bodies[1] as { messages: Array<Record<string, unknown>> };
    const toolMessage = second.messages.find((message) => message.role === 'tool');
    const error = JSON.parse(String(toolMessage?.content)) as { error: string; detail: string };
    expect(error.error).toBe('metadata_incomplete');
    expect(error.detail).toContain('title');
    expect(error.detail).toContain('identifiers');
  });

  it('feeds malformed arguments back to the model instead of throwing', async () => {
    const { transport, bodies } = assistantTransport((_body, index) =>
      index === 0
        ? { tool_calls: [{ name: 'search_open_library', arguments: '{not json' }] }
        : { tool_calls: [{ name: 'submit_metadata', arguments: validSubmission }] },
    );
    const result = await runMetadataAgent(agentOptions(transport));
    expect(result.toolCalls).toBe(2);

    const second = bodies[1] as { messages: Array<Record<string, unknown>> };
    const toolMessage = second.messages.find((message) => message.role === 'tool');
    expect(JSON.parse(String(toolMessage?.content))).toMatchObject({ error: 'invalid_arguments' });
  });

  it('truncates oversized tool arguments before asking the model again', async () => {
    let secondBody = '';
    const { transport } = assistantTransport((_body, index) => {
      if (index === 0) {
        return {
          tool_calls: [
            {
              name: 'search_open_library',
              arguments: { title: 'x'.repeat(150_000) },
            },
          ],
        };
      }
      secondBody = JSON.stringify(_body);
      return { tool_calls: [{ name: 'submit_metadata', arguments: validSubmission }] };
    });
    const result = await runMetadataAgent(agentOptions(transport));
    expect(result.proposal.title).toBe('The Book');
    expect(secondBody.length).toBeLessThan(150_000);
    const parsed = JSON.parse(secondBody) as { messages: Array<Record<string, unknown>> };
    const toolMessage = parsed.messages.find((message) => message.role === 'tool');
    expect(JSON.parse(String(toolMessage?.content))).toMatchObject({ error: 'invalid_arguments' });
  });

  it('fails with metadata_incomplete when the model never submits', async () => {
    const { transport } = assistantTransport(() => ({ content: 'I need more time.' }));
    expect(await errorCode(runMetadataAgent(agentOptions(transport)))).toBe('metadata_incomplete');
  });

  it('stops at four model turns', async () => {
    let requests = 0;
    const { transport } = assistantTransport(() => {
      requests += 1;
      return { tool_calls: [{ name: 'search_open_library', arguments: { title: 'The Book' } }] };
    });
    const { transport: openLibrary, urls } = openLibraryTransport(() => ({ docs: [] }));
    expect(await errorCode(runMetadataAgent(agentOptions(transport, openLibrary)))).toBe('metadata_incomplete');
    expect(requests).toBe(AGENT_MAX_TURNS);
    expect(urls).toHaveLength(AGENT_MAX_TURNS);
  });

  it('stops after six tool calls in one response', async () => {
    const { transport } = assistantTransport(() => ({
      tool_calls: Array.from({ length: 7 }, () => ({
        name: 'search_open_library',
        arguments: { title: 'The Book' },
      })),
    }));
    const { transport: openLibrary, urls } = openLibraryTransport(() => ({ docs: [] }));
    expect(await errorCode(runMetadataAgent(agentOptions(transport, openLibrary)))).toBe('metadata_incomplete');
    expect(urls).toHaveLength(AGENT_MAX_TOOL_CALLS);
  });

  it('does not request another model turn after six tool calls', async () => {
    let requests = 0;
    const { transport } = assistantTransport(() => {
      requests += 1;
      return {
        tool_calls: Array.from({ length: 2 }, () => ({
          name: 'search_open_library',
          arguments: { title: 'The Book' },
        })),
      };
    });
    const { transport: openLibrary, urls } = openLibraryTransport(() => ({ docs: [] }));
    expect(await errorCode(runMetadataAgent(agentOptions(transport, openLibrary)))).toBe('metadata_incomplete');
    expect(requests).toBe(3);
    expect(urls).toHaveLength(AGENT_MAX_TOOL_CALLS);
  });

  it('stops when the ninety second budget is exhausted', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const { transport } = assistantTransport(() => {
      clock += AGENT_TIMEOUT_MS + 1;
      return { tool_calls: [{ name: 'search_open_library', arguments: { title: 'The Book' } }] };
    });
    const { transport: openLibrary, urls } = openLibraryTransport(() => ({ docs: [] }));
    expect(await errorCode(runMetadataAgent(agentOptions(transport, openLibrary)))).toBe('metadata_incomplete');
    expect(urls).toEqual([]);
  });

  it('does not leak prompt text into the metadata_incomplete message', async () => {
    const { transport } = assistantTransport(() => ({ content: 'No tools for you.' }));
    try {
      await runMetadataAgent(agentOptions(transport));
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).toContain('metadata_incomplete');
      expect(message).not.toContain('Embedded Title');
      expect(message).not.toContain('quiet-book.epub');
    }
  });
});
