import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  AssistantError,
  buildChatUrl,
  buildModelsUrl,
  listAssistantModels,
  postChatCompletion,
  testAssistant,
  type AssistantConfig,
  type AssistantTransport,
} from '../src/metadata/assistant/client.js';
import {
  clearAssistantSettings,
  publicAssistantSettings,
  readAssistantSettings,
  writeAssistantSettings,
} from '../src/metadata/assistant-settings.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir, tempConfig } from './helpers.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';
const adminKey = 'sk-admin-secret-9876';
const baseUrl = 'https://api.example.com/v1';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function cookieFrom(response: { headers: { 'set-cookie'?: string | string[] | undefined } }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(';')[0] ?? '';
}

function settingsPath(dir: string): string {
  return path.join(dir, 'metadata-assistant.json');
}

/** The web search fields of a public view with web search off and no extra keys. */
const webOff = {
  webSearch: 'off',
  webSearchAvailable: false,
  searchApiKeyConfigured: false,
  searchApiKeyHint: null,
  googleBooksApiKeyConfigured: false,
  googleBooksApiKeyHint: null,
} as const;

/** The stored web fields for a base URL that is not DeepSeek. */
const storedWebOff = { webSearch: 'off', searchApiKey: null, googleBooksApiKey: null } as const;

function publicUnconfigured() {
  return {
    configured: false,
    baseUrl: null,
    model: null,
    apiKeyConfigured: false,
    apiKeyHint: null,
    ...webOff,
  };
}

async function startApp(transport: AssistantTransport = {}) {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  const config = tempConfig(temp.dir);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  const app = await buildApp({ config, clientDist: null, logger: false, assistant: transport });
  cleanups.push(() => {
    void app.close();
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { username: 'ada', password, libraryName: 'Home' },
  });
  expect(setup.statusCode).toBe(201);
  return { app, config, tempDir: temp.dir, cookie: cookieFrom(setup) };
}

async function readerCookie(app: Awaited<ReturnType<typeof buildApp>>, cookie: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { cookie },
    payload: { username: 'reader', password },
  });
  expect(created.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/session/login',
    payload: { username: 'reader', password },
  });
  expect(login.statusCode).toBe(200);
  return cookieFrom(login);
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AssistantError);
    return (error as AssistantError).code;
  }
  throw new Error('expected the assistant request to fail');
}

describe('assistant settings', () => {
  it('writes a private file and never exposes the key in the public view', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    chmodSync(temp.dir, 0o775);
    expect(statSync(temp.dir).mode & 0o777).toBe(0o775);

    const view = writeAssistantSettings(temp.dir, {
      baseUrl: ` ${baseUrl}/ `,
      model: ' gpt-test ',
      apiKey: ` ${adminKey} `,
    });
    expect(view).toEqual({
      configured: true,
      baseUrl,
      model: 'gpt-test',
      apiKeyConfigured: true,
      apiKeyHint: '9876',
      ...webOff,
    });
    expect(JSON.stringify(view)).not.toContain(adminKey);

    const file = settingsPath(temp.dir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(temp.dir).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({ baseUrl, model: 'gpt-test', apiKey: adminKey });
    expect(typeof stored.updatedAt).toBe('string');
    expect(readAssistantSettings(temp.dir)).toEqual({ baseUrl, model: 'gpt-test', apiKey: adminKey, ...storedWebOff });
    expect(readFileSync(file, 'utf8')).not.toContain('"baseUrl":"https://api.example.com/v1//"');
  });

  it('keeps an existing key for blank updates and clears settings explicitly', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    writeAssistantSettings(temp.dir, { baseUrl, model: 'first', apiKey: adminKey });

    const blank = writeAssistantSettings(temp.dir, { baseUrl, model: 'second', apiKey: '   ' });
    expect(blank.apiKeyConfigured).toBe(true);
    expect(blank.apiKeyHint).toBe('9876');
    expect(readAssistantSettings(temp.dir)?.apiKey).toBe(adminKey);

    const absent = writeAssistantSettings(temp.dir, { baseUrl, model: 'third' });
    expect(absent.apiKeyConfigured).toBe(true);
    expect(absent.apiKeyHint).toBe('9876');
    expect(readAssistantSettings(temp.dir)?.apiKey).toBe(adminKey);

    clearAssistantSettings(temp.dir);
    expect(readAssistantSettings(temp.dir)).toBeNull();
    expect(existsSync(settingsPath(temp.dir))).toBe(false);
    expect(publicAssistantSettings(null)).toEqual(publicUnconfigured());
  });

  it('stores null for a first save with a blank key', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const view = writeAssistantSettings(temp.dir, { baseUrl: 'http://localhost:11434/v1', model: 'local', apiKey: '' });
    expect(view).toEqual({
      configured: true,
      baseUrl: 'http://localhost:11434/v1',
      model: 'local',
      apiKeyConfigured: false,
      apiKeyHint: null,
      ...webOff,
    });
    expect(readAssistantSettings(temp.dir)).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      model: 'local',
      apiKey: null,
      ...storedWebOff,
    });
  });

  it('rejects invalid base urls, models, and keys', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const invalid = [
      { baseUrl: 'ftp://api.example.com/v1', model: 'gpt-test' },
      { baseUrl: 'not a url', model: 'gpt-test' },
      { baseUrl, model: '   ' },
      { baseUrl, model: 'x'.repeat(101) },
      { baseUrl, model: 'gpt-test', apiKey: 'k'.repeat(501) },
      { baseUrl: `https://api.example.com/${'a'.repeat(2100)}`, model: 'gpt-test' },
    ];
    for (const input of invalid) {
      expect(() => writeAssistantSettings(temp.dir, input)).toThrow();
    }
    expect(existsSync(settingsPath(temp.dir))).toBe(false);
  });

  it('treats a missing or invalid file as unconfigured', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    expect(readAssistantSettings(temp.dir)).toBeNull();

    writeFileSync(settingsPath(temp.dir), '{not json');
    expect(readAssistantSettings(temp.dir)).toBeNull();

    writeFileSync(
      settingsPath(temp.dir),
      JSON.stringify({ baseUrl: 'ftp://api.example.com/v1', model: 'gpt-test', apiKey: null, updatedAt: 'now' }),
    );
    expect(readAssistantSettings(temp.dir)).toBeNull();

    writeFileSync(
      settingsPath(temp.dir),
      JSON.stringify({ baseUrl, model: 'gpt-test', apiKey: 42, updatedAt: 'now' }),
    );
    expect(readAssistantSettings(temp.dir)).toBeNull();
  });
});

describe('assistant client', () => {
  it('types metadata_incomplete as an assistant error code', () => {
    const error = new AssistantError('metadata_incomplete');
    expect(error.code).toBe('metadata_incomplete');
    expect(error.message).toBe('metadata_incomplete');
  });

  it('builds the chat completions url without duplicate slashes', () => {
    expect(buildChatUrl(`${baseUrl}/`)).toBe(`${baseUrl}/chat/completions`);
    expect(buildChatUrl('http://localhost:11434/v1///')).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('posts JSON and sends authorization only when a key exists', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init: RequestInit }> = [];
    const transport: AssistantTransport = {
      async fetch(input, init) {
        calls.push({ input, init: init ?? {} });
        return Response.json({ choices: [] });
      },
    };
    const body = { model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] };

    await expect(
      postChatCompletion(transport, { baseUrl: `${baseUrl}/`, model: 'gpt-test', apiKey: adminKey }, body),
    ).resolves.toEqual({ choices: [] });

    const first = calls[0];
    const href =
      typeof first.input === 'string'
        ? first.input
        : first.input instanceof URL
          ? first.input.href
          : first.input.url;
    expect(href).toBe(`${baseUrl}/chat/completions`);
    const headers = new Headers(first.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBe(`Bearer ${adminKey}`);
    expect(first.init.method).toBe('POST');
    expect(first.init.redirect).toBe('error');
    expect(first.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(first.init.body))).toEqual(body);

    await postChatCompletion(transport, { baseUrl, model: 'gpt-test', apiKey: null }, body);
    await postChatCompletion(transport, { baseUrl, model: 'gpt-test', apiKey: '' }, body);
    expect(new Headers(calls[1].init.headers).has('authorization')).toBe(false);
    expect(new Headers(calls[2].init.headers).has('authorization')).toBe(false);
  });

  it('maps status, network, timeout, and parse failures to named errors', async () => {
    const config: AssistantConfig = { baseUrl, model: 'gpt-test', apiKey: adminKey };
    const respond =
      (status: number, text = '') =>
      async (): Promise<Response> =>
        new Response(text, { status });

    expect(await errorCode(postChatCompletion({ fetch: respond(401) }, config, {}))).toBe('assistant_unauthorized');
    expect(await errorCode(postChatCompletion({ fetch: respond(403) }, config, {}))).toBe('assistant_unauthorized');
    expect(await errorCode(postChatCompletion({ fetch: respond(500, 'server secret') }, config, {}))).toBe(
      'metadata_unavailable',
    );
    expect(
      await errorCode(
        postChatCompletion(
          {
            async fetch() {
              throw new Error('offline');
            },
          },
          config,
          {},
        ),
      ),
    ).toBe('metadata_unavailable');
    expect(
      await errorCode(
        postChatCompletion(
          {
            async fetch() {
              throw new DOMException('The operation was aborted.', 'AbortError');
            },
          },
          config,
          {},
        ),
      ),
    ).toBe('metadata_unavailable');
    expect(await errorCode(postChatCompletion({ fetch: respond(200, 'not json') }, config, {}))).toBe(
      'assistant_invalid_response',
    );

    try {
      await postChatCompletion({ fetch: respond(500, 'body-secret') }, config, { prompt: 'body-secret' });
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantError);
      expect(String((error as Error).message)).not.toContain(adminKey);
      expect(String((error as Error).message)).not.toContain('body-secret');
    }
  });

  it('caps response bodies at two megabytes', async () => {
    const config: AssistantConfig = { baseUrl, model: 'gpt-test', apiKey: null };
    const tooLarge = 'x'.repeat(2 * 1024 * 1024 + 1);
    expect(await errorCode(postChatCompletion({ fetch: async () => new Response(tooLarge) }, config, {}))).toBe(
      'assistant_invalid_response',
    );
  });

  it('tests the model with a tiny no-tools request', async () => {
    const calls: RequestInit[] = [];
    const transport: AssistantTransport = {
      async fetch(_input, init) {
        calls.push(init ?? {});
        return Response.json({ id: 'chatcmpl-test' });
      },
    };
    const result = await testAssistant(transport, { baseUrl, model: 'gpt-test', apiKey: adminKey });
    expect(result).toEqual({ model: 'gpt-test' });
    const body = JSON.parse(String(calls[0].body)) as {
      model: string;
      max_tokens: number;
      tools?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('gpt-test');
    expect(body.max_tokens).toBe(8);
    expect(body.tools).toBeUndefined();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content.toLowerCase()).toContain('ok');
  });
});

describe('assistant routes', () => {
  it('requires an administrator and masks the saved key', async () => {
    const started = await startApp();
    const unauth = await started.app.inject({ method: 'GET', url: '/api/metadata/assistant' });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.json()).toEqual({ error: 'unauthorized' });

    const reader = await readerCookie(started.app, started.cookie);
    const readerRequests = [
      started.app.inject({ method: 'GET', url: '/api/metadata/assistant', headers: { cookie: reader } }),
      started.app.inject({
        method: 'PUT',
        url: '/api/metadata/assistant',
        headers: { cookie: reader },
        payload: { baseUrl, model: 'gpt-test', apiKey: adminKey },
      }),
      started.app.inject({ method: 'DELETE', url: '/api/metadata/assistant', headers: { cookie: reader } }),
      started.app.inject({ method: 'POST', url: '/api/metadata/assistant/test', headers: { cookie: reader } }),
    ];
    for (const response of await Promise.all(readerRequests)) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'forbidden' });
    }
    expect(existsSync(settingsPath(started.tempDir))).toBe(false);

    const initial = await started.app.inject({
      method: 'GET',
      url: '/api/metadata/assistant',
      headers: { cookie: started.cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.headers['cache-control']).toBe('no-store');
    expect(initial.json()).toEqual({ assistant: publicUnconfigured() });

    const invalid = await started.app.inject({
      method: 'PUT',
      url: '/api/metadata/assistant',
      headers: { cookie: started.cookie },
      payload: { baseUrl: 'ftp://api.example.com/v1', model: 'gpt-test' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'invalid_request' });

    const saved = await started.app.inject({
      method: 'PUT',
      url: '/api/metadata/assistant',
      headers: { cookie: started.cookie },
      payload: { baseUrl: `${baseUrl}/`, model: 'gpt-router', apiKey: adminKey },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(saved.json()).toEqual({
      assistant: {
        configured: true,
        baseUrl,
        model: 'gpt-router',
        apiKeyConfigured: true,
        apiKeyHint: '9876',
        ...webOff,
      },
    });
    expect(saved.body).not.toContain(adminKey);
    expect(statSync(settingsPath(started.tempDir)).mode & 0o777).toBe(0o600);

    const fetched = await started.app.inject({
      method: 'GET',
      url: '/api/metadata/assistant',
      headers: { cookie: started.cookie },
    });
    expect(fetched.json()).toEqual(saved.json());

    const blank = await started.app.inject({
      method: 'PUT',
      url: '/api/metadata/assistant',
      headers: { cookie: started.cookie },
      payload: { baseUrl, model: 'gpt-router-2', apiKey: '   ' },
    });
    expect(blank.statusCode).toBe(200);
    expect(blank.json().assistant.apiKeyHint).toBe('9876');
    expect(readAssistantSettings(started.tempDir)?.apiKey).toBe(adminKey);

    const removed = await started.app.inject({
      method: 'DELETE',
      url: '/api/metadata/assistant',
      headers: { cookie: started.cookie },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.headers['cache-control']).toBe('no-store');
    expect(removed.json()).toEqual({ assistant: publicUnconfigured() });
    expect(existsSync(settingsPath(started.tempDir))).toBe(false);
  });

  it('tests the saved assistant and reports named failures', async () => {
    let mode: 'ok' | 'unauthorized' | 'network' | 'malformed' = 'ok';
    const calls: RequestInit[] = [];
    const transport: AssistantTransport = {
      async fetch(_input, init) {
        calls.push(init ?? {});
        if (mode === 'network') throw new Error('offline');
        if (mode === 'unauthorized') return new Response('', { status: 401 });
        if (mode === 'malformed') return new Response('not json', { status: 200 });
        return Response.json({ choices: [{ message: { content: 'OK' } }] });
      },
    };
    const started = await startApp(transport);

    const unconfigured = await started.app.inject({
      method: 'POST',
      url: '/api/metadata/assistant/test',
      headers: { cookie: started.cookie },
    });
    expect(unconfigured.statusCode).toBe(400);
    expect(unconfigured.headers['cache-control']).toBe('no-store');
    expect(unconfigured.json()).toEqual({ error: 'metadata_assistant_unconfigured' });

    const saved = await started.app.inject({
      method: 'PUT',
      url: '/api/metadata/assistant',
      headers: { cookie: started.cookie },
      payload: { baseUrl, model: 'gpt-test', apiKey: adminKey },
    });
    expect(saved.statusCode).toBe(200);

    const ok = await started.app.inject({
      method: 'POST',
      url: '/api/metadata/assistant/test',
      headers: { cookie: started.cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.json()).toEqual({ ok: true, model: 'gpt-test' });
    expect(ok.body).not.toContain(adminKey);
    expect(new Headers(calls[0].headers).get('authorization')).toBe(`Bearer ${adminKey}`);

    mode = 'unauthorized';
    const unauthorized = await started.app.inject({
      method: 'POST',
      url: '/api/metadata/assistant/test',
      headers: { cookie: started.cookie },
    });
    expect(unauthorized.statusCode).toBe(502);
    expect(unauthorized.json()).toEqual({ error: 'assistant_unauthorized' });
    expect(unauthorized.body).not.toContain(adminKey);

    mode = 'network';
    const network = await started.app.inject({
      method: 'POST',
      url: '/api/metadata/assistant/test',
      headers: { cookie: started.cookie },
    });
    expect(network.statusCode).toBe(502);
    expect(network.json()).toEqual({ error: 'metadata_unavailable' });

    mode = 'malformed';
    const malformed = await started.app.inject({
      method: 'POST',
      url: '/api/metadata/assistant/test',
      headers: { cookie: started.cookie },
    });
    expect(malformed.statusCode).toBe(502);
    expect(malformed.json()).toEqual({ error: 'assistant_invalid_response' });
  });
});

describe('model list', () => {
  function modelsTransport(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transport: AssistantTransport = {
      async fetch(input, init) {
        const url = String(input);
        calls.push({ url, init: init ?? {} });
        return respond(url, init ?? {});
      },
    };
    return { transport, calls };
  }

  async function listModels(
    started: Awaited<ReturnType<typeof startApp>>,
    payload: Record<string, unknown>,
    cookie = started.cookie,
  ) {
    return started.app.inject({
      method: 'POST',
      url: '/api/metadata/assistant/models',
      headers: { cookie },
      payload,
    });
  }

  it('builds the models URL from the base URL', () => {
    expect(buildModelsUrl(baseUrl)).toBe('https://api.example.com/v1/models');
    expect(buildModelsUrl(`${baseUrl}/`)).toBe('https://api.example.com/v1/models');
  });

  it('accepts a bare array of ids or strings, deduplicated and sorted', async () => {
    const target = { baseUrl, apiKey: null };
    const bare = await listAssistantModels(
      { fetch: async () => Response.json(['b-model', { id: 'a-model' }, 'b-model', { id: '' }, 42]) },
      target,
    );
    expect(bare).toEqual(['a-model', 'b-model']);
  });

  it('caps the list and the response size', async () => {
    const target = { baseUrl, apiKey: null };
    const many = Array.from({ length: 600 }, (_, index) => ({ id: `m-${String(index).padStart(3, '0')}` }));
    const capped = await listAssistantModels({ fetch: async () => Response.json({ data: many }) }, target);
    expect(capped).toHaveLength(500);
    expect(capped[0]).toBe('m-000');

    const tooLarge = 'x'.repeat(1024 * 1024 + 1);
    expect(await errorCode(listAssistantModels({ fetch: async () => new Response(tooLarge) }, target))).toBe(
      'assistant_invalid_response',
    );
  });

  it('reports a timeout separately from an unreachable server', async () => {
    const target = { baseUrl, apiKey: null };
    const timeout = async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };
    expect(await errorCode(listAssistantModels({ fetch: timeout }, target))).toBe('assistant_timeout');
    const offline = async () => {
      throw new Error('offline');
    };
    expect(await errorCode(listAssistantModels({ fetch: offline }, target))).toBe('metadata_unavailable');
  });

  it('lists models from unsaved form values in the OpenAI shape', async () => {
    const { transport, calls } = modelsTransport(() =>
      Response.json({ object: 'list', data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-b' }] }),
    );
    const started = await startApp(transport);
    const response = await listModels(started, { baseUrl: `${baseUrl}/`, apiKey: adminKey });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ models: ['gpt-a', 'gpt-b'] });
    expect(response.body).not.toContain(adminKey);
    expect(calls[0].url).toBe('https://api.example.com/v1/models');
    expect(calls[0].init.method).toBe('GET');
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe(`Bearer ${adminKey}`);
    expect(existsSync(settingsPath(started.tempDir))).toBe(false);
  });

  it('uses the saved key for a blank key only on the saved base URL', async () => {
    const { transport, calls } = modelsTransport(() => Response.json({ data: [{ id: 'gpt-test' }] }));
    const started = await startApp(transport);
    writeAssistantSettings(started.tempDir, { baseUrl, model: 'gpt-test', apiKey: adminKey });

    const blank = await listModels(started, { baseUrl, apiKey: '' });
    expect(blank.statusCode).toBe(200);
    expect(blank.json()).toEqual({ models: ['gpt-test'] });
    expect(blank.body).not.toContain(adminKey);
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe(`Bearer ${adminKey}`);

    const absent = await listModels(started, { baseUrl });
    expect(absent.statusCode).toBe(200);
    expect(new Headers(calls[1].init.headers).get('authorization')).toBe(`Bearer ${adminKey}`);

    const otherServer = await listModels(started, { baseUrl: 'https://other.example.com/v1', apiKey: '' });
    expect(otherServer.statusCode).toBe(200);
    expect(calls[2].url).toBe('https://other.example.com/v1/models');
    expect(new Headers(calls[2].init.headers).get('authorization')).toBeNull();
  });

  it('reports a rejected key, a server without a model list, and a malformed body', async () => {
    let mode: 'unauthorized' | 'forbidden' | 'missing' | 'malformed' | 'wrong-shape' | 'error' = 'unauthorized';
    const { transport } = modelsTransport(() => {
      if (mode === 'unauthorized') return new Response('', { status: 401 });
      if (mode === 'forbidden') return new Response('', { status: 403 });
      if (mode === 'missing') return new Response('not found', { status: 404 });
      if (mode === 'malformed') return new Response('<html>models</html>', { status: 200 });
      if (mode === 'wrong-shape') return Response.json({ models: 'none' });
      return new Response('', { status: 500 });
    });
    const started = await startApp(transport);
    const expected = {
      unauthorized: 'assistant_unauthorized',
      forbidden: 'assistant_unauthorized',
      missing: 'assistant_models_unsupported',
      malformed: 'assistant_models_unsupported',
      'wrong-shape': 'assistant_models_unsupported',
      error: 'metadata_unavailable',
    } as const;
    for (const next of Object.keys(expected) as Array<keyof typeof expected>) {
      mode = next;
      const response = await listModels(started, { baseUrl, apiKey: adminKey });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: expected[next] });
      expect(response.body).not.toContain(adminKey);
    }
  });

  it('rejects invalid base URLs and unknown fields without calling out', async () => {
    const { transport, calls } = modelsTransport(() => Response.json({ data: [] }));
    const started = await startApp(transport);
    const invalid = [
      { baseUrl: 'ftp://api.example.com/v1' },
      { baseUrl: 'https://api.example.com/v1?x=1' },
      { baseUrl: 'https://api.example.com/v1#models' },
      { baseUrl: 'https://user:pass@api.example.com/v1' },
      { baseUrl: '' },
      { baseUrl, apiKey: 42 },
      { baseUrl, model: 'gpt-test' },
    ];
    for (const payload of invalid) {
      const response = await listModels(started, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_request' });
    }
    expect(calls).toHaveLength(0);
  });

  it('requires an administrator', async () => {
    const { transport, calls } = modelsTransport(() => Response.json({ data: [{ id: 'gpt-test' }] }));
    const started = await startApp(transport);
    const unauth = await started.app.inject({
      method: 'POST',
      url: '/api/metadata/assistant/models',
      payload: { baseUrl },
    });
    expect(unauth.statusCode).toBe(401);
    const reader = await readerCookie(started.app, started.cookie);
    const forbidden = await listModels(started, { baseUrl }, reader);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: 'forbidden' });
    expect(calls).toHaveLength(0);
  });
});
