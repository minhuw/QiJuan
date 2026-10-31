import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  MAX_MODEL_TURNS,
  MAX_TOOL_CALLS,
  TOTAL_BUDGET_MS,
  runMetadataAgent,
  type AgentStep,
} from '../src/metadata/assistant/agent.js';
import {
  REQUEST_TIMEOUT_MS,
  type AssistantConfig,
  type AssistantTransport,
  type WebTransport,
} from '../src/metadata/assistant/client.js';
import { buildSystemPrompt } from '../src/metadata/assistant/prompt.js';
import { validateSubmission } from '../src/metadata/assistant/submit.js';
import { agentToolDefinitions } from '../src/metadata/assistant/tools.js';
import {
  FETCH_PAGE_RESULT_CHARS,
  MAX_WEB_SEARCHES,
  SEARCH_MAX_RESULTS,
  executeWebTool,
  newWebToolState,
  validateFetchUrl,
  webSearchKey,
  type WebToolName,
} from '../src/metadata/assistant/web-tools.js';
import { readAssistantSettings, writeAssistantSettings } from '../src/metadata/assistant-settings.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir, tempConfig } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const agentKey = 'sk-agent-key-1111';
const searchKey = 'sk-search-key-2222';
const googleKey = 'AIza-google-key-3333';

const deepseekConfig: AssistantConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: agentKey,
  webSearch: 'deepseek',
  searchApiKey: null,
  googleBooksApiKey: null,
};

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stub web transport: every DNS name resolves to a public address unless listed. */
function webTransport(
  handler: (request: Captured) => Response,
  dns: Record<string, string[]> = {},
): { transport: WebTransport; requests: Captured[] } {
  const requests: Captured[] = [];
  const transport: WebTransport = {
    async fetch(input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      const captured: Captured = {
        url,
        method: init?.method ?? 'GET',
        headers,
        body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
      };
      requests.push(captured);
      return handler(captured);
    },
    async lookup(host) {
      if (host in dns) return dns[host]!;
      return ['93.184.216.34'];
    },
  };
  return { transport, requests };
}

function run(name: WebToolName, args: unknown, transport: WebTransport, config: AssistantConfig = deepseekConfig) {
  return executeWebTool(name, args, { config, transport, state: newWebToolState() });
}

const searchResponse = {
  results: [
    {
      rerank_score: 2.4,
      title: '三体 (豆瓣)',
      url: 'https://book.douban.com/subject/2567698/',
      snippet: 'Short snippet.',
      summary: '三体 刘慈欣 重庆出版社 2008 ISBN 9787536692930',
      content: '',
      site_name: '豆瓣读书',
      site_icon: null,
      date: '2008-01-01T00:00:00+00:00',
      authority: 3,
    },
    { title: 'Not a web page', url: 'ftp://example.com/x', snippet: '', summary: '' },
  ],
};

describe('web_search', () => {
  it('posts the documented request to DeepSeek Search and returns compact results', async () => {
    const { transport, requests } = webTransport(() => Response.json(searchResponse));
    const text = await run('web_search', { query: '  三体  刘慈欣 ', count: 20 }, transport);

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(request!.method).toBe('POST');
    expect(request!.headers.authorization).toBe(`Bearer ${agentKey}`);
    expect(request!.headers['content-type']).toBe('application/json');
    // count is clamped to the agent's maximum; need_content is left at its documented default.
    expect(request!.body).toEqual({ query: '三体 刘慈欣', count: SEARCH_MAX_RESULTS });

    const parsed = JSON.parse(text) as { query: string; results: Array<Record<string, unknown>> };
    expect(parsed.query).toBe('三体 刘慈欣');
    expect(parsed.results).toEqual([
      {
        title: '三体 (豆瓣)',
        url: 'https://book.douban.com/subject/2567698/',
        host: 'book.douban.com',
        site: '豆瓣读书',
        date: '2008-01-01T00:00:00+00:00',
        summary: '三体 刘慈欣 重庆出版社 2008 ISBN 9787536692930',
        authority: 3,
      },
    ]);
  });

  it('rejects empty and over-long queries without a request', async () => {
    const { transport, requests } = webTransport(() => Response.json(searchResponse));
    expect(JSON.parse(await run('web_search', { query: '   ' }, transport))).toMatchObject({ error: 'invalid_arguments' });
    expect(JSON.parse(await run('web_search', { query: '书'.repeat(129) }, transport))).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(JSON.parse(await run('web_search', { query: '书'.repeat(128), count: 3 }, transport))).toHaveProperty('results');
    expect(requests).toHaveLength(1);
  });

  it('reports the documented error statuses with the API message', async () => {
    const statuses: Array<[number, string]> = [
      [401, 'unauthorized'],
      [402, 'insufficient_balance'],
      [429, 'rate_limited'],
      [500, 'search_unavailable'],
    ];
    for (const [status, code] of statuses) {
      const { transport } = webTransport(() =>
        Response.json(
          { error: { message: `upstream says ${status}`, type: 'invalid_request_error', param: null, code: 'x' } },
          { status },
        ),
      );
      const result = JSON.parse(await run('web_search', { query: 'q' }, transport)) as Record<string, unknown>;
      expect(result).toMatchObject({ error: code, status });
      expect(String(result.detail)).toContain(`upstream says ${status}`);
      expect(JSON.stringify(result)).not.toContain(agentKey);
    }
  });

  it('caps searches per run', async () => {
    const { transport, requests } = webTransport(() => Response.json({ results: [] }));
    const state = newWebToolState();
    const context = { config: deepseekConfig, transport, state };
    for (let index = 0; index < MAX_WEB_SEARCHES; index += 1) {
      expect(JSON.parse(await executeWebTool('web_search', { query: `q${index}` }, context))).toEqual({
        query: `q${index}`,
        results: [],
      });
    }
    expect(JSON.parse(await executeWebTool('web_search', { query: 'again' }, context))).toMatchObject({
      error: 'limit_reached',
    });
    expect(requests).toHaveLength(MAX_WEB_SEARCHES);
  });
});

describe('fetch_page', () => {
  it('posts the documented request to DeepSeek Fetch and returns the Markdown page', async () => {
    const { transport, requests } = webTransport(() =>
      Response.json({ title: '三体', content: '# 三体\n\nISBN: 9787536692930' }),
    );
    const text = await run('fetch_page', { url: 'https://book.douban.com/subject/2567698/' }, transport);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://api.deepseek.com/v1/tools/fetch');
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${agentKey}`);
    expect(requests[0]!.body).toEqual({ url: 'https://book.douban.com/subject/2567698/' });
    expect(JSON.parse(text)).toEqual({
      url: 'https://book.douban.com/subject/2567698/',
      host: 'book.douban.com',
      title: '三体',
      content: '# 三体\n\nISBN: 9787536692930',
    });
  });

  it('truncates long pages to valid JSON within the result cap', async () => {
    const content = `# Long\n\n${'正文 "quoted" \\ '.repeat(5_000)}`;
    const { transport } = webTransport(() => Response.json({ title: 'Long', content }));
    const text = await run('fetch_page', { url: 'https://example.com/long' }, transport);
    expect(text.length).toBeLessThanOrEqual(FETCH_PAGE_RESULT_CHARS);
    const parsed = JSON.parse(text) as { content: string; truncated: boolean; title: string };
    expect(parsed.truncated).toBe(true);
    expect(parsed.title).toBe('Long');
    expect(content.startsWith(parsed.content)).toBe(true);
    expect(parsed.content.length).toBeGreaterThan(FETCH_PAGE_RESULT_CHARS / 2);
  });

  it('reports 403 and 404 from Fetch as a reason to try another source', async () => {
    for (const [status, code] of [
      [403, 'blocked'],
      [404, 'not_found'],
    ] as const) {
      const { transport } = webTransport(() => Response.json({ error: { message: 'no' } }, { status }));
      expect(JSON.parse(await run('fetch_page', { url: 'https://example.com/a' }, transport))).toMatchObject({
        error: code,
        status,
      });
    }
  });

  it('rejects unsafe urls before any request', async () => {
    const dns = {
      'internal.example.com': ['10.0.0.5'],
      'metadata.example.com': ['169.254.169.254'],
      'loop6.example.com': ['::1'],
      'mapped.example.com': ['::ffff:127.0.0.1'],
      'mixed.example.com': ['93.184.216.34', '192.168.1.10'],
      'ula.example.com': ['fd00::1'],
    };
    const { transport, requests } = webTransport(() => Response.json({ title: '', content: 'x' }), dns);
    const failing: WebTransport = {
      ...transport,
      lookup: async (host) => {
        if (host === 'nxdomain.example.com') throw new Error('ENOTFOUND');
        return transport.lookup!(host);
      },
    };
    const unsafe = [
      'ftp://example.com/file',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:pass@example.com/',
      'https://user@example.com/',
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://[::1]/',
      'http://10.1.2.3/',
      'http://localhost:3000/',
      'http://foo.localhost/',
      'http://printer.local/',
      'http://intranet/',
      'https://example.com:8080/',
      'https://internal.example.com/',
      'https://metadata.example.com/latest',
      'https://loop6.example.com/',
      'https://mapped.example.com/',
      'https://mixed.example.com/',
      'https://ula.example.com/',
      'https://nxdomain.example.com/',
      `https://example.com/${'a'.repeat(8200)}`,
      '',
      42,
    ];
    for (const url of unsafe) {
      const result = JSON.parse(await run('fetch_page', { url }, failing)) as Record<string, unknown>;
      expect(result, String(url)).toMatchObject({ error: 'url_rejected' });
    }
    expect(requests).toEqual([]);
    expect(await validateFetchUrl('https://book.douban.com/subject/1/', failing.lookup)).toMatchObject({ ok: true });
  });
});

describe('web search key selection', () => {
  it('uses the agent key only for a DeepSeek base url, otherwise the separate search key', () => {
    expect(webSearchKey(deepseekConfig)).toBe(agentKey);
    expect(webSearchKey({ ...deepseekConfig, searchApiKey: searchKey })).toBe(agentKey);
    expect(webSearchKey({ ...deepseekConfig, apiKey: null, searchApiKey: searchKey })).toBe(searchKey);
    expect(webSearchKey({ ...deepseekConfig, webSearch: 'off' })).toBeNull();
    expect(webSearchKey({ ...deepseekConfig, webSearch: undefined })).toBeNull();

    const other: AssistantConfig = { ...deepseekConfig, baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-openai' };
    expect(webSearchKey(other)).toBeNull();
    expect(webSearchKey({ ...other, searchApiKey: searchKey })).toBe(searchKey);
    // A look-alike host never receives the agent key.
    expect(webSearchKey({ ...other, baseUrl: 'https://api.deepseek.com.evil.example/v1' })).toBeNull();
  });

  it('sends the separate search key to DeepSeek when the agent is another provider', async () => {
    const { transport, requests } = webTransport(() => Response.json({ results: [] }));
    const config: AssistantConfig = {
      ...deepseekConfig,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      searchApiKey: searchKey,
    };
    await run('web_search', { query: 'q' }, transport, config);
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${searchKey}`);
  });
});

describe('agent tool list', () => {
  it('offers web tools only when web search is on and a key is available', () => {
    expect(agentToolDefinitions({ webSearch: false }).map((tool) => tool.function.name)).toEqual([
      'search_open_library',
      'get_open_library_record',
      'google_books',
      'submit_metadata',
    ]);
    expect(agentToolDefinitions({ webSearch: true }).map((tool) => tool.function.name)).toEqual([
      'search_open_library',
      'get_open_library_record',
      'google_books',
      'web_search',
      'fetch_page',
      'page_images',
      'submit_metadata',
    ]);
  });

  it('sends the right tool list to the model and refuses a web tool that is not offered', async () => {
    const cases: Array<[AssistantConfig, boolean]> = [
      [deepseekConfig, true],
      [{ ...deepseekConfig, webSearch: 'off' }, false],
      [{ ...deepseekConfig, apiKey: null }, false],
      [{ ...deepseekConfig, baseUrl: 'https://api.openai.com/v1' }, false],
    ];
    for (const [config, expected] of cases) {
      const { transport, bodies } = scriptedModel([
        [{ name: 'web_search', arguments: { query: 'q' } }],
        [{ name: 'submit_metadata', arguments: submission }],
      ]);
      const web = webTransport(() => Response.json({ results: [] }));
      transport.web = web.transport;
      await runMetadataAgent({
        transport,
        metadataPrivate: false,
        openLibrary: { origin: 'https://ol.example', fetch: async () => Response.json({}) },
        config,
        input: { filename: 'a.epub', format: 'epub', fields: emptyFields },
      });
      const names = (bodies[0]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
      expect(names.includes('web_search')).toBe(expected);
      expect(names.includes('fetch_page')).toBe(expected);
      expect(names).toContain('google_books');
      const toolReply = (bodies[1]!.messages as Array<Record<string, unknown>>).find((m) => m.role === 'tool');
      const content = JSON.parse(String(toolReply?.content)) as Record<string, unknown>;
      if (expected) expect(content).toEqual({ query: 'q', results: [] });
      else expect(content).toMatchObject({ error: 'unknown_tool' });
      expect(web.requests).toHaveLength(expected ? 1 : 0);
    }
  });
});

describe('google_books', () => {
  const volumes = {
    totalItems: 1,
    items: [
      {
        id: 'zyTCAlFPjgYC',
        volumeInfo: {
          title: 'The Google Story',
          subtitle: 'Inside the Hottest Business',
          authors: ['David A. Vise', 'Mark Malseed'],
          publisher: 'Random House',
          publishedDate: '2005-11-15',
          language: 'en',
          industryIdentifiers: [
            { type: 'ISBN_10', identifier: '055380457X' },
            { type: 'ISBN_13', identifier: '9780553804577' },
          ],
          description: 'x'.repeat(3_000),
          canonicalVolumeLink: 'https://books.google.com/books/about/The_Google_Story.html?id=zyTCAlFPjgYC',
          pageCount: 207,
        },
      },
    ],
  };

  it('looks up by ISBN anonymously and returns compact volumes', async () => {
    const { transport, requests } = webTransport(() => Response.json(volumes));
    const config = { ...deepseekConfig, webSearch: 'off' as const };
    const text = await run('google_books', { isbn: '978-0-553-80457-7' }, transport, config);
    const url = new URL(requests[0]!.url);
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/books/v1/volumes');
    expect(url.searchParams.get('q')).toBe('isbn:9780553804577');
    expect(url.searchParams.has('key')).toBe(false);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.headers.authorization).toBeUndefined();

    const parsed = JSON.parse(text) as { volumes: Array<Record<string, unknown>> };
    expect(parsed.volumes).toHaveLength(1);
    const volume = parsed.volumes[0]!;
    expect(volume).toMatchObject({
      id: 'zyTCAlFPjgYC',
      title: 'The Google Story',
      subtitle: 'Inside the Hottest Business',
      authors: ['David A. Vise', 'Mark Malseed'],
      publisher: 'Random House',
      publishedDate: '2005-11-15',
      language: 'en',
      industryIdentifiers: [
        { type: 'ISBN_10', identifier: '055380457X' },
        { type: 'ISBN_13', identifier: '9780553804577' },
      ],
      link: 'https://books.google.com/books/about/The_Google_Story.html?id=zyTCAlFPjgYC',
    });
    expect(String(volume.description).length).toBeLessThanOrEqual(1_000);
    expect(volume).not.toHaveProperty('pageCount');
  });

  it('returns the largest image link as https without the page-curl effect', async () => {
    const withImages = {
      items: [
        {
          ...volumes.items[0],
          volumeInfo: {
            ...volumes.items[0]!.volumeInfo,
            imageLinks: {
              smallThumbnail: 'http://books.google.com/books/content?id=zyTCAlFPjgYC&printsec=frontcover&img=1&zoom=5&edge=curl&source=gbs_api',
              thumbnail: 'http://books.google.com/books/content?id=zyTCAlFPjgYC&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api',
              medium: 'http://books.google.com/books/content?id=zyTCAlFPjgYC&printsec=frontcover&img=1&zoom=3&edge=curl&source=gbs_api',
            },
          },
        },
        { id: 'noImages1234', volumeInfo: { title: 'No images', imageLinks: { thumbnail: 'javascript:alert(1)' } } },
      ],
    };
    const { transport } = webTransport(() => Response.json(withImages));
    const parsed = JSON.parse(await run('google_books', { isbn: '9780553804577' }, transport)) as {
      volumes: Array<Record<string, unknown>>;
    };
    expect(parsed.volumes[0]!.imageLinks).toEqual({
      size: 'medium',
      url: 'https://books.google.com/books/content?id=zyTCAlFPjgYC&printsec=frontcover&img=1&zoom=3&source=gbs_api',
    });
    expect(parsed.volumes[1]).not.toHaveProperty('imageLinks');
  });

  it('sends the saved key as a query parameter and never returns it', async () => {
    const { transport, requests } = webTransport(() => Response.json(volumes));
    const config = { ...deepseekConfig, googleBooksApiKey: googleKey };
    const text = await run('google_books', { query: 'intitle:google story' }, transport, config);
    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get('key')).toBe(googleKey);
    expect(url.searchParams.get('q')).toBe('intitle:google story');
    expect(text).not.toContain(googleKey);
  });

  it('explains a 429 for the anonymous quota and for a configured key', async () => {
    const { transport } = webTransport(() => Response.json({ error: { code: 429 } }, { status: 429 }));
    const anonymous = JSON.parse(await run('google_books', { isbn: '9780553804577' }, transport)) as Record<string, string>;
    expect(anonymous).toMatchObject({ error: 'rate_limited', status: 429 });
    expect(anonymous.detail).toContain('anonymous shared quota');
    expect(anonymous.detail).toContain('Google Books API key in Settings');

    const keyed = JSON.parse(
      await run('google_books', { isbn: '9780553804577' }, transport, { ...deepseekConfig, googleBooksApiKey: googleKey }),
    ) as Record<string, string>;
    expect(keyed).toMatchObject({ error: 'rate_limited', status: 429 });
    expect(keyed.detail).toContain('configured API key');
    expect(JSON.stringify(keyed)).not.toContain(googleKey);
  });

  it('requires an isbn or a query', async () => {
    const { transport, requests } = webTransport(() => Response.json(volumes));
    expect(JSON.parse(await run('google_books', {}, transport))).toMatchObject({ error: 'invalid_arguments' });
    expect(JSON.parse(await run('google_books', { isbn: '12' }, transport))).toMatchObject({ error: 'invalid_arguments' });
    expect(requests).toEqual([]);
  });
});

describe('agent prompt and limits', () => {
  it('guides identifier-first lookups, web search, official titles, and sourced identifiers', () => {
    const prompt = buildSystemPrompt();
    for (const text of [
      'identifier first',
      'web_search',
      'fetch_page',
      'google_books',
      'Douban',
      'national library catalogues',
      'not from the filename',
      'sourceUrl',
      'Never invent an identifier',
      'Never send book content',
    ]) {
      expect(prompt).toContain(text);
    }
  });

  it('guides the agent to a cover of this edition from a trustworthy source', () => {
    const prompt = buildSystemPrompt();
    for (const text of [
      'page_images',
      'cover { url, sourceUrl }',
      'THIS edition',
      'never use another printing, translation, or volume',
      'Douban subject page',
      'Google Books imageLinks',
      'national library catalogues',
      'never invent or edit a URL',
      'Omit cover if you are unsure',
    ]) {
      expect(prompt).toContain(text);
    }
    const submit = agentToolDefinitions({ webSearch: true }).find((tool) => tool.function.name === 'submit_metadata');
    expect(JSON.stringify(submit?.function.parameters)).toContain('"cover"');
  });

  it('keeps a safe submitted cover url and drops an unsafe one without failing the submission', () => {
    const kept = validateSubmission({
      ...submission,
      cover: { url: 'https://img3.doubanio.com/view/subject/l/public/s28305968.jpg', sourceUrl: 'https://book.douban.com/subject/25869109/' },
    });
    expect(kept.ok && kept.proposal.cover).toEqual({
      url: 'https://img3.doubanio.com/view/subject/l/public/s28305968.jpg',
      sourceUrl: 'https://book.douban.com/subject/25869109/',
    });
    for (const cover of [{ url: 'javascript:alert(1)' }, { url: 'https://u:p@img.example.com/c.jpg' }, 'https://img.example.com/c.jpg', null]) {
      const result = validateSubmission({ ...submission, cover });
      expect(result.ok && result.proposal.cover).toBeNull();
    }
  });

  it('raises the run limits and keeps the per-request timeout', () => {
    expect(MAX_MODEL_TURNS).toBe(8);
    expect(MAX_TOOL_CALLS).toBe(10);
    expect(TOTAL_BUDGET_MS).toBe(150_000);
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('keeps a valid sourceUrl on submitted identifiers and drops an unsafe one', () => {
    const result = validateSubmission({
      ...submission,
      identifiers: [
        { scheme: 'isbn', value: '9787536692930', sourceUrl: 'https://book.douban.com/subject/2567698/' },
        { scheme: 'douban', value: '2567698', sourceUrl: 'javascript:alert(1)' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.identifiers).toEqual([
      { scheme: 'isbn', value: '9787536692930', sourceUrl: 'https://book.douban.com/subject/2567698/' },
      { scheme: 'douban', value: '2567698' },
    ]);
  });
});

describe('trajectory steps for web tools', () => {
  it('records each web tool call and a readable summary, never the Google key', async () => {
    const { transport } = scriptedModel([
      [
        { name: 'google_books', arguments: { isbn: '9787536692930' } },
        { name: 'web_search', arguments: { query: '三体 site:book.douban.com' } },
      ],
      [{ name: 'fetch_page', arguments: { url: 'https://book.douban.com/subject/2567698/' } }],
      [{ name: 'submit_metadata', arguments: submission }],
    ]);
    transport.web = webTransport((request) => {
      if (request.url.includes('googleapis')) return Response.json({ error: {} }, { status: 429 });
      if (request.url.endsWith('/search')) return Response.json(searchResponse);
      return Response.json({ title: '三体 (豆瓣)', content: `# 三体\n\n${'内容'.repeat(10_000)}` });
    }).transport;
    const steps: AgentStep[] = [];
    await runMetadataAgent({
      transport,
      metadataPrivate: false,
      openLibrary: { origin: 'https://ol.example', fetch: async () => Response.json({}) },
      config: { ...deepseekConfig, googleBooksApiKey: googleKey },
      input: { filename: 'santi.epub', format: 'epub', fields: emptyFields },
      onStep: (step) => steps.push(step),
    });

    expect(steps[0]).toMatchObject({
      kind: 'input',
      tools: [
        'search_open_library',
        'get_open_library_record',
        'google_books',
        'web_search',
        'fetch_page',
        'page_images',
        'submit_metadata',
      ],
    });
    const calls = steps.filter((step) => step.kind === 'tool_call');
    expect(calls.map((step) => step.kind === 'tool_call' && step.name)).toEqual(['google_books', 'web_search', 'fetch_page']);
    const results = steps.filter((step) => step.kind === 'tool_result');
    expect(results.map((step) => (step.kind === 'tool_result' ? step.summary : null))).toEqual([
      { error: 'rate_limited', detail: expect.stringContaining('configured API key') },
      { count: 1, title: '三体 (豆瓣)' },
      {
        title: '三体 (豆瓣)',
        host: 'book.douban.com',
        url: 'https://book.douban.com/subject/2567698/',
        truncated: true,
      },
    ]);
    const page = results[2]!;
    expect(page.kind === 'tool_result' && page.result.length).toBeLessThanOrEqual(12_000);
    expect(JSON.stringify(steps)).not.toContain(googleKey);
    expect(JSON.stringify(steps)).not.toContain(agentKey);
  });
});

describe('web search settings', () => {
  it('defaults to DeepSeek only for a DeepSeek base url and stores the extra keys privately', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const deepseek = writeAssistantSettings(temp.dir, { baseUrl: 'https://api.deepseek.com', model: 'm', apiKey: agentKey });
    expect(deepseek).toMatchObject({ webSearch: 'deepseek', webSearchAvailable: true });

    const other = writeAssistantSettings(temp.dir, { baseUrl: 'https://api.openai.com/v1', model: 'm' });
    expect(other).toMatchObject({ webSearch: 'off', webSearchAvailable: false });

    const chosen = writeAssistantSettings(temp.dir, {
      baseUrl: 'https://api.openai.com/v1',
      model: 'm',
      webSearch: 'deepseek',
      searchApiKey: searchKey,
      googleBooksApiKey: googleKey,
    });
    expect(chosen).toMatchObject({
      webSearch: 'deepseek',
      webSearchAvailable: true,
      searchApiKeyConfigured: true,
      searchApiKeyHint: '2222',
      googleBooksApiKeyConfigured: true,
      googleBooksApiKeyHint: '3333',
    });
    expect(JSON.stringify(chosen)).not.toContain(searchKey);
    expect(JSON.stringify(chosen)).not.toContain(googleKey);

    // An explicit choice survives a save that leaves it out; blank keys keep the saved ones.
    writeAssistantSettings(temp.dir, { baseUrl: 'https://api.openai.com/v1', model: 'm2', searchApiKey: ' ' });
    expect(readAssistantSettings(temp.dir)).toMatchObject({
      webSearch: 'deepseek',
      searchApiKey: searchKey,
      googleBooksApiKey: googleKey,
    });
    const stored = JSON.parse(readFileSync(path.join(temp.dir, 'metadata-assistant.json'), 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({ webSearch: 'deepseek', searchApiKey: searchKey, googleBooksApiKey: googleKey });

    // null removes an optional key.
    const cleared = writeAssistantSettings(temp.dir, { baseUrl: 'https://api.openai.com/v1', model: 'm2', googleBooksApiKey: null });
    expect(cleared).toMatchObject({ googleBooksApiKeyConfigured: false, googleBooksApiKeyHint: null, searchApiKeyHint: '2222' });
  });

  it('accepts the new fields over the API and returns hints, never keys', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = tempConfig(temp.dir);
    migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
    const app = await buildApp({ config, clientDist: null, logger: false, assistant: {} });
    cleanups.push(() => void app.close());
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'ada', password: 'correct-horse-battery', libraryName: 'Home' },
    });
    const raw = setup.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '';

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/metadata/assistant',
      headers: { cookie },
      payload: {
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt',
        apiKey: 'sk-openai-0000',
        webSearch: 'deepseek',
        searchApiKey: searchKey,
        googleBooksApiKey: googleKey,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().assistant).toEqual({
      configured: true,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt',
      apiKeyConfigured: true,
      apiKeyHint: 'sk-openai-0000'.slice(-4),
      webSearch: 'deepseek',
      webSearchAvailable: true,
      searchApiKeyConfigured: true,
      searchApiKeyHint: '2222',
      googleBooksApiKeyConfigured: true,
      googleBooksApiKeyHint: '3333',
    });
    const read = await app.inject({ method: 'GET', url: '/api/metadata/assistant', headers: { cookie } });
    for (const body of [saved.body, read.body]) {
      expect(body).not.toContain(searchKey);
      expect(body).not.toContain(googleKey);
      expect(body).not.toContain('sk-openai-0000');
    }
    expect(read.json()).toEqual(saved.json());

    for (const payload of [
      { baseUrl: 'https://api.openai.com/v1', model: 'gpt', webSearch: 'google' },
      { baseUrl: 'https://api.openai.com/v1', model: 'gpt', searchApiKey: 42 },
      { baseUrl: 'https://api.openai.com/v1', model: 'gpt', bingKey: 'x' },
    ]) {
      const bad = await app.inject({ method: 'PUT', url: '/api/metadata/assistant', headers: { cookie }, payload });
      expect(bad.statusCode).toBe(400);
    }
  });
});

// --- helpers ----------------------------------------------------------------

const emptyFields = {
  title: null,
  authors: [],
  translators: [],
  description: null,
  publisher: null,
  publishedDate: null,
  language: null,
  identifiers: [],
  series: null,
  seriesOrder: null,
};

const submission = {
  title: '三体',
  authors: ['刘慈欣'],
  description: '地球文明与三体文明的故事。',
  publisher: '重庆出版社',
  publishedDate: '2008-01',
  language: 'zh',
};

/** A model that answers each turn with the given tool calls. */
function scriptedModel(turns: Array<Array<{ name: string; arguments: unknown }>>) {
  const bodies: Array<Record<string, unknown>> = [];
  const transport: AssistantTransport = {
    async fetch(_input, init) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const calls = turns[bodies.length - 1] ?? [];
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: calls.map((call, index) => ({
                id: `call_${bodies.length}_${index}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            },
          },
        ],
      });
    },
  };
  return { transport, bodies };
}
